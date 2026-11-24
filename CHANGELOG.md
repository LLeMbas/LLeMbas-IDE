# Changelog

## [Unreleased]

### Neovim plugin

- First version. A chat panel beside your files, on `lembas serve --stdio` of the LLeMbas CLI:
  `:LLeMbas` opens it, `:LLeMbasAsk` asks about the selected lines (with a question at once, without one
  the lines go with the next message you type), `:LLeMbasEdit` has the selected lines rewritten,
  `:LLeMbasStop`, `:LLeMbasNew`, `:LLeMbasMode` and `:LLeMbasModel`.
- A selection is sent as the buffer has it, saved or not, with its file, its lines and the
  diagnostics shown on them. A typed message names the file you are in.
- The CLI's approval cards are asked in the editor; closing one is a denial.
- Files the agent changes are reloaded in buffers that have no changes of their own.
