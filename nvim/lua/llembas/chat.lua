-- The chat panel: a transcript nobody types in and a prompt under it. What the model writes is put
-- there as text and nothing else: it is never run, and modelines are off in both buffers.
local M = { tbuf = nil, ibuf = nil, marks = {}, on_send = nil, on_stop = nil }
local ns = vim.api.nvim_create_namespace("llembas")

local function valid(b) return b and vim.api.nvim_buf_is_valid(b) end

local function win_of(buf)
  if not valid(buf) then return nil end
  for _, w in ipairs(vim.api.nvim_tabpage_list_wins(0)) do
    if vim.api.nvim_win_get_buf(w) == buf then return w end
  end
end

local function scratch(name, ft)
  local b = vim.api.nvim_create_buf(false, true)
  vim.bo[b].buftype = "nofile"
  vim.bo[b].bufhidden = "hide"
  vim.bo[b].swapfile = false
  vim.bo[b].modeline = false
  vim.bo[b].filetype = ft
  pcall(vim.api.nvim_buf_set_name, b, name)
  return b
end

local function buffers()
  if not valid(M.tbuf) then
    M.tbuf = scratch("llembas://chat", "markdown")
    vim.bo[M.tbuf].modifiable = false
    M.marks = {}
  end
  if not valid(M.ibuf) then
    M.ibuf = scratch("llembas://prompt", "markdown")
    local function send()
      local text = table.concat(vim.api.nvim_buf_get_lines(M.ibuf, 0, -1, false), "\n")
      if not text:match("%S") then return end
      if M.on_send and M.on_send(text) ~= false then vim.api.nvim_buf_set_lines(M.ibuf, 0, -1, false, {}) end
    end
    vim.keymap.set("n", "<CR>", send, { buffer = M.ibuf, desc = "LLeMbas: send" })
    vim.keymap.set({ "n", "i" }, "<C-s>", send, { buffer = M.ibuf, desc = "LLeMbas: send" })
    vim.keymap.set("n", "<C-c>", function() if M.on_stop then M.on_stop() end end, { buffer = M.ibuf, desc = "LLeMbas: stop the turn" })
    vim.keymap.set("n", "q", function() M.close() end, { buffer = M.ibuf, desc = "LLeMbas: close the panel" })
    vim.keymap.set("n", "q", function() M.close() end, { buffer = M.tbuf, desc = "LLeMbas: close the panel" })
    local function open_at_cursor()
      local token = vim.fn.expand("<cWORD>")
      if not token or token == "" then return end
      token = token:gsub("^[`\"'(%[<]+", ""):gsub("[`\"')%]>.,;:]+$", "")
      local path, line = token:match("^([%w%._%-%/]+%.[%w]+):(%d+)")
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
    vim.keymap.set("n", "<CR>", open_at_cursor, { buffer = M.tbuf, desc = "LLeMbas: open file:line under cursor" })
    vim.keymap.set("n", "gf", open_at_cursor, { buffer = M.tbuf, desc = "LLeMbas: open file:line under cursor" })
  end
end

function M.is_open() return win_of(M.tbuf) ~= nil end

--- Open the panel (a column on the right: the transcript, and the prompt under it).
function M.open(width, focus)
  buffers()
  local back = vim.api.nvim_get_current_win()
  local tw = win_of(M.tbuf)
  if not tw then
    vim.cmd("botright vertical " .. width .. "split")
    tw = vim.api.nvim_get_current_win()
    vim.api.nvim_win_set_buf(tw, M.tbuf)
    for k, v in pairs({ wrap = true, linebreak = true, number = false, relativenumber = false, signcolumn = "no", winfixwidth = true }) do
      vim.wo[tw][k] = v
    end
  end
  local iw = win_of(M.ibuf)
  if not iw then
    vim.api.nvim_set_current_win(tw)
    vim.cmd("belowright 5split")
    iw = vim.api.nvim_get_current_win()
    vim.api.nvim_win_set_buf(iw, M.ibuf)
    for k, v in pairs({ wrap = true, linebreak = true, number = false, relativenumber = false, signcolumn = "no", winfixheight = true }) do
      vim.wo[iw][k] = v
    end
  end
  if focus == false and vim.api.nvim_win_is_valid(back) then vim.api.nvim_set_current_win(back)
  else vim.api.nvim_set_current_win(iw) end
end

function M.close()
  for _, b in ipairs({ M.ibuf, M.tbuf }) do
    local w = win_of(b)
    if w and #vim.api.nvim_tabpage_list_wins(0) > 1 then pcall(vim.api.nvim_win_close, w, true) end
  end
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
  if follow and tw and vim.api.nvim_win_is_valid(tw) then
    pcall(vim.api.nvim_win_set_cursor, tw, { vim.api.nvim_buf_line_count(M.tbuf), 0 })
  end
  if not ok then error(err, 0) end
end

--- Add text at the end, continuing the last line.
function M.append(text)
  if not text or text == "" then return end
  edit(function()
    -- Inserted at the very end, so a line that is rewritten later keeps its mark.
    local parts = vim.split(text, "\n", { plain = true })
    local n = vim.api.nvim_buf_line_count(M.tbuf)
    local tail = vim.api.nvim_buf_get_lines(M.tbuf, n - 1, n, false)[1] or ""
    vim.api.nvim_buf_set_text(M.tbuf, n - 1, #tail, n - 1, #tail, parts)
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

function M.section(title)
  buffers()
  local n, tail = last_line()
  if not (n == 1 and tail == "") then
    M.newline()
    local _, t = last_line()
    local prev = vim.api.nvim_buf_get_lines(M.tbuf, -3, -2, false)[1]
    if t == "" and prev ~= "" then M.append("\n") end
  end
  M.append("## " .. title .. "\n\n")
end

--- One line that is rewritten later under the same `id` (a tool call, the plan).
function M.line(id, text)
  buffers()
  text = (text:gsub("[\r\n]+", " "))
  local mark = M.marks[id]
  if mark then
    local pos = vim.api.nvim_buf_get_extmark_by_id(M.tbuf, ns, mark, {})
    if pos[1] then
      edit(function()
        local old = vim.api.nvim_buf_get_lines(M.tbuf, pos[1], pos[1] + 1, false)[1] or ""
        vim.api.nvim_buf_set_text(M.tbuf, pos[1], 0, pos[1], #old, { text })
      end)
      return
    end
  end
  M.newline()
  M.append(text)
  local n = vim.api.nvim_buf_line_count(M.tbuf)
  M.marks[id] = vim.api.nvim_buf_set_extmark(M.tbuf, ns, n - 1, 0, { right_gravity = false })
  M.append("\n")
end

function M.clear()
  buffers()
  M.marks = {}
  vim.bo[M.tbuf].modifiable = true
  vim.api.nvim_buf_clear_namespace(M.tbuf, ns, 0, -1)
  vim.api.nvim_buf_set_lines(M.tbuf, 0, -1, false, {})
  vim.bo[M.tbuf].modifiable = false
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
