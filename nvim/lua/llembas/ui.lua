-- Visual design, highlights, floating cards and formatting helpers for llembas.nvim.
-- Every colour links to standard Neovim highlight groups with `default = true`, so any
-- colorscheme looks cohesive and users can override individual `LLeMbas*` groups.
local M = {}

local HIGHLIGHTS = {
  LLeMbasBrand = { link = "Special" },
  LLeMbasUserHeader = { link = "Title" },
  LLeMbasAgentHeader = { link = "Function" },
  LLeMbasThoughtHeader = { link = "Comment" },
  LLeMbasThought = { link = "Comment" },
  LLeMbasToolPending = { link = "DiagnosticWarn" },
  LLeMbasToolDone = { link = "DiagnosticOk" },
  LLeMbasToolFail = { link = "DiagnosticError" },
  LLeMbasToolDenied = { link = "DiagnosticWarn" },
  LLeMbasToolKind = { link = "Tag" },
  LLeMbasToolMeta = { link = "Comment" },
  LLeMbasPlanHeader = { link = "Title" },
  LLeMbasPlanBar = { link = "DiagnosticOk" },
  LLeMbasPlanDone = { link = "DiagnosticOk" },
  LLeMbasPlanActive = { link = "DiagnosticInfo" },
  LLeMbasPlanPending = { link = "Comment" },
  LLeMbasNote = { link = "Comment" },
  LLeMbasWarn = { link = "DiagnosticWarn" },
  LLeMbasError = { link = "DiagnosticError" },
  LLeMbasDiffAdd = { link = "DiffAdd" },
  LLeMbasDiffDelete = { link = "DiffDelete" },
  LLeMbasDiffHint = { link = "DiagnosticVirtualTextInfo" },
  LLeMbasGhost = { link = "Comment" },
  LLeMbasSeparator = { link = "WinSeparator" },
  LLeMbasStatusBrand = { link = "Special" },
  LLeMbasStatusMode = { link = "DiagnosticInfo" },
  LLeMbasStatusModel = { link = "Comment" },
  LLeMbasStatusBusy = { link = "DiagnosticWarn" },
  LLeMbasStatusAttach = { link = "DiagnosticHint" },
}

local hi_installed = false

function M.setup_highlights()
  for name, spec in pairs(HIGHLIGHTS) do
    vim.api.nvim_set_hl(0, name, vim.tbl_extend("force", { default = true }, spec))
  end
  if not hi_installed then
    hi_installed = true
    local group = vim.api.nvim_create_augroup("llembas-highlights", { clear = true })
    vim.api.nvim_create_autocmd("ColorScheme", {
      group = group,
      callback = function()
        for name, spec in pairs(HIGHLIGHTS) do
          vim.api.nvim_set_hl(0, name, vim.tbl_extend("force", { default = true }, spec))
        end
      end,
    })
  end
end

function M.format_tokens(n)
  local v = tonumber(n) or 0
  if v >= 1000000 then return ("%.1fM"):format(v / 1000000) end
  if v >= 1000 then return ("%.1fk"):format(v / 1000) end
  return tostring(math.floor(v))
end

function M.format_ms(ms)
  local v = tonumber(ms)
  if not v or v < 0 then return "" end
  if v < 1000 then return ("%dms"):format(math.floor(v + 0.5)) end
  return ("%.1fs"):format(v / 1000)
end

function M.progress_bar(done, total, width)
  width = width or 12
  if not total or total <= 0 then return "" end
  local ratio = math.max(0, math.min(1, done / total))
  local filled = math.floor(ratio * width + 0.5)
  return "[" .. string.rep("█", filled) .. string.rep("░", width - filled) .. "]"
end

--- Welcome virtual lines shown in an empty transcript (never written to the buffer text).
function M.welcome_virt_lines()
  return {
    { { "", "Normal" } },
    { { "  ◈ ", "LLeMbasBrand" }, { "LLeMbas", "LLeMbasUserHeader" }, { "  ·  Waybread for the code ahead.", "LLeMbasNote" } },
    { { "  ────────────────────────────────────────────", "LLeMbasSeparator" } },
    { { "  Prompt: ", "LLeMbasNote" }, { "<CR>/<C-s>", "LLeMbasToolKind" }, { " send  ", "LLeMbasNote" }, { "<C-c>", "LLeMbasToolKind" }, { " stop  ", "LLeMbasNote" }, { "q", "LLeMbasToolKind" }, { " close", "LLeMbasNote" } },
    { { "  Chat:   ", "LLeMbasNote" }, { "<CR>/gf", "LLeMbasToolKind" }, { " open file  ", "LLeMbasNote" }, { "K", "LLeMbasToolKind" }, { " output  ", "LLeMbasNote" }, { "y", "LLeMbasToolKind" }, { " yank code  ", "LLeMbasNote" }, { "g?", "LLeMbasToolKind" }, { " help", "LLeMbasNote" } },
    { { "  Tools:  ", "LLeMbasNote" }, { ":LLeMbasAsk", "LLeMbasAgentHeader" }, { "  ", "Normal" }, { ":LLeMbasEdit", "LLeMbasAgentHeader" }, { "  ", "Normal" }, { ":LLeMbasGenerate", "LLeMbasAgentHeader" }, { "  ", "Normal" }, { ":LLeMbasFiles", "LLeMbasAgentHeader" } },
    { { "  Models: ", "LLeMbasNote" }, { ":LLeMbasAutocompleteTokens", "LLeMbasAgentHeader" }, { "  ", "Normal" }, { ":LLeMbasSessions", "LLeMbasAgentHeader" } },
  }
end

--- Open a read-only floating window with rounded borders (`q` or `<Esc>` closes).
function M.float(title, lines, opts)
  opts = opts or {}
  local b = vim.api.nvim_create_buf(false, true)
  vim.bo[b].buftype = "nofile"
  vim.bo[b].bufhidden = "wipe"
  vim.bo[b].swapfile = false
  vim.bo[b].modeline = false
  vim.bo[b].undolevels = -1
  vim.api.nvim_buf_set_lines(b, 0, -1, false, lines)
  if opts.filetype then vim.bo[b].filetype = opts.filetype end
  vim.bo[b].modifiable = false

  local max_w = 0
  for _, l in ipairs(lines) do
    local w = vim.fn.strdisplaywidth(l)
    if w > max_w then max_w = w end
  end
  local ui = vim.api.nvim_list_uis()[1]
  local cols = (ui and ui.width) or vim.o.columns or 100
  local rows = (ui and ui.height) or vim.o.lines or 30
  local width = math.min(math.max(max_w + 4, 44), math.max(44, math.floor(cols * 0.8)))
  local height = math.min(math.max(#lines, 4), math.max(6, math.floor(rows * 0.7)))
  local win = vim.api.nvim_open_win(b, opts.enter ~= false, {
    relative = "editor",
    width = width,
    height = height,
    row = math.max(1, math.floor((rows - height) / 2) - 1),
    col = math.max(1, math.floor((cols - width) / 2)),
    style = "minimal",
    border = opts.border or "rounded",
    title = title and (" " .. title .. " ") or nil,
    title_pos = title and "center" or nil,
  })
  vim.wo[win].wrap = true
  vim.wo[win].linebreak = true
  local function close()
    if vim.api.nvim_win_is_valid(win) then pcall(vim.api.nvim_win_close, win, true) end
  end
  vim.keymap.set("n", "q", close, { buffer = b, nowait = true, desc = "LLeMbas: close window" })
  vim.keymap.set("n", "<Esc>", close, { buffer = b, nowait = true, desc = "LLeMbas: close window" })
  return win, close
end

return M
