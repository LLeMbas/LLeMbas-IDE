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
check("start: plain ACP, no LLeMbas client capability claimed",
  init and init.params.protocolVersion == 1 and next(init.params.clientCapabilities) == nil)
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

-- 9. A command that does not exist is said, not thrown.
L.setup({ cmd = { "llembas-no-such-command" } })
vim.cmd("LLeMbasNew")
type_and_send("anyone?")
check("missing: said in the transcript", wait(function() return chat.text():find("Could not start", 1, true) ~= nil end) and not L._state.busy, chat.text())

print(("RAN %d, failed %d"):format(ran, failed))
vim.fn.delete(tmp, "rf")
vim.cmd(failed == 0 and "qall!" or "cquit!")
