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
- **Suggestions as you type, and on a key** (`<M-\>`), from the autocomplete model chosen on your
  server; `<Tab>` accepts. A newer keystroke cancels the request before it, and an answer for a place
  you have left is never drawn. `:LLeMbasAutocomplete` turns typing-time suggestions on and off.
- **A rewrite is a proposal.** `:LLeMbasEdit` shows the result as changes in place, old lines marked
  and new lines beside them; `ga` / `gr` accept or reject the one under the cursor, `gA` / `gR` all.
  Nothing is written before you accept, and the buffer need not be saved.
- **Two model settings**, saved in your account: `:LLeMbasAutocompleteModel` and `:LLeMbasMainModel`
  (chat and rewriting). With `!` the autocomplete model is switched for this editor only.
- An approval that carries a diff shows it while the question is open.
- The agent reads a file that is open here from its buffer, saved or not.
- A file the agent shows is opened in the window you edit in; one that is not text is named in the
  chat and `:LLeMbasOpen` hands it to the system's viewer.
- The editor's context (file, cursor, selection, diagnostics) goes to the agent as data.
- These need a LLeMbas CLI with harness spec 3.11.0. With an older one the plugin works as before.

### Fixed (Neovim)

- Starting a new session could leave the plugin believing the new agent had stopped.
