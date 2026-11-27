-- LLeMbas in Neovim. The agent is the LLeMbas CLI, unchanged: this plugin starts `lembas serve --stdio`
-- and is its client (Agent Client Protocol, version 1). Models, permissions, tools and the sign-in are
-- the CLI's; nothing is set here but how the panel looks and which command starts the agent.
local rpc = require("llembas.rpc")
local chat = require("llembas.chat")
local context = require("llembas.context")
local ui = require("llembas.ui")

local M = {}

local function read_repo_version()
  local src = debug.getinfo(1, "S").source
  if type(src) == "string" and src:sub(1, 1) == "@" then
    local vfile = vim.fn.fnamemodify(src:sub(2), ":p:h:h:h:h") .. "/VERSION"
    if vim.fn.filereadable(vfile) == 1 then
      local v = vim.trim(table.concat(vim.fn.readfile(vfile), ""))
      if v ~= "" then return v end
    end
  end
  return "1.0.0-beta.4"
end

M.config = {
  cmd = { "lembas", "serve", "--stdio" }, -- the agent
  position = "right",                     -- "right" | "left" | "bottom" | "float"
  width = 64,                             -- the panel's columns (right/left)
  prompt_height = 5,                      -- the prompt window's rows
  border = "rounded",                     -- border style for floating windows
  mode = nil,                             -- the mode a session starts in (the CLI's own when nil)
  model = nil,                            -- the model a session starts on (the CLI's own when nil)
  show_thoughts = false,                  -- the model's thinking in the transcript
  send_open_file = true,                  -- a prompt names the file you are in
  complete = {
    auto = true,                          -- suggest as you type (needs an autocomplete model on the server)
    debounce_ms = 250,                    -- how long you must pause before a suggestion is asked for
    model = nil,                          -- a quick switch for this editor only; nil: your saved choice
    max_tokens = nil,                     -- maximum tokens to predict (nil/0: server default or length preset)
    length = "auto",                      -- "auto" | "words" | "line" | "block" | "file"
    instructions = "",                    -- custom instructions sent with autocomplete requests
    accept = "<Tab>",                     -- accepts a shown suggestion; falls through when none is shown
    accept_word = "<M-Right>",            -- accepts the next word of a shown suggestion
    trigger = "<M-\\>",                   -- asks for a suggestion now
  },
}

local S = {
  conn = nil, session = nil, starting = nil, connecting = nil, ready = false, caps = {}, busy = false,
  modes = {}, mode = nil, model = nil, title = nil, progress = nil, usage = nil, team = nil, commands = {},
  attached = nil, attached_label = nil, last_buf = nil, said = nil, shown = nil,
}

local function note(text, level)
  chat.newline()
  chat.append("> " .. text .. "\n", level == "error" and "LLeMbasError" or level == "warn" and "LLeMbasWarn" or "LLeMbasNote")
end

local function escape_at_path(p)
  return (tostring(p or ""):gsub("([ #])", "\\%1"))
end

local function normalize_file_entry(entry)
  if type(entry) == "string" then
    local clean = entry:gsub("/$", "")
    if clean == "" then return nil end
    return { path = clean, kind = entry:sub(-1) == "/" and "dir" or "file" }
  end
  if type(entry) == "table" and type(entry.path) == "string" and entry.path ~= "" then
    return { path = entry.path:gsub("/$", ""), kind = entry.kind == "dir" and "dir" or "file" }
  end
  return nil
end

local function extract_text_content(content)
  local parts = {}
  for _, c in ipairs(content or {}) do
    if type(c) == "table" then
      if c.type == "content" and type(c.content) == "table" and c.content.type == "text" and type(c.content.text) == "string" then
        parts[#parts + 1] = c.content.text
      elseif c.type == "text" and type(c.text) == "string" then
        parts[#parts + 1] = c.text
      end
    end
  end
  return table.concat(parts, "\n")
end

local function status()
  local top = { "◈ LLeMbas" }
  if S.title and S.title ~= "" then top[#top + 1] = S.title end
  if S.mode then top[#top + 1] = "[" .. S.mode .. "]" end
  if S.model then top[#top + 1] = S.model end
  if S.usage and ((S.usage.input or 0) > 0 or (S.usage.output or 0) > 0) then
    top[#top + 1] = ("↑%s ↓%s"):format(ui.format_tokens(S.usage.input), ui.format_tokens(S.usage.output))
  end
  if S.busy then
    top[#top + 1] = (S.progress and S.progress ~= "" and ("◐ " .. S.progress) or "◐ working")
  end
  chat.header(" " .. table.concat(top, " · "))

  local parts = {}
  if S.attached_label then parts[#parts + 1] = "with " .. S.attached_label end
  if S.mode then parts[#parts + 1] = "mode " .. S.mode end
  if S.model then parts[#parts + 1] = S.model end
  if S.busy then
    parts[#parts + 1] = (S.progress and S.progress ~= "" and (S.progress .. " (Ctrl-C stops)") or "working (Ctrl-C stops)")
  end
  chat.status(" " .. table.concat(parts, " | "))
end

local function reload_files()
  -- The agent writes files itself; a buffer without changes of its own takes the new text.
  pcall(vim.cmd, "silent! checktime")
end

local ICON = { pending = "…", in_progress = "◐", completed = "✓", failed = "✗" }
local PLAN_ICON = { pending = "☐", in_progress = "▸", completed = "✓" }
local tools = {}
local pending_cards = {} -- toolCallId -> { line_id, label }

local function tool_hl(t)
  if t.denied then return "LLeMbasToolDenied" end
  if t.status == "completed" then return "LLeMbasToolDone" end
  if t.status == "failed" then return "LLeMbasToolFail" end
  return "LLeMbasToolPending"
end

local function render_tool_line(t)
  local icon = t.denied and "⊘" or (ICON[t.status] or "…")
  local title = t.title or "tool"
  local show_kind = t.kind and t.kind ~= "" and t.kind ~= "other" and not title:lower():match("^" .. vim.pesc(t.kind:lower()) .. "%f[%W]")
  local tag = show_kind and ("[" .. t.kind .. "] ") or ""
  local suffix = t.denied and " (not allowed)" or ""
  local dur = t.ms and (" · " .. ui.format_ms(t.ms)) or ""
  return ("- %s %s%s%s%s"):format(icon, tag, title, suffix, dur)
end

local function on_update(u)
  local kind = u.sessionUpdate
  if kind == "agent_message_chunk" then
    if S.said ~= "agent" then chat.section("LLeMbas", "LLeMbasAgentHeader"); S.said = "agent" end
    if u.content and u.content.type == "text" then chat.append(u.content.text) end
  elseif kind == "agent_thought_chunk" then
    if M.config.show_thoughts and u.content and u.content.type == "text" then
      if S.said ~= "thought" then chat.section("Thinking", "LLeMbasThoughtHeader"); S.said = "thought" end
      chat.append(u.content.text, "LLeMbasThought")
    end
  elseif kind == "tool_call" or kind == "tool_call_update" then
    local id = tostring(u.toolCallId or "")
    local t = tools[id] or { id = id }
    tools[id] = t
    t.title = u.title or t.title or "tool"
    t.kind = u.kind or t.kind
    t.status = u.status or t.status or "pending"
    if u._meta and u._meta.lembas and u._meta.lembas.denied then t.denied = true end
    local text_out = extract_text_content(u.content)
    if text_out ~= "" then t.output = text_out:sub(1, 20000) end
    chat.line("tool:" .. id, render_tool_line(t), tool_hl(t), t.output)
    S.said = "tool"
    if t.status == "completed" then reload_files() end
  elseif kind == "plan" then
    local entries = u.entries or {}
    local done, all = 0, 0
    local active_task = nil
    for _, e in ipairs(entries) do
      all = all + 1
      if e.status == "completed" then done = done + 1
      elseif e.status == "in_progress" and not active_task then active_task = e.content end
    end
    local structured = (u._meta and u._meta.lembas and u._meta.lembas.plan) or nil
    if all > 0 then
      local title = (structured and structured.title and structured.title ~= "") and (structured.title .. ": ") or "plan: "
      local bar = ui.progress_bar(done, all, 10)
      local tail = active_task and (" — " .. active_task) or ""
      chat.line("plan", ("- %s%s %d of %d tasks done%s"):format(title, bar, done, all, tail), "LLeMbasPlanHeader")
      for idx, e in ipairs(entries) do
        if idx > 16 then break end
        local picon = PLAN_ICON[e.status] or "☐"
        local phl = e.status == "completed" and "LLeMbasPlanDone" or e.status == "in_progress" and "LLeMbasPlanActive" or "LLeMbasPlanPending"
        chat.line("plan:item:" .. idx, ("  %s %s"):format(picon, tostring(e.content or "")), phl)
      end
      S.said = "tool"
    end
  elseif kind == "current_mode_update" then
    S.mode = u.currentModeId or S.mode
    status()
  elseif kind == "available_commands_update" then
    local list = {}
    for _, c in ipairs(u.availableCommands or {}) do
      if type(c) == "table" and type(c.name) == "string" then
        list[#list + 1] = {
          name = c.name,
          description = type(c.description) == "string" and c.description or "",
          hint = (c.input and type(c.input.hint) == "string") and c.input.hint or "",
          kind = (c._meta and c._meta.lembas and type(c._meta.lembas.kind) == "string") and c._meta.lembas.kind or "",
        }
      end
    end
    S.commands = list
  end
end

local function on_permission(p, reply)
  local call = p.toolCall or {}
  local meta = (p._meta or {}).lembas or {}
  local options = p.options or {}
  local call_id = tostring(call.toolCallId or "")
  local line_id = "ask:" .. call_id
  local who = meta.subagent and meta.subagent.name and (" [" .. meta.subagent.name .. "]") or ""
  chat.line(line_id, "- ? " .. (call.title or meta.tool or "a tool") .. who .. " (waits for your answer)", "LLeMbasToolPending")
  pending_cards[call_id] = { line_id = line_id, title = call.title or meta.tool or "a tool" }
  local preview = require("llembas.diff").preview(call.content)
  local prompt = "LLeMbas asks" .. who .. ": " .. (call.title or meta.tool or "a tool")
  if meta.reason then prompt = prompt .. " (" .. meta.reason .. ")" end
  -- The refusals first: the question can open while you are typing, and a digit and Enter meant for
  -- your code must not allow a command. The first choice is always a denial.
  options = vim.list_slice(options)
  table.sort(options, function(x, y)
    local dx, dy = tostring(x.kind):match("^reject") and 0 or 1, tostring(y.kind):match("^reject") and 0 or 1
    return dx < dy
  end)
  pcall(vim.cmd, "stopinsert")
  pcall(vim.cmd, "redraw")
  vim.ui.select(options, {
    prompt = prompt:gsub("[\r\n]+", " "):sub(1, 400),
    format_item = function(o) return o.name or o.optionId end,
  }, function(choice)
    pending_cards[call_id] = nil
    if preview then preview() end
    if not choice then
      chat.line(line_id, "- ✗ " .. (call.title or "a tool") .. " (not answered: denied)", "LLeMbasToolFail")
      return reply({ outcome = { outcome = "cancelled" } })
    end
    local denied = tostring(choice.kind):match("^reject") ~= nil
    chat.line(line_id, ("- %s: %s"):format(choice.name or choice.optionId, call.title or "a tool"), denied and "LLeMbasToolDenied" or "LLeMbasToolDone")
    reply({ outcome = { outcome = "selected", optionId = choice.optionId } })
  end)
end

local function on_question(p, reply)
  local qs = p.questions or {}
  local call_id = tostring(p.toolCallId or "")
  local id = "q:" .. call_id
  chat.line(id, "- ? " .. (p.why or (qs[1] and qs[1].question) or "question") .. " (waits for your answer)", "LLeMbasToolPending")
  pending_cards[call_id] = { line_id = id, title = "question" }
  pcall(vim.cmd, "stopinsert")
  local answers = {}
  local summaries = {}
  local function done_all()
    pending_cards[call_id] = nil
    local summary = table.concat(summaries, " · ")
    chat.line(id, "- ✓ answered question" .. (summary ~= "" and (": " .. summary) or ""), "LLeMbasToolDone")
    return reply({ outcome = "answered", answers = answers })
  end
  local function dismiss_all()
    pending_cards[call_id] = nil
    chat.line(id, "- ✗ question dismissed", "LLeMbasToolDenied")
    return reply({ outcome = "dismissed" })
  end
  local function ask_idx(i)
    if i > #qs then return done_all() end
    local q = qs[i]
    local opts = q.options or {}
    local title_prompt = (q.header and (q.header .. ": ") or "") .. (q.question or "Choose")
    if #opts > 0 and q.multiple then
      local picked = {}
      local function pick_multi()
        local choices = {}
        for _, o in ipairs(opts) do
          choices[#choices + 1] = { label = o.label, description = o.description, recommended = o.recommended, _opt = true }
        end
        choices[#choices + 1] = { label = "__done__", _done = true }
        choices[#choices + 1] = { label = "__custom__", _custom = true }
        choices[#choices + 1] = { label = "__skip__", _skip = true }
        vim.ui.select(choices, {
          prompt = title_prompt .. " (select one or more, then Done)",
          format_item = function(o)
            if o._done then
              local n = #picked
              return n > 0 and ("Done (" .. n .. " selected)") or "Done (skip)"
            end
            if o._custom then return "Type a custom answer…" end
            if o._skip then return "Skip this question" end
            local mark = vim.tbl_contains(picked, o.label) and "[✓] " or "[ ] "
            local star = o.recommended and " ★" or ""
            return mark .. o.label .. star .. (o.description and o.description ~= "" and (" — " .. o.description) or "")
          end,
        }, function(choice)
          if not choice then return dismiss_all() end
          if choice._skip then
            answers[i] = { kind = "skipped" }
            summaries[#summaries + 1] = "skipped"
            return ask_idx(i + 1)
          end
          if choice._done then
            if #picked > 0 then
              answers[i] = { kind = "options", labels = picked }
              summaries[#summaries + 1] = table.concat(picked, ", ")
            else
              answers[i] = { kind = "skipped" }
            end
            return ask_idx(i + 1)
          end
          if choice._custom then
            return vim.ui.input({ prompt = (q.question or "Answer") .. ": " }, function(text)
              if not text or not text:match("%S") then return dismiss_all() end
              answers[i] = { kind = "custom", text = vim.trim(text) }
              summaries[#summaries + 1] = vim.trim(text)
              ask_idx(i + 1)
            end)
          end
          local idx = nil
          for k, v in ipairs(picked) do if v == choice.label then idx = k break end end
          if idx then table.remove(picked, idx) else picked[#picked + 1] = choice.label end
          pick_multi()
        end)
      end
      pick_multi()
    elseif #opts > 0 then
      local choices = {}
      for _, o in ipairs(opts) do choices[#choices + 1] = o end
      choices[#choices + 1] = { label = "__custom__", _custom = true }
      choices[#choices + 1] = { label = "__skip__", _skip = true }
      vim.ui.select(choices, {
        prompt = title_prompt,
        format_item = function(o)
          if o._custom then return "Type a custom answer…" end
          if o._skip then return "Skip this question" end
          local star = o.recommended and " ★" or ""
          return o.label .. star .. (o.description and o.description ~= "" and (" — " .. o.description) or "")
        end,
      }, function(choice)
        if not choice then return dismiss_all() end
        if choice._skip then
          answers[i] = { kind = "skipped" }
          summaries[#summaries + 1] = "skipped"
          return ask_idx(i + 1)
        end
        if choice._custom then
          vim.ui.input({ prompt = (q.question or "Answer") .. ": " }, function(text)
            if not text or not text:match("%S") then return dismiss_all() end
            answers[i] = { kind = "custom", text = vim.trim(text) }
            summaries[#summaries + 1] = vim.trim(text)
            ask_idx(i + 1)
          end)
        else
          answers[i] = { kind = "options", labels = { choice.label } }
          summaries[#summaries + 1] = choice.label
          ask_idx(i + 1)
        end
      end)
    else
      vim.ui.input({ prompt = (q.question or "Answer") .. ": " }, function(text)
        if not text then return dismiss_all() end
        if not text:match("%S") then
          answers[i] = { kind = "skipped" }
        else
          answers[i] = { kind = "custom", text = vim.trim(text) }
          summaries[#summaries + 1] = vim.trim(text)
        end
        ask_idx(i + 1)
      end)
    end
  end
  ask_idx(1)
end

local function on_plan(p, reply)
  local title = (p.plan and p.plan.title) or "Plan ready"
  local call_id = tostring(p.toolCallId or "")
  local id = "plan:" .. call_id
  chat.section("Plan: " .. title, "LLeMbasPlanHeader")
  if type(p.text) == "string" and p.text ~= "" then chat.append(p.text .. "\n") end
  chat.line(id, "- ? " .. title .. " (waits for approval)", "LLeMbasToolPending")
  pending_cards[call_id] = { line_id = id, title = title }
  pcall(vim.cmd, "stopinsert")
  local actions = {
    { id = "dismiss", label = "Dismiss" },
    { id = "approve_edit", label = "Approve (edit mode)" },
    { id = "approve_manual", label = "Approve (manual mode)" },
    { id = "revise", label = "Revise with feedback" },
  }
  vim.ui.select(actions, {
    prompt = "LLeMbas plan: " .. title,
    format_item = function(a) return a.label end,
  }, function(choice)
    pending_cards[call_id] = nil
    if not choice or choice.id == "dismiss" then
      chat.line(id, "- ✗ plan dismissed", "LLeMbasToolDenied")
      return reply({ outcome = "dismissed" })
    end
    if choice.id == "approve_edit" then
      chat.line(id, "- ✓ plan approved (edit mode)", "LLeMbasToolDone")
      return reply({ outcome = "approve", mode = "edit" })
    end
    if choice.id == "approve_manual" then
      chat.line(id, "- ✓ plan approved (manual mode)", "LLeMbasToolDone")
      return reply({ outcome = "approve", mode = "manual" })
    end
    vim.ui.input({ prompt = "Plan revision feedback: " }, function(fb)
      if not fb or not fb:match("%S") then
        chat.line(id, "- ✗ plan dismissed", "LLeMbasToolDenied")
        return reply({ outcome = "dismissed" })
      end
      chat.line(id, "- ↻ plan revision requested", "LLeMbasPlanActive")
      reply({ outcome = "revise", feedback = vim.trim(fb) })
    end)
  end)
end

local function stopped(code, stderr)
  local was = S.session ~= nil or S.starting ~= nil
  local waiting = S.starting
  local connecting = S.connecting
  S.conn, S.session, S.starting, S.connecting, S.ready, S.busy = nil, nil, nil, nil, false, false
  S.progress, S.team = nil, nil
  pending_cards = {}
  for _, cb in ipairs(connecting or {}) do cb(false) end
  if was then
    local last = ""
    for line in (stderr or ""):gmatch("[^\r\n]+") do if line:match("%S") then last = line end end
    note(("The agent stopped (exit %s)%s"):format(tostring(code), last ~= "" and (": " .. last) or "."), "error")
  end
  for _, cb in ipairs(waiting or {}) do cb(false) end
  status()
end

--- Have a running agent that has answered `initialize`, then call `cb(true)`; `cb(false)` when not.
--- `quiet`: a failure is not written into the chat (completion asks often and must not nag).
local function connect(cb, quiet)
  if S.conn and S.ready then return cb(true) end
  if S.connecting then S.connecting[#S.connecting + 1] = cb; return end
  S.connecting = { cb }
  local function done(ok)
    local waiting = S.connecting or {}
    S.connecting = nil
    for _, f in ipairs(waiting) do f(ok) end
  end
  local me = {}
  local conn, err = rpc.start(M.config.cmd, {
    notify = function(method, params)
      if method == "session/update" and params.sessionId == S.session then on_update(params.update or {})
      elseif method == "_lembas/edit/delta" then require("llembas.diff").delta(params)
      elseif method == "_lembas/permission/settled" then
        local cid = tostring(params.toolCallId or "")
        local card = pending_cards[cid]
        if card then
          pending_cards[cid] = nil
          chat.line(card.line_id, "- ⊘ " .. card.title .. " (answered elsewhere or expired)", "LLeMbasNote")
        end
      elseif method == "_lembas/event" and params.sessionId == S.session and params.event then
        local ev = params.event
        if ev.type == "model" and type(ev.ref) == "string" then S.model = ev.ref; status()
        elseif ev.type == "mode" and type(ev.mode) == "string" then S.mode = ev.mode; status()
        elseif ev.type == "title" and type(ev.title) == "string" then S.title = ev.title; status()
        elseif ev.type == "phase" then
          local pr = ev.progress
          S.progress = (pr and type(pr.phase) == "string") and (pr.phase:gsub("_", " ") .. (pr.detail and (": " .. pr.detail) or "")) or nil
          status()
        elseif ev.type == "usage" then
          local inp = tonumber(ev.input_tokens or ev.input or ev.tokens_in) or 0
          local outp = tonumber(ev.output_tokens or ev.output or ev.tokens_out) or 0
          if inp > 0 or outp > 0 then
            S.usage = { input = ((S.usage and S.usage.input) or 0) + inp, output = ((S.usage and S.usage.output) or 0) + outp }
            status()
          end
        elseif ev.type == "tool_end" and type(ev.id) == "string" and tonumber(ev.ms) then
          local t = tools[ev.id]
          if t then
            t.ms = tonumber(ev.ms)
            chat.line("tool:" .. ev.id, render_tool_line(t), tool_hl(t), t.output)
          end
        elseif ev.type == "notice" and type(ev.message) == "string" and ev.message:match("%S") then
          note(ev.message, ev.level)
        elseif ev.type == "compacted" and type(ev.summary) == "string" and ev.summary:match("%S") then
          note("Context compacted: " .. ev.summary)
        elseif ev.type == "team" then
          S.team = ev.tree
          status()
        end
      end
    end,
    request = function(method, params, reply)
      if method == "session/request_permission" then return on_permission(params, reply) end
      if method == "_lembas/question" then return on_question(params, reply) end
      if method == "_lembas/plan" then return on_plan(params, reply) end
      if method == "fs/read_text_file" then return require("llembas.context").read_for_agent(params, reply) end
      if method == "_lembas/show" then return M._show(params, reply) end
      if method == "fs/write_text_file" then return require("llembas.context").write_for_agent(params, reply) end
      reply(nil, { code = -32601, message = "Method not found: " .. method })
    end,
    -- Only the agent in use: one that was replaced (a new session) ends later and must not undo its successor.
    exit = function(code, stderr) if S.conn == me.conn then stopped(code, stderr) end end,
  }, { cwd = vim.fn.getcwd() })
  if not conn then
    if not quiet then note(("Could not start %s: %s"):format(M.config.cmd[1], err), "error") end
    S.start_error = ("could not start %s: %s"):format(M.config.cmd[1], err)
    return done(false)
  end
  me.conn = conn
  S.conn, S.ready, S.start_error = conn, false, nil
  conn:request("initialize", {
    protocolVersion = 1,
    clientCapabilities = { fs = { readTextFile = true, writeTextFile = true },
      _meta = { lembas = { protocol = 2, editor = true, show = true, media = true } } },
    clientInfo = { name = "llembas.nvim", version = M.version },
  }, function(e1, r)
    if S.conn ~= conn then return done(false) end
    if e1 then
      if not quiet then note("The agent refused to start: " .. tostring(e1.message), "error") end
      S.conn = nil
      conn:stop()
      return done(false)
    end
    S.ready = true
    S.caps = {}
    for _, c in ipairs((((r or {})._meta or {}).lembas or {}).capabilities or {}) do S.caps[c] = true end
    require("llembas.complete").warm(S.last_buf)
    done(true)
  end)
end

--- Have a running agent and an open session, then call `cb(true)`; `cb(false)` when that failed.
local function ensure(cb)
  if S.session then return cb(true) end
  if S.starting then S.starting[#S.starting + 1] = cb; return end
  S.starting = { cb }
  local function finish(ok)
    local waiting = S.starting or {}
    S.starting = nil
    for _, f in ipairs(waiting) do f(ok) end
  end
  connect(function(ok)
    if not ok then return finish(false) end
    local conn = S.conn
    local meta = {}
    if M.config.mode then meta.mode = M.config.mode end
    if M.config.model then meta.model = M.config.model end
    conn:request("session/new", { cwd = vim.fn.getcwd(), mcpServers = {}, _meta = meta }, function(e2, r)
      if S.conn ~= conn then return finish(false) end
      if e2 then
        note("No session: " .. tostring(e2.message), "error")
        return finish(false)
      end
      S.session = r.sessionId
      S.modes = (r.modes and r.modes.availableModes) or {}
      local lm = (r._meta or {}).lembas or {}
      S.mode = (r.modes and r.modes.currentModeId) or lm.mode
      S.model = lm.model
      status()
      finish(true)
    end)
  end)
end

--- Send `blocks` as a prompt; `shown` is what the transcript says you wrote.
local function send(blocks, shown, meta)
  chat.section("You", "LLeMbasUserHeader")
  chat.append(shown .. "\n")
  S.said = "you"
  S.busy = true
  S.progress = nil
  status()
  ensure(function(ok)
    if not ok then S.busy = false; status(); return end
    S.conn:request("session/prompt", { sessionId = S.session, prompt = blocks, _meta = meta }, function(err, r)
      S.busy = false
      S.progress = nil
      if err then note("The turn failed: " .. tostring(err.message), "error")
      else
        local lm = (r and r._meta and r._meta.lembas) or {}
        if type(lm.message) == "string" and lm.message ~= "" then note(lm.message) end
        if type(lm.summary) == "string" and lm.summary ~= "" then note("Compacted: " .. lm.summary) end
        if r and r.stopReason and r.stopReason ~= "end_turn" then note("The turn ended: " .. r.stopReason) end
      end
      chat.newline()
      reload_files()
      status()
    end)
  end)
  return true
end

local function editing_buf()
  local b = vim.api.nvim_get_current_buf()
  if vim.bo[b].buftype == "" then return b end
  if S.last_buf and vim.api.nvim_buf_is_valid(S.last_buf) then return S.last_buf end
end

--- A prompt typed in the panel: with what was attached, or else the name of the open file. An agent
--- that takes the editor's context as data (`editor`) gets it so; an older one is told in a sentence.
local function send_typed(text)
  if S.busy then
    if S.conn and S.session and S.caps.steer then
      chat.section("You (while working)", "LLeMbasUserHeader")
      chat.append(text .. "\n")
      S.conn:request("_lembas/steer", { sessionId = S.session, text = text }, function(err)
        if err then note("Steer failed: " .. tostring(err.message), "error") end
      end)
      return true
    end
    vim.notify("LLeMbas is still working on the last message (:LLeMbasStop stops it)", vim.log.levels.WARN)
    return false
  end
  local attached, label = S.attached, S.attached_label
  S.attached, S.attached_label = nil, nil
  S.busy = true
  connect(function()
    local blocks, shown, meta = {}, text, nil
    if attached then
      shown = ("[%s]\n%s"):format(label, text)
      if S.caps.editor and attached.editor then meta = { lembas = { editor = attached.editor } }
      else vim.list_extend(blocks, attached.blocks) end
    elseif M.config.send_open_file and not text:match("^/") then
      local b = editing_buf()
      if b and S.caps.editor then
        local e = context.editor(b)
        if e then meta = { lembas = { editor = e } } end
      else
        local f = b and context.file(b)
        if f then blocks[#blocks + 1] = f end
      end
    end
    blocks[#blocks + 1] = { type = "text", text = text }
    send(blocks, shown, meta)
  end, true)
  status()
end

local function label(buf, first, last)
  local name = vim.api.nvim_buf_get_name(buf)
  return ("%s:%d-%d"):format(name ~= "" and vim.fn.fnamemodify(name, ":.") or "buffer", first, last)
end

function M.open(focus)
  ui.setup_highlights()
  local b = vim.api.nvim_get_current_buf()
  if vim.bo[b].buftype == "" then S.last_buf = b end
  chat.on_send = send_typed
  chat.on_stop = M.stop
  chat.on_help = M.help
  chat.on_files = function() M.files("", false) end
  chat.on_commands = M.commands
  chat.open({
    width = M.config.width,
    position = M.config.position,
    prompt_height = M.config.prompt_height,
    border = M.config.border,
  }, focus)
  status()
end

function M.toggle()
  if chat.is_open() then chat.close() else M.open() end
end

--- Ask about lines `first..last` of the current buffer. With `question` it is sent at once; without,
--- the lines are attached to the next message you type.
function M.ask(first, last, question)
  local buf = vim.api.nvim_get_current_buf()
  local what = label(buf, first, last)
  S.attached = { blocks = context.selection(buf, first, last), editor = context.editor(buf, first, last) }
  S.attached_label = what
  if question and question:match("%S") then
    M.open(false)
    send_typed(question)
  else
    M.open(true)
  end
end

--- Have lines `first..last` rewritten as `instruction` says. The agent changes the file itself, under
--- its own permissions, so the buffer has to be saved first when using an older CLI.
function M.edit(first, last, instruction)
  local buf = vim.api.nvim_get_current_buf()
  if vim.api.nvim_buf_get_name(buf) == "" or vim.bo[buf].buftype ~= "" then
    return vim.notify("LLeMbas: this buffer is not a file", vim.log.levels.WARN)
  end
  if not instruction or not instruction:match("%S") then
    return vim.ui.input({ prompt = "Rewrite the selection: " }, function(text)
      if text and text:match("%S") then M.edit(first, last, text) end
    end)
  end
  if not S.ready then
    -- Which way a rewrite goes depends on what the agent can do, known once it has started.
    return connect(function(ok) if ok then M.edit(first, last, instruction) end end)
  end
  if S.caps.editor then return require("llembas.diff").rewrite(buf, first, last, instruction) end
  if vim.bo[buf].modified then
    return vim.notify("LLeMbas: save the file first (this LLeMbas CLI edits the file on disk)", vim.log.levels.WARN)
  end
  if S.busy then
    return vim.notify("LLeMbas is still working on the last message (:LLeMbasStop stops it)", vim.log.levels.WARN)
  end
  local blocks = context.selection(buf, first, last)
  blocks[#blocks + 1] = { type = "text", text =
    "Rewrite exactly those lines of that file as asked below. Change nothing outside them unless the request "
    .. "cannot work otherwise, and then say what else you changed. Answer with one or two sentences, not with the code.\n\n"
    .. instruction }
  M.open(false)
  send(blocks, ("[rewrite %s]\n%s"):format(label(buf, first, last), instruction))
end

--- Generate code at the current cursor line using `_lembas/edit`.
function M.generate(instruction)
  local buf = vim.api.nvim_get_current_buf()
  if vim.bo[buf].buftype ~= "" or not vim.bo[buf].modifiable then
    return vim.notify("LLeMbas: open an editable buffer first", vim.log.levels.WARN)
  end
  if not instruction or not instruction:match("%S") then
    return vim.ui.input({ prompt = "Generate code at cursor: " }, function(text)
      if text and text:match("%S") then M.generate(text) end
    end)
  end
  if not S.ready then
    return connect(function(ok) if ok then M.generate(instruction) end end)
  end
  if not S.caps.editor then
    return vim.notify("LLeMbas: this LLeMbas CLI does not support inline generation yet", vim.log.levels.WARN)
  end
  local row = vim.api.nvim_win_get_cursor(0)[1]
  require("llembas.diff").generate(buf, row, instruction)
end

function M.stop()
  if S.conn and S.session and S.busy then S.conn:notify("session/cancel", { sessionId = S.session }) end
end

--- A new session; the old one stays in the CLI's store.
function M.new(force)
  if S.busy and not force then
    return vim.notify("LLeMbas is working; stop it first (:LLeMbasStop), or :LLeMbasNew! to end the agent", vim.log.levels.WARN)
  end
  S.busy = false
  local conn = S.conn
  S.conn, S.session, S.starting, S.connecting, S.ready, S.said = nil, nil, nil, nil, false, nil
  S.title, S.progress, S.usage, S.team, S.commands = nil, nil, nil, nil, {}
  S.attached, S.attached_label, S.shown = nil, nil, nil
  tools = {}
  pending_cards = {}
  if conn then conn:stop() end
  chat.clear()
  M.open()
end

function M.compact()
  if S.busy then return vim.notify("LLeMbas is working; wait for the turn to finish", vim.log.levels.WARN) end
  if not S.session or not S.conn then return vim.notify("LLeMbas: no active session to compact", vim.log.levels.INFO) end
  S.conn:request("_lembas/session/compact", { sessionId = S.session }, function(err, r)
    if err then return vim.notify("LLeMbas: " .. tostring(err.message), vim.log.levels.ERROR) end
    local summary = r and type(r.summary) == "string" and r.summary or ""
    note(summary ~= "" and ("Session compacted: " .. summary) or "Session compacted.")
  end)
end

function M.mode(id)
  ensure(function(ok)
    if not ok then return end
    local function set(mode)
      S.conn:request("session/set_mode", { sessionId = S.session, modeId = mode }, function(err)
        if err then return vim.notify("LLeMbas: " .. tostring(err.message), vim.log.levels.ERROR) end
        S.mode = mode
        status()
      end)
    end
    if id and id ~= "" then return set(id) end
    vim.ui.select(S.modes, { prompt = "LLeMbas mode", format_item = function(m) return m.name or m.id end },
      function(m) if m then set(m.id) end end)
  end)
end

--- Search the project file index (`_lembas/files/search`) and either open a file or insert `@path` into chat.
function M.files(query, open_directly)
  ensure(function(ok)
    if not ok then return end
    local function pick_from(raw_list)
      local list = {}
      for _, item in ipairs(raw_list or {}) do
        local norm = normalize_file_entry(item)
        if norm and (not open_directly or norm.kind ~= "dir") then list[#list + 1] = norm end
      end
      if #list == 0 then return vim.notify("LLeMbas: no matching files found", vim.log.levels.INFO) end
      vim.ui.select(list, {
        prompt = open_directly and "LLeMbas open file" or "LLeMbas attach file to chat",
        format_item = function(f) return (f.kind == "dir" and "[dir]  " or "[file] ") .. f.path .. (f.kind == "dir" and "/" or "") end,
      }, function(entry)
        if not entry then return end
        if open_directly then
          local full = entry.path:match("^/") and entry.path or (vim.fn.getcwd() .. "/" .. entry.path)
          local target
          for _, w in ipairs(vim.api.nvim_tabpage_list_wins(0)) do
            if vim.bo[vim.api.nvim_win_get_buf(w)].buftype == "" then target = w break end
          end
          if target then vim.api.nvim_set_current_win(target) end
          pcall(vim.cmd, "edit " .. vim.fn.fnameescape(full))
        else
          M.open(true)
          local ref = escape_at_path(entry.path) .. (entry.kind == "dir" and "/" or "")
          chat.insert_prompt("@" .. ref .. " ")
        end
      end)
    end
    if S.caps.files then
      S.conn:request("_lembas/files/search", { sessionId = S.session, query = query or "", limit = 50 }, function(err, r)
        if err then return vim.notify("LLeMbas: " .. tostring(err.message), vim.log.levels.ERROR) end
        pick_from(r and r.files or {})
      end)
    else
      local found = vim.fn.glob("**/*", false, true)
      local out = {}
      local q = (query or ""):lower()
      for _, f in ipairs(found) do
        if vim.fn.isdirectory(f) == 0 and (q == "" or f:lower():find(q, 1, true)) then
          out[#out + 1] = { path = f, kind = "file" }
          if #out >= 50 then break end
        end
      end
      pick_from(out)
    end
  end)
end

--- Pick a session slash command (`/compact`, `/review`, skills, etc.) and insert it into the prompt.
function M.commands()
  ensure(function(ok)
    if not ok then return end
    local function pick_cmd(list)
      if not list or #list == 0 then return vim.notify("LLeMbas: no slash commands available", vim.log.levels.INFO) end
      vim.ui.select(list, {
        prompt = "LLeMbas command",
        format_item = function(c)
          local tag = (c.kind and c.kind ~= "") and ("[" .. c.kind .. "] ") or ""
          local desc = (c.description and c.description ~= "") and (" — " .. c.description) or ""
          return tag .. "/" .. c.name .. desc
        end,
      }, function(chosen)
        if not chosen then return end
        M.open(true)
        chat.insert_prompt("/" .. chosen.name .. " ")
      end)
    end
    if #S.commands > 0 then return pick_cmd(S.commands) end
    if S.caps.commands then
      S.conn:request("_lembas/commands", { sessionId = S.session }, function(err, r)
        if err then return vim.notify("LLeMbas: " .. tostring(err.message), vim.log.levels.ERROR) end
        local out = {}
        for _, c in ipairs((r and r.commands) or {}) do
          if type(c) == "table" and type(c.name) == "string" then
            out[#out + 1] = {
              name = c.name,
              description = type(c.description) == "string" and c.description or "",
              kind = (c._meta and c._meta.lembas and type(c._meta.lembas.kind) == "string") and c._meta.lembas.kind or (c.source or ""),
            }
          end
        end
        S.commands = out
        pick_cmd(out)
      end)
    else
      vim.notify("LLeMbas: this CLI does not list slash commands", vim.log.levels.INFO)
    end
  end)
end

--- List previous sessions in this project and resume one with its history (`_lembas/sessions/list` & `resume`).
function M.sessions()
  if S.busy then return vim.notify("LLeMbas is working; stop it first (:LLeMbasStop)", vim.log.levels.WARN) end
  connect(function(ok)
    if not ok then return end
    S.conn:request("_lembas/sessions/list", { cwd = vim.fn.getcwd(), limit = 40 }, function(err, r)
      if err then return vim.notify("LLeMbas: " .. tostring(err.message), vim.log.levels.ERROR) end
      local list = (r and r.sessions) or {}
      if #list == 0 then return vim.notify("LLeMbas: no previous sessions in this directory", vim.log.levels.INFO) end
      vim.ui.select(list, {
        prompt = "LLeMbas resume session",
        format_item = function(s) return (s.title or s.id) .. (s.model and ("  (" .. s.model .. ")") or "") end,
      }, function(chosen)
        if not chosen then return end
        S.conn:request("_lembas/sessions/resume", { sessionId = chosen.id }, function(e2, res)
          if e2 then return vim.notify("LLeMbas: " .. tostring(e2.message), vim.log.levels.ERROR) end
          S.session = res.sessionId
          S.title = type(res.title) == "string" and res.title or chosen.title
          S.modes = (res.modes and res.modes.availableModes) or S.modes
          local lm = (res._meta or {}).lembas or {}
          S.mode = (res.modes and res.modes.currentModeId) or lm.mode or S.mode
          S.model = lm.model or S.model
          S.progress, S.usage, S.team = nil, nil, nil
          tools = {}
          pending_cards = {}
          chat.clear()
          M.open(false)
          for _, turn in ipairs(res.turns or {}) do
            if type(turn) == "table" then
              if turn.role == "user" then
                local u_text = type(turn.text) == "string" and turn.text or ""
                if u_text ~= "" then
                  chat.section(turn.machine and "Harness" or "You", "LLeMbasUserHeader")
                  chat.append(u_text .. "\n")
                end
              elseif turn.role == "assistant" then
                if M.config.show_thoughts and type(turn.reasoning) == "string" and turn.reasoning ~= "" then
                  chat.section("Thinking", "LLeMbasThoughtHeader")
                  chat.append(turn.reasoning .. "\n", "LLeMbasThought")
                end
                for _, t in ipairs(turn.tools or {}) do
                  local tid = tostring(t.id or ("h" .. tostring(#tools + 1)))
                  local entry = { id = tid, title = t.title or t.name or "tool", status = t.isError and "failed" or "completed", output = type(t.output) == "string" and t.output or nil }
                  tools[tid] = entry
                  chat.line("hist:" .. tid, render_tool_line(entry), tool_hl(entry), entry.output)
                end
                if type(turn.text) == "string" and turn.text ~= "" then
                  chat.section("LLeMbas", "LLeMbasAgentHeader")
                  chat.append(turn.text .. "\n")
                end
              else
                -- Legacy combined shape fallback
                if type(turn.user) == "string" and turn.user ~= "" then
                  chat.section("You", "LLeMbasUserHeader")
                  chat.append(turn.user .. "\n")
                end
                for _, t in ipairs(turn.tools or {}) do
                  chat.line("hist:" .. tostring(t.id or ""), ("- %s %s"):format(t.isError and "✗" or "✓", t.title or t.name or "tool"), t.isError and "LLeMbasToolFail" or "LLeMbasToolDone")
                end
                if type(turn.assistant) == "string" and turn.assistant ~= "" then
                  chat.section("LLeMbas", "LLeMbasAgentHeader")
                  chat.append(turn.assistant .. "\n")
                end
              end
            end
          end
          S.said = nil
          status()
        end)
      end)
    end)
  end)
end

--- Explain the selected lines concisely in the chat panel.
function M.explain(first, last)
  M.ask(first, last, "Explain the selected code concisely, including any subtle behavior or edge cases.")
end

--- Send the current buffer's diagnostics to the agent to fix.
function M.fix()
  local buf = editing_buf()
  if not buf then return vim.notify("LLeMbas: open a file first", vim.log.levels.WARN) end
  local diags = vim.diagnostic.get(buf)
  if #diags == 0 then return vim.notify("LLeMbas: no diagnostics reported in this buffer", vim.log.levels.INFO) end
  S.last_buf = buf
  local editor = context.editor(buf)
  local blocks = { context.file(buf) }
  local dtext = context.diagnostics(buf)
  if dtext then blocks[#blocks + 1] = { type = "text", text = dtext } end
  S.attached = { blocks = blocks, editor = editor }
  S.attached_label = vim.fn.fnamemodify(vim.api.nvim_buf_get_name(buf), ":.") .. " (" .. #diags .. " diagnostics)"
  M.open(false)
  send_typed("Fix the reported diagnostics in this file.")
end

function M.toggle_thoughts()
  M.config.show_thoughts = not M.config.show_thoughts
  vim.notify("LLeMbas: show thinking is " .. (M.config.show_thoughts and "on" or "off"), vim.log.levels.INFO)
end

local function settings(set, cb)
  connect(function(ok)
    if not ok then return end
    if not S.caps.editor then return vim.notify("LLeMbas: this LLeMbas CLI has no editor settings yet", vim.log.levels.WARN) end
    S.conn:request("_lembas/editor/settings", set and { set = set } or vim.empty_dict(), function(err, r)
      if err then return vim.notify("LLeMbas: " .. tostring(err.message), vim.log.levels.ERROR) end
      cb(r or {})
    end)
  end)
end

local function pick(which, cb)
  connect(function(ok)
    if not ok then return end
    if not S.caps.editor then return vim.notify("LLeMbas: this LLeMbas CLI does not list models yet", vim.log.levels.WARN) end
    S.conn:request("_lembas/models", vim.empty_dict(), function(err, r)
      if err then return vim.notify("LLeMbas: " .. tostring(err.message), vim.log.levels.ERROR) end
      local items = {}
      for _, m in ipairs((r or {}).models or {}) do
        if vim.tbl_contains(m["for"] or { "main" }, which) then items[#items + 1] = m end
      end
      vim.ui.select(items, { prompt = "LLeMbas " .. which .. " model",
        format_item = function(m) return m.name and m.name ~= m.id and (m.name .. "  (" .. m.id .. ")") or m.id end },
        function(m) if m then cb(m.id) end end)
    end)
  end)
end

function M.model(name)
  local function set(id)
    ensure(function(ok)
      if not ok then return end
      S.conn:request("_lembas/configure", { sessionId = S.session, model = id }, function(err, r)
        if err then return vim.notify("LLeMbas: " .. tostring(err.message), vim.log.levels.ERROR) end
        S.model = (r and r.model) or id
        status()
      end)
    end)
  end
  if name and name ~= "" then return set(name) end
  if S.ready and S.caps.editor then return pick("main", set) end
  vim.notify("LLeMbas: model " .. (S.model or "not known yet"), vim.log.levels.INFO)
end

--- The agent shows a file (the `show` tool). The agent runs on this machine, so the file is opened
--- from where it is: text in the window you edit in, anything else named in the chat and opened by
--- the system's own viewer on request. Nothing here is rendered or run.
function M._show(p, reply)
  local path = p.uri and vim.uri_to_fname(p.uri) or p.path
  local target
  for _, w in ipairs(vim.api.nvim_tabpage_list_wins(0)) do
    if vim.bo[vim.api.nvim_win_get_buf(w)].buftype == "" then target = w break end
  end
  if type(path) == "string" and path ~= "" then
    if not path:match("^/") then path = vim.fn.getcwd() .. "/" .. path end
  end
  if (not path or path == "" or vim.fn.filereadable(path) == 0) and type(p.text) == "string" then
    local b = vim.api.nvim_create_buf(false, true)
    vim.bo[b].buftype = "nofile"
    vim.bo[b].bufhidden = "wipe"
    vim.bo[b].swapfile = false
    vim.bo[b].modeline = false
    vim.api.nvim_buf_set_lines(b, 0, -1, false, vim.split(p.text, "\n", { plain = true }))
    if type(p.language) == "string" and p.language ~= "" then pcall(function() vim.bo[b].filetype = p.language end) end
    vim.bo[b].modifiable = false
    if target then vim.api.nvim_win_set_buf(target, b) end
    chat.line("show:" .. tostring(p.toolCallId), "- shown: " .. tostring(p.path or "text"), "LLeMbasNote")
    S.said = "tool"
    return reply({ shown = true })
  end
  if type(path) ~= "string" or path == "" then return reply({ shown = false, reason = "no path" }) end
  if vim.fn.filereadable(path) == 0 then return reply({ shown = false, reason = "the editor cannot read that file" }) end
  local texty = ({ markdown = true, code = true, text = true, html = true, table = true, svg = true, notebook = true })[p.kind or ""]
  S.shown = path
  local rel = vim.fn.fnamemodify(path, ":.")
  if texty then
    if target then
      vim.api.nvim_win_call(target, function()
        pcall(vim.cmd, "keepalt edit " .. vim.fn.fnameescape(path))
        if tonumber(p.line) then pcall(vim.api.nvim_win_set_cursor, 0, { tonumber(p.line), 0 }) end
      end)
    end
    chat.line("show:" .. tostring(p.toolCallId), "- shown: " .. rel, "LLeMbasNote")
  else
    chat.line("show:" .. tostring(p.toolCallId), ("- shown: %s (%s) — :LLeMbasOpen opens it"):format(rel, tostring(p.kind or "file")), "LLeMbasNote")
  end
  S.said = "tool"
  reply({ shown = true })
end

--- Open the file the agent showed last with the system's viewer.
-- What the system's viewer is given: files that are only looked at or listened to. Anything else
-- (a script, a page, a shortcut, a document that can carry macros) is named and left alone.
local VIEWED = {}
for _, e in ipairs({ "png", "jpg", "jpeg", "gif", "webp", "avif", "bmp", "pdf", "mp3", "wav", "ogg", "oga", "flac", "m4a",
  "mp4", "webm", "mkv", "mov", "glb", "gltf", "obj", "stl", "csv", "tsv", "txt" }) do VIEWED[e] = true end

function M.open_shown()
  if not S.shown then return vim.notify("LLeMbas: nothing has been shown yet", vim.log.levels.INFO) end
  local ext = (S.shown:match("%.([%w]+)$") or ""):lower()
  if not VIEWED[ext] then
    return vim.notify("LLeMbas: not opened, since a file of that kind may run: " .. S.shown, vim.log.levels.WARN)
  end
  vim.ui.open(S.shown)
end

local function said(r)
  local a, m = r.autocomplete or {}, r.main or {}
  vim.notify(("LLeMbas: autocomplete %s%s; main %s"):format(a.model or "not chosen",
    a.source and (" (" .. a.source .. ")") or "", m.model or "as a session starts"), vim.log.levels.INFO)
end

--- The model that writes suggestions. No name: pick from the list. `quick`: for this editor only,
--- not saved; "-" goes back to the saved choice (quick) or to the instance's default (saved).
function M.autocomplete_model(name, quick)
  local function set(id)
    local complete = require("llembas.complete")
    if quick then
      M.config.complete.model = id ~= "-" and id or nil
      complete.reset()
      return vim.notify("LLeMbas: autocomplete here uses " .. (M.config.complete.model or "your saved choice"), vim.log.levels.INFO)
    end
    settings({ autocomplete_model = id ~= "-" and id or vim.NIL }, function(r) complete.reset(); said(r) end)
  end
  if name and name ~= "" then return set(name) end
  pick("autocomplete", set)
end

--- The model for chat, rewriting and generating, saved in your account.
function M.main_model(name)
  local function set(id) settings({ main_model = id ~= "-" and id or vim.NIL }, said) end
  if name == "?" then return settings(nil, said) end
  if name and name ~= "" then return set(name) end
  pick("main", set)
end

--- Configure autocomplete max tokens & length scope preset interactively or by argument.
function M.autocomplete_tokens(arg)
  local complete = require("llembas.complete")
  local presets = {
    { id = "auto", tokens = 0, label = "Server default (auto)" },
    { id = "words", tokens = 24, label = "Few words — ~24 tokens (current expression)" },
    { id = "line", tokens = 64, label = "Single line — ~64 tokens (finish current line)" },
    { id = "block", tokens = 256, label = "Function / block — ~256 tokens" },
    { id = "file", tokens = 2048, label = "Large / full file — ~2048 tokens" },
    { id = "custom", tokens = nil, label = "Custom max tokens number…" },
  }
  local function apply(length, tokens)
    if length then M.config.complete.length = length end
    M.config.complete.max_tokens = (tokens and tokens > 0) and math.min(4096, math.floor(tokens)) or nil
    complete.reset()
    vim.notify(("LLeMbas: autocomplete scope=%s, max_tokens=%s"):format(
      M.config.complete.length or "auto",
      M.config.complete.max_tokens and tostring(M.config.complete.max_tokens) or "default"), vim.log.levels.INFO)
  end
  if arg and arg ~= "" then
    local n = tonumber(arg)
    if n then return apply(nil, n) end
    for _, p in ipairs(presets) do
      if p.id == arg and p.id ~= "custom" then return apply(p.id, p.tokens) end
    end
    return vim.notify("LLeMbas: use a number (0..4096) or auto|words|line|block|file", vim.log.levels.WARN)
  end
  vim.ui.select(presets, {
    prompt = ("LLeMbas autocomplete length (now: %s, %s tokens)"):format(
      M.config.complete.length or "auto", M.config.complete.max_tokens or "default"),
    format_item = function(p) return p.label end,
  }, function(choice)
    if not choice then return end
    if choice.id == "custom" then
      return vim.ui.input({ prompt = "Max tokens (0 for server default, up to 4096): " }, function(val)
        local n = tonumber(val or "")
        if n then apply(nil, n) end
      end)
    end
    apply(choice.id, choice.tokens)
  end)
end

--- Configure custom autocomplete instructions (or "-" to clear).
function M.autocomplete_instructions(arg)
  local function apply(text)
    M.config.complete.instructions = (text == "-" or not text) and "" or vim.trim(text)
    require("llembas.complete").reset()
    vim.notify("LLeMbas: autocomplete instructions " .. (M.config.complete.instructions ~= "" and ("set: " .. M.config.complete.instructions) or "cleared"), vim.log.levels.INFO)
  end
  if arg and arg ~= "" then return apply(arg) end
  vim.ui.input({ prompt = "Autocomplete instructions (empty or '-' to clear): ", default = M.config.complete.instructions or "" }, function(val)
    if val ~= nil then apply(val) end
  end)
end

--- Floating status overview card (`:LLeMbasStatus`).
function M.status_popup()
  ui.setup_highlights()
  local c = M.config.complete
  local caps = vim.tbl_keys(S.caps)
  table.sort(caps)
  local lines = {
    "◈ LLeMbas " .. M.version,
    "──────────────────────────────────────────",
    "Agent:         " .. (S.ready and "connected" or S.conn and "starting…" or "idle"),
    "Session:       " .. (S.session or "(none)"),
    "Title:         " .. (S.title or "—"),
    "Mode:          " .. (S.mode or "—"),
    "Model:         " .. (S.model or "—"),
    "Busy:          " .. (S.busy and (S.progress or "working") or "no"),
    "Usage:         " .. (S.usage and ("↑" .. ui.format_tokens(S.usage.input) .. " ↓" .. ui.format_tokens(S.usage.output)) or "—"),
    "",
    "Autocomplete:  " .. (c.auto and "on" or "off") .. "  (debounce " .. tostring(c.debounce_ms) .. "ms)",
    "Scope / Cap:   " .. (c.length or "auto") .. " · " .. (c.max_tokens and (tostring(c.max_tokens) .. " tokens") or "server default"),
    "Instructions:  " .. ((c.instructions and c.instructions ~= "") and c.instructions or "(none)"),
    "Window model:  " .. (c.model or "(account default)"),
    "",
    "Capabilities:  " .. (#caps > 0 and table.concat(caps, ", ") or "(not connected yet)"),
  }
  ui.float("LLeMbas Status", lines, { border = M.config.border })
end

--- Floating keymaps & commands card (`:LLeMbasHelp`).
function M.help()
  ui.setup_highlights()
  local lines = {
    "◈ LLeMbas IDE — Commands & Keys",
    "───────────────────────────────────────────────",
    "Panel:",
    "  :LLeMbas                 Toggle chat panel",
    "  :LLeMbasNew[!]           New session (! kills hung turn)",
    "  :LLeMbasSessions         Resume a previous session",
    "  :LLeMbasCompact          Compact session context",
    "  :LLeMbasStop             Stop running turn",
    "  :LLeMbasStatus           Show agent & autocomplete status",
    "",
    "Coding:",
    "  :[range]LLeMbasAsk       Ask about selection (or attach)",
    "  :[range]LLeMbasExplain   Explain selected lines",
    "  :[range]LLeMbasEdit      Rewrite selection as inline diff",
    "  :LLeMbasGenerate         Generate code at cursor",
    "  :LLeMbasFix              Fix buffer diagnostics",
    "  :LLeMbasFiles[!]         Attach @file (! opens directly)",
    "  :LLeMbasCommands         Pick a /command or skill",
    "",
    "Inline Diff Proposal Keys:",
    "  ga / gr                  Accept / reject hunk under cursor",
    "  gA / gR                  Accept / reject all hunks",
    "  ]h / [h                  Next / previous proposed hunk",
    "",
    "Autocomplete:",
    "  <Tab> / <M-Right>        Accept suggestion / accept word",
    "  <M-\\>                    Trigger suggestion manually",
    "  :LLeMbasAutocompleteTokens [N|words|line|block|file|auto]",
    "  :LLeMbasAutocompleteInstructions [text|-]",
    "",
    "Transcript Keys: <CR>/gf open file · K tool output · y yank code · i prompt · q close",
  }
  ui.float("LLeMbas Help", lines, { border = M.config.border })
end

--- Compact statusline component for lualine / statusline integration.
function M.statusline()
  local pending = require("llembas.diff").pending()
  if pending > 0 then
    return ("◈ LLeMbas: %d change%s (ga/gr)"):format(pending, pending == 1 and "" or "s")
  end
  if S.busy then
    return "◈ LLeMbas ◐ " .. (S.progress or "working")
  end
  if S.session then
    local short = S.model and (S.model:match("[^/]+$") or S.model) or ""
    return "◈ LLeMbas" .. (S.mode and (" [" .. S.mode .. "]") or "") .. (short ~= "" and (" " .. short) or "")
  end
  return ""
end

function M.mode_ids()
  return vim.tbl_map(function(m) return m.id end, S.modes)
end

function M.setup(opts)
  M.config = vim.tbl_deep_extend("force", M.config, opts or {})
  if type(M.config.cmd) == "string" then M.config.cmd = { M.config.cmd, "serve", "--stdio" } end
  ui.setup_highlights()
  require("llembas.complete").setup()
end

--- For the plugin's other parts: the connection once the agent has started (`cb(conn | nil)`).
function M._connect(cb, quiet)
  connect(function(ok) cb(ok and S.conn or nil) end, quiet)
end

function M._note(text, level)
  M.open(false)
  note(text, level)
end

M.version = read_repo_version()
M._state = S -- for the tests

vim.api.nvim_create_autocmd("VimLeavePre", {
  group = vim.api.nvim_create_augroup("llembas", { clear = true }),
  callback = function() if S.conn then S.conn:stop() end end,
})
vim.api.nvim_create_autocmd({ "FileChangedShellPost", "BufReadPost" }, {
  group = "llembas",
  callback = function(ev) require("llembas.diff").forget(ev.buf) end,
})
vim.api.nvim_create_autocmd("BufEnter", {
  group = "llembas",
  callback = function(ev) if vim.bo[ev.buf].buftype == "" then S.last_buf = ev.buf end end,
})

return M
