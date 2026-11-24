#!/bin/sh
# Builds the VS Code / VSCodium extension as dist/llembas-<version>.vsix. Needs only Node 18 or
# newer: no packaging tool, no npm install. The version is the repository's VERSION file.
set -eu
cd "$(dirname "$0")/.."
exec node vscode/tools/vsix.js "$@"
