-- Changes shown before they are made: a rewrite of a selection as hunks you accept or reject, and the
-- diff of an edit the agent asks permission for. What the model wrote is only ever put into a buffer
-- as text, and only when you accept it.
local M = {}
local ns = vim.api.nvim_create_namespace("llembas-diff")

local proposals = {} -- buf -> list of pending hunks { mark, old_count, new, above }

local function count(buf) return #(proposals[buf] or {}) end

local function unmap(buf)
  for _, k in ipairs({ "ga", "gr", "gA", "gR" }) do pcall(vim.keymap.del, "n", k, { buffer = buf }) end
end

local function drop(buf, hunk)
  pcall(vim.api.nvim_buf_del_extmark, buf, ns, hunk.mark)
  if hunk.mark2 then pcall(vim.api.nvim_buf_del_extmark, buf, ns, hunk.mark2) end
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
  local row = row_of(buf, hunk)
  if not row then return drop(buf, hunk) end
  if hunk.old_count > 0 then
    vim.api.nvim_buf_set_lines(buf, row, row + hunk.old_count, false, hunk.new)
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
  for _, l in ipairs(lines) do out[#out + 1] = { { l == "" and " " or l, "DiffAdd" } } end
  return out
end

--- Show `new` (a list of lines) as a proposed replacement of lines `first..last` of `buf`, hunk by hunk.
--- Returns the number of hunks (0: nothing would change).
function M.propose(buf, first, last, new)
  local old = vim.api.nvim_buf_get_lines(buf, first - 1, last, false)
  local hunks = vim.diff(table.concat(old, "\n") .. "\n", table.concat(new, "\n") .. "\n", { result_type = "indices" })
  if #hunks == 0 then return 0 end
  proposals[buf] = proposals[buf] or {}
  for _, h in ipairs(hunks) do
    local a_start, a_count, b_start, b_count = h[1], h[2], h[3], h[4]
    local lines = vim.list_slice(new, b_start, b_start + b_count - 1)
    local hunk = { old_count = a_count, new = lines }
    if a_count > 0 then
      local row = first - 1 + a_start - 1
      hunk.mark = vim.api.nvim_buf_set_extmark(buf, ns, row, 0, {
        end_row = row + a_count, hl_group = "DiffDelete", hl_eol = true, right_gravity = false })
      if #lines > 0 then
        hunk.mark2 = vim.api.nvim_buf_set_extmark(buf, ns, row + a_count - 1, 0, { virt_lines = virt(lines) })
      end
    else
      -- Lines added and none taken away: after old line `a_start`, or above the first when it is 0.
      local row = first - 1 + a_start - 1
      hunk.above = a_start == 0
      if hunk.above then row = first - 1 end
      row = math.min(math.max(row, 0), math.max(vim.api.nvim_buf_line_count(buf) - 1, 0))
      hunk.mark = vim.api.nvim_buf_set_extmark(buf, ns, row, 0, {
        virt_lines = virt(lines), virt_lines_above = hunk.above, right_gravity = false })
    end
    table.insert(proposals[buf], hunk)
  end
  local function map(k, fn, desc) vim.keymap.set("n", k, fn, { buffer = buf, desc = desc, nowait = true }) end
  map("ga", function() M.accept(false) end, "LLeMbas: accept this change")
  map("gr", function() M.reject(false) end, "LLeMbas: reject this change")
  map("gA", function() M.accept(true) end, "LLeMbas: accept all changes")
  map("gR", function() M.reject(true) end, "LLeMbas: reject all changes")
  return #hunks
end

local written = 0
--- The agent says how far a rewrite has got.
function M.delta(params)
  written = written + #(params.delta or "")
  vim.api.nvim_echo({ { ("LLeMbas is rewriting… %d characters"):format(written), "Comment" } }, false, {})
end

--- Have lines `first..last` rewritten as `instruction` says, and show the result as hunks.
function M.rewrite(buf, first, last, instruction)
  local L = require("llembas")
  if count(buf) > 0 then
    return vim.notify("LLeMbas: accept or reject the changes shown first (ga / gr, gA / gR)", vim.log.levels.WARN)
  end
  local name = vim.api.nvim_buf_get_name(buf)
  local text = vim.api.nvim_buf_get_lines(buf, first - 1, last, false)
  local before = vim.api.nvim_buf_get_lines(buf, math.max(0, first - 41), first - 1, false)
  local after = vim.api.nvim_buf_get_lines(buf, last, last + 40, false)
  local tick = vim.api.nvim_buf_get_changedtick(buf)
  written = 0
  vim.api.nvim_echo({ { "LLeMbas is rewriting…", "Comment" } }, false, {})
  L._connect(function(conn)
    if not conn then return vim.notify("LLeMbas: the agent did not start", vim.log.levels.ERROR) end
    conn:request("_lembas/edit", {
      id = ("e%d"):format(tick), cwd = vim.fn.getcwd(), sessionId = L._state.session, path = name,
      text = table.concat(text, "\n"), before = table.concat(before, "\n"), after = table.concat(after, "\n"),
      language = vim.bo[buf].filetype, instruction = instruction, model = L.config.model,
    }, function(err, r)
      vim.api.nvim_echo({ { "" } }, false, {})
      if err then return vim.notify("LLeMbas: " .. tostring(err.message), vim.log.levels.ERROR) end
      if not vim.api.nvim_buf_is_valid(buf) then return end
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

--- An approval card that carries diffs (ACP `diff` content): shown in a window of its own while the
--- question is open. Returns a function that closes it, or nil when there was nothing to show.
function M.preview(content)
  local out = {}
  for _, c in ipairs(content or {}) do
    if type(c) == "table" and c.type == "diff" and type(c.newText) == "string" then
      out[#out + 1] = "--- " .. tostring(c.path or "?")
      local d = vim.diff((c.oldText or "") .. "\n", c.newText .. "\n", { result_type = "unified", ctxlen = 3 })
      vim.list_extend(out, vim.split(d ~= "" and d or "(no change)", "\n", { plain = true, trimempty = true }))
    end
  end
  if #out == 0 then return nil end
  local back = vim.api.nvim_get_current_win()
  local b = vim.api.nvim_create_buf(false, true)
  vim.bo[b].buftype, vim.bo[b].bufhidden, vim.bo[b].swapfile, vim.bo[b].modeline = "nofile", "wipe", false, false
  vim.api.nvim_buf_set_lines(b, 0, -1, false, out)
  vim.bo[b].filetype, vim.bo[b].modifiable = "diff", false
  vim.cmd("botright " .. math.min(#out + 1, 18) .. "split")
  local w = vim.api.nvim_get_current_win()
  vim.api.nvim_win_set_buf(w, b)
  if vim.api.nvim_win_is_valid(back) then vim.api.nvim_set_current_win(back) end
  return function() if vim.api.nvim_win_is_valid(w) then pcall(vim.api.nvim_win_close, w, true) end end
end

return M
