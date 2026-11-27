# LLeMbas IDE

LLeMbas in your editor: a Neovim plugin, and a VS Code / VSCodium extension.

Both are clients of the [LLeMbas CLI](https://github.com/LLeMbas/LLeMbas-CLI). The CLI is the agent:
it holds the sign-in to your LLeMbas server, the models, the tools and the permissions. The editor
starts `lembas serve --stdio` and talks to it over the Agent Client Protocol. Nothing about a server
or a model is set in the editor.

This is a beta. It needs LLeMbas CLI 2.0.0-beta.14 or newer, signed in (`lembas login <address>`).
With an older CLI only the chat, asking about a selection and approvals work.

## Neovim

Needs Neovim 0.10 or newer. The plugin lives in `nvim/`, so the runtime path points there.

lazy.nvim:

```lua
{
  "LLeMbas/LLeMbas-IDE",
  branch = "dev",
  config = function(plugin)
    vim.opt.rtp:append(plugin.dir .. "/nvim")
    vim.cmd("runtime plugin/llembas.lua")
    require("llembas").setup({})
  end,
}
```

vim-plug: `Plug 'LLeMbas/LLeMbas-IDE', { 'branch': 'dev', 'rtp': 'nvim' }`

| Command | What it does |
|---|---|
| `:LLeMbas` | open or close the chat panel (`right`, `left`, `bottom`, or `float`) |
| `:'<,'>LLeMbasAsk [question]` | ask about the selected lines; without a question they go with the next message |
| `:'<,'>LLeMbasExplain` | explain the selected lines |
| `:'<,'>LLeMbasEdit [instruction]` | rewrite the selected lines as inline hunks (`ga`/`gr`, `gA`/`gR`, `]h`/`[h`) |
| `:LLeMbasGenerate [instruction]` | generate code at the cursor as inline hunks |
| `:LLeMbasCancelEdit` | cancel an in-flight rewrite or generation |
| `:LLeMbasFix` | send the current buffer's diagnostics to the agent to fix |
| `:LLeMbasAccept[!]`, `:LLeMbasReject[!]` | accept or reject proposed changes (`!`: all) |
| `:LLeMbasNextHunk`, `:LLeMbasPrevHunk` | jump between proposed changes (`]h`, `[h`) |
| `:LLeMbasAutocomplete [on\|off]` | toggle suggestions as you type |
| `:LLeMbasAutocompleteTokens [N\|auto\|words\|line\|block\|file]` | tune autocomplete max tokens and prediction length preset |
| `:LLeMbasAutocompleteInstructions [text\|-]` | set or clear custom instructions sent with autocomplete |
| `:LLeMbasAutocompleteModel[!] [model]` | the model that writes suggestions (`!`: this editor only; `-`: back to default) |
| `:LLeMbasMainModel [model]` | the model for chat and rewriting, saved in your account (`?` shows both) |
| `:LLeMbasFiles[!] [query]` | search project index and insert `@path` (`!`: open file in editor) |
| `:LLeMbasOpenFile [query]` | open a file from the project index |
| `:LLeMbasCommands` | pick a session `/command` or skill |
| `:LLeMbasSessions` | list and resume a previous session with its history |
| `:LLeMbasCompact` | compact the session context |
| `:LLeMbasToggleThoughts` | show or hide model thinking |
| `:LLeMbasOpen` | open the file the agent showed last |
| `:LLeMbasStop` | stop the running turn |
| `:LLeMbasNew[!]` | start a new session (`!` ends a hung turn) |
| `:LLeMbasMode [mode]` | change the mode (works live mid-turn) |
| `:LLeMbasModel [model]` | pick or change the session's model |
| `:LLeMbasStatus`, `:LLeMbasHelp` | floating status overview / commands & keys card |

In the prompt: `<CR>` (normal mode) or `<C-s>` sends (or steers mid-turn), `<C-c>` stops the turn, `<C-x><C-f>` inserts `@file`, `<C-x><C-o>` inserts `/command`, `q` closes, `g?` opens help.
In the transcript: `<CR>` / `gf` opens `file:line`, `K` inspects tool output in a float, `y` yanks the fenced code block under the cursor, `i` jumps to the prompt, `q` closes.

While typing, `<Tab>` accepts a suggestion, `<M-Right>` accepts the next word, and `<M-\>` triggers one manually; all keys and `LLeMbas*` highlight groups can be customized. `require("llembas").statusline()` provides a compact statusline component.
Help: `:help llembas`.

## VS Code and VSCodium

Needs VS Code or VSCodium 1.85 or newer. The extension lives in `vscode/`; it is plain JavaScript
with no dependencies, and is installed from a package you build with Node alone:

```sh
scripts/package-vscode.sh                                   # writes dist/llembas-<version>.vsix
codium --install-extension dist/llembas-<version>.vsix      # or: code --install-extension …
```

Includes a redesigned sidebar chat with interactive approval, question and plan cards, real GFM
tables, code-block Copy/Insert toolbars, collapsible thinking and tool output, session resume and
compaction, `@file` and `/command` popups, inline diff rewrites and generation, inline autocomplete
with a **Tune** drawer (max-tokens slider, length presets, and custom instructions), and shown
media. Commands, keys, and settings: [`vscode/README.md`](vscode/README.md).

## Tests

`scripts/test-nvim.sh` runs the plugin headless against a stand-in agent (needs `nvim` and `python3`).

`scripts/test-vscode.sh` runs the extension's parts that need no editor against a stand-in agent of
its own, and checks the package (needs Node 18 or newer and `python3`). It does not start VS Code.

## Licence

MIT.
