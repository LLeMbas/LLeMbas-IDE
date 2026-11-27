-- What the editor knows and the agent is told: the file, the selection, the diagnostics on it.
local M = {}

local function uri_of(buf)
  local name = vim.api.nvim_buf_get_name(buf)
  if name == "" then return nil, nil end
  return vim.uri_from_fname(name), name
end

--- Lines `first..last` (1-based, inclusive) of `buf` as prompt blocks: a sentence saying where the
--- text is from, and the text itself as an embedded resource. The text is the buffer's, saved or not.
function M.selection(buf, first, last)
  local lines = vim.api.nvim_buf_get_lines(buf, first - 1, last, false)
  local uri, name = uri_of(buf)
  local where = name and vim.fn.fnamemodify(name, ":.") or "an unnamed buffer"
  local ft = vim.bo[buf].filetype
  local head = ("Selected in the editor: %s, lines %d-%d%s%s."):format(
    where, first, last, ft ~= "" and (" (" .. ft .. ")") or "",
    vim.bo[buf].modified and ", not saved yet" or "")
  local blocks = { { type = "text", text = head } }
  blocks[#blocks + 1] = {
    type = "resource",
    resource = { uri = (uri or "untitled:buffer") .. "#L" .. first .. "-" .. last, mimeType = "text/plain", text = table.concat(lines, "\n") },
  }
  local diags = M.diagnostics(buf, first, last)
  if diags then blocks[#blocks + 1] = { type = "text", text = diags } end
  return blocks
end

--- The diagnostics on lines `first..last` (or the whole buffer when nil), as one text; nil when none.
function M.diagnostics(buf, first, last)
  local out = {}
  for _, d in ipairs(vim.diagnostic.get(buf)) do
    local l = d.lnum + 1
    local in_range = (not first or not last) or (l >= first and l <= last)
    if in_range and #out < 30 then
      local sev = vim.diagnostic.severity[d.severity] or "INFO"
      out[#out + 1] = ("- line %d, %s%s: %s"):format(l, sev:lower(), d.source and (" (" .. d.source .. ")") or "", (d.message:gsub("%s+", " ")))
    end
  end
  if #out == 0 then return nil end
  return "Diagnostics the editor shows there:\n" .. table.concat(out, "\n")
end

--- The file in `buf` named to the agent, without its text (the agent reads it itself).
function M.file(buf)
  local _, name = uri_of(buf)
  if not name then return nil end
  local win = vim.fn.bufwinid(buf)
  local row = win ~= -1 and vim.api.nvim_win_get_cursor(win)[1] or 1
  return { type = "text", text = ("Open in the editor: %s, cursor on line %d%s."):format(
    vim.fn.fnamemodify(name, ":."), row, vim.bo[buf].modified and " (the buffer has changes that are not saved)" or "") }
end

--- The same as data, for an agent that takes it so (`_meta.lembas.editor`): the file, the cursor,
--- diagnostics (selected lines, or buffer errors/warnings when nothing is selected), and open files.
--- Lines are 1-based, inclusive.
function M.editor(buf, first, last)
  local _, name = uri_of(buf)
  local out = {}
  if name then out.path = name end
  local win = vim.fn.bufwinid(buf)
  if win ~= -1 then out.cursor = { line = vim.api.nvim_win_get_cursor(win)[1] } end
  if first and last then
    out.selection = { path = name, start = first, ["end"] = last,
      text = table.concat(vim.api.nvim_buf_get_lines(buf, first - 1, last, false), "\n") }
  end
  local raw = vim.diagnostic.get(buf)
  table.sort(raw, function(a, b)
    if (a.severity or 9) ~= (b.severity or 9) then return (a.severity or 9) < (b.severity or 9) end
    return (a.lnum or 0) < (b.lnum or 0)
  end)
  local diags = {}
  for _, d in ipairs(raw) do
    local l = d.lnum + 1
    local keep
    if first and last then
      keep = l >= first and l <= last
    else
      keep = (d.severity or vim.diagnostic.severity.INFO) <= vim.diagnostic.severity.WARN
    end
    if keep and #diags < 20 then
      diags[#diags + 1] = { path = name, line = l, severity = (vim.diagnostic.severity[d.severity] or "INFO"):lower(),
        message = (d.message:gsub("%s+", " ")):sub(1, 300), source = d.source }
    end
  end
  if #diags > 0 then out.diagnostics = diags end
  local open = {}
  local seen = {}
  if name then seen[name] = true end
  for _, b in ipairs(vim.api.nvim_list_bufs()) do
    if #open >= 30 then break end
    if b ~= buf and vim.api.nvim_buf_is_loaded(b) and vim.bo[b].buftype == "" then
      local p = vim.api.nvim_buf_get_name(b)
      if p ~= "" and not seen[p] then
        seen[p] = true
        open[#open + 1] = p
      end
    end
  end
  if #open > 0 then out.open = open end
  if next(out) == nil then return nil end
  return out
end

--- The loaded buffer that holds exactly this file, or nil. By the full name, never by a pattern:
--- `README` must not find `README.md`.
function M.buffer_of(path)
  local want = vim.fs.normalize(vim.fn.fnamemodify(path, ":p"))
  for _, b in ipairs(vim.api.nvim_list_bufs()) do
    if vim.api.nvim_buf_is_loaded(b) and vim.bo[b].buftype == "" then
      local name = vim.api.nvim_buf_get_name(b)
      if name ~= "" and vim.fs.normalize(name) == want then return b end
    end
  end
end

--- The agent writes a file (ACP `fs/write_text_file`): one that is open here gets the text in its
--- buffer and is saved at once, so the buffer and the disk agree when the agent is answered. A file
--- that is not open is refused, and the agent writes the disk itself.
function M.write_for_agent(params, reply)
  local path, content = params.path, params.content
  if type(path) ~= "string" or type(content) ~= "string" then return reply(nil, { code = -32602, message = "no path or no text" }) end
  local buf = M.buffer_of(path)
  if not buf then return reply(nil, { code = -32002, message = "not open in the editor" }) end
  if not vim.bo[buf].modifiable or vim.bo[buf].readonly then
    return reply(nil, { code = -32002, message = "the editor holds that file read-only" })
  end
  local lines = vim.split((content:gsub("\r\n", "\n")), "\n", { plain = true })
  if lines[#lines] == "" and #lines > 1 then table.remove(lines) end
  vim.api.nvim_buf_set_lines(buf, 0, -1, false, lines)
  -- Saved as it is: no autocommand (a formatter) may change what the agent believes it wrote.
  local ok, err = pcall(vim.api.nvim_buf_call, buf, function() vim.cmd("silent noautocmd write!") end)
  if not ok then return reply(nil, { code = -32002, message = "the editor could not save it: " .. tostring(err) }) end
  reply(vim.NIL)
end

--- The agent asks for a file's text (ACP `fs/read_text_file`): a file open here is answered from its
--- buffer, saved or not, so the agent sees what you see. Anything else is read from disk.
function M.read_for_agent(params, reply)
  local path = params.path
  if type(path) ~= "string" or path == "" then return reply(nil, { code = -32602, message = "no path" }) end
  local lines
  local buf = M.buffer_of(path)
  if buf then
    lines = vim.api.nvim_buf_get_lines(buf, 0, -1, false)
  else
    local ok, read = pcall(vim.fn.readfile, path)
    if not ok then return reply(nil, { code = -32002, message = "cannot read " .. path }) end
    lines = read
  end
  local first = math.max(1, tonumber(params.line) or 1)
  local last = params.limit and (first + tonumber(params.limit) - 1) or #lines
  reply({ content = table.concat(vim.list_slice(lines, first, last), "\n") })
end

return M
