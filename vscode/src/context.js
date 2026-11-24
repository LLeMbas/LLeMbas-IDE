'use strict';
// What the editor knows and the agent is told with a prompt (`_meta.lembas.editor`), and the
// answer to the agent's question for a file's text. No `vscode` here.

const LIMITS = { diagnostics: 20, diagnosticChars: 300, open: 30, selectionChars: 20000 };
const SEVERITIES = ['error', 'warning', 'info', 'hint'];

function oneLine(text, max) {
  const flat = String(text).replace(/\s+/g, ' ').trim();
  return flat.length > max ? flat.slice(0, max - 1) + '…' : flat;
}

/**
 * The `editor` object of a prompt, from plain data. Lines are 1-based, a selection's range
 * inclusive. Returns `undefined` when there is nothing to say.
 * @param {{ path?: string, cursorLine?: number,
 *           selection?: { path?: string, start: number, end: number, text?: string },
 *           diagnostics?: { path?: string, line?: number, severity?: string, message: string, source?: string }[],
 *           open?: string[] }} seen
 */
function editorContext(seen) {
  if (!seen) return undefined;
  const out = {};
  if (seen.path) out.path = seen.path;
  if (Number.isInteger(seen.cursorLine) && seen.cursorLine > 0) out.cursor = { line: seen.cursorLine };
  if (seen.selection && Number.isInteger(seen.selection.start) && Number.isInteger(seen.selection.end)) {
    const s = seen.selection;
    out.selection = { start: Math.max(1, s.start), end: Math.max(s.start, s.end) };
    if (s.path && s.path !== seen.path) out.selection.path = s.path;
    if (typeof s.text === 'string') out.selection.text = s.text;
  }
  const diagnostics = [];
  for (const d of seen.diagnostics || []) {
    if (!d || typeof d.message !== 'string' || !d.message.trim()) continue;
    if (diagnostics.length >= LIMITS.diagnostics) break;
    const item = { message: oneLine(d.message, LIMITS.diagnosticChars) };
    if (d.path) item.path = d.path;
    if (Number.isInteger(d.line) && d.line > 0) item.line = d.line;
    if (SEVERITIES.includes(d.severity)) item.severity = d.severity;
    if (d.source) item.source = oneLine(d.source, 60);
    diagnostics.push(item);
  }
  if (diagnostics.length) out.diagnostics = diagnostics;
  const open = [];
  for (const p of seen.open || []) {
    if (typeof p !== 'string' || !p || p === seen.path || open.includes(p)) continue;
    if (open.length >= LIMITS.open) break;
    open.push(p);
  }
  if (open.length) out.open = open;
  return Object.keys(out).length ? out : undefined;
}

/** How a selection is named in the transcript: `file.py:3-9`. */
function selectionLabel(name, start, end) {
  return `${name || 'untitled'}:${start}${end !== start ? '-' + end : ''}`;
}

/**
 * The params of `session/prompt` for a typed text and what the editor shows. An agent that
 * lists the capability `editor` gets the context as `_meta.lembas.editor`; an older one gets a
 * sentence and the selected text in front of the prompt, as the prompt's own blocks.
 */
function promptParams(sessionId, text, editor, agentReadsEditor) {
  const params = { sessionId, prompt: [] };
  if (editor && agentReadsEditor) {
    params._meta = { lembas: { editor } };
  } else if (editor) {
    const sel = editor.selection;
    const where = (sel && sel.path) || editor.path || 'an unsaved file';
    if (sel) {
      params.prompt.push({ type: 'text', text: `Selected in the editor: ${where}, lines ${sel.start}-${sel.end}.` });
      if (typeof sel.text === 'string') {
        params.prompt.push({
          type: 'resource',
          resource: { uri: `untitled:selection#L${sel.start}-${sel.end}`, mimeType: 'text/plain', text: sel.text },
        });
      }
    } else if (editor.path) {
      const at = editor.cursor ? `, cursor on line ${editor.cursor.line}` : '';
      params.prompt.push({ type: 'text', text: `Open in the editor: ${editor.path}${at}.` });
    }
    if (editor.diagnostics && editor.diagnostics.length) {
      const lines = editor.diagnostics.map(
        (d) => `- ${d.line ? 'line ' + d.line + ', ' : ''}${d.severity || 'info'}${d.source ? ' (' + d.source + ')' : ''}: ${d.message}`,
      );
      params.prompt.push({ type: 'text', text: 'Diagnostics the editor shows there:\n' + lines.join('\n') });
    }
  }
  params.prompt.push({ type: 'text', text });
  return params;
}

/**
 * The part of a text ACP's `fs/read_text_file` asks for: from `line` (1-based), at most `limit`
 * lines. Without either, the whole text.
 */
function sliceLines(text, line, limit) {
  const from = Number.isFinite(Number(line)) && Number(line) > 1 ? Math.floor(Number(line)) : 1;
  const count = Number.isFinite(Number(limit)) && Number(limit) >= 0 && limit !== null && limit !== undefined ? Math.floor(Number(limit)) : null;
  if (from === 1 && count === null) return text;
  const lines = String(text).split('\n');
  return lines.slice(from - 1, count === null ? undefined : from - 1 + count).join('\n');
}

module.exports = { editorContext, promptParams, selectionLabel, sliceLines, LIMITS };
