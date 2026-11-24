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
| `:LLeMbas` | open or close the chat panel |
| `:'<,'>LLeMbasAsk [question]` | ask about the selected lines; without a question they go with the next message |
| `:'<,'>LLeMbasEdit [instruction]` | have the selected lines rewritten; shown as changes to accept (`ga`, `gA`) or reject (`gr`, `gR`) |
| `:LLeMbasAccept[!]`, `:LLeMbasReject[!]` | the same from the command line (`!`: all) |
| `:LLeMbasAutocomplete [on\|off]` | suggestions as you type |
| `:LLeMbasAutocompleteModel[!] [model]` | the model that writes suggestions (`!`: this editor only; `-`: back to the default) |
| `:LLeMbasMainModel [model]` | the model for chat and rewriting, saved in your account (`?` shows both) |
| `:LLeMbasOpen` | open the file the agent showed last |
| `:LLeMbasStop` | stop the running turn |
| `:LLeMbasNew` | start a new session |
| `:LLeMbasMode [mode]` | change the mode |
| `:LLeMbasModel [model]` | show or change the model |

In the prompt: Enter (normal mode) or Ctrl-S sends, Ctrl-C stops the turn, `q` closes the panel.
Help: `:help llembas`.

While typing, `<Tab>` accepts a suggestion and `<M-\>` asks for one; both keys can be changed in `setup`.

Suggestions, rewrites shown as changes, the model settings and shown files need a LLeMbas CLI with
harness spec 3.11.0 (2.0.0-beta.14 or newer). With an older CLI the chat, asking about a selection and
approvals work, and a rewrite is done by the agent on the saved file.

Not there yet: picking an older session, and the agent's questions and plans as cards.

## VS Code and VSCodium

Needs VS Code or VSCodium 1.85 or newer. The extension lives in `vscode/`; it is plain JavaScript
with no dependencies, and is installed from a package you build with Node alone:

```sh
scripts/package-vscode.sh                                   # writes dist/llembas-<version>.vsix
codium --install-extension dist/llembas-<version>.vsix      # or: code --install-extension …
```

A chat in the side bar, questions about a selection, a selection rewritten as changes you accept or
reject, autocomplete as you type and on `Alt+\`, the two model settings, and pictures the agent
shows. Commands, keys, settings and what is not there yet: [`vscode/README.md`](vscode/README.md).

## Tests

`scripts/test-nvim.sh` runs the plugin headless against a stand-in agent (needs `nvim` and `python3`).

`scripts/test-vscode.sh` runs the extension's parts that need no editor against a stand-in agent of
its own, and checks the package (needs Node 18 or newer and `python3`). It does not start VS Code.

## Licence

MIT.
