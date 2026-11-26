'use strict';
// The chat view's page: a fixed skeleton with a strict Content-Security-Policy. Nothing a model
// or a server writes is ever part of this text; it reaches the page as messages and is drawn
// with `textContent`. No `vscode` here.

/**
 * @param {{ cspSource: string, nonce: string, scriptUri: string, styleUri: string }} o
 */
function chatHtml(o) {
  // VS Code / VSCodium's `webview.cspSource` may list multiple space-separated origins
  // (e.g. "vscode-resource: https://*.vscode-cdn.net"); forbid quotes, angle brackets, semicolons and newlines.
  if (typeof o.cspSource !== 'string' || !o.cspSource.trim() || /["<>;\r\n]/.test(o.cspSource)) {
    throw new Error('unsafe cspSource for the chat page');
  }
  for (const v of [o.nonce, o.scriptUri, o.styleUri]) {
    if (typeof v !== 'string' || !v || /["<>\s]/.test(v)) throw new Error('unsafe value for the chat page');
  }
  const csp = [
    "default-src 'none'",
    `img-src ${o.cspSource}`,
    `style-src ${o.cspSource}`,
    `script-src 'nonce-${o.nonce}'`,
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ');
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="${o.styleUri}">
<title>LLeMbas</title>
</head>
<body>
<header class="bar">
  <select id="mode" title="Mode (can be changed mid-turn)" aria-label="Mode"></select>
  <select id="model" title="This session's model" aria-label="Model"></select>
  <button id="sessions" type="button" class="second" title="Resume a previous session">History</button>
  <button id="new" type="button" title="Start a new session">New</button>
</header>
<main id="log" aria-live="polite"></main>
<footer>
  <div id="popup" class="popup" hidden role="listbox" aria-label="Suggestions"></div>
  <textarea id="prompt" rows="3" placeholder="Ask LLeMbas (@file, /command, Enter sends, Shift+Enter newline)" aria-label="Message"></textarea>
  <div class="send">
    <div class="left-controls">
      <button id="add-file" type="button" class="second" title="Add a file from the project index (@file)">@ File</button>
      <div id="attached" class="attached" hidden>
        <span id="attached-label" class="attached-label"></span>
        <button id="detach" type="button" class="plain" title="Do not send the selection" aria-label="Do not send the selection">×</button>
      </div>
    </div>
    <span id="working" class="working" hidden>Working…</span>
    <div class="actions">
      <button id="stop" type="button" class="second" hidden>Stop</button>
      <button id="send" type="button">Send</button>
    </div>
  </div>
</footer>
<script nonce="${o.nonce}" src="${o.scriptUri}"></script>
</body>
</html>`;
}

module.exports = { chatHtml };
