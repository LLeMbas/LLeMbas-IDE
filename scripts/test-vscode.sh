#!/bin/sh
# The extension's tests: the parts that need no editor, against a stand-in agent.
# Needs Node 18 or newer and python3. Nothing here starts VS Code.
set -eu
cd "$(dirname "$0")/.."
exec node --test vscode/tests/*.test.js
