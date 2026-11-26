-- LLeMbas in Neovim. The agent is the LLeMbas CLI, unchanged: this plugin starts `lembas serve --stdio`
-- and is its client (Agent Client Protocol, version 1). Models, permissions, tools and the sign-in are
-- the CLI's; nothing is set here but how the panel looks and which command starts the agent.
local rpc = require("llembas.rpc")
local chat = require("llembas.chat")
local context = require("llembas.context")

local M = {}

M.config = {
  cmd = { "lembas", "serve", "--stdio" }, -- the agent
  width = 64,                             -- the panel's columns
  mode = nil,                             -- the mode a session starts in (the CLI's own when nil)
  model = nil,                            -- the model a session starts on (the CLI's own when nil)
  show_thoughts = false,                  -- the model's thinking in the transcript
  send_open_file = true,                  -- a prompt names the file you are in
  complete = {
    auto = true,                          -- suggest as you type (needs an autocomplete model on the server)
    debounce_ms = 250,                    -- how long you must pause before a suggestion is asked for
    model = nil,                          -- a quick switch for this editor only; nil: your saved choice
    accept = "<Tab>",                     -- accepts a shown suggestion; falls through when none is shown
    trigger = "<M-\\>",                   -- asks for a suggestion now
  },
}

local S = { conn = nil, session = nil, starting = nil, connecting = nil, ready = false, caps = {}, busy = false,
            modes = {}, mode = nil, model = nil, progress = nil, attached = nil, attached_label = nil, last_buf = nil, said = nil }

local function note(text) chat.newline(); chat.append("> " .. text .. "\n") end

local function status()
  local parts = {}
  if S.attached_label then parts[#parts + 1] = "with " .. S.attached_label end
  if S.mode then parts[#parts + 1] = "mode " .. S.mode end
  if S.model then parts[#parts + 1] = S.model end
  if S.busy then parts[#parts + 1] = (S.progress and S.progress ~= "" and (S.progress .. " (Ctrl-C stops)") or "working (Ctrl-C stops)") end
  chat.status(" " .. table.concat(parts, " | "))
end

local function reload_files()
  -- The agent writes files itself; a buffer without changes of its own takes the new text.
  pcall(vim.cmd, "silent! checktime")
end

local ICON = { pending = "…", in_progress = "…", completed = "✓", failed = "✗" }
local tools = {}

local function on_update(u)
  local kind = u.sessionUpdate
  if kind == "agent_message_chunk" then
    if S.said ~= "agent" then chat.section("LLeMbas"); S.said = "agent" end
    if u.content and u.content.type == "text" then chat.append(u.content.text) end
  elseif kind == "agent_thought_chunk" then
    if M.config.show_thoughts and u.content and u.content.type == "text" then
      if S.said ~= "thought" then chat.section("Thinking"); S.said = "thought" end
      chat.append(u.content.text)
    end
  elseif kind == "tool_call" or kind == "tool_call_update" then
    local t = tools[u.toolCallId] or {}
    tools[u.toolCallId] = t
    t.title = u.title or t.title or "tool"
    t.status = u.status or t.status or "pending"
    chat.line("tool:" .. u.toolCallId, ("- %s %s"):format(ICON[t.status] or "…", t.title))
    S.said = "tool"
    if t.status == "completed" then reload_files() end
  elseif kind == "plan" then
    local done, all = 0, 0
    for _, e in ipairs(u.entries or {}) do
      all = all + 1
      if e.status == "completed" then done = done + 1 end
    end
    if all > 0 then chat.line("plan", ("- plan: %d of %d tasks done"):format(done, all)); S.said = "tool" end
  elseif kind == "current_mode_update" then
    S.mode = u.currentModeId or S.mode
    status()
  end
end

local function on_permission(p, reply)
  local call = p.toolCall or {}
  local meta = (p._meta or {}).lembas or {}
  local options = p.options or {}
  chat.line("ask:" .. tostring(call.toolCallId), "- ? " .. (call.title or meta.tool or "a tool") .. " (waits for your answer)")
  local preview = require("llembas.diff").preview(call.content)
  local prompt = "LLeMbas asks: " .. (call.title or meta.tool or "a tool")
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
    if preview then preview() end
    if not choice then
      chat.line("ask:" .. tostring(call.toolCallId), "- ✗ " .. (call.title or "a tool") .. " (not answered: denied)")
      return reply({ outcome = { outcome = "cancelled" } })
    end
    chat.line("ask:" .. tostring(call.toolCallId), ("- %s: %s"):format(choice.name or choice.optionId, call.title or "a tool"))
    reply({ outcome = { outcome = "selected", optionId = choice.optionId } })
  end)
end

local function on_question(p, reply)
  local qs = p.questions or {}
  local id = "q:" .. tostring(p.toolCallId or "")
  chat.line(id, "- ? " .. (p.why or (qs[1] and qs[1].question) or "question") .. " (waits for your answer)")
  pcall(vim.cmd, "stopinsert")
  local answers = {}
  local function ask_idx(i)
    if i > #qs then
      chat.line(id, "- answered question")
      return reply({ outcome = "answered", answers = answers })
    end
    local q = qs[i]
    local opts = q.options or {}
    if #opts > 0 then
      local choices = {}
      for _, o in ipairs(opts) do choices[#choices + 1] = o end
      choices[#choices + 1] = { label = "__custom__", _custom = true }
      vim.ui.select(choices, {
        prompt = (q.header and (q.header .. ": ") or "") .. (q.question or "Choose"),
        format_item = function(o)
          if o._custom then return "Type a custom answer…" end
          return o.description and o.description ~= "" and (o.label .. " — " .. o.description) or o.label
        end,
      }, function(choice)
        if not choice then
          chat.line(id, "- ✗ question dismissed")
          return reply({ outcome = "dismissed" })
        end
        if choice._custom then
          vim.ui.input({ prompt = (q.question or "Answer") .. ": " }, function(text)
            if not text or not text:match("%S") then
              chat.line(id, "- ✗ question dismissed")
              return reply({ outcome = "dismissed" })
            end
            answers[i] = { text }
            ask_idx(i + 1)
          end)
        else
          answers[i] = { choice.label }
          ask_idx(i + 1)
        end
      end)
    else
      vim.ui.input({ prompt = (q.question or "Answer") .. ": " }, function(text)
        if not text then
          chat.line(id, "- ✗ question dismissed")
          return reply({ outcome = "dismissed" })
        end
        answers[i] = { text }
        ask_idx(i + 1)
      end)
    end
  end
  ask_idx(1)
end

local function on_plan(p, reply)
  local title = (p.plan and p.plan.title) or "Plan ready"
  local id = "plan:" .. tostring(p.toolCallId or "")
  chat.section("Plan: " .. title)
  if type(p.text) == "string" and p.text ~= "" then chat.append(p.text .. "\n") end
  chat.line(id, "- ? " .. title .. " (waits for approval)")
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
    if not choice or choice.id == "dismiss" then
      chat.line(id, "- ✗ plan dismissed")
      return reply({ outcome = "dismiss" })
    end
    if choice.id == "approve_edit" then
      chat.line(id, "- ✓ plan approved (edit mode)")
      return reply({ outcome = "approve", mode = "edit" })
    end
    if choice.id == "approve_manual" then
      chat.line(id, "- ✓ plan approved (manual mode)")
      return reply({ outcome = "approve", mode = "manual" })
    end
    vim.ui.input({ prompt = "Plan revision feedback: " }, function(fb)
      if not fb or not fb:match("%S") then
        chat.line(id, "- ✗ plan dismissed")
        return reply({ outcome = "dismiss" })
      end
      chat.line(id, "- ↻ plan revision requested")
      reply({ outcome = "revise", feedback = fb })
    end)
  end)
end

local function stopped(code, stderr)
  local was = S.session ~= nil or S.starting ~= nil
  local waiting = S.starting
  local connecting = S.connecting
  S.conn, S.session, S.starting, S.connecting, S.ready, S.busy = nil, nil, nil, nil, false, false
  for _, cb in ipairs(connecting or {}) do cb(false) end
  if was then
    local last = ""
    for line in (stderr or ""):gmatch("[^\r\n]+") do if line:match("%S") then last = line end end
    note(("The agent stopped (exit %s)%s"):format(tostring(code), last ~= "" and (": " .. last) or "."))
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
      elseif method == "_lembas/event" and params.sessionId == S.session and params.event then
        local ev = params.event
        if ev.type == "model" and type(ev.ref) == "string" then S.model = ev.ref; status()
        elseif ev.type == "mode" and type(ev.mode) == "string" then S.mode = ev.mode; status()
        elseif ev.type == "phase" then
          local pr = ev.progress
          S.progress = (pr and type(pr.phase) == "string") and (pr.phase:gsub("_", " ") .. (pr.detail and (": " .. pr.detail) or "")) or nil
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
    if not quiet then note(("Could not start %s: %s"):format(M.config.cmd[1], err)) end
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
      if not quiet then note("The agent refused to start: " .. tostring(e1.message)) end
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
        note("No session: " .. tostring(e2.message))
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
  chat.section("You")
  chat.append(shown .. "\n")
  S.said = "you"
  S.busy = true
  status()
  ensure(function(ok)
    if not ok then S.busy = false; status(); return end
    S.conn:request("session/prompt", { sessionId = S.session, prompt = blocks, _meta = meta }, function(err, r)
      S.busy = false
      if err then note("The turn failed: " .. tostring(err.message))
      elseif r and r.stopReason and r.stopReason ~= "end_turn" then note("The turn ended: " .. r.stopReason) end
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
      chat.section("You (while working)")
      chat.append(text .. "\n")
      S.conn:request("_lembas/steer", { sessionId = S.session, text = text }, function(err)
        if err then note("Steer failed: " .. tostring(err.message)) end
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
  local b = vim.api.nvim_get_current_buf()
  if vim.bo[b].buftype == "" then S.last_buf = b end
  chat.on_send = send_typed
  chat.on_stop = M.stop
  chat.open(M.config.width, focus)
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
--- its own permissions, so the buffer has to be saved first.
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
  tools = {}
  if conn then conn:stop() end
  chat.clear()
  M.open()
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
    local function pick_from(list)
      if not list or #list == 0 then return vim.notify("LLeMbas: no matching files found", vim.log.levels.INFO) end
      vim.ui.select(list, { prompt = open_directly and "LLeMbas open file" or "LLeMbas attach file to chat" }, function(file)
        if not file then return end
        if open_directly then
          local full = file:match("^/") and file or (vim.fn.getcwd() .. "/" .. file)
          local target
          for _, w in ipairs(vim.api.nvim_tabpage_list_wins(0)) do
            if vim.bo[vim.api.nvim_win_get_buf(w)].buftype == "" then target = w break end
          end
          if target then vim.api.nvim_set_current_win(target) end
          pcall(vim.cmd, "edit " .. vim.fn.fnameescape(full))
        else
          M.open(true)
          chat.insert_prompt("@" .. file .. " ")
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
          out[#out + 1] = f
          if #out >= 50 then break end
        end
      end
      pick_from(out)
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
          S.modes = (res.modes and res.modes.availableModes) or S.modes
          local lm = (res._meta or {}).lembas or {}
          S.mode = (res.modes and res.modes.currentModeId) or lm.mode or S.mode
          S.model = lm.model or S.model
          tools = {}
          chat.clear()
          M.open(false)
          for _, turn in ipairs(res.turns or {}) do
            if type(turn.user) == "string" and turn.user ~= "" then
              chat.section("You")
              chat.append(turn.user .. "\n")
            end
            for _, t in ipairs(turn.tools or {}) do
              chat.line("hist:" .. tostring(t.id or ""), ("- %s %s"):format(t.isError and "✗" or "✓", t.title or t.name or "tool"))
            end
            if type(turn.assistant) == "string" and turn.assistant ~= "" then
              chat.section("LLeMbas")
              chat.append(turn.assistant .. "\n")
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
  M.open(false)
  send_typed("Fix the reported diagnostics in this file.")
end

function M.model(name)
  if not name or name == "" then return vim.notify("LLeMbas: model " .. (S.model or "not known yet"), vim.log.levels.INFO) end
  ensure(function(ok)
    if not ok then return end
    S.conn:request("_lembas/configure", { sessionId = S.session, model = name }, function(err, r)
      if err then return vim.notify("LLeMbas: " .. tostring(err.message), vim.log.levels.ERROR) end
      S.model = (r and r.model) or name
      status()
    end)
  end)
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
    vim.bo[b].modifiable = false
    if target then vim.api.nvim_win_set_buf(target, b) end
    chat.line("show:" .. tostring(p.toolCallId), "- shown: " .. tostring(p.path or "text"))
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
    chat.line("show:" .. tostring(p.toolCallId), "- shown: " .. rel)
  else
    chat.line("show:" .. tostring(p.toolCallId), ("- shown: %s (%s) — :LLeMbasOpen opens it"):format(rel, tostring(p.kind or "file")))
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

function M.mode_ids()
  return vim.tbl_map(function(m) return m.id end, S.modes)
end

function M.setup(opts)
  M.config = vim.tbl_deep_extend("force", M.config, opts or {})
  if type(M.config.cmd) == "string" then M.config.cmd = { M.config.cmd, "serve", "--stdio" } end  require("llembas.complete").setup()
end

--- For the plugin's other parts: the connection once the agent has started (`cb(conn | nil)`).
function M._connect(cb, quiet)
  connect(function(ok) cb(ok and S.conn or nil) end, quiet)
end

function M._note(text)
  M.open(false)
  note(text)
end

M.version = "1.0.0-beta.3"
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
