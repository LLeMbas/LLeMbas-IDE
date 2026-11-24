#!/bin/sh
# The Neovim plugin's tests: headless, against a stand-in agent. Needs nvim 0.10+ and python3.
set -eu
cd "$(dirname "$0")/.."
exec nvim --headless -u NONE -i NONE --cmd "set rtp+=nvim" -l nvim/tests/run.lua
