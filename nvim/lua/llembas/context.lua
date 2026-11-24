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

--- The diagnostics on lines `first..last`, as one text; nil when there are none.
function M.diagnostics(buf, first, last)
  local out = {}
  for _, d in ipairs(vim.diagnostic.get(buf)) do
    local l = d.lnum + 1
    if l >= first and l <= last and #out < 30 then
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
  local row = vim.api.nvim_win_get_cursor(0)[1]
  return { type = "text", text = ("Open in the editor: %s, cursor on line %d%s."):format(
    vim.fn.fnamemodify(name, ":."), row, vim.bo[buf].modified and " (the buffer has changes that are not saved)" or "") }
end

return M
