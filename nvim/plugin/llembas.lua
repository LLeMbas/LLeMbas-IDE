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
cmd("LLeMbasGenerate", function(o) L().generate(o.args) end,
  { nargs = "*", desc = "LLeMbas: generate code at the cursor" })
cmd("LLeMbasCancelEdit", function() require("llembas.diff").cancel() end,
  { desc = "LLeMbas: cancel an in-flight rewrite or generation" })
cmd("LLeMbasStop", function() L().stop() end, { desc = "LLeMbas: stop the running turn" })
cmd("LLeMbasNew", function(o) L().new(o.bang) end, { bang = true, desc = "LLeMbas: start a new session (! also while a turn hangs)" })
cmd("LLeMbasCompact", function() L().compact() end, { desc = "LLeMbas: compact session context" })
cmd("LLeMbasMode", function(o) L().mode(o.args) end,
  { nargs = "?", complete = function() return L().mode_ids() end, desc = "LLeMbas: change the mode" })
cmd("LLeMbasModel", function(o) L().model(o.args) end, { nargs = "?", desc = "LLeMbas: show or change the model" })
cmd("LLeMbasAccept", function(o) require("llembas.diff").accept(o.bang) end, { bang = true, desc = "LLeMbas: accept the change under the cursor (! all)" })
cmd("LLeMbasReject", function(o) require("llembas.diff").reject(o.bang) end, { bang = true, desc = "LLeMbas: reject the change under the cursor (! all)" })
cmd("LLeMbasNextHunk", function() require("llembas.diff").next_hunk() end, { desc = "LLeMbas: jump to next proposed change" })
cmd("LLeMbasPrevHunk", function() require("llembas.diff").prev_hunk() end, { desc = "LLeMbas: jump to previous proposed change" })
cmd("LLeMbasAutocomplete", function(o)
  local on = require("llembas.complete").auto(o.args == "on" and true or o.args == "off" and false or nil)
  vim.notify("LLeMbas: suggestions as you type are " .. (on and "on" or "off"))
end, { nargs = "?", complete = function() return { "on", "off" } end, desc = "LLeMbas: suggestions as you type on or off" })
cmd("LLeMbasAutocompleteTokens", function(o) L().autocomplete_tokens(o.args) end,
  { nargs = "?", complete = function() return { "auto", "words", "line", "block", "file", "24", "64", "256", "1024", "2048" } end,
    desc = "LLeMbas: set autocomplete max tokens or prediction length preset" })
cmd("LLeMbasAutocompleteInstructions", function(o) L().autocomplete_instructions(o.args) end,
  { nargs = "*", desc = "LLeMbas: set custom instructions for autocomplete (- clears)" })
cmd("LLeMbasAutocompleteModel", function(o) L().autocomplete_model(o.args, o.bang) end,
  { nargs = "?", bang = true, desc = "LLeMbas: the autocomplete model (! for this editor only, - for the default)" })
cmd("LLeMbasMainModel", function(o) L().main_model(o.args) end,
  { nargs = "?", desc = "LLeMbas: the model for chat and rewriting, saved in your account (? shows both)" })
cmd("LLeMbasOpen", function() L().open_shown() end, { desc = "LLeMbas: open the file the agent showed last" })
cmd("LLeMbasFiles", function(o) L().files(o.args, o.bang) end,
  { nargs = "?", bang = true, desc = "LLeMbas: search project files and attach @path (! opens file in editor)" })
cmd("LLeMbasOpenFile", function(o) L().files(o.args, true) end,
  { nargs = "?", desc = "LLeMbas: open a file from the project index" })
cmd("LLeMbasCommands", function() L().commands() end, { desc = "LLeMbas: pick a /command or skill" })
cmd("LLeMbasSessions", function() L().sessions() end, { desc = "LLeMbas: list and resume a previous session" })
cmd("LLeMbasExplain", function(o) L().explain(o.line1, o.line2) end,
  { range = true, desc = "LLeMbas: explain the selected lines" })
cmd("LLeMbasFix", function() L().fix() end, { desc = "LLeMbas: fix diagnostics in the current buffer" })
cmd("LLeMbasToggleThoughts", function() L().toggle_thoughts() end, { desc = "LLeMbas: toggle showing model thinking" })
cmd("LLeMbasStatus", function() L().status_popup() end, { desc = "LLeMbas: show agent, session and autocomplete status" })
cmd("LLeMbasHelp", function() L().help() end, { desc = "LLeMbas: show commands and keymaps" })
