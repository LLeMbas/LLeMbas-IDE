-- Changes shown before they are made: a rewrite of a selection as hunks you accept or reject, and the
-- diff of an edit the agent asks permission for. What the model wrote is only ever put into a buffer
-- as text, and only when you accept it.
local M = {}
local ns = vim.api.nvim_create_namespace("llembas-diff")

local proposals = {} -- buf -> list of pending hunks { mark, mark2, hint, old_count, new, above }
local rewriting = {} -- buf -> active request id
local req_seq = 0
local written_by_id = {}

local function count(buf) return #(proposals[buf] or {}) end

local KEYS = { "ga", "gr", "gA", "gR", "]h", "[h" }
local saved = {} -- buf -> the buffer mappings these keys had before

local function unmap(buf)
  for _, k in ipairs(KEYS) do pcall(vim.keymap.del, "n", k, { buffer = buf }) end
  for _, before in ipairs(saved[buf] or {}) do pcall(vim.fn.mapset, "n", false, before) end
  saved[buf] = nil
end

local function drop(buf, hunk)
  pcall(vim.api.nvim_buf_del_extmark, buf, ns, hunk.mark)
  if hunk.mark2 then pcall(vim.api.nvim_buf_del_extmark, buf, ns, hunk.mark2) end
  if hunk.hint then pcall(vim.api.nvim_buf_del_extmark, buf, ns, hunk.hint) end
  local list = proposals[buf] or {}
  for i, h in ipairs(list) do if h == hunk then table.remove(list, i) break end end
  if #list == 0 then
    proposals[buf] = nil
    unmap(buf)
  end
end

local function row_of(buf, hunk)
  local pos = vim.api.nvim_buf_get_extmark_by_id(buf, ns, hunk.mark, {})
  return pos[1]
end

local function apply(buf, hunk)
  local pos = vim.api.nvim_buf_get_extmark_by_id(buf, ns, hunk.mark, { details = true })
  local row = pos[1]
  if not row then return drop(buf, hunk) end
  if hunk.old_count > 0 then
    -- What the mark covers now, not what it covered when shown: lines you removed since are not removed twice.
    local last = (pos[3] or {}).end_row or row
    if last <= row then
      drop(buf, hunk)
      return vim.notify("LLeMbas: the lines of that change are gone; it was dropped", vim.log.levels.WARN)
    end
    vim.api.nvim_buf_set_lines(buf, row, last, false, hunk.new)
  elseif hunk.above then
    vim.api.nvim_buf_set_lines(buf, row, row, false, hunk.new)
  else
    vim.api.nvim_buf_set_lines(buf, row + 1, row + 1, false, hunk.new)
  end
  drop(buf, hunk)
end

--- The pending hunk the cursor is on, else the next one below, else the last.
local function nearest(buf)
  local list = proposals[buf] or {}
  local cur = vim.api.nvim_win_get_cursor(0)[1] - 1
  local best
  for _, h in ipairs(list) do
    local row = row_of(buf, h)
    if row then
      if cur >= row and cur < row + math.max(h.old_count, 1) then return h end
      if row >= cur and (not best or row < row_of(buf, best)) then best = h end
    end
  end
  return best or list[#list]
end

function M.next_hunk()
  local buf = vim.api.nvim_get_current_buf()
  local list = proposals[buf] or {}
  if #list == 0 then return end
  local rows = {}
  for _, h in ipairs(list) do
    local r = row_of(buf, h)
    if r then rows[#rows + 1] = r end
  end
  table.sort(rows)
  local cur = vim.api.nvim_win_get_cursor(0)[1] - 1
  for _, r in ipairs(rows) do
    if r > cur then return pcall(vim.api.nvim_win_set_cursor, 0, { r + 1, 0 }) end
  end
  if rows[1] then pcall(vim.api.nvim_win_set_cursor, 0, { rows[1] + 1, 0 }) end
end

function M.prev_hunk()
  local buf = vim.api.nvim_get_current_buf()
  local list = proposals[buf] or {}
  if #list == 0 then return end
  local rows = {}
  for _, h in ipairs(list) do
    local r = row_of(buf, h)
    if r then rows[#rows + 1] = r end
  end
  table.sort(rows)
  local cur = vim.api.nvim_win_get_cursor(0)[1] - 1
  for i = #rows, 1, -1 do
    if rows[i] < cur then return pcall(vim.api.nvim_win_set_cursor, 0, { rows[i] + 1, 0 }) end
  end
  if rows[#rows] then pcall(vim.api.nvim_win_set_cursor, 0, { rows[#rows] + 1, 0 }) end
end

function M.accept(all)
  local buf = vim.api.nvim_get_current_buf()
  if all then
    -- From the bottom up, so no accepted hunk moves one still waiting above it by more than its mark knows.
    local list = vim.list_slice(proposals[buf] or {})
    table.sort(list, function(a, b) return (row_of(buf, a) or 0) > (row_of(buf, b) or 0) end)
    for _, h in ipairs(list) do apply(buf, h) end
  else
    local h = nearest(buf)
    if h then apply(buf, h) end
  end
end

function M.reject(all)
  local buf = vim.api.nvim_get_current_buf()
  if all then
    for _, h in ipairs(vim.list_slice(proposals[buf] or {})) do drop(buf, h) end
  else
    local h = nearest(buf)
    if h then drop(buf, h) end
  end
end

function M.pending(buf) return count(buf or vim.api.nvim_get_current_buf()) end

local function virt(lines)
  local out = {}
  for _, l in ipairs(lines) do out[#out + 1] = { { l == "" and " " or l, "LLeMbasDiffAdd" } } end
  return out
end

--- Show `new` (a list of lines) as a proposed replacement of lines `first..last` of `buf`, hunk by hunk.
--- Returns the number of hunks (0: nothing would change).
function M.propose(buf, first, last, new)
  require("llembas.ui").setup_highlights()
  local old = vim.api.nvim_buf_get_lines(buf, first - 1, last, false)
  local hunks = vim.diff(table.concat(old, "\n") .. "\n", table.concat(new, "\n") .. "\n", { result_type = "indices" })
  if #hunks == 0 then return 0 end
  proposals[buf] = proposals[buf] or {}
  for i, h in ipairs(hunks) do
    local a_start, a_count, b_start, b_count = h[1], h[2], h[3], h[4]
    local lines = vim.list_slice(new, b_start, b_start + b_count - 1)
    local hunk = { old_count = a_count, new = lines }
    local hint_row
    if a_count > 0 then
      local row = first - 1 + a_start - 1
      hint_row = row
      hunk.mark = vim.api.nvim_buf_set_extmark(buf, ns, row, 0, {
        end_row = row + a_count, hl_group = "LLeMbasDiffDelete", hl_eol = true, right_gravity = false })
      if #lines > 0 then
        hunk.mark2 = vim.api.nvim_buf_set_extmark(buf, ns, row + a_count - 1, 0, { virt_lines = virt(lines) })
      end
    else
      -- Lines added and none taken away: after old line `a_start`, or above the first when it is 0.
      local row = first - 1 + a_start - 1
      hunk.above = a_start == 0
      if hunk.above then row = first - 1 end
      row = math.min(math.max(row, 0), math.max(vim.api.nvim_buf_line_count(buf) - 1, 0))
      hint_row = row
      hunk.mark = vim.api.nvim_buf_set_extmark(buf, ns, row, 0, {
        virt_lines = virt(lines), virt_lines_above = hunk.above, right_gravity = false })
    end
    if i == 1 and hint_row then
      local label = #hunks > 1
        and ("  ◈ LLeMbas (%d changes): ga accept · gr reject · gA/gR all · ]h/[h jump"):format(#hunks)
        or "  ◈ LLeMbas: ga accept · gr reject"
      hunk.hint = vim.api.nvim_buf_set_extmark(buf, ns, hint_row, 0, {
        virt_text = { { label, "LLeMbasDiffHint" } },
        virt_text_pos = "eol",
      })
    end
    table.insert(proposals[buf], hunk)
  end
  if not saved[buf] then
    saved[buf] = {}
    for _, k in ipairs(KEYS) do
      local before = vim.fn.maparg(k, "n", false, true)
      if next(before) and before.buffer == 1 then table.insert(saved[buf], before) end
    end
  end
  local function map(k, fn, desc) vim.keymap.set("n", k, fn, { buffer = buf, desc = desc, nowait = true }) end
  map("ga", function() M.accept(false) end, "LLeMbas: accept this change")
  map("gr", function() M.reject(false) end, "LLeMbas: reject this change")
  map("gA", function() M.accept(true) end, "LLeMbas: accept all changes")
  map("gR", function() M.reject(true) end, "LLeMbas: reject all changes")
  map("]h", function() M.next_hunk() end, "LLeMbas: next proposed change")
  map("[h", function() M.prev_hunk() end, "LLeMbas: previous proposed change")
  return #hunks
end

--- A buffer was reloaded from disk: what was proposed for its old text is void.
function M.forget(buf)
  for _, h in ipairs(vim.list_slice(proposals[buf] or {})) do drop(buf, h) end
end

--- The agent says how far a rewrite has got.
function M.delta(params)
  local id = (params and params.id) or "default"
  written_by_id[id] = (written_by_id[id] or 0) + #((params and params.delta) or "")
  vim.api.nvim_echo({ { ("LLeMbas is rewriting… %d characters"):format(written_by_id[id]), "Comment" } }, false, {})
end

--- Cancel an in-flight rewrite or generation in the current buffer.
function M.cancel(buf)
  buf = buf or vim.api.nvim_get_current_buf()
  local id = rewriting[buf]
  if not id then return false end
  rewriting[buf] = nil
  written_by_id[id] = nil
  local conn = require("llembas")._state.conn
  if conn then conn:notify("_lembas/edit/cancel", { id = id }) end
  vim.api.nvim_echo({ { "" } }, false, {})
  vim.notify("LLeMbas: cancelled the rewrite", vim.log.levels.INFO)
  return true
end

local function run_edit(buf, first, last, instruction, verb)
  local L = require("llembas")
  if count(buf) > 0 then
    return vim.notify("LLeMbas: accept or reject the changes shown first (ga / gr, gA / gR)", vim.log.levels.WARN)
  end
  if rewriting[buf] then
    return vim.notify("LLeMbas: a rewrite of this buffer is already running (:LLeMbasCancelEdit cancels it)", vim.log.levels.WARN)
  end
  local name = vim.api.nvim_buf_get_name(buf)
  local text = vim.api.nvim_buf_get_lines(buf, first - 1, last, false)
  local before = vim.api.nvim_buf_get_lines(buf, math.max(0, first - 41), first - 1, false)
  local after = vim.api.nvim_buf_get_lines(buf, last, last + 40, false)
  local tick = vim.api.nvim_buf_get_changedtick(buf)
  req_seq = req_seq + 1
  local id = ("e%d"):format(req_seq)
  rewriting[buf] = id
  written_by_id[id] = 0
  vim.api.nvim_echo({ { "LLeMbas is " .. verb .. "…", "Comment" } }, false, {})
  L._connect(function(conn)
    if not conn then
      rewriting[buf] = nil
      written_by_id[id] = nil
      return vim.notify("LLeMbas: the agent did not start", vim.log.levels.ERROR)
    end
    local body_text = table.concat(text, "\n")
    if body_text == "" then body_text = " " end
    conn:request("_lembas/edit", {
      id = id, cwd = vim.fn.getcwd(), sessionId = L._state.session, path = name ~= "" and name or nil,
      text = body_text, before = table.concat(before, "\n"), after = table.concat(after, "\n"),
      language = vim.bo[buf].filetype, instruction = instruction, model = L.config.model,
    }, function(err, r)
      if rewriting[buf] == id then rewriting[buf] = nil end
      written_by_id[id] = nil
      vim.api.nvim_echo({ { "" } }, false, {})
      if err then return vim.notify("LLeMbas: " .. tostring(err.message), vim.log.levels.ERROR) end
      if not r or r.cancelled or not vim.api.nvim_buf_is_valid(buf) then return end
      if vim.api.nvim_buf_get_changedtick(buf) ~= tick then
        return vim.notify("LLeMbas: the buffer changed while the rewrite was written; nothing is shown. Ask again.", vim.log.levels.WARN)
      end
      local new = vim.split(((r or {}).text or ""):gsub("\r\n", "\n"), "\n", { plain = true })
      if new[#new] == "" and #new > 1 then table.remove(new) end
      local n = M.propose(buf, first, last, new)
      if n == 0 then return vim.notify("LLeMbas: the rewrite changes nothing", vim.log.levels.INFO) end
      vim.notify(("LLeMbas: %d change%s shown. ga accepts, gr rejects, gA / gR all."):format(n, n == 1 and "" or "s"), vim.log.levels.INFO)
    end)
  end)
end

--- Have lines `first..last` rewritten as `instruction` says, and show the result as hunks.
function M.rewrite(buf, first, last, instruction)
  run_edit(buf, first, last, instruction, "rewriting")
end

--- Generate code at 1-based `row` as `instruction` says, and show the result as hunks.
function M.generate(buf, row, instruction)
  run_edit(buf, row, row, "At this line, " .. instruction, "generating")
end

--- An approval card that carries diffs (ACP `diff` content): shown in a window of its own while the
--- question is open. Returns a function that closes it, or nil when there was nothing to show.
function M.preview(content)
  local out = {}
  for _, c in ipairs(content or {}) do
    if type(c) == "table" and c.type == "diff" and type(c.newText) == "string" then
      out[#out + 1] = "--- " .. (tostring(c.path or "?"):gsub("[\r\n]+", " "))
      local d = vim.diff((c.oldText or "") .. "\n", c.newText .. "\n", { result_type = "unified", ctxlen = 3 })
      vim.list_extend(out, vim.split(d ~= "" and d or "(no change)", "\n", { plain = true, trimempty = true }))
    end
  end
  if #out == 0 then return nil end
  local back = vim.api.nvim_get_current_win()
  local b = vim.api.nvim_create_buf(false, true)
  vim.bo[b].buftype, vim.bo[b].bufhidden, vim.bo[b].swapfile, vim.bo[b].modeline = "nofile", "wipe", false, false
  vim.bo[b].undolevels = -1
  vim.api.nvim_buf_set_lines(b, 0, -1, false, out)
  vim.bo[b].filetype, vim.bo[b].modifiable = "diff", false
  vim.cmd("botright " .. math.min(#out + 1, 18) .. "split")
  local w = vim.api.nvim_get_current_win()
  vim.api.nvim_win_set_buf(w, b)
  vim.wo[w].winbar = " ◈ LLeMbas proposed diff "
  if vim.api.nvim_win_is_valid(back) then vim.api.nvim_set_current_win(back) end
  return function() if vim.api.nvim_win_is_valid(w) then pcall(vim.api.nvim_win_close, w, true) end end
end

return M
