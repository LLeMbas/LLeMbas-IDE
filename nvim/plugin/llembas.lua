if vim.g.loaded_llembas then return end
vim.g.loaded_llembas = true
if vim.fn.has("nvim-0.10") == 0 then
  vim.notify("llembas.nvim needs Neovim 0.10 or newer", vim.log.levels.WARN)
  return
end

local function L() return require("llembas") end
local cmd = vim.api.nvim_create_user_command

cmd("LLeMbas", function() L().toggle() end, { desc = "LLeMbas: open or close the chat panel" })
cmd("LLeMbasAsk", function(o) L().ask(o.line1, o.line2, o.args) end,
  { range = true, nargs = "*", desc = "LLeMbas: ask about the selected lines" })
cmd("LLeMbasEdit", function(o) L().edit(o.line1, o.line2, o.args) end,
  { range = true, nargs = "*", desc = "LLeMbas: have the selected lines rewritten" })
cmd("LLeMbasStop", function() L().stop() end, { desc = "LLeMbas: stop the running turn" })
cmd("LLeMbasNew", function() L().new() end, { desc = "LLeMbas: start a new session" })
cmd("LLeMbasMode", function(o) L().mode(o.args) end,
  { nargs = "?", complete = function() return L().mode_ids() end, desc = "LLeMbas: change the mode" })
cmd("LLeMbasModel", function(o) L().model(o.args) end, { nargs = "?", desc = "LLeMbas: show or change the model" })
