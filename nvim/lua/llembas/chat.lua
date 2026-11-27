-- The chat panel: a transcript nobody types in and a prompt under it. What the model writes is put
-- there as text and nothing else: it is never run, and modelines are off in both buffers.
local ui = require("llembas.ui")

local M = {
  tbuf = nil, ibuf = nil, marks = {}, details = {},
  on_send = nil, on_stop = nil, on_help = nil, on_files = nil, on_commands = nil,
}
local ns = vim.api.nvim_create_namespace("llembas")
local ns_hl = vim.api.nvim_create_namespace("llembas-hl")
local ns_welcome = vim.api.nvim_create_namespace("llembas-welcome")

local function valid(b) return b and vim.api.nvim_buf_is_valid(b) end

local function win_of(buf)
  if not valid(buf) then return nil end
  for _, w in ipairs(vim.api.nvim_tabpage_list_wins(0)) do
    if vim.api.nvim_win_get_buf(w) == buf then return w end
  end
end

local function is_empty_buf(buf)
  local n = vim.api.nvim_buf_line_count(buf)
  if n ~= 1 then return false end
  return (vim.api.nvim_buf_get_lines(buf, 0, 1, false)[1] or "") == ""
end

local function sync_welcome()
  if not valid(M.tbuf) then return end
  vim.api.nvim_buf_clear_namespace(M.tbuf, ns_welcome, 0, -1)
  if is_empty_buf(M.tbuf) then
    vim.api.nvim_buf_set_extmark(M.tbuf, ns_welcome, 0, 0, {
      virt_lines = ui.welcome_virt_lines(),
      virt_lines_above = false,
    })
  end
end

local function scratch(name, ft, readonly)
  local b = vim.api.nvim_create_buf(false, true)
  vim.bo[b].buftype = "nofile"
  vim.bo[b].bufhidden = "hide"
  vim.bo[b].swapfile = false
  vim.bo[b].modeline = false
  vim.bo[b].filetype = ft
  if readonly then vim.bo[b].undolevels = -1 end
  pcall(vim.api.nvim_buf_set_name, b, name)
  return b
end

local function open_at_cursor()
  local token = vim.fn.expand("<cWORD>")
  if not token or token == "" then return end
  token = token:gsub("^[`\"'(%[<]+", ""):gsub("[`\"')%]>.,;:]+$", "")
  local path, line = token:match("^([%w%._%-%/]+%.[%w]+):(%d+)")
  if not path then path, line = token:match("^([%w%._%-%/]+%.[%w]+)#L(%d+)") end
  if not path then path = token:match("^([%w%._%-%/]+%.[%w]+)$") end
  if not path then return end
  local full = path:match("^/") and path or (vim.fn.getcwd() .. "/" .. path)
  if vim.fn.filereadable(full) == 0 then return end
  local target
  for _, w in ipairs(vim.api.nvim_tabpage_list_wins(0)) do
    if vim.bo[vim.api.nvim_win_get_buf(w)].buftype == "" then target = w break end
  end
  if target then
    vim.api.nvim_set_current_win(target)
    pcall(vim.cmd, "edit " .. vim.fn.fnameescape(full))
    if tonumber(line) then pcall(vim.api.nvim_win_set_cursor, 0, { tonumber(line), 0 }) end
  end
end

local function inspect_line()
  if not valid(M.tbuf) then return end
  local row = vim.api.nvim_win_get_cursor(0)[1] - 1
  for id, mark in pairs(M.marks) do
    local pos = vim.api.nvim_buf_get_extmark_by_id(M.tbuf, ns, mark, {})
    if pos[1] == row and M.details[id] and M.details[id] ~= "" then
      local lines = vim.split(M.details[id], "\n", { plain = true })
      ui.float("Tool output", lines)
      return
    end
  end
  vim.notify("LLeMbas: no tool output on this line", vim.log.levels.INFO)
end

local function yank_code_block()
  if not valid(M.tbuf) then return end
  local cur = vim.api.nvim_win_get_cursor(0)[1]
  local lines = vim.api.nvim_buf_get_lines(M.tbuf, 0, -1, false)
  local open_row, close_row, fence
  for i = cur, 1, -1 do
    local m = lines[i]:match("^%s*(`%`%`+)") or lines[i]:match("^%s*(~~~+)")
    if m then
      if i == cur then
        -- Cursor on fence line: check whether it opens or closes
        open_row, fence = i, m
      else
        open_row, fence = i, m
      end
      break
    end
  end
  if not open_row then return vim.notify("LLeMbas: cursor is not inside a code block", vim.log.levels.INFO) end
  local ch = fence:sub(1, 1)
  for j = open_row + 1, #lines do
    local trimmed = vim.trim(lines[j])
    if trimmed:sub(1, #fence) == fence and trimmed:match("^" .. ch .. "+$") then
      close_row = j
      break
    end
  end
  if not close_row or cur > close_row then
    return vim.notify("LLeMbas: cursor is not inside a code block", vim.log.levels.INFO)
  end
  local block = vim.list_slice(lines, open_row + 1, close_row - 1)
  local text = table.concat(block, "\n")
  vim.fn.setreg('"', text)
  pcall(vim.fn.setreg, "+", text)
  vim.notify(("LLeMbas: yanked %d line%s of code"):format(#block, #block == 1 and "" or "s"), vim.log.levels.INFO)
end

local function buffers()
  if not valid(M.tbuf) then
    M.tbuf = scratch("llembas://chat", "markdown", true)
    vim.bo[M.tbuf].modifiable = false
    M.marks = {}
    M.details = {}
    vim.keymap.set("n", "q", function() M.close() end, { buffer = M.tbuf, desc = "LLeMbas: close the panel" })
    vim.keymap.set("n", "<C-c>", function() if M.on_stop then M.on_stop() end end, { buffer = M.tbuf, desc = "LLeMbas: stop the turn" })
    vim.keymap.set("n", "<CR>", open_at_cursor, { buffer = M.tbuf, desc = "LLeMbas: open file:line under cursor" })
    vim.keymap.set("n", "gf", open_at_cursor, { buffer = M.tbuf, desc = "LLeMbas: open file:line under cursor" })
    vim.keymap.set("n", "K", inspect_line, { buffer = M.tbuf, desc = "LLeMbas: inspect tool output" })
    vim.keymap.set("n", "y", yank_code_block, { buffer = M.tbuf, desc = "LLeMbas: yank code block under cursor" })
    vim.keymap.set("n", "g?", function() if M.on_help then M.on_help() end end, { buffer = M.tbuf, desc = "LLeMbas: help" })
    vim.keymap.set("n", "i", function()
      local iw = win_of(M.ibuf)
      if iw then vim.api.nvim_set_current_win(iw); pcall(vim.cmd, "startinsert") end
    end, { buffer = M.tbuf, desc = "LLeMbas: jump to prompt" })
    sync_welcome()
  end
  if not valid(M.ibuf) then
    M.ibuf = scratch("llembas://prompt", "markdown", false)
    local function send()
      local text = table.concat(vim.api.nvim_buf_get_lines(M.ibuf, 0, -1, false), "\n")
      if not text:match("%S") then return end
      if M.on_send and M.on_send(text) ~= false then vim.api.nvim_buf_set_lines(M.ibuf, 0, -1, false, {}) end
    end
    vim.keymap.set("n", "<CR>", send, { buffer = M.ibuf, desc = "LLeMbas: send" })
    vim.keymap.set({ "n", "i" }, "<C-s>", send, { buffer = M.ibuf, desc = "LLeMbas: send" })
    vim.keymap.set({ "n", "i" }, "<C-c>", function() if M.on_stop then M.on_stop() end end, { buffer = M.ibuf, desc = "LLeMbas: stop the turn" })
    vim.keymap.set("n", "q", function() M.close() end, { buffer = M.ibuf, desc = "LLeMbas: close the panel" })
    vim.keymap.set("n", "g?", function() if M.on_help then M.on_help() end end, { buffer = M.ibuf, desc = "LLeMbas: help" })
    vim.keymap.set("n", "<C-k>", function()
      local tw = win_of(M.tbuf)
      if tw then vim.api.nvim_set_current_win(tw) end
    end, { buffer = M.ibuf, desc = "LLeMbas: focus transcript" })
    vim.keymap.set("i", "<C-x><C-f>", function() if M.on_files then M.on_files() end end, { buffer = M.ibuf, desc = "LLeMbas: insert @file" })
    vim.keymap.set("i", "<C-x><C-o>", function() if M.on_commands then M.on_commands() end end, { buffer = M.ibuf, desc = "LLeMbas: insert /command" })
  end
end

function M.is_open() return win_of(M.tbuf) ~= nil end

--- Open the panel (`opts` may be a width number or `{ width, position, prompt_height, border }`).
function M.open(opts, focus)
  buffers()
  local width = type(opts) == "number" and opts or (opts and opts.width) or 64
  local position = type(opts) == "table" and opts.position or "right"
  local prompt_h = type(opts) == "table" and opts.prompt_height or 5
  local border = type(opts) == "table" and opts.border or "rounded"
  local back = vim.api.nvim_get_current_win()
  local tw = win_of(M.tbuf)
  local iw = win_of(M.ibuf)

  if position == "float" then
    local u = vim.api.nvim_list_uis()[1]
    local cols = (u and u.width) or vim.o.columns or 120
    local rows = (u and u.height) or vim.o.lines or 36
    local w = math.min(math.max(width, 48), math.floor(cols * 0.85))
    local total_h = math.max(14, math.floor(rows * 0.8))
    local th = math.max(8, total_h - prompt_h - 3)
    local col = math.max(1, math.floor((cols - w) / 2))
    local row = math.max(1, math.floor((rows - total_h) / 2))
    if not tw then
      tw = vim.api.nvim_open_win(M.tbuf, true, {
        relative = "editor", width = w, height = th, row = row, col = col,
        style = "minimal", border = border, title = " ◈ LLeMbas ", title_pos = "center",
      })
      for k, v in pairs({ wrap = true, linebreak = true, number = false, relativenumber = false, signcolumn = "no" }) do
        vim.wo[tw][k] = v
      end
    end
    if not iw then
      iw = vim.api.nvim_open_win(M.ibuf, true, {
        relative = "editor", width = w, height = prompt_h, row = row + th + 2, col = col,
        style = "minimal", border = border, title = " Prompt (<CR>/<C-s> send · q close) ", title_pos = "left",
      })
      for k, v in pairs({ wrap = true, linebreak = true, number = false, relativenumber = false, signcolumn = "no" }) do
        vim.wo[iw][k] = v
      end
    end
  else
    if not tw then
      if position == "left" then vim.cmd("topleft vertical " .. width .. "split")
      elseif position == "bottom" then vim.cmd("botright " .. math.max(12, math.floor(vim.o.lines * 0.35)) .. "split")
      else vim.cmd("botright vertical " .. width .. "split") end
      tw = vim.api.nvim_get_current_win()
      vim.api.nvim_win_set_buf(tw, M.tbuf)
      for k, v in pairs({ wrap = true, linebreak = true, number = false, relativenumber = false, signcolumn = "no", winfixwidth = position ~= "bottom" }) do
        vim.wo[tw][k] = v
      end
    end
    if not iw then
      vim.api.nvim_set_current_win(tw)
      vim.cmd("belowright " .. prompt_h .. "split")
      iw = vim.api.nvim_get_current_win()
      vim.api.nvim_win_set_buf(iw, M.ibuf)
      for k, v in pairs({ wrap = true, linebreak = true, number = false, relativenumber = false, signcolumn = "no", winfixheight = true }) do
        vim.wo[iw][k] = v
      end
    end
  end

  if focus == false and vim.api.nvim_win_is_valid(back) then vim.api.nvim_set_current_win(back)
  elseif iw and vim.api.nvim_win_is_valid(iw) then vim.api.nvim_set_current_win(iw) end
end

function M.close()
  for _, b in ipairs({ M.ibuf, M.tbuf }) do
    local w = win_of(b)
    if w and #vim.api.nvim_tabpage_list_wins(0) > 1 then pcall(vim.api.nvim_win_close, w, true) end
  end
end

--- The header line above the transcript: brand, session title, mode, model, usage.
function M.header(text)
  local w = win_of(M.tbuf)
  if w then vim.wo[w].winbar = (text or ""):gsub("%%", "%%%%") end
end

--- The line above the prompt: what the next message carries, the mode, the model.
function M.status(text)
  local w = win_of(M.ibuf)
  if w then vim.wo[w].winbar = (text or ""):gsub("%%", "%%%%") end
end

local function edit(fn)
  buffers()
  local tw = win_of(M.tbuf)
  local last = vim.api.nvim_buf_line_count(M.tbuf)
  local follow = tw and vim.api.nvim_win_get_cursor(tw)[1] >= last
  vim.bo[M.tbuf].modifiable = true
  local ok, err = pcall(fn)
  vim.bo[M.tbuf].modifiable = false
  sync_welcome()
  if follow and tw and vim.api.nvim_win_is_valid(tw) then
    pcall(vim.api.nvim_win_set_cursor, tw, { vim.api.nvim_buf_line_count(M.tbuf), 0 })
  end
  if not ok then error(err, 0) end
end

local function highlight_lines(from_row, to_row, hl)
  if not hl or not valid(M.tbuf) then return end
  for r = from_row, to_row do
    pcall(vim.api.nvim_buf_set_extmark, M.tbuf, ns_hl, r, 0, { line_hl_group = hl })
  end
end

--- Add text at the end, continuing the last line. Optional `hl` highlights appended lines.
function M.append(text, hl)
  if not text or text == "" then return end
  edit(function()
    -- Inserted at the very end, so a line that is rewritten later keeps its mark.
    local parts = vim.split(text, "\n", { plain = true })
    local n = vim.api.nvim_buf_line_count(M.tbuf)
    local tail = vim.api.nvim_buf_get_lines(M.tbuf, n - 1, n, false)[1] or ""
    local start_row = n - 1
    vim.api.nvim_buf_set_text(M.tbuf, start_row, #tail, start_row, #tail, parts)
    if hl then
      local end_row = start_row + #parts - 1
      if parts[#parts] == "" and end_row > start_row then end_row = end_row - 1 end
      highlight_lines(start_row, end_row, hl)
    end
  end)
end

local function last_line()
  local n = vim.api.nvim_buf_line_count(M.tbuf)
  return n, vim.api.nvim_buf_get_lines(M.tbuf, n - 1, n, false)[1] or ""
end

--- Start a new line unless the transcript already ends on an empty one.
function M.newline()
  buffers()
  local n, tail = last_line()
  if tail ~= "" then M.append("\n") elseif n == 1 then return end
end

function M.section(title, hl)
  buffers()
  local n, tail = last_line()
  local first = (n == 1 and tail == "")
  if not first then
    M.newline()
    local _, t = last_line()
    local prev = vim.api.nvim_buf_get_lines(M.tbuf, -3, -2, false)[1]
    if t == "" and prev ~= "" then M.append("\n") end
  end
  local header_row = vim.api.nvim_buf_line_count(M.tbuf) - 1
  M.append("## " .. title .. "\n\n", hl)
  if not first and valid(M.tbuf) then
    pcall(vim.api.nvim_buf_set_extmark, M.tbuf, ns_hl, header_row, 0, {
      virt_lines = { { { "────────────────────────────────────────", "LLeMbasSeparator" } } },
      virt_lines_above = true,
    })
  end
end

--- One line that is rewritten later under the same `id` (a tool call, the plan).
function M.line(id, text, hl, detail)
  buffers()
  text = (text:gsub("[\r\n]+", " "))
  if detail ~= nil then M.details[id] = detail end
  local mark = M.marks[id]
  if mark then
    local pos = vim.api.nvim_buf_get_extmark_by_id(M.tbuf, ns, mark, {})
    if pos[1] then
      edit(function()
        local old = vim.api.nvim_buf_get_lines(M.tbuf, pos[1], pos[1] + 1, false)[1] or ""
        vim.api.nvim_buf_set_text(M.tbuf, pos[1], 0, pos[1], #old, { text })
        vim.api.nvim_buf_clear_namespace(M.tbuf, ns_hl, pos[1], pos[1] + 1)
        if hl then highlight_lines(pos[1], pos[1], hl) end
      end)
      return
    end
  end
  M.newline()
  M.append(text, hl)
  local n = vim.api.nvim_buf_line_count(M.tbuf)
  M.marks[id] = vim.api.nvim_buf_set_extmark(M.tbuf, ns, n - 1, 0, { right_gravity = false })
  M.append("\n")
end

function M.clear()
  buffers()
  M.marks = {}
  M.details = {}
  vim.bo[M.tbuf].modifiable = true
  vim.api.nvim_buf_clear_namespace(M.tbuf, ns, 0, -1)
  vim.api.nvim_buf_clear_namespace(M.tbuf, ns_hl, 0, -1)
  vim.api.nvim_buf_set_lines(M.tbuf, 0, -1, false, {})
  vim.bo[M.tbuf].modifiable = false
  sync_welcome()
end

function M.insert_prompt(text)
  buffers()
  local lines = vim.api.nvim_buf_get_lines(M.ibuf, 0, -1, false)
  local last = lines[#lines] or ""
  lines[#lines] = (last ~= "" and not last:match("%s$") and (last .. " " .. text)) or (last .. text)
  vim.api.nvim_buf_set_lines(M.ibuf, 0, -1, false, lines)
end

function M.text()
  buffers()
  return table.concat(vim.api.nvim_buf_get_lines(M.tbuf, 0, -1, false), "\n")
end

return M
