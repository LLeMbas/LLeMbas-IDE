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

### VS Code / VSCodium extension

- First version, in `vscode/`: a client of `lembas serve --stdio`, like the Neovim plugin. Plain
  JavaScript with no dependencies and no build; `scripts/package-vscode.sh` writes the `.vsix`.
- A chat in the side bar: the transcript, the session's mode and model, Stop, and a new session.
  The CLI's approval cards are answered there; one that carries an edit opens the change in the
  editor's diff view before you answer, and nothing is written until you allow it.
- Ask about a selection: the file, the lines, the selected text as the editor has it and the
  problems shown there go with the question; a typed message carries the file in front.
- Rewrite a selection: the result is proposed in the file as changes to accept or reject, one by
  one or all at once, and as a diff beside it. Nothing is written before you accept.
- Autocomplete as inline suggestions, as you type and on `Alt+\`. Without an autocomplete model
  it says so once, with a button to choose one.
- The two model settings, autocomplete and main: saved in your account, or switched for one
  window only.
- A picture the agent shows appears in the chat; any other file is a line with Open. Files of
  more than 64 MB are refused.
- The agent reads a file you have open as the editor has it, saved or not.
- What a model writes is drawn as text through the extension's own small Markdown reader: HTML in
  a reply stays text, and only `http`, `https` and `mailto` links open.
