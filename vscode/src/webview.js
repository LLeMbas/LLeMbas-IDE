'use strict';
// The chat view's page: a fixed skeleton with a strict Content-Security-Policy. Nothing a model
// or a server writes is ever part of this text; it reaches the page as messages and is drawn
// with `textContent`. No `vscode` here.

/**
 * @param {{ cspSource: string, nonce: string, scriptUri: string, styleUri: string, logoUri?: string }} o
 */
function chatHtml(o) {
  // VS Code / VSCodium's `webview.cspSource` may list multiple space-separated origins
  // (e.g. "vscode-resource: https://*.vscode-cdn.net"); forbid quotes, angle brackets, semicolons and newlines.
  if (typeof o.cspSource !== 'string' || !o.cspSource.trim() || /["<>;\r\n]/.test(o.cspSource)) {
    throw new Error('unsafe cspSource for the chat page');
  }
  const uris = [o.nonce, o.scriptUri, o.styleUri];
  if (o.logoUri !== undefined && o.logoUri !== '') uris.push(o.logoUri);
  for (const v of uris) {
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
  const brandImg = o.logoUri ? `<img class="brand-logo" src="${o.logoUri}" alt="" width="18" height="18">` : '';
  const heroImg = o.logoUri ? `<img class="hero-logo" src="${o.logoUri}" alt="LLeMbas IDE" width="44" height="44">` : '';
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
  <div class="bar-top">
    <div class="brand">
      ${brandImg}
      <span id="conn-dot" class="dot" title="Agent status" aria-hidden="true"></span>
      <span id="session-title" class="brand-title">LLeMbas</span>
    </div>
    <div class="bar-btns">
      <button id="compact" type="button" class="second icon-btn" title="Compact session context" hidden>Compact</button>
      <button id="settings-toggle" type="button" class="second icon-btn" title="Autocomplete length, tokens &amp; instructions" aria-expanded="false">Tune</button>
      <button id="sessions" type="button" class="second icon-btn" title="Resume a previous session">History</button>
      <button id="new" type="button" class="icon-btn" title="Start a new session">New</button>
    </div>
  </div>
  <div class="bar-controls">
    <div class="select-wrap">
      <span id="mode-dot" class="dot mode-dot" aria-hidden="true"></span>
      <select id="mode" title="Mode (can be changed mid-turn)" aria-label="Mode"></select>
    </div>
    <select id="model" title="This session's model" aria-label="Model"></select>
  </div>
</header>
<section id="settings-panel" class="settings-panel" hidden aria-label="Autocomplete settings">
  <div class="sp-row">
    <label class="sp-label" for="ac-tokens">Autocomplete max tokens</label>
    <span id="ac-tokens-val" class="sp-val">Default</span>
  </div>
  <input id="ac-tokens" class="sp-slider" type="range" min="0" max="4096" step="16" value="0" aria-label="Autocomplete maximum tokens">
  <div class="sp-presets">
    <button type="button" class="mini preset-btn" data-length="auto" data-tokens="0">Default</button>
    <button type="button" class="mini preset-btn" data-length="words" data-tokens="24">Words</button>
    <button type="button" class="mini preset-btn" data-length="line" data-tokens="64">Line</button>
    <button type="button" class="mini preset-btn" data-length="block" data-tokens="256">Block</button>
    <button type="button" class="mini preset-btn" data-length="file" data-tokens="2048">File</button>
  </div>
  <div class="sp-grid">
    <label class="sp-label" for="ac-length">Prediction scope</label>
    <select id="ac-length" aria-label="Autocomplete prediction scope">
      <option value="auto">Auto (server default)</option>
      <option value="words">Few words</option>
      <option value="line">Single line</option>
      <option value="block">Function / block</option>
      <option value="file">Large / full file</option>
    </select>
  </div>
  <div class="sp-field">
    <label class="sp-label" for="ac-instructions">Autocomplete instructions</label>
    <input id="ac-instructions" class="q-input" type="text" placeholder="Optional guidance (e.g. concise idiomatic code, no comments)">
  </div>
  <div class="sp-checks">
    <label class="sp-check"><input id="ac-auto" type="checkbox"> Suggest as you type</label>
    <label class="sp-check"><input id="chat-thinking" type="checkbox"> Show thinking</label>
  </div>
</section>
<div id="team-bar" class="team-bar" hidden aria-live="polite"></div>
<main id="log" aria-live="polite">
  <section id="empty" class="empty">
    <div class="hero">
      ${heroImg}
      <div class="hero-title">LLeMbas</div>
      <div class="hero-sub">Waybread for the code ahead.</div>
    </div>
    <div class="starter-grid">
      <button type="button" class="starter" data-action="explain">Explain selection</button>
      <button type="button" class="starter" data-action="fix">Fix file problems</button>
      <button type="button" class="starter" data-action="addFile">Add @file</button>
      <button type="button" class="starter" data-action="sessions">Resume session</button>
    </div>
    <div class="hero-hints">
      <span class="hint-pill">@file</span>
      <span class="hint-pill">/command</span>
      <span class="hint-pill">Alt+\ complete</span>
    </div>
  </section>
</main>
<footer>
  <div id="popup" class="popup" hidden role="listbox" aria-label="Suggestions"></div>
  <div id="attached" class="attached" hidden>
    <span id="attached-label" class="attached-label"></span>
    <button id="detach" type="button" class="plain" title="Do not send the selection" aria-label="Do not send the selection">×</button>
  </div>
  <div class="composer">
    <textarea id="prompt" rows="3" placeholder="Ask LLeMbas (@file, /command, Enter sends, Shift+Enter newline)" aria-label="Message"></textarea>
    <div class="send">
      <div class="left-controls">
        <button id="add-file" type="button" class="second" title="Add a file from the project index (@file)">@ File</button>
        <span id="working" class="working" hidden><span class="pulse-dot" aria-hidden="true"></span><span id="working-text">Working…</span></span>
        <span id="usage" class="usage" hidden></span>
      </div>
      <div class="actions">
        <button id="stop" type="button" class="second" hidden>Stop</button>
        <button id="send" type="button">Send</button>
      </div>
    </div>
  </div>
</footer>
<script nonce="${o.nonce}" src="${o.scriptUri}"></script>
</body>
</html>`;
}

module.exports = { chatHtml };
