-- Suggestions as you type, and on a key. The text comes from the LLeMbas CLI (`_lembas/complete`),
-- which asks your server's autocomplete model. A suggestion is drawn as virtual text and becomes part
-- of the buffer only when you accept it; what the model wrote is never run.
local M = {}
local ns = vim.api.nvim_create_namespace("llembas-complete")

local st = { timer = nil, seq = 0, asked = nil, shown = nil, off = nil, said = false, last_warm = nil, installed = false }

local PREFIX_MAX, SUFFIX_MAX = 16000, 4000
local REFUSALS = { no_model = true, not_allowed = true, not_logged_in = true, unsupported = true }

local LENGTH_PRESETS = {
  auto = { tokens = nil, instruction = "" },
  words = {
    tokens = 24,
    instruction = "Predict only a few words to finish the current expression or identifier. Stop immediately once the current token or phrase is complete.",
  },
  line = {
    tokens = 64,
    instruction = "Predict at most the remainder of the current line. Do not start a new line.",
  },
  block = {
    tokens = 256,
    instruction = "Predict a complete statement, block, or function body fitting the surrounding code.",
  },
  file = {
    tokens = 2048,
    instruction = "Predict a comprehensive continuation, up to a full multi-function section or file implementation when appropriate.",
  },
}

local function L() return require("llembas") end

local function resolve_prediction()
  local c = L().config.complete or {}
  local preset = LENGTH_PRESETS[c.length or "auto"] or LENGTH_PRESETS.auto
  local explicit = tonumber(c.max_tokens)
  local max_tokens = (explicit and explicit > 0) and math.floor(explicit) or preset.tokens
  local parts = {}
  if preset.instruction ~= "" then parts[#parts + 1] = preset.instruction end
  if type(c.instructions) == "string" and c.instructions:match("%S") then parts[#parts + 1] = vim.trim(c.instructions) end
  local guidance = table.concat(parts, "\n")
  return max_tokens, guidance ~= "" and guidance or nil
end

--- Whether you are typing (insert mode). A function of its own so the tests, which cannot stay in
--- insert mode in a headless run, can say yes.
function M._typing() return vim.api.nvim_get_mode().mode:sub(1, 1) == "i" end

--- The accept keys are ours only while a suggestion is on the screen: buffer mappings put there
--- with the suggestion and taken away with it, whatever was mapped before given back as it was.
local function unmap_accept()
  local s = st.shown
  if not s or not s.maps then return end
  for _, m in ipairs(s.maps) do
    pcall(vim.keymap.del, "i", m.key, { buffer = s.buf })
    if m.before and next(m.before) and m.before.buffer == 1 then pcall(vim.fn.mapset, "i", false, m.before) end
  end
end

function M.clear()
  if st.shown then
    unmap_accept()
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
  require("llembas.ui").setup_highlights()
  M.clear()
  local lines = vim.split(text, "\n", { plain = true })
  local opts = { virt_text = { { lines[1], "LLeMbasGhost" } }, virt_text_pos = "inline" }
  if #lines > 1 then
    opts.virt_lines = {}
    for i = 2, #lines do opts.virt_lines[#opts.virt_lines + 1] = { { lines[i], "LLeMbasGhost" } } end
  end
  st.shown = { buf = buf, text = text, mark = vim.api.nvim_buf_set_extmark(buf, ns, row, col, opts), maps = {} }
  local c = L().config.complete
  local function bind(key, fn, desc)
    if not key or key == "" then return end
    local before = vim.fn.maparg(key, "i", false, true)
    st.shown.maps[#st.shown.maps + 1] = { key = key, before = before }
    vim.keymap.set("i", key, fn, { buffer = buf, nowait = true, desc = desc })
  end
  bind(c.accept, function() M.accept() end, "LLeMbas: accept the suggestion")
  if c.accept_word and c.accept_word ~= "" and c.accept_word ~= c.accept then
    bind(c.accept_word, function() M.accept_word() end, "LLeMbas: accept next word of suggestion")
  end
end

local function usable(buf)
  return vim.bo[buf].buftype == "" and vim.bo[buf].modifiable
end

--- Collect up to 6 other loaded file buffers' text so the CLI can prefer unsaved open buffers
--- for session-aware autocomplete context.
local function open_snippets(exclude_buf)
  local out = {}
  for _, b in ipairs(vim.api.nvim_list_bufs()) do
    if #out >= 6 then break end
    if b ~= exclude_buf and vim.api.nvim_buf_is_loaded(b) and vim.bo[b].buftype == "" then
      local name = vim.api.nvim_buf_get_name(b)
      if name ~= "" then
        local text = table.concat(vim.api.nvim_buf_get_lines(b, 0, 400, false), "\n")
        if #text > 0 and #text <= 32768 then
          out[#out + 1] = { path = name, text = text }
        end
      end
    end
  end
  return #out > 0 and out or nil
end

--- Pre-warm the CLI's session file index & direct imports for `buf` before typing pauses.
function M.warm(buf)
  buf = buf or vim.api.nvim_get_current_buf()
  if not buf or not vim.api.nvim_buf_is_valid(buf) or vim.bo[buf].buftype ~= "" then return end
  local conn = L()._state.conn
  if not conn or not L()._state.ready or not L()._state.caps.editor then return end
  local name = vim.api.nvim_buf_get_name(buf)
  if name == "" then return end
  local cwd = vim.fn.getcwd()
  local key = (L()._state.session or "") .. "|" .. cwd .. "|" .. name
  if st.last_warm == key then return end
  st.last_warm = key
  local text = table.concat(vim.api.nvim_buf_get_lines(buf, 0, 400, false), "\n")
  conn:notify("_lembas/complete/warm", {
    cwd = cwd,
    sessionId = L()._state.session,
    path = name,
    text = #text <= 32768 and text or nil,
  })
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
      -- An agent that does not start is not started again at every pause: once a minute at most.
      st.wait_until = vim.uv.now() + 60000
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
    local max_tokens, guidance = resolve_prediction()
    local params = {
      id = id, prefix = prefix, suffix = suffix, path = name ~= "" and name or nil,
      language = vim.bo[buf].filetype ~= "" and vim.bo[buf].filetype or nil,
      cwd = vim.fn.getcwd(),
      sessionId = L()._state.session,
      open = open_snippets(buf),
      model = L().config.complete.model,
      max_tokens = max_tokens,
    }
    if guidance then
      params.context = { { path = "llembas:autocomplete-instructions", text = guidance } }
    end
    conn:request("_lembas/complete", params, function(err, r)
      if st.asked == id then st.asked = nil end
      if seq ~= st.seq then return end
      if err then
        local reason = (type(err.data) == "table" and type(err.data.reason) == "string") and err.data.reason or ""
        local msg = tostring(err.message or "completion failed")
        if REFUSALS[reason] or reason == "" then
          -- Permanent refusal (e.g. no model): said once, stops asking until a model is chosen.
          st.off = msg
          if manual or not st.said then
            st.said = true
            vim.notify("LLeMbas: no suggestions: " .. st.off .. " (:LLeMbasAutocompleteModel chooses a model)", vim.log.levels.WARN)
          end
        else
          -- Transient server failure: pause briefly instead of shutting off permanently.
          st.wait_until = vim.uv.now() + 15000
          if manual then vim.notify("LLeMbas: " .. msg, vim.log.levels.WARN) end
        end
        return
      end
      if manual and st.off then st.off, st.said = nil, false end
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
  -- Where the suggestion stands now: its mark moves with the text around it.
  local pos = vim.api.nvim_buf_get_extmark_by_id(s.buf, ns, s.mark, {})
  M.clear()
  st.seq = st.seq + 1
  if not pos[1] then return false end
  local at_row, at_col = pos[1], pos[2]
  local lines = vim.split(s.text, "\n", { plain = true })
  vim.api.nvim_buf_set_text(s.buf, at_row, at_col, at_row, at_col, lines)
  local row = at_row + #lines
  local col = #lines == 1 and (at_col + #lines[1]) or #lines[#lines]
  vim.api.nvim_win_set_cursor(0, { row, col })
  return true
end

--- Accept only the next word (or line break) of the shown suggestion, keeping the rest visible.
function M.accept_word()
  local s = st.shown
  if not s or s.buf ~= vim.api.nvim_get_current_buf() then return false end
  local pos = vim.api.nvim_buf_get_extmark_by_id(s.buf, ns, s.mark, {})
  if not pos[1] then M.clear(); return false end
  local chunk = s.text:match("^%s*[%w_]+") or s.text:match("^%s*[^\n%s]") or s.text:match("^\n[ \t]*") or s.text
  if chunk == s.text then return M.accept() end
  local rest = s.text:sub(#chunk + 1)
  local buf = s.buf
  M.clear()
  st.seq = st.seq + 1
  local at_row, at_col = pos[1], pos[2]
  local lines = vim.split(chunk, "\n", { plain = true })
  vim.api.nvim_buf_set_text(buf, at_row, at_col, at_row, at_col, lines)
  local new_row = at_row + #lines
  local new_col = #lines == 1 and (at_col + #lines[1]) or #lines[#lines]
  vim.api.nvim_win_set_cursor(0, { new_row, new_col })
  if rest ~= "" then show(buf, new_row - 1, new_col, rest) end
  return true
end

function M.dismiss()
  M.clear()
  cancel()
end

function M.visible() return st.shown ~= nil end

--- Suggestions as you type: on, off, or the other of the two.
function M.auto(on)
  local c = L().config.complete
  if on == nil then c.auto = not c.auto else c.auto = on end
  if c.auto then
    if not st.installed then M.setup() end
    st.off, st.said = nil, false
  else
    M.clear()
    cancel()
  end
  return c.auto
end

--- A model or token/instruction setting was chosen: ask again.
function M.reset() st.off, st.said, st.last_warm, st.wait_until = nil, false, nil, nil end

local function typed()
  M.clear()
  local c = L().config.complete
  if not c.auto or st.off or (st.wait_until and vim.uv.now() < st.wait_until) then return cancel() end
  if not usable(vim.api.nvim_get_current_buf()) then return end
  cancel()
  st.timer = st.timer or vim.uv.new_timer()
  st.timer:start(c.debounce_ms, 0, vim.schedule_wrap(function()
    if M._typing() then M.request(false) end
  end))
end

function M.setup()
  st.installed = true
  local group = vim.api.nvim_create_augroup("llembas-complete", { clear = true })
  vim.api.nvim_create_autocmd({ "TextChangedI", "CursorMovedI" }, { group = group, callback = typed })
  vim.api.nvim_create_autocmd({ "InsertLeave", "BufLeave" }, { group = group, callback = function() M.clear(); cancel() end })
  vim.api.nvim_create_autocmd("BufEnter", { group = group, callback = function(ev) M.warm(ev.buf) end })
  local c = L().config.complete
  if c.trigger and c.trigger ~= "" then
    vim.keymap.set("i", c.trigger, function() M.request(true) end, { desc = "LLeMbas: suggest here" })
  end
end

return M
