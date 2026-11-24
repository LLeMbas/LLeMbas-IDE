# LLeMbas for VS Code and VSCodium

LLeMbas in the editor: a chat with the agent beside your files, questions about a selection, a
selection rewritten as a diff you accept or reject, and autocomplete.

The extension is a client of the [LLeMbas CLI](https://github.com/LLeMbas/LLeMbas-CLI). The CLI is
the agent: it holds the sign-in to your LLeMbas server, the models, the tools and the permissions.
The extension starts `lembas serve --stdio` and talks to it over the Agent Client Protocol. Nothing
about a server or a model is set in the editor, only which command starts the CLI.

This is a beta. It has been tested without an editor (see *Tests*); it has not yet been run inside
VS Code or VSCodium by its authors.

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

**Chat.** The LLeMbas icon in the activity bar opens the chat. Above the transcript: the session's
mode, the session's model, and *New*. Enter sends, Shift+Enter starts a new line; while the agent
works the button is *Stop*. When the agent asks before doing something, the question appears as a
card with its answers as buttons. A question about an edit — in manual mode, every edit — opens
the change in the editor's own diff view first; nothing is written until you allow it. Files the
agent changed are named under the tool's line and open with a click.

What a model writes is shown as text. A small Markdown reader in the extension turns it into
paragraphs, lists, code and links; HTML in a reply stays text, pictures in a reply are not loaded,
and a link opens in your browser only when it is `http`, `https` or `mailto`. A reply of more than
400,000 characters is shown as it was written.

**Ask about a selection.** Select text, then *LLeMbas: Ask About the Selection*. With a question it
is sent at once; with an empty one the selection goes with the next message you type. The agent is
told the file, the lines, the selected text as the editor has it (saved or not) and the problems
the editor shows there. A message typed in the chat carries the file in front and the cursor's line
the same way (setting *Send Editor Context*).

**Rewrite a selection.** Select lines, then *LLeMbas: Rewrite the Selection* and say what should
change. The result comes back as proposed changes in the file: each one is marked, with *Accept*
and *Reject* above it, *Accept all* / *Reject all* above the first, and the whole proposal in the
diff view beside the file. Nothing is written until you accept; rejecting leaves the file as it
was. A change whose lines you edited meanwhile is dropped instead of being applied to the wrong
text.

**Autocomplete.** Suggestions appear as you type, after a short pause, as the editor's own inline
suggestions: Tab accepts, Escape dismisses. `Alt+\` asks for one now. It needs an autocomplete
model: when none is chosen the extension says so once, with a button to choose one, and stays quiet
until one is set.

**Two model settings.** *LLeMbas: Models (Autocomplete and Main)* — also the *LLeMbas* item in the
status bar — shows both: the **autocomplete** model, and the **main** model (chat and rewriting).
Any model your server offers can be picked for either. *Save it* keeps the choice in your account,
so every editor you sign in from uses it; *Only this window* is a quick switch that is saved
nowhere. The picker in the chat changes the model of the session you are in.

**Files the agent shows.** A picture the agent shows (a screenshot, a chart) appears in the chat.
Any other file is a line in the chat. *Open* is offered only for kinds that are merely displayed —
pictures and plain text (opened inside the editor), PDF, sound and video (your system's viewer) —
and only when the file's first bytes are that kind and its name says the same. Everything else,
whatever it is called, gets *Show in folder* and is never opened for you. Files of more than 64 MB
are refused, and the agent is told why (setting *Media: Max Megabytes*). Shown files are kept
until the chat is cleared by a new session.

**Unsaved text.** When the agent reads a file you have open, it gets the text as the editor has
it, saved or not. When it writes one, the new text is put into the open document and saved — one
undo step in the editor — so the file and what you see never part ways. A file that is not open
is read and written by the agent itself.

## Commands and keys

| Command | Key | |
|---|---|---|
| LLeMbas: Open the Chat | `Ctrl+Alt+L` | |
| LLeMbas: Ask About the Selection | `Ctrl+Alt+K` | also in the editor's context menu |
| LLeMbas: Rewrite the Selection | `Ctrl+Alt+E` | also in the editor's context menu |
| LLeMbas: Suggest a Completion Here | `Alt+\` | |
| LLeMbas: Accept All Proposed Changes in This File | `Ctrl+Alt+Enter` | while changes are proposed |
| LLeMbas: Reject All Proposed Changes in This File | `Ctrl+Alt+Backspace` | while changes are proposed |
| LLeMbas: Accept / Reject the Proposed Change at the Cursor | | or the lines above each change |
| LLeMbas: Show the Proposed Changes as a Diff | | |
| LLeMbas: New Session | | the old session stays in the CLI's own store |
| LLeMbas: Stop the Running Turn | | |
| LLeMbas: Choose the Mode | | |
| LLeMbas: Choose This Session's Model | | |
| LLeMbas: Models (Autocomplete and Main) | | |
| LLeMbas: Choose the Autocomplete Model / the Main Model | | |
| LLeMbas: Stop the Agent | | it starts again when needed |

On macOS the keys use `Cmd` in place of `Ctrl`.

## Settings

| Setting | Default | |
|---|---|---|
| `llembas.command` | `lembas` | the LLeMbas CLI, or its full path. Set for the machine, never by a folder |
| `llembas.chat.sendEditorContext` | on | tell the agent which file is in front, the cursor, the selection and its problems |
| `llembas.chat.showThinking` | off | show the model's thinking |
| `llembas.chat.startMode` | | the mode a new session starts in; empty: the CLI's own. Set for the machine, never by a folder |
| `llembas.complete.auto` | on | suggest as you type; off: only on `Alt+\` |
| `llembas.complete.debounce` | 250 | the pause, in milliseconds, before a suggestion is asked for |
| `llembas.complete.maxTokens` | 0 | the longest suggestion; 0: the server's own number |
| `llembas.rewrite.openDiff` | on | open the diff view beside the file when a rewrite is proposed |
| `llembas.media.maxMegabytes` | 64 | the largest file taken from the agent to show or open |

## Not there yet

- Picking up an older session: a window starts a new one.
- The agent's questions with choices (`ask_user`) and its plans for approval are not shown as
  cards; the agent is told nobody can be asked.
- Sound, video, PDF and 3D files are not drawn in the chat: they are a line with *Open*.
- A table in a reply is shown as written, not drawn as a table.
- An edit the agent asks about in a chat is allowed or denied as a whole, not change by change.
- A window with several folders works in the first one.
- No marketplace listing: install from the `.vsix`.

## How it is made

Plain JavaScript, no bundler, no dependencies, nothing fetched from the network, no telemetry.
`extension.js` is the only file that talks to the editor; everything else is in `src/` and runs
without one: the protocol client (`rpc.js`, `agent.js`), the chat (`chat.js`), autocomplete's
waiting and cancelling (`completion.js`), the changes of a rewrite (`hunks.js`), the Markdown
reader (`markdown.js`), the editor context (`context.js`) and shown files (`media.js`). The chat's
page (`media/chat.js`) builds what it shows from elements and text only, under a
Content-Security-Policy that allows one script and nothing from elsewhere; every colour is one of
the editor's theme variables.

## Tests

```sh
scripts/test-vscode.sh       # needs Node 18+ and python3
```

They run the modules in `src/` against a stand-in agent (`tests/fake_agent.py`), check the
package the script builds (its archive, its manifest, what is and is not in it), and load
`extension.js` against an in-memory stand-in for the editor's API (`tests/stub_vscode.js`). None of
them starts VS Code: how the extension looks and behaves in a real editor is not covered by them.
