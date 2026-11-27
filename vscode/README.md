# LLeMbas for VS Code and VSCodium

LLeMbas in the editor: an agentic chat beside your files, questions and plans as interactive cards,
rewriting and generating code as inline diffs, session resume, `@file` and `/command` completion,
and tunable inline autocomplete.

The extension is a client of the [LLeMbas CLI](https://github.com/LLeMbas/LLeMbas-CLI). The CLI is
the agent: it holds the sign-in to your LLeMbas server, the models, the tools and the permissions.
The extension starts `lembas serve --stdio` and talks to it over the Agent Client Protocol. Nothing
about a server or a model is set in the editor, only which command starts the CLI.

## What you need

- VS Code or VSCodium 1.85 or newer.
- The LLeMbas CLI, signed in (`lembas login <address>`). The chat works with LLeMbas CLI 2.0 betas;
  autocomplete, rewriting a selection, the model settings and pictures in the chat need a CLI and a
  server that have the editor methods (harness spec 3.11.0). With an older one the extension says so
  where it matters and the rest keeps working.

## Install

Build the package (needs only Node 18 or newer — no `npm install`, no packaging tool):

```sh
scripts/package-vscode.sh          # writes dist/llembas-<version>.vsix
```

Then install it:

```sh
codium --install-extension dist/llembas-<version>.vsix     # VSCodium
code --install-extension dist/llembas-<version>.vsix       # VS Code
```

or in the editor: Extensions → `…` → *Install from VSIX…*.

If the editor does not find `lembas` (an editor started from the desktop does not always have your
shell's `PATH`), set **LLeMbas: Command** to the program's full path.

The extension is off in a folder you have not trusted (Restricted Mode): it starts an agent that
works in that folder.

## What it does

**Chat.** The LLeMbas icon in the activity bar opens the chat. The header shows the connection
status, session title, mode (switchable live mid-turn), session model, **Tune** (autocomplete
settings drawer), **Compact**, **History** (resume previous sessions), and **New**. Enter sends
(or steers mid-run), Shift+Enter starts a new line, `@` searches project files and folders, and `/`
completes slash commands and skills. Approval cards open edited files in the diff view first;
question cards support single/multi-select, recommended markers, custom answers, and skip; plan
cards render formatted Markdown with Approve (Edit/Manual), Revise, and Dismiss actions.

What a model writes is drawn as text through the extension's own Markdown reader: paragraphs,
headings, lists, task checklists, quotes, real GFM tables (in horizontally scrollable wrappers),
strikethrough, fenced code blocks with **Copy** and **Insert** buttons, and clickable `file:line`
references. HTML in a reply stays text, pictures in a reply are not loaded, and links open only for
`http`, `https` and `mailto`. Replies over 400,000 characters are shown as written. Tool calls show
status, kind, duration, clickable changed files, and expandable output; thinking blocks collapse
cleanly.

**Ask, Explain, Fix, Generate & Rewrite.** Ask about or explain a selection, fix reported warnings
and errors in the active file, generate code at the cursor, or rewrite selected lines as proposed
hunks with *Accept* / *Reject* CodeLenses and a side-by-side diff view. Nothing is written until you
accept, and hunks whose lines you edited meanwhile are dropped safely.

**Tunable Autocomplete.** Inline suggestions appear as you type and on `Alt+\` (Tab accepts, Escape
dismisses). Use the **Tune** drawer in the chat header (or Settings) to slide **Max Tokens** from a
few words up to a full file (`0`..`4096`), pick a prediction scope preset (`Auto`, `Few words`,
`Single line`, `Function / block`, `Large / file`), and add custom **Autocomplete instructions**.

**Two model settings.** *LLeMbas: Models (Autocomplete and Main)* — also the *LLeMbas* item in the
status bar — shows both the **autocomplete** model and the **main** model (chat and rewriting), saved
in your account or switched for this window only.

**Files the agent shows.** Pictures appear inline in the chat. Other files appear with *Open* (only
for display-only kinds whose bytes match their filename) or *Show in folder* for anything else. Files
over 64 MB are refused (`llembas.media.maxMegabytes`).

**Unsaved text.** The agent reads open files from your editor buffers (saved or not), and writes
open files back through the document so undo and disk stay in sync.

## Commands and keys

| Command | Key | |
|---|---|---|
| LLeMbas: Open the Chat | `Ctrl+Alt+L` | |
| LLeMbas: Ask About the Selection | `Ctrl+Alt+K` | also in editor context menu |
| LLeMbas: Explain the Selection | | editor context menu |
| LLeMbas: Fix Problems in This File | | editor context menu |
| LLeMbas: Generate Code at Cursor | | editor context menu |
| LLeMbas: Rewrite the Selection | `Ctrl+Alt+E` | also in editor context menu |
| LLeMbas: Suggest a Completion Here | `Alt+\` | |
| LLeMbas: Toggle Autocomplete as You Type | | |
| LLeMbas: Accept All Proposed Changes in This File | `Ctrl+Alt+Enter` | while changes are proposed |
| LLeMbas: Reject All Proposed Changes in This File | `Ctrl+Alt+Backspace` | while changes are proposed |
| LLeMbas: Accept / Reject the Proposed Change at the Cursor | | or CodeLenses above each change |
| LLeMbas: Show the Proposed Changes as a Diff | | |
| LLeMbas: Open File from Project Index / Add File to Chat | | |
| LLeMbas: New Session / Resume a Previous Session | | |
| LLeMbas: Compact Session Context | | |
| LLeMbas: Stop the Running Turn | | |
| LLeMbas: Choose the Mode / Choose This Session's Model | | |
| LLeMbas: Models (Autocomplete and Main) | | also status bar item |
| LLeMbas: Choose the Autocomplete Model / the Main Model | | |
| LLeMbas: Stop the Agent | | starts again when needed |

On macOS the keys use `Cmd` in place of `Ctrl`.

## Settings

| Setting | Default | |
|---|---|---|
| `llembas.command` | `lembas` | the LLeMbas CLI, or its full path (machine-scoped) |
| `llembas.chat.sendEditorContext` | on | send active file, cursor, selection, diagnostics and open files |
| `llembas.chat.showThinking` | off | show collapsible model thinking blocks |
| `llembas.chat.startMode` | | initial mode for a new session (machine-scoped) |
| `llembas.complete.auto` | on | suggest as you type; off: only on `Alt+\` |
| `llembas.complete.debounce` | 250 | pause in milliseconds before requesting a completion |
| `llembas.complete.maxTokens` | 0 | max tokens to predict (`0`: server default or preset; up to `4096`) |
| `llembas.complete.length` | `auto` | prediction scope preset (`auto`, `words`, `line`, `block`, `file`) |
| `llembas.complete.instructions` | `""` | custom instructions sent with autocomplete requests |
| `llembas.rewrite.openDiff` | on | open diff view beside the file when a rewrite is proposed |
| `llembas.media.maxMegabytes` | 64 | largest shown file accepted from the agent |

## Not there yet

- Sound, video, PDF and 3D files are not rendered inline in the chat: they appear with *Open*.
- An edit the agent asks about in a chat is allowed or denied as a whole, not change by change.
- No marketplace listing: install from the `.vsix`.

## How it is made

Plain JavaScript, no bundler, no dependencies, nothing fetched from the network, no telemetry.
`extension.js` is the only file that talks to the editor; everything else is in `src/` and runs
without one. The chat page (`media/chat.js`) builds elements with `createElement` and `textContent`
only, under a strict Content-Security-Policy; every colour comes from VS Code's theme variables.

## Tests

```sh
scripts/test-vscode.sh       # needs Node 18+ and python3
```
