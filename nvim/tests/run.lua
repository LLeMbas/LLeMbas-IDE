-- The plugin's tests, against tests/fake_agent.py. Run by scripts/test-nvim.sh:
--   nvim --headless -u NONE --cmd "set rtp+=nvim" -l nvim/tests/run.lua
local here = debug.getinfo(1, "S").source:sub(2):match("(.*/)")
local tmp = vim.fn.tempname()
vim.fn.mkdir(tmp, "p")
local log = tmp .. "/agent.log"
vim.env.FAKE_AGENT_LOG = log
vim.cmd("runtime plugin/llembas.lua")

local L = require("llembas")
local chat = require("llembas.chat")
L.setup({ cmd = { "python3", here .. "fake_agent.py" }, width = 50 })

local failed, ran = 0, 0
local function check(name, cond, extra)
  ran = ran + 1
  if cond then print("ok   " .. name) else
    failed = failed + 1
    print("FAIL " .. name .. (extra and ("\n     " .. tostring(extra)) or ""))
  end
end
local function wait(cond) return vim.wait(8000, cond, 20) end
local function idle() return wait(function() return not L._state.busy end) end
local function sent()
  local out = {}
  for _, line in ipairs(vim.fn.filereadable(log) == 1 and vim.fn.readfile(log) or {}) do
    out[#out + 1] = vim.json.decode(line)
  end
  return out
end
local function last_prompt()
  local all = sent()
  for i = #all, 1, -1 do if all[i].method == "session/prompt" then return all[i].params.prompt end end
end
local function type_and_send(text)
  vim.api.nvim_buf_set_lines(chat.ibuf, 0, -1, false, vim.split(text, "\n"))
  vim.api.nvim_set_current_win(vim.fn.bufwinid(chat.ibuf))
  vim.api.nvim_feedkeys(vim.api.nvim_replace_termcodes("<CR>", true, false, true), "x", false)
end

local version = vim.trim(table.concat(vim.fn.readfile(here .. "../../VERSION"), ""))
check("version: the plugin says the repository's version", L.version == version, L.version .. " / " .. version)

-- A file to work in.
local file = tmp .. "/sample.py"
vim.fn.writefile({ "def a():", "    return 1", "", "def b():", "    return 2" }, file)
vim.cmd("edit " .. vim.fn.fnameescape(file))
local fbuf = vim.api.nvim_get_current_buf()

-- 1. The panel opens beside the file and a typed prompt is answered.
vim.cmd("LLeMbas")
check("panel: two windows are added and the prompt has the focus",
  #vim.api.nvim_tabpage_list_wins(0) == 3 and vim.api.nvim_get_current_buf() == chat.ibuf)
type_and_send("hello")
check("prompt: the turn ends", idle())
local text = chat.text()
check("prompt: what was typed and the answer are in the transcript, in order",
  text:find("## You\n\nhello\n\n## LLeMbas\n\nHello there.\nSecond line", 1, true) ~= nil, text)
check("prompt: thinking is not shown by default", not text:find("hidden thought", 1, true))
check("prompt: the prompt buffer is emptied", table.concat(vim.api.nvim_buf_get_lines(chat.ibuf, 0, -1, false), "") == "")
local p = last_prompt()
check("prompt: the open file is named, its text is not sent",
  #p == 2 and p[1].text:find("sample.py", 1, true) and p[1].text:find("cursor on line 1", 1, true) and p[2].text == "hello", vim.inspect(p))
local init
for _, m in ipairs(sent()) do if m.method == "initialize" then init = m end end
local lm = init and (init.params.clientCapabilities._meta or {}).lembas or {}
check("start: ACP version 1, and the client says it is an editor that shows files and serves unsaved text",
  init and init.params.protocolVersion == 1 and lm.editor == true and lm.media == true
  and init.params.clientCapabilities.fs.readTextFile == true and init.params.clientCapabilities.fs.writeTextFile == false)
check("start: the transcript cannot be typed in and reads no modeline",
  vim.bo[chat.tbuf].modifiable == false and vim.bo[chat.tbuf].modeline == false and vim.bo[chat.ibuf].modeline == false)

-- 2. A selection with a question goes at once, with the unsaved text and the place.
vim.api.nvim_set_current_win(vim.fn.bufwinid(fbuf))
vim.api.nvim_buf_set_lines(fbuf, 1, 2, false, { "    return 10  # unsaved" })
vim.cmd("1,2LLeMbasAsk what does this return?")
check("ask: the turn ends", idle())
p = last_prompt()
check("ask: place, text as the buffer has it, then the question",
  #p == 3 and p[1].text:find("lines 1-2", 1, true) and p[1].text:find("not saved yet", 1, true)
  and p[2].type == "resource" and p[2].resource.text == "def a():\n    return 10  # unsaved"
  and p[2].resource.uri:find("#L1-2", 1, true) and p[3].text == "what does this return?", vim.inspect(p))
check("ask: the focus stays in the file", vim.api.nvim_get_current_buf() == fbuf)

-- 3. A selection without a question waits for the next typed message, once.
vim.cmd("4,5LLeMbasAsk")
check("attach: the prompt has the focus and says what it carries",
  vim.api.nvim_get_current_buf() == chat.ibuf and vim.wo[vim.fn.bufwinid(chat.ibuf)].winbar:find("sample.py:4-5", 1, true) ~= nil)
type_and_send("and this?")
idle()
p = last_prompt()
check("attach: the lines go with the message", #p == 3 and p[2].resource.text == "def b():\n    return 2" and p[3].text == "and this?", vim.inspect(p))
type_and_send("again")
idle()
p = last_prompt()
check("attach: the next message carries them no more", #p == 2 and p[2].text == "again", vim.inspect(p))

-- 4. An approval is put to the person; the answer goes back.
local asked
vim.ui.select = function(items, opts, cb) asked = { items = items, opts = opts }; cb(items[1]) end
type_and_send("PERM")
idle()
check("approval: asked with the command and the reason",
  asked and asked.opts.prompt:find("rm -r build", 1, true) and asked.opts.prompt:find("deletes files", 1, true)
  and asked.opts.format_item(asked.items[2]) == "Deny")
check("approval: the choice reaches the agent", chat.text():find("answer=once", 1, true) ~= nil, chat.text())
vim.ui.select = function(_, _, cb) cb(nil) end
type_and_send("PERM")
idle()
check("approval: closing the question is a denial", chat.text():find("answer=cancelled", 1, true) ~= nil)
check("approval: each card is one line, rewritten with its answer",
  not chat.text():find("waits for your answer", 1, true) and select(2, chat.text():gsub("rm %-r build", "")) == 2, chat.text())

-- 5. A rewrite: refused on unsaved text, then done by the agent, and the buffer takes the new text.
vim.api.nvim_set_current_win(vim.fn.bufwinid(fbuf))
local before = #sent()
vim.cmd("1,2LLeMbasEdit make it shorter")
check("rewrite: nothing is sent while the buffer is unsaved", #sent() == before and not L._state.busy)
vim.cmd("silent write")
vim.o.autoread = true
vim.cmd("1,2LLeMbasEdit WRITE " .. file)
idle()
check("rewrite: the buffer shows what the agent wrote",
  wait(function() return vim.api.nvim_buf_get_lines(fbuf, 0, 1, false)[1] == "rewritten by the agent" end),
  vim.inspect(vim.api.nvim_buf_get_lines(fbuf, 0, -1, false)))
check("rewrite: the tool call is one line, marked done", select(2, chat.text():gsub("%- ✓ edit sample%.py", "")) == 1
  and not chat.text():find("… edit sample.py", 1, true), chat.text())

-- 6. A second message while one runs is refused; stop ends the turn.
vim.api.nvim_set_current_win(vim.fn.bufwinid(chat.ibuf))
type_and_send("SLOW")
wait(function() local q = last_prompt(); return q and q[#q].text == "SLOW" end)
before = #sent()
type_and_send("too early")
check("busy: a second message is not sent and stays in the prompt",
  #sent() == before and vim.api.nvim_buf_get_lines(chat.ibuf, 0, 1, false)[1] == "too early")
vim.cmd("LLeMbasStop")
check("stop: the turn ends as cancelled", idle() and chat.text():find("The turn ended: cancelled", 1, true) ~= nil)
vim.api.nvim_buf_set_lines(chat.ibuf, 0, -1, false, {})

-- 7. Mode and model.
vim.cmd("LLeMbasMode edit")
check("mode: set and shown", wait(function() return L._state.mode == "edit" end))
vim.cmd("LLeMbasModel example/model-b")
check("model: set and shown", wait(function() return L._state.model == "example/model-b" end)
  and vim.wo[vim.fn.bufwinid(chat.ibuf)].winbar:find("example/model-b", 1, true) ~= nil)

-- 8. The agent dying is said, with its last words, and the next message starts it again.
type_and_send("CRASH")
check("crash: the turn is over and the reason is in the transcript",
  wait(function() return not L._state.busy and chat.text():find("run lembas login", 1, true) ~= nil end), chat.text())
type_and_send("back")
check("crash: the next message gets an answer from a new agent", idle() and chat.text():match("back\n\n## LLeMbas") ~= nil)

-- 8b. An agent that offers the editor's methods (spec 3.11.0).
vim.env.FAKE_EDITOR = "1"
vim.cmd("LLeMbasNew")
vim.fn.delete(log)
local function calls(method)
  local out = {}
  for _, m in ipairs(sent()) do if m.method == method then out[#out + 1] = m.params end end
  return out
end
vim.fn.writefile({ "def a():", "    return 1", "", "def b():", "    return 2" }, file)
vim.api.nvim_set_current_win(vim.fn.bufwinid(fbuf))
vim.cmd("edit!")

-- Context as data, not as a sentence.
vim.api.nvim_win_set_cursor(0, { 4, 0 })
type_and_send("hello editor")
idle()
local all = sent()
local pr
for i = #all, 1, -1 do if all[i].method == "session/prompt" then pr = all[i].params break end end
check("editor: a typed message carries the file and the cursor as data and no sentence",
  pr and #pr.prompt == 1 and pr._meta.lembas.editor.path == file and pr._meta.lembas.editor.cursor.line == 4, vim.inspect(pr))
vim.api.nvim_set_current_win(vim.fn.bufwinid(fbuf))
vim.cmd("4,5LLeMbasAsk what is b?")
idle()
all = sent()
for i = #all, 1, -1 do if all[i].method == "session/prompt" then pr = all[i].params break end end
local sel = pr._meta.lembas.editor.selection
check("editor: a selection goes as data with its lines and text",
  #pr.prompt == 1 and sel.start == 4 and sel["end"] == 5 and sel.text == "def b():\n    return 2", vim.inspect(pr))

-- Unsaved text is what the agent reads.
vim.api.nvim_buf_set_lines(fbuf, 2, 3, false, { "# not saved" })
vim.api.nvim_set_current_win(vim.fn.bufwinid(chat.ibuf))
type_and_send("READ " .. file)
idle()
check("unsaved: the agent's read of an open file gets the buffer's text",
  chat.text():find('read="def a():\\n    return 1\\n# not saved\\ndef b():\\n    return 2"', 1, true) ~= nil, chat.text())
type_and_send("READ " .. tmp .. "/none.txt")
idle()
check("unsaved: a file that cannot be read is an error, not a crash", chat.text():find("read=null", 1, true) ~= nil)

-- A rewrite is shown, and nothing is written before it is accepted.
vim.api.nvim_set_current_win(vim.fn.bufwinid(fbuf))
vim.api.nvim_buf_set_lines(fbuf, 2, 3, false, { "" })
local D = require("llembas.diff")
local before_text = vim.api.nvim_buf_get_lines(fbuf, 0, -1, false)
vim.cmd("1,2LLeMbasEdit make it louder")
check("rewrite: two changes are shown on unsaved text", wait(function() return D.pending(fbuf) == 2 end), tostring(D.pending(fbuf)))
check("rewrite: the buffer is as it was", vim.deep_equal(vim.api.nvim_buf_get_lines(fbuf, 0, -1, false), before_text))
local e = calls("_lembas/edit")[1]
check("rewrite: the request has the text, the lines around it, the instruction and an id",
  e and e.text == "def a():\n    return 1" and e.after:find("def b", 1, true) and e.before == "" and e.instruction == "make it louder"
  and e.path == file and type(e.id) == "string", vim.inspect(e))
vim.api.nvim_win_set_cursor(0, { 1, 0 })
vim.cmd("LLeMbasAccept")
check("rewrite: accepting one change makes that one and leaves the other shown",
  vim.api.nvim_buf_get_lines(fbuf, 0, 1, false)[1] == "DEF A():" and D.pending(fbuf) == 1
  and #vim.api.nvim_buf_get_lines(fbuf, 0, -1, false) == 5)
vim.cmd("LLeMbasReject")
check("rewrite: rejecting the other leaves its lines alone and nothing shown",
  D.pending(fbuf) == 0 and vim.deep_equal(vim.api.nvim_buf_get_lines(fbuf, 0, -1, false),
    { "DEF A():", "    return 1", "", "def b():", "    return 2" }))
vim.cmd("4,5LLeMbasEdit again")
wait(function() return D.pending(fbuf) == 2 end)
vim.cmd("LLeMbasAccept!")
check("rewrite: accepting all makes both, in the right places",
  D.pending(fbuf) == 0 and vim.deep_equal(vim.api.nvim_buf_get_lines(fbuf, 0, -1, false),
    { "DEF A():", "    return 1", "", "DEF B():", "    return 2", "    # added by the rewrite" }),
  vim.inspect(vim.api.nvim_buf_get_lines(fbuf, 0, -1, false)))
local said_msgs = {}
local notify = vim.notify
vim.notify = function(m) said_msgs[#said_msgs + 1] = m end
vim.cmd("1,2LLeMbasEdit SAME")
check("rewrite: one that changes nothing says so", wait(function() return table.concat(said_msgs, "|"):find("changes nothing", 1, true) ~= nil end))
vim.cmd("1,2LLeMbasEdit REFUSE")
check("rewrite: a refusal is said in the agent's words", wait(function() return table.concat(said_msgs, "|"):find("no model to rewrite with", 1, true) ~= nil end)
  and D.pending(fbuf) == 0)

-- An approval that carries a diff shows it while the question is open.
local wins_during
vim.ui.select = function(items, _, cb)
  wins_during = {}
  for _, w in ipairs(vim.api.nvim_tabpage_list_wins(0)) do
    local b = vim.api.nvim_win_get_buf(w)
    if vim.bo[b].filetype == "diff" then wins_during = vim.api.nvim_buf_get_lines(b, 0, -1, false) end
  end
  cb(items[2])
end
local wins_before = #vim.api.nvim_tabpage_list_wins(0)
vim.api.nvim_set_current_win(vim.fn.bufwinid(chat.ibuf))
type_and_send("PERMDIFF")
idle()
local joined = table.concat(wins_during or {}, "\n")
check("approval: the diff is on the screen while the question is asked",
  joined:find("--- sample.py", 1, true) and joined:find("-two", 1, true) and joined:find("+TWO", 1, true), joined)
check("approval: the diff's window is gone afterwards and the answer went back",
  #vim.api.nvim_tabpage_list_wins(0) == wins_before and chat.text():find("answer=deny", 1, true) ~= nil)

-- Shown files.
local png = tmp .. "/chart.png"
vim.fn.writefile({ "not really a picture" }, png)
local opened
vim.ui.open = function(pth) opened = pth end
type_and_send("SHOW " .. png)
idle()
check("show: a file that is not text is named in the chat and answered as shown",
  chat.text():find("chart.png (image)", 1, true) ~= nil and chat.text():find('shown={"shown": true}', 1, true) ~= nil, chat.text())
vim.cmd("LLeMbasOpen")
check("show: :LLeMbasOpen hands it to the system's viewer", opened == png)
local other = tmp .. "/other.py"
vim.fn.writefile({ "x = 1", "y = 2", "z = 3" }, other)
type_and_send("SHOW " .. other)
idle()
check("show: a text file is opened in the window you edit in, at its line, and the prompt keeps the focus",
  vim.api.nvim_buf_get_name(vim.api.nvim_win_get_buf(vim.fn.bufwinid(fbuf) ~= -1 and vim.fn.bufwinid(fbuf) or vim.fn.win_getid(1))) ~= ""
  and vim.fn.bufwinid(vim.fn.bufnr(other)) ~= -1 and vim.api.nvim_win_get_cursor(vim.fn.bufwinid(vim.fn.bufnr(other)))[1] == 2
  and vim.api.nvim_get_current_buf() == chat.ibuf)

-- Suggestions.
local C = require("llembas.complete")
local ns_c = vim.api.nvim_get_namespaces()["llembas-complete"]
local function ghost(buf)
  local m = vim.api.nvim_buf_get_extmarks(buf, ns_c, 0, -1, { details = true })[1]
  if not m then return nil end
  local d = m[4]
  local t = d.virt_text and d.virt_text[1][1] or ""
  for _, vl in ipairs(d.virt_lines or {}) do t = t .. "\n" .. vl[1][1] end
  return t, m[2], m[3]
end
local obuf = vim.fn.bufnr(other)
vim.api.nvim_set_current_win(vim.fn.bufwinid(obuf))
vim.api.nvim_buf_set_lines(obuf, 0, -1, false, { "abc = fo", "tail" })
vim.bo[obuf].filetype = "python"
C._typing = function() return true end
vim.o.virtualedit = "onemore" -- so the cursor can stand after the last character, as it does while typing
vim.api.nvim_win_set_cursor(0, { 1, 8 })
C.request(true)
check("suggest: asked on the key, the text is drawn at the cursor and is not in the buffer",
  wait(function() return ghost(obuf) ~= nil end) and ghost(obuf) == "< fo|\nta>" and vim.api.nvim_buf_get_lines(obuf, 0, 1, false)[1] == "abc = fo",
  vim.inspect({ ghost(obuf) }))
local c = calls("_lembas/complete")
check("suggest: the request has what is before and after the cursor, the file and the language",
  c[#c].prefix == "abc = fo" and c[#c].suffix == "\ntail" and c[#c].path == other and c[#c].language == "python" and type(c[#c].id) == "string",
  vim.inspect(c[#c]))
check("suggest: accepting puts it in and moves the cursor to its end",
  C.accept() and vim.deep_equal(vim.api.nvim_buf_get_lines(obuf, 0, -1, false), { "abc = fo< fo|", "ta>", "tail" })
  and vim.deep_equal(vim.api.nvim_win_get_cursor(0), { 2, 3 }) and ghost(obuf) == nil,
  vim.inspect(vim.api.nvim_buf_get_lines(obuf, 0, -1, false)))
check("suggest: with nothing shown there is nothing to accept", C.accept() == false)
-- As you type: asked after the pause, and an answer for a place you have left is not drawn.
L.config.complete.debounce_ms = 30
vim.api.nvim_buf_set_lines(obuf, 0, -1, false, { "" })
vim.api.nvim_win_set_cursor(0, { 1, 0 })
local n0 = #calls("_lembas/complete")
vim.api.nvim_buf_set_lines(obuf, 0, -1, false, { "xy" })
vim.api.nvim_win_set_cursor(0, { 1, 2 })
vim.cmd("doautocmd TextChangedI")
check("suggest: typing asks by itself after the pause", wait(function() return ghost(obuf) == "<xy|>" end), vim.inspect({ ghost(obuf) }))
vim.api.nvim_buf_set_lines(obuf, 0, -1, false, { "SLOWC" })
vim.api.nvim_win_set_cursor(0, { 1, 5 })
vim.cmd("doautocmd TextChangedI")
wait(function() local k = calls("_lembas/complete"); return k[#k] and k[#k].prefix == "SLOWC" end)
vim.api.nvim_buf_set_lines(obuf, 0, -1, false, { "SLOWCz" })
vim.api.nvim_win_set_cursor(0, { 1, 6 })
vim.cmd("doautocmd TextChangedI")
check("suggest: a newer keystroke cancels the request before it by its id",
  wait(function() return #calls("_lembas/complete/cancel") >= 1 end))
vim.wait(400)
local g = ghost(obuf)
check("suggest: only the answer for where the cursor is now is ever drawn", g == nil or g == "<WCz|>", tostring(g))
C.clear()
-- A refusal is said once and the asking stops.
said_msgs = {}
vim.api.nvim_buf_set_lines(obuf, 0, -1, false, { "NOMODEL" })
vim.api.nvim_win_set_cursor(0, { 1, 7 })
vim.cmd("doautocmd TextChangedI")
check("suggest: no model chosen is said once", wait(function() return table.concat(said_msgs, "|"):find("no autocomplete model is chosen", 1, true) ~= nil end))
n0 = #calls("_lembas/complete")
vim.cmd("doautocmd TextChangedI")
vim.wait(200)
check("suggest: and nothing more is asked until a model is chosen", #calls("_lembas/complete") == n0 and #said_msgs == 1)
-- Choosing models.
vim.cmd("LLeMbasAutocompleteModel example/model-a")
check("models: the autocomplete model is saved through the agent",
  wait(function() local k = calls("_lembas/editor/settings"); return k[#k] and k[#k].set and k[#k].set.autocomplete_model == "example/model-a" end))
vim.ui.select = function(items, opts, cb) asked = { items = items, opts = opts }; cb(items[1]) end
vim.cmd("LLeMbasAutocompleteModel")
check("models: without a name the list offers only models allowed for it",
  wait(function() return asked and asked.opts.prompt:find("autocomplete", 1, true) ~= nil end) and #asked.items == 1 and asked.items[1].id == "example/model-a")
vim.cmd("LLeMbasAutocompleteModel! example/model-b")
check("models: the quick switch is this editor's only", L.config.complete.model == "example/model-b"
  and (function() local k = calls("_lembas/editor/settings"); return k[#k].set.autocomplete_model ~= "example/model-b" end)())
vim.cmd("LLeMbasMainModel example/model-b")
check("models: the main model is saved as its own entry",
  wait(function() local k = calls("_lembas/editor/settings"); return k[#k].set and k[#k].set.main_model == "example/model-b" end))
vim.notify = notify

-- 9. A command that does not exist is said, not thrown.
L.setup({ cmd = { "llembas-no-such-command" } })
vim.cmd("LLeMbasNew")
type_and_send("anyone?")
check("missing: said in the transcript", wait(function() return chat.text():find("Could not start", 1, true) ~= nil end) and not L._state.busy, chat.text())

print(("RAN %d, failed %d"):format(ran, failed))
vim.fn.delete(tmp, "rf")
vim.cmd(failed == 0 and "qall!" or "cquit!")
