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
cmd("LLeMbasNew", function(o) L().new(o.bang) end, { bang = true, desc = "LLeMbas: start a new session (! also while a turn hangs)" })
cmd("LLeMbasMode", function(o) L().mode(o.args) end,
  { nargs = "?", complete = function() return L().mode_ids() end, desc = "LLeMbas: change the mode" })
cmd("LLeMbasModel", function(o) L().model(o.args) end, { nargs = "?", desc = "LLeMbas: show or change the model" })
cmd("LLeMbasAccept", function(o) require("llembas.diff").accept(o.bang) end, { bang = true, desc = "LLeMbas: accept the change under the cursor (! all)" })
cmd("LLeMbasReject", function(o) require("llembas.diff").reject(o.bang) end, { bang = true, desc = "LLeMbas: reject the change under the cursor (! all)" })
cmd("LLeMbasAutocomplete", function(o)
  local on = require("llembas.complete").auto(o.args == "on" and true or o.args == "off" and false or nil)
  vim.notify("LLeMbas: suggestions as you type are " .. (on and "on" or "off"))
end, { nargs = "?", complete = function() return { "on", "off" } end, desc = "LLeMbas: suggestions as you type on or off" })
cmd("LLeMbasAutocompleteModel", function(o) L().autocomplete_model(o.args, o.bang) end,
  { nargs = "?", bang = true, desc = "LLeMbas: the autocomplete model (! for this editor only, - for the default)" })
cmd("LLeMbasMainModel", function(o) L().main_model(o.args) end,
  { nargs = "?", desc = "LLeMbas: the model for chat and rewriting, saved in your account (? shows both)" })
cmd("LLeMbasOpen", function() L().open_shown() end, { desc = "LLeMbas: open the file the agent showed last" })
