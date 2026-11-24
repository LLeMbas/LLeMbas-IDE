# LLeMbas IDE

LLeMbas in your editor: a Neovim plugin, and a VS Code / VSCodium extension (not written yet).

Both are clients of the [LLeMbas CLI](https://github.com/LLeMbas/LLeMbas-CLI). The CLI is the agent:
it holds the sign-in to your LLeMbas server, the models, the tools and the permissions. The editor
starts `lembas serve --stdio` and talks to it over the Agent Client Protocol. Nothing about a server
or a model is set in the editor.

This is a beta. It needs LLeMbas CLI 2.0.0-beta.12 or newer, signed in (`lembas login <address>`).

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
| `:'<,'>LLeMbasEdit [instruction]` | have the selected lines rewritten (the file must be saved) |
| `:LLeMbasStop` | stop the running turn |
| `:LLeMbasNew` | start a new session |
| `:LLeMbasMode [mode]` | change the mode |
| `:LLeMbasModel [model]` | show or change the model |

In the prompt: Enter (normal mode) or Ctrl-S sends, Ctrl-C stops the turn, `q` closes the panel.
Help: `:help llembas`.

Not there yet: completion as you type, a rewrite shown as a diff you accept or reject, picking an
older session. In this version the agent changes files on disk itself, under the CLI's permissions.

## Tests

`scripts/test-nvim.sh` runs the plugin headless against a stand-in agent (needs `nvim` and `python3`).

## Licence

MIT.
