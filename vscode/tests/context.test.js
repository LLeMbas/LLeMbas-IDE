'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { editorContext, promptParams, selectionLabel, sliceLines, LIMITS } = require('../src/context');

test('nothing to say is no context at all', () => {
  assert.equal(editorContext(null), undefined);
  assert.equal(editorContext({}), undefined);
  assert.equal(editorContext({ diagnostics: [], open: [] }), undefined);
});

test('lines are 1-based, a selection in another file names it, the open file is not listed twice', () => {
  assert.deepEqual(editorContext({ path: '/p/a.py', cursorLine: 3, selection: { path: '/p/a.py', start: 2, end: 2, text: 'x' }, open: ['/p/a.py', '/p/b.py', '/p/b.py'] }), {
    path: '/p/a.py',
    cursor: { line: 3 },
    selection: { start: 2, end: 2, text: 'x' },
    open: ['/p/b.py'],
  });
  assert.deepEqual(editorContext({ path: '/p/a.py', selection: { path: '/p/c.py', start: 5, end: 3 } }).selection, { start: 5, end: 5, path: '/p/c.py' });
  assert.equal(editorContext({ path: '/p/a.py', cursorLine: 0 }).cursor, undefined);
});

test('diagnostics and open files are kept to the limits, each message one line', () => {
  const many = Array.from({ length: 50 }, (_, i) => ({ line: i + 1, severity: 'error', message: 'bad\n  thing ' + i + ' ' + 'x'.repeat(400), source: 'lint' }));
  const ctx = editorContext({ path: '/p/a.py', diagnostics: [...many, { message: '   ' }, null], open: Array.from({ length: 80 }, (_, i) => '/p/f' + i) });
  assert.equal(ctx.diagnostics.length, LIMITS.diagnostics);
  assert.ok(ctx.diagnostics.every((d) => !d.message.includes('\n') && d.message.length <= LIMITS.diagnosticChars));
  assert.match(ctx.diagnostics[0].message, /^bad thing 0 x+…$/);
  assert.equal(ctx.open.length, LIMITS.open);
  assert.equal(editorContext({ diagnostics: [{ message: 'm', severity: 'fatal', line: -2 }] }).diagnostics[0].severity, undefined);
});

test('the prompt: context beside the text for an agent that reads it', () => {
  const editor = editorContext({ path: '/p/a.py', cursorLine: 3 });
  assert.deepEqual(promptParams('ses_1', 'hi', editor, true), {
    sessionId: 'ses_1',
    prompt: [{ type: 'text', text: 'hi' }],
    _meta: { lembas: { editor: { path: '/p/a.py', cursor: { line: 3 } } } },
  });
  assert.deepEqual(promptParams('ses_1', 'hi', undefined, true), { sessionId: 'ses_1', prompt: [{ type: 'text', text: 'hi' }] });
  assert.deepEqual(promptParams('ses_1', 'hi', editor, false).prompt, [
    { type: 'text', text: 'Open in the editor: /p/a.py, cursor on line 3.' },
    { type: 'text', text: 'hi' },
  ]);
});

test('how a selection is named', () => {
  assert.equal(selectionLabel('src/a.py', 3, 9), 'src/a.py:3-9');
  assert.equal(selectionLabel('src/a.py', 3, 3), 'src/a.py:3');
  assert.equal(selectionLabel('', 1, 2), 'untitled:1-2');
});

test("the part of a text the agent asks for (ACP's line and limit)", () => {
  const text = 'one\ntwo\nthree\nfour\n';
  assert.equal(sliceLines(text), text);
  assert.equal(sliceLines(text, null, null), text);
  assert.equal(sliceLines(text, 1), text);
  assert.equal(sliceLines(text, 2, 2), 'two\nthree');
  assert.equal(sliceLines(text, 3), 'three\nfour\n');
  assert.equal(sliceLines(text, 1, 1), 'one');
  assert.equal(sliceLines(text, 99, 5), '');
  assert.equal(sliceLines(text, 2, 0), '');
  assert.equal(sliceLines(text, 'x', 'y'), text);
});
