-- Suggestions as you type, and on a key. The text comes from the LLeMbas CLI (`_lembas/complete`),
-- which asks your server's autocomplete model. A suggestion is drawn as virtual text and becomes part
-- of the buffer only when you accept it; what the model wrote is never run.
local M = {}
local ns = vim.api.nvim_create_namespace("llembas-complete")

local st = { timer = nil, seq = 0, asked = nil, shown = nil, off = nil, said = false }

local PREFIX_MAX, SUFFIX_MAX = 16000, 4000

local function L() return require("llembas") end

--- Whether you are typing (insert mode). A function of its own so the tests, which cannot stay in
--- insert mode in a headless run, can say yes.
function M._typing() return vim.api.nvim_get_mode().mode:sub(1, 1) == "i" end

function M.clear()
  if st.shown then
    pcall(vim.api.nvim_buf_del_extmark, st.shown.buf, ns, st.shown.mark)
    st.shown = nil
  end
end

local function cancel()
  if st.timer then st.timer:stop() end
  st.seq = st.seq + 1
  local conn = L()._state.conn
  if st.asked and conn then conn:notify("_lembas/complete/cancel", { id = st.asked }) end
  st.asked = nil
end

local function show(buf, row, col, text)
  M.clear()
  local lines = vim.split(text, "\n", { plain = true })
  local opts = { virt_text = { { lines[1], "Comment" } }, virt_text_pos = "inline" }
  if #lines > 1 then
    opts.virt_lines = {}
    for i = 2, #lines do opts.virt_lines[#opts.virt_lines + 1] = { { lines[i], "Comment" } } end
  end
  st.shown = { buf = buf, row = row, col = col, text = text, mark = vim.api.nvim_buf_set_extmark(buf, ns, row, col, opts) }
end

local function usable(buf)
  return vim.bo[buf].buftype == "" and vim.bo[buf].modifiable
end

--- Ask for a suggestion at the cursor now. `manual`: you pressed the key, so say why nothing came.
function M.request(manual)
  local buf = vim.api.nvim_get_current_buf()
  if not usable(buf) then return end
  local win = vim.api.nvim_get_current_win()
  local pos = vim.api.nvim_win_get_cursor(win)
  local row, col = pos[1] - 1, pos[2]
  local line = vim.api.nvim_buf_get_lines(buf, row, row + 1, false)[1] or ""
  local before = vim.api.nvim_buf_get_lines(buf, math.max(0, row - 400), row, false)
  local after = vim.api.nvim_buf_get_lines(buf, row + 1, row + 100, false)
  before[#before + 1] = line:sub(1, col)
  table.insert(after, 1, line:sub(col + 1))
  local prefix, suffix = table.concat(before, "\n"), table.concat(after, "\n")
  if #prefix > PREFIX_MAX then prefix = prefix:sub(-PREFIX_MAX) end
  if #suffix > SUFFIX_MAX then suffix = suffix:sub(1, SUFFIX_MAX) end
  cancel()
  local seq = st.seq
  L()._connect(function(conn)
    if seq ~= st.seq then return end
    if not conn then
      if manual then vim.notify("LLeMbas: " .. (L()._state.start_error or "the agent did not start"), vim.log.levels.WARN) end
      return
    end
    if not L()._state.caps.editor then
      st.off = "this LLeMbas CLI does not offer autocomplete yet"
      if manual then vim.notify("LLeMbas: " .. st.off, vim.log.levels.WARN) end
      return
    end
    local id = ("c%d"):format(seq)
    st.asked = id
    local name = vim.api.nvim_buf_get_name(buf)
    conn:request("_lembas/complete", {
      id = id, prefix = prefix, suffix = suffix, path = name ~= "" and name or nil,
      language = vim.bo[buf].filetype ~= "" and vim.bo[buf].filetype or nil,
      model = L().config.complete.model,
    }, function(err, r)
      if st.asked == id then st.asked = nil end
      if seq ~= st.seq then return end
      if err then
        -- Asked on every pause, so a refusal is said once and the asking stops until you choose.
        st.off = tostring(err.message)
        if manual or not st.said then
          st.said = true
          vim.notify("LLeMbas: no suggestions: " .. st.off .. " (:LLeMbasAutocompleteModel chooses a model)", vim.log.levels.WARN)
        end
        return
      end
      if not r or r.cancelled or type(r.text) ~= "string" or r.text == "" then return end
      if vim.api.nvim_get_current_buf() ~= buf or not M._typing() then return end
      local now = vim.api.nvim_win_get_cursor(0)
      if now[1] - 1 ~= row or now[2] ~= col then return end
      show(buf, row, col, (r.text:gsub("\r\n", "\n")))
    end)
  end, not manual)
end

--- Put the shown suggestion into the buffer. False when none is shown.
function M.accept()
  local s = st.shown
  if not s or s.buf ~= vim.api.nvim_get_current_buf() then return false end
  M.clear()
  st.seq = st.seq + 1
  local lines = vim.split(s.text, "\n", { plain = true })
  vim.api.nvim_buf_set_text(s.buf, s.row, s.col, s.row, s.col, lines)
  local row = s.row + #lines
  local col = #lines == 1 and (s.col + #lines[1]) or #lines[#lines]
  vim.api.nvim_win_set_cursor(0, { row, col })
  return true
end

function M.visible() return st.shown ~= nil end

--- Suggestions as you type: on, off, or the other of the two.
function M.auto(on)
  local c = L().config.complete
  if on == nil then c.auto = not c.auto else c.auto = on end
  if c.auto then st.off, st.said = nil, false else M.clear(); cancel() end
  return c.auto
end

--- A model was chosen: ask again.
function M.reset() st.off, st.said = nil, false end

local function typed()
  M.clear()
  local c = L().config.complete
  if not c.auto or st.off then return cancel() end
  if not usable(vim.api.nvim_get_current_buf()) then return end
  cancel()
  st.timer = st.timer or vim.uv.new_timer()
  st.timer:start(c.debounce_ms, 0, vim.schedule_wrap(function()
    if M._typing() then M.request(false) end
  end))
end

function M.setup()
  local group = vim.api.nvim_create_augroup("llembas-complete", { clear = true })
  vim.api.nvim_create_autocmd({ "TextChangedI", "CursorMovedI" }, { group = group, callback = typed })
  vim.api.nvim_create_autocmd({ "InsertLeave", "BufLeave" }, { group = group, callback = function() M.clear(); cancel() end })
  local c = L().config.complete
  if c.accept and c.accept ~= "" then
    vim.keymap.set("i", c.accept, function()
      if not M.accept() then
        vim.api.nvim_feedkeys(vim.api.nvim_replace_termcodes(c.accept, true, false, true), "n", false)
      end
    end, { desc = "LLeMbas: accept the suggestion" })
  end
  if c.trigger and c.trigger ~= "" then
    vim.keymap.set("i", c.trigger, function() M.request(true) end, { desc = "LLeMbas: suggest here" })
  end
end

return M
