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
}

local S = { conn = nil, session = nil, starting = nil, busy = false, modes = {}, mode = nil, model = nil,
            attached = nil, attached_label = nil, last_buf = nil, said = nil }

local function note(text) chat.newline(); chat.append("> " .. text .. "\n") end

local function status()
  local parts = {}
  if S.attached_label then parts[#parts + 1] = "with " .. S.attached_label end
  if S.mode then parts[#parts + 1] = "mode " .. S.mode end
  if S.model then parts[#parts + 1] = S.model end
  if S.busy then parts[#parts + 1] = "working (Ctrl-C stops)" end
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
  local prompt = "LLeMbas asks: " .. (call.title or meta.tool or "a tool")
  if meta.reason then prompt = prompt .. " (" .. meta.reason .. ")" end
  vim.ui.select(options, {
    prompt = prompt:gsub("[\r\n]+", " "):sub(1, 400),
    format_item = function(o) return o.name or o.optionId end,
  }, function(choice)
    if not choice then
      chat.line("ask:" .. tostring(call.toolCallId), "- ✗ " .. (call.title or "a tool") .. " (not answered: denied)")
      return reply({ outcome = { outcome = "cancelled" } })
    end
    chat.line("ask:" .. tostring(call.toolCallId), ("- %s: %s"):format(choice.name or choice.optionId, call.title or "a tool"))
    reply({ outcome = { outcome = "selected", optionId = choice.optionId } })
  end)
end

local function stopped(code, stderr)
  local was = S.conn ~= nil or S.starting ~= nil
  local waiting = S.starting
  S.conn, S.session, S.starting, S.busy = nil, nil, nil, false
  if was then
    local last = ""
    for line in (stderr or ""):gmatch("[^\r\n]+") do if line:match("%S") then last = line end end
    note(("The agent stopped (exit %s)%s"):format(tostring(code), last ~= "" and (": " .. last) or "."))
  end
  for _, cb in ipairs(waiting or {}) do cb(false) end
  status()
end

--- Have a running agent and an open session, then call `cb(true)`; `cb(false)` when that failed.
local function ensure(cb)
  if S.session then return cb(true) end
  if S.starting then S.starting[#S.starting + 1] = cb; return end
  S.starting = { cb }
  local function fail(what)
    note(what)
    local conn = S.conn
    local waiting = S.starting or {}
    S.conn, S.starting, S.session = nil, nil, nil
    if conn then conn:stop() end
    for _, f in ipairs(waiting) do f(false) end
  end
  local conn, err = rpc.start(M.config.cmd, {
    notify = function(method, params)
      if method == "session/update" and params.sessionId == S.session then on_update(params.update or {}) end
    end,
    request = function(method, params, reply)
      if method == "session/request_permission" then return on_permission(params, reply) end
      reply(nil, { code = -32601, message = "Method not found: " .. method })
    end,
    exit = stopped,
  }, { cwd = vim.fn.getcwd() })
  if not conn then
    S.starting = nil
    note(("Could not start %s: %s"):format(M.config.cmd[1], err))
    return cb(false)
  end
  S.conn = conn
  conn:request("initialize", { protocolVersion = 1, clientCapabilities = {},
    clientInfo = { name = "llembas.nvim", version = M.version } }, function(e1)
    if S.conn ~= conn then return end
    if e1 then return fail("The agent refused to start: " .. tostring(e1.message)) end
    local meta = {}
    if M.config.mode then meta.mode = M.config.mode end
    if M.config.model then meta.model = M.config.model end
    conn:request("session/new", { cwd = vim.fn.getcwd(), mcpServers = {}, _meta = meta }, function(e2, r)
      if S.conn ~= conn then return end
      if e2 then return fail("No session: " .. tostring(e2.message)) end
      S.session = r.sessionId
      S.modes = (r.modes and r.modes.availableModes) or {}
      local lm = (r._meta or {}).lembas or {}
      S.mode = (r.modes and r.modes.currentModeId) or lm.mode
      S.model = lm.model
      local waiting = S.starting or {}
      S.starting = nil
      status()
      for _, f in ipairs(waiting) do f(true) end
    end)
  end)
end

--- Send `blocks` as a prompt; `shown` is what the transcript says you wrote.
local function send(blocks, shown)
  if S.busy then
    vim.notify("LLeMbas is still working on the last message (:LLeMbasStop stops it)", vim.log.levels.WARN)
    return false
  end
  chat.section("You")
  chat.append(shown .. "\n")
  S.said = "you"
  S.busy = true
  status()
  ensure(function(ok)
    if not ok then S.busy = false; status(); return end
    S.conn:request("session/prompt", { sessionId = S.session, prompt = blocks }, function(err, r)
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

--- A prompt typed in the panel: with what was attached, or else the name of the open file.
local function send_typed(text)
  local blocks, shown = {}, text
  if S.attached then
    vim.list_extend(blocks, S.attached)
    shown = ("[%s]\n%s"):format(S.attached_label, text)
  elseif M.config.send_open_file and not text:match("^/") then
    local b = editing_buf()
    local f = b and context.file(b)
    if f then blocks[#blocks + 1] = f end
  end
  blocks[#blocks + 1] = { type = "text", text = text }
  if send(blocks, shown) == false then return false end
  S.attached, S.attached_label = nil, nil
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
  local blocks = context.selection(buf, first, last)
  local what = label(buf, first, last)
  if question and question:match("%S") then
    M.open(false)
    blocks[#blocks + 1] = { type = "text", text = question }
    send(blocks, ("[%s]\n%s"):format(what, question))
  else
    S.attached, S.attached_label = blocks, what
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
  if vim.bo[buf].modified then
    return vim.notify("LLeMbas: save the file first (the agent edits the file on disk)", vim.log.levels.WARN)
  end
  if not instruction or not instruction:match("%S") then
    return vim.ui.input({ prompt = "Rewrite the selection: " }, function(text)
      if text and text:match("%S") then M.edit(first, last, text) end
    end)
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
function M.new()
  if S.busy then return vim.notify("LLeMbas is working; stop it first (:LLeMbasStop)", vim.log.levels.WARN) end
  local conn = S.conn
  S.conn, S.session, S.starting, S.said = nil, nil, nil, nil
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

function M.mode_ids()
  return vim.tbl_map(function(m) return m.id end, S.modes)
end

function M.setup(opts)
  M.config = vim.tbl_deep_extend("force", M.config, opts or {})
  if type(M.config.cmd) == "string" then M.config.cmd = { M.config.cmd, "serve", "--stdio" } end
end

M.version = "1.0.0-beta.1"
M._state = S -- for the tests

vim.api.nvim_create_autocmd("VimLeavePre", {
  group = vim.api.nvim_create_augroup("llembas", { clear = true }),
  callback = function() if S.conn then S.conn:stop() end end,
})
vim.api.nvim_create_autocmd("BufEnter", {
  group = "llembas",
  callback = function(ev) if vim.bo[ev.buf].buftype == "" then S.last_buf = ev.buf end end,
})

return M
