# Changelog

## [1.0.0-beta.5] — 2026-11-27

### Fixed (VS Code / VSCodium)

- **Chat input pinned to the bottom of the side panel.** Wrapped the header, collapsible Tune drawer, and subagent strip inside a single `.chrome` container and restored a 3-row `body` grid (`auto minmax(0, 1fr) auto`) with `height: 100vh`. Previously, `hidden` (`display: none`) siblings shifted `<main id="log">` and `<footer>` onto `auto` tracks above an empty `1fr` track, floating the chat composer near the top with empty space beneath it.

## [1.0.0-beta.4] — 2026-11-27

### Fixed (VS Code / VSCodium & Neovim)

- **Protocol compatibility with LLeMbas CLI 2.0:**
  - `_lembas/files/search`: read `{ path, kind }` objects returned by the CLI (with string fallback) so `@file` search, `:LLeMbasFiles`, and *Add File / Open File* work reliably and distinguish files from directories while escaping spaces and `#`.
  - `_lembas/sessions/resume`: replay the CLI's `historyTurns` shape (`role: "user" | "assistant"`, tool calls with outputs, thinking blocks, attachments, and harness turns), fixing empty transcripts on session resume.
  - `_lembas/question`: send spec-compliant `Answer` objects (`{ kind: "options", labels }`, `{ kind: "custom", text }`, `{ kind: "skipped" }`) so answers are accepted instead of silently treated as dismissed; support `recommended` markers and multi-select in Neovim too.
  - `_lembas/plan`: send `{ outcome: "dismissed" }` on dismissal.
- **Neovim `:LLeMbasFix` & editor context:** include buffer error/warning diagnostics and open file paths in `_meta.lembas.editor` even when no visual range is selected, and read cursor position from the buffer's own window.
- **VS Code `llembas.generate`:** guard against concurrent rewrites on the same file, show streaming progress with cancellation (`_lembas/edit/cancel`), and report when nothing changed or the document edited meanwhile.
- **Neovim robustness:** cap JSON-RPC line buffer memory in `rpc.lua`, disable undo history on the read-only transcript buffer, reset session metadata (`title`, `progress`, `usage`, `team`, `attached`, `shown`) on `:LLeMbasNew`, handle `_lembas/permission/settled` and transient autocomplete errors cleanly, and read `M.version` directly from `VERSION`.

### Added & Improved (VS Code / VSCodium)

- **Redesigned chat sidebar UI & visual polish:**
  - Two-row branded header with the LLeMbas pixel-leaf icon, live connection/working dot, mode indicator dot, session title, and compact action bar.
  - Welcome empty state (*"Waybread for the code ahead."*) with quick-action starter buttons (`Explain selection`, `Fix file problems`, `Add @file`, `Resume session`) and shortcut hints.
  - **Autocomplete Tune drawer** in the sidebar with an interactive **Max Tokens slider** (`0`..`4096`), quick length presets (`Default`, `Words`, `Line`, `Block`, `File`), **Prediction scope** selector (`llembas.complete.length`), **Autocomplete instructions** input (`llembas.complete.instructions`), and live toggles for *Suggest as you type* and *Show thinking*.
  - Real **GFM Markdown tables** inside horizontally scrollable wrappers with column alignment and inline formatting, plus `~~strikethrough~~` and task list checkboxes (`- [x]` / `- [ ]`).
  - **Fenced code block toolbars** with one-click **Copy** and **Insert at cursor** buttons.
  - **Collapsible Thinking blocks** and **expandable tool call outputs** with semantic status icons, tool kind tags, execution duration (`ms`), and clickable file chips.
  - Visual `<progress>` bar on live Plan cards, rich Markdown rendering inside Plan approval cards, live subagent team strip, session token usage indicator (`↑`/`↓`), auto-growing prompt input, and upgraded status bar item.
  - New commands: `LLeMbas: Compact Session Context` (`llembas.compact`) and `LLeMbas: Toggle Autocomplete as You Type` (`llembas.toggleAutocomplete`).

### Added & Improved (Neovim)

- **Dedicated `LLeMbas*` highlight groups & visual design (`lua/llembas/ui.lua`):** colorscheme-aware highlights re-applied on `ColorScheme`, branded transcript winbar with session title/mode/model/token usage/phase, empty-state virtual-text welcome banner, section dividers, visual plan progress bar + task list, inline diff hint & gutter highlights, and floating preview windows.
- **Autocomplete length, tokens & word-by-word accept:** `:LLeMbasAutocompleteTokens [N|auto|words|line|block|file]` and `:LLeMbasAutocompleteInstructions [text|-]`, plus `<M-Right>` (`accept_word`) to accept suggestions one word at a time.
- **New commands & panel keys:** `:LLeMbasGenerate`, `:LLeMbasCompact`, `:LLeMbasCommands`, `:LLeMbasToggleThoughts`, `:LLeMbasCancelEdit`, `:LLeMbasNextHunk` / `:LLeMbasPrevHunk` (`]h`/`[h`), `:LLeMbasStatus`, `:LLeMbasHelp` (`g?`), `require("llembas").statusline()`, plus `K` (inspect tool output in a float), `y` (yank code block under cursor), `i` (jump to prompt), `<C-x><C-f>` (`@file`), `<C-x><C-o>` (`/command`), and configurable panel `position` (`right`, `left`, `bottom`, `float`).

## [1.0.0-beta.3] — 2026-11-26

### Fixed (VS Code / VSCodium)

- **Chat sidebar view loads cleanly in VSCodium.** Allowed space-separated
  multi-origin `webview.cspSource` values (such as
  `vscode-resource: https://*.vscode-cdn.net`) in `src/webview.js` instead of
  throwing `unsafe value for the chat page` (which caused VSCodium to display
  `An error occurred while loading view: llembas.chat`), while still blocking
  CSP injection characters (`"`, `<`, `>`, `;`, newlines).

## [1.0.0-beta.2] — 2026-11-26

### Added (VS Code / VSCodium & Neovim)

- **Full agentic workflows (protocol 2):** interactive Question cards
  (`_lembas/question`), Plan approval cards (`_lembas/plan`), detailed live plan
  progress, live phase status, live mid-run mode switching, and mid-run steering
  (`_lembas/steer`).
- **Session-aware prefilled autocomplete:** sends workspace `cwd`, `sessionId`,
  and open buffer snippets on `_lembas/complete`, and pre-warms the CLI's file
  index and direct imports on tab/buffer switch (`_lembas/complete/warm`).
- **Project file index & navigation:** `@file` search popup in VS Code chat,
  clickable `file:line` references (VS Code chat + `<CR>`/`gf` in Neovim chat),
  project file index commands (`llembas.openFile`, `llembas.addFile`,
  `:LLeMbasFiles`, `:LLeMbasOpenFile`), and `_lembas/show` text fallback & line
  range reveal.
- **Session resume & coding actions:** resume previous sessions with full
  transcript replay (`llembas.resumeSession`, `:LLeMbasSessions`), plus
  `llembas.explain` / `:LLeMbasExplain`, `llembas.fixProblems` / `:LLeMbasFix`,
  `llembas.generate`, `/` slash command completion, and multi-root workspace
  detection.

## [1.0.0-beta.1] — 2026-11-24

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

- The agent's write to a file that is open here goes into the buffer and is saved at once, so the
  buffer and the disk never part.
- `<Tab>` is the plugin's only while a suggestion is on the screen; whatever you had mapped to it
  is yours the rest of the time. The same holds for `ga`, `gr`, `gA`, `gR` and a shown rewrite.
- An approval lists the refusal first, so a digit and Enter typed while the question opens allows
  nothing.
- `:LLeMbasOpen` hands the system only files that are looked at or listened to, never one that may run.
- `:LLeMbasNew!` ends an agent whose turn hangs.

### Fixed (Neovim)

- A file the agent asked for could be answered from another open file whose name began the same.
- Accepting a change after deleting one of its lines removed a line that was not part of it.
- A reloaded file kept the changes proposed for its old text.
- An agent that does not start was started again at every typing pause.

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
- A picture the agent shows appears in the chat; any other file is a line there. Open is offered
  only for kinds that are merely displayed (pictures, plain text, PDF, sound, video), and only
  when the file's bytes and its name agree; everything else can only be shown in its folder.
  Files of more than 64 MB are refused.
- The agent reads a file you have open as the editor has it, saved or not, and a file it writes
  is put into the open document and saved.
- What a model writes is drawn as text through the extension's own small Markdown reader: HTML in
  a reply stays text, and only `http`, `https` and `mailto` links open.
  However long or oddly written a reply is, reading it takes time in step with its length.
