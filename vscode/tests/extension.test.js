'use strict';
// extension.js, loaded against tests/stub_vscode.js and the stand-in agent. This is NOT a run
// inside VS Code: the editor here is a few hundred lines of memory. It shows that the glue
// loads, registers what the manifest names, and drives the tested modules the way it means to.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const crypto = require('node:crypto');
const { make } = require('./stub_vscode');
const { FAKE, tempDir, until } = require('./helpers');

const ROOT = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), crypto.randomBytes(3000)]);

/** Activate the extension in a fresh stand-in editor whose `lembas` is the stand-in agent. */
function host(t, env) {
  const dir = tempDir(t);
  const log = path.join(dir, 'agent.log');
  const command = path.join(dir, 'lembas');
  const vars = { FAKE_AGENT_LOG: log, PYTHONDONTWRITEBYTECODE: '1', ...(env || {}) };
  const exports_ = Object.entries(vars).map(([k, v]) => `export ${k}='${v}'`).join('\n');
  // The extension starts `<command> serve --stdio`; this one is the stand-in, whatever it is told.
  fs.writeFileSync(command, `#!/bin/sh\n${exports_}\nexec python3 '${FAKE}'\n`, { mode: 0o755 });
  const vscode = make(pkg);
  vscode.__.config['llembas.command'] = command;
  vscode.workspace.workspaceFolders = [{ uri: vscode.Uri.file(dir) }];
  const load = Module._load;
  Module._load = function (request, ...rest) {
    return request === 'vscode' ? vscode : load.call(this, request, ...rest);
  };
  for (const key of Object.keys(require.cache)) if (key.startsWith(ROOT + path.sep) && !key.includes(`${path.sep}tests${path.sep}`)) delete require.cache[key];
  const extension = require('../extension.js');
  Module._load = load;
  const context = { subscriptions: [], extensionUri: vscode.Uri.file(ROOT), extension: { packageJSON: { version: '0.0.0' } } };
  extension.activate(context);
  t.after(() => {
    for (const s of context.subscriptions) s.dispose && s.dispose();
    extension.deactivate();
  });
  const view = vscode.__.view();
  vscode.__.viewProviders.get('llembas.chat').provider.resolveWebviewView(view);
  view.say({ type: 'ready' });
  const sent = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  const run = (name, ...args) => vscode.__.commands.get(name)(...args);
  /** The newest version of every item the page was sent, in order. */
  const items = () => {
    const byId = new Map();
    for (const m of view.posted) {
      if (m.type === 'reset') {
        byId.clear();
        for (const i of m.items) byId.set(i.id, i);
      } else if (m.type === 'item') byId.set(m.item.id, m.item);
    }
    return [...byId.values()];
  };
  const state = () => view.posted.filter((m) => m.type === 'state' || m.type === 'reset').pop().state;
  const idle = () => until(() => state().busy === false && items().length > 0);
  return { vscode, view, dir, sent, run, items, state, idle, s: vscode.__ };
}

const flat = (ast) => JSON.stringify(ast);

test('activation registers the view, every command of the manifest, the providers and a status item', (t) => {
  const { s, view } = host(t);
  assert.deepEqual([...s.commands.keys()].sort(), pkg.contributes.commands.map((c) => c.command).sort());
  assert.ok(s.viewProviders.get('llembas.chat').options.webviewOptions.retainContextWhenHidden);
  assert.equal(s.inlineProviders.length, 1);
  assert.equal(s.lensProviders.length, 1);
  assert.ok(s.contentProviders.has('llembas-diff'));
  assert.equal(s.statusItems[0].text, 'LLeMbas');
  assert.equal(s.statusItems[0].command, 'llembas.modelSettings');
  assert.equal(view.webview.options.enableScripts, true);
  assert.equal(view.webview.options.enableCommandUris, false);
  assert.equal(view.webview.options.localResourceRoots.length, 2);
  assert.match(view.webview.html, /Content-Security-Policy" content="default-src 'none'; img-src https:\/\/file\.example; style-src https:\/\/file\.example; script-src 'nonce-[A-Za-z0-9_-]{20,}'/);
  assert.deepEqual(view.posted[0], { type: 'reset', items: [], state: { busy: false, session: false, mode: null, modes: [], model: null, models: [] }, attached: '' });
});

test('a message typed in the view is answered, and the reply reaches the page as a tree, not as markup', async (t) => {
  const { vscode, view, sent, items, state, idle, dir } = host(t);
  vscode.__.open(path.join(dir, 'oven.py'), 'def bake():\n    pass\n', new vscode.Selection(1, 4, 1, 4), 'python');
  view.say({ type: 'send', text: 'hello' });
  await until(() => items().some((i) => i.kind === 'agent'));
  await idle();
  const [user, agent] = items();
  assert.deepEqual({ kind: user.kind, text: user.text }, { kind: 'user', text: 'hello' });
  assert.equal(agent.text, undefined, "the model's text is not sent as a string to draw");
  assert.equal(flat(agent.ast), flat([{ t: 'p', c: [{ t: 'text', v: 'Hello there.' }, { t: 'br' }, { t: 'text', v: 'Second line' }] }]));
  assert.equal(state().mode, 'ask');
  assert.equal(state().model, 'example/model-a');
  await until(() => state().models.length === 3);
  // The file in front and the cursor went with the prompt.
  const prompt = sent().find((m) => m.method === 'session/prompt');
  assert.deepEqual(prompt.params._meta.lembas.editor, { path: path.join(dir, 'oven.py'), cursor: { line: 2 } });
  assert.equal(sent().find((m) => m.method === 'session/new').params.cwd, dir);
  // The page's own controls.
  view.say({ type: 'setModel', id: 'example/model-b' });
  await until(() => state().model === 'example/model-b');
  view.say({ type: 'setMode', id: 'edit' });
  await until(() => state().mode === 'edit');
  view.say({ type: 'new' });
  await until(() => items().length === 0);
});

test('messages from the page are checked: a bad link is not opened, a wrong shape is ignored', async (t) => {
  const { view, s } = host(t);
  for (const m of [null, 'send', { type: 7 }, { type: 'send', text: 42 }, { type: 'send', text: '   ' }, { type: 'answer', card: 1, option: {} }, { type: 'openLink', href: 'javascript:alert(1)' },
    { type: 'openLink', href: 'command:workbench.action.terminal.new' }, { type: 'openLink', href: 'file:///etc/passwd' }, { type: 'openFile', path: 'relative/path' }, { type: 'openMedia', key: 'nope' }, { type: 'unknown' }]) {
    view.say(m);
  }
  view.say({ type: 'openLink', href: 'https://example.org/docs' });
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(s.external, ['https://example.org/docs']);
  assert.equal(view.posted.filter((m) => m.type === 'item').length, 0, 'nothing was sent to the agent');
});

test('ask about a selection: the answer in the chat, the selection as editor context', async (t) => {
  const { vscode, view, sent, items, idle, run, dir, s } = host(t);
  const file = path.join(dir, 'oven.py');
  vscode.__.open(file, 'import flour\n\ndef bake():\n    return crumbs\n\nprint(bake())\n', new vscode.Selection(2, 0, 4, 0), 'python');
  s.diagnostics.set(vscode.Uri.file(file).toString(), [
    { range: new vscode.Range(3, 11, 3, 17), severity: 0, message: "name 'crumbs' is not defined", source: 'lint' },
    { range: new vscode.Range(0, 0, 0, 12), severity: 1, message: 'unused import', source: 'lint' },
  ]);
  s.inputs.push('META why does this fail?');
  await run('llembas.ask');
  await until(() => items().some((i) => i.kind === 'agent'));
  await idle();
  const prompt = sent().find((m) => m.method === 'session/prompt');
  assert.deepEqual(prompt.params.prompt, [{ type: 'text', text: 'META why does this fail?' }]);
  assert.deepEqual(prompt.params._meta.lembas.editor, {
    path: file,
    cursor: { line: 5 },
    selection: { start: 3, end: 4, text: 'def bake():\n    return crumbs\n' },
    diagnostics: [{ message: "name 'crumbs' is not defined", line: 4, severity: 'error', source: 'lint' }],
  });
  assert.equal(items()[0].label, 'oven.py:3-4');
  assert.ok(s.executed.some((e) => e[0] === 'llembas.chat.focus'), 'the chat is brought forward');

  // Without a question the selection waits for the next message typed.
  s.inputs.push('');
  await run('llembas.ask');
  assert.deepEqual(view.posted.filter((m) => m.type === 'attached').pop(), { type: 'attached', label: 'oven.py:3-4' });
  view.say({ type: 'send', text: 'and this?' });
  await until(() => sent().filter((m) => m.method === 'session/prompt').length === 2);
  assert.equal(sent().filter((m) => m.method === 'session/prompt')[1].params._meta.lembas.editor.selection.start, 3);
  assert.deepEqual(view.posted.filter((m) => m.type === 'attached').pop(), { type: 'attached', label: '' });
  await idle();

  // Nothing selected: said, and nothing sent.
  vscode.window.activeTextEditor.selection = new vscode.Selection(1, 0, 1, 0);
  await run('llembas.ask');
  assert.match(s.messages.pop().text, /select the text/);
});

test('rewrite a selection: shown as changes to accept or reject, nothing written before', async (t) => {
  const { vscode, sent, run, dir, s } = host(t);
  const before = ['top', 'a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7', 'a8', 'a9', 'bottom'].join('\n');
  const editor = vscode.__.open(path.join(dir, 'list.txt'), before, new vscode.Selection(1, 0, 10, 0));
  const doc = editor.document;
  s.inputs.push('REPLACE A1\\na2\\na3\\na5\\na6\\nnew\\na7\\na8\\nA9\\ntail');
  await run('llembas.rewrite');

  const asked = sent().find((m) => m.method === '_lembas/edit');
  assert.equal(asked.params.text, 'a1\na2\na3\na4\na5\na6\na7\na8\na9', 'whole lines, and not the line the selection only ends in front of');
  assert.equal(asked.params.before, 'top');
  assert.equal(asked.params.after, 'bottom');
  assert.equal(asked.params.path, path.join(dir, 'list.txt'));
  assert.equal(asked.params.id, 'e1');
  assert.ok(s.executed.some((e) => e[0] === 'progress'), 'the pieces written so far are shown');

  assert.equal(doc.text, before, 'nothing is written before it is accepted');
  assert.match(s.messages.pop().text, /proposes 4 changes\. Nothing is written until you accept\./);
  const lenses = s.lensProviders[0].provideCodeLenses(doc);
  assert.deepEqual(lenses.map((l) => `${l.range.start.line}:${l.command.title}`), [
    '1:Accept', '1:Reject', '1:Accept all 4', '1:Reject all', '1:Show as a diff', '4:Accept', '4:Reject', '7:Accept', '7:Reject', '9:Accept', '9:Reject',
  ]);
  const [removed, added] = [...editor.decorations.values()];
  assert.deepEqual(removed.map((d) => d.range.start.line), [1, 4, 9]);
  assert.deepEqual(added.map((d) => d.renderOptions.after.contentText), ['→ A1', 'taken away', 'added above: new', '→ A9 (+1 more line)']);

  // The diff view: the file on the left, the whole proposal on the right.
  const diff = s.executed.find((e) => e[0] === 'vscode.diff');
  assert.equal(diff[1], doc.uri);
  assert.equal(diff[2].scheme, 'llembas-diff');
  const proposed = () => s.contentProviders.get('llembas-diff').provideTextDocumentContent(diff[2]);
  assert.equal(proposed(), ['top', 'A1', 'a2', 'a3', 'a5', 'a6', 'new', 'a7', 'a8', 'A9', 'tail', 'bottom'].join('\n'));

  // A second rewrite waits until this one is settled.
  s.inputs.push('anything');
  await run('llembas.rewrite');
  assert.match(s.messages.pop().text, /accept or reject the changes shown in this file first/);

  // Accept the second change (a4 taken away) through its code lens.
  const second = lenses.find((l) => l.range.start.line === 4 && l.command.title === 'Accept').command;
  await run(second.command, ...second.arguments);
  assert.equal(doc.text, ['top', 'a1', 'a2', 'a3', 'a5', 'a6', 'a7', 'a8', 'a9', 'bottom'].join('\n'));
  assert.deepEqual(s.lensProviders[0].provideCodeLenses(doc).filter((l) => l.command.title === 'Accept').map((l) => l.range.start.line), [1, 6, 8]);

  // Reject the first (A1) at the cursor, by the command without arguments.
  editor.selection = new vscode.Selection(1, 0, 1, 0);
  await run('llembas.rejectChange');
  assert.deepEqual(s.lensProviders[0].provideCodeLenses(doc).filter((l) => l.command.title === 'Accept').map((l) => l.range.start.line), [6, 8]);
  assert.equal(proposed(), ['top', 'a1', 'a2', 'a3', 'a5', 'a6', 'new', 'a7', 'a8', 'A9', 'tail', 'bottom'].join('\n'));

  // Typing above moves what is left; then accept all.
  doc.text = 'typed\n' + doc.text;
  doc.version += 1;
  s.changed.fire({ document: doc, contentChanges: [{ range: new vscode.Range(0, 0, 0, 0), text: 'typed\n' }] });
  assert.deepEqual(s.lensProviders[0].provideCodeLenses(doc).filter((l) => l.command.title === 'Accept').map((l) => l.range.start.line), [7, 9]);
  await run('llembas.acceptAllChanges');
  assert.equal(doc.text, ['typed', 'top', 'a1', 'a2', 'a3', 'a5', 'a6', 'new', 'a7', 'a8', 'A9', 'tail', 'bottom'].join('\n'));
  assert.deepEqual(s.lensProviders[0].provideCodeLenses(doc), []);
  assert.deepEqual([...editor.decorations.values()].map((d) => d.length), [0, 0]);
  assert.ok(!s.tabs.some((tab) => tab.input.modified), 'the diff view is closed with the last change');
});

test('rewrite: a change typed over is dropped rather than applied to the wrong text; reject all leaves the file alone', async (t) => {
  const { vscode, run, dir, s } = host(t);
  const editor = vscode.__.open(path.join(dir, 'a.txt'), 'one\ntwo\nthree', new vscode.Selection(0, 0, 2, 5));
  const doc = editor.document;
  s.inputs.push('REPLACE ONE\\ntwo\\nTHREE');
  await run('llembas.rewrite');
  assert.equal(s.lensProviders[0].provideCodeLenses(doc).filter((l) => l.command.title === 'Accept').length, 2);
  // The person edits line 3 behind the extension's back (no change event reaches it).
  doc.text = 'one\ntwo\nthree!';
  await run('llembas.acceptAllChanges');
  assert.equal(doc.text, 'ONE\ntwo\nthree!');
  assert.match(s.messages.pop().text, /the text changed where a change was proposed; it was dropped/);

  s.inputs.push('REPLACE x');
  editor.selection = new vscode.Selection(0, 0, 2, 6);
  await run('llembas.rewrite');
  await run('llembas.rejectAllChanges');
  assert.equal(doc.text, 'ONE\ntwo\nthree!');
  assert.deepEqual(s.lensProviders[0].provideCodeLenses(doc), []);
});

test('rewrite: the answer to the proposal\'s own message accepts all; a file that changed meanwhile shows nothing', async (t) => {
  const { vscode, run, dir, s } = host(t);
  const editor = vscode.__.open(path.join(dir, 'a.txt'), 'one\ntwo', new vscode.Selection(0, 0, 1, 3));
  s.inputs.push('shout');
  s.answers.push('Accept all');
  await run('llembas.rewrite');
  assert.equal(editor.document.text, 'ONE\nTWO');

  s.inputs.push('SLOWE shout');
  const going = run('llembas.rewrite');
  await until(() => typeof s.cancelProgress === 'function');
  await new Promise((r) => setTimeout(r, 100));
  s.cancelProgress();
  await going;
  assert.equal(editor.document.text, 'ONE\nTWO', 'a cancelled rewrite proposes nothing');
  assert.deepEqual(s.lensProviders[0].provideCodeLenses(editor.document), []);
});

test('autocomplete: as you type and by hand, as an inline completion at the cursor', async (t) => {
  const { vscode, sent, dir, s } = host(t);
  s.config['llembas.complete.debounce'] = 10;
  const editor = vscode.__.open(path.join(dir, 'oven.py'), 'def bake(flour):\n    return \nprint(1)\n', new vscode.Selection(1, 11, 1, 11), 'python');
  const provider = s.inlineProviders[0];
  const token = () => ({ isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) });
  const at = new vscode.Position(1, 11);
  const got = await provider.provideInlineCompletionItems(editor.document, at, { triggerKind: 1 }, token());
  assert.equal(got.length, 1);
  assert.equal(got[0].insertText, '<return|example/model-a>');
  assert.deepEqual(got[0].range.start, at);
  assert.deepEqual(sent().find((m) => m.method === '_lembas/complete').params, {
    id: 'c1', prefix: 'def bake(flour):\n    return ', suffix: '\nprint(1)\n', path: path.join(dir, 'oven.py'), language: 'python',
  });
  // The editor's own suggestion list is open: stay out of its way.
  assert.equal(await provider.provideInlineCompletionItems(editor.document, at, { triggerKind: 1, selectedCompletionInfo: {} }, token()), undefined);
  // Switched off: nothing as you type, still there by hand.
  s.config['llembas.complete.auto'] = false;
  assert.equal(await provider.provideInlineCompletionItems(editor.document, at, { triggerKind: 1 }, token()), undefined);
  assert.equal((await provider.provideInlineCompletionItems(editor.document, at, { triggerKind: 0 }, token()))[0].insertText, '<return|example/model-a>');
  s.config['llembas.complete.auto'] = true;
  // The editor moved on before the answer: the request is cancelled by its id and nothing is shown.
  editor.document.text = 'x = SLOWC \n';
  let cancel;
  const moving = provider.provideInlineCompletionItems(editor.document, new vscode.Position(0, 10), { triggerKind: 0 }, {
    isCancellationRequested: false,
    onCancellationRequested: (fn) => ((cancel = fn), { dispose() {} }),
  });
  await until(() => sent().filter((m) => m.method === '_lembas/complete').length === 3);
  cancel();
  assert.equal(await moving, undefined);
  await until(() => sent().some((m) => m.method === '_lembas/complete/cancel'));
  assert.deepEqual(sent().find((m) => m.method === '_lembas/complete/cancel').params, { id: 'c3' });
  // The command asks the editor for an inline suggestion, which comes back to the provider as "by hand".
  await s.commands.get('llembas.complete')();
  assert.ok(s.executed.some((e) => e[0] === 'editor.action.inlineSuggest.trigger'));
});

test('autocomplete without a model: said once with a button, quiet until one is chosen; the quick switch is not saved', async (t) => {
  const { vscode, sent, dir, s } = host(t, { FAKE_AGENT_AUTOCOMPLETE: 'none' });
  s.config['llembas.complete.debounce'] = 5;
  const editor = vscode.__.open(path.join(dir, 'a.py'), 'x = 1\ny = ', new vscode.Selection(1, 4, 1, 4), 'python');
  const provider = s.inlineProviders[0];
  const ask = () => provider.provideInlineCompletionItems(editor.document, new vscode.Position(1, 4), { triggerKind: 1 }, { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) });

  // The person presses the button, picks Model B, for this window only.
  s.answers.push('Choose a model');
  s.picks.push((items) => {
    assert.deepEqual(items.map((i) => i.label), ['Model A', 'Model B', "Use the server's default"], 'only models allowed for autocomplete');
    return items[1];
  });
  s.picks.push((items) => items.find((i) => i.label === 'Only this window'));
  assert.equal(await ask(), undefined);
  assert.deepEqual(s.messages[0], { level: 'info', text: 'LLeMbas: No autocomplete model is chosen. Choose one in your settings on the server.', buttons: ['Choose a model'] });
  await until(() => s.statusItems[0].text === 'LLeMbas: model-b');
  assert.match(s.statusItems[0].tooltip, /example\/model-b \(this window only\)/);
  assert.equal(s.messages.length, 1);

  const got = await ask();
  assert.equal(got[0].insertText, '<=|example/model-b>');
  assert.equal(sent().filter((m) => m.method === '_lembas/complete').pop().params.model, 'example/model-b');
  assert.ok(!sent().some((m) => m.method === '_lembas/editor/settings'), 'a quick switch is saved nowhere');
});

test('autocomplete without a model: asked again and again while typing, the server is asked once', async (t) => {
  const { vscode, sent, dir, s } = host(t, { FAKE_AGENT_AUTOCOMPLETE: 'none' });
  s.config['llembas.complete.debounce'] = 5;
  const editor = vscode.__.open(path.join(dir, 'a.py'), 'x = ', new vscode.Selection(0, 4, 0, 4), 'python');
  const ask = () => s.inlineProviders[0].provideInlineCompletionItems(editor.document, new vscode.Position(0, 4), { triggerKind: 1 }, { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) });
  for (let i = 0; i < 4; i++) assert.equal(await ask(), undefined);
  assert.equal(sent().filter((m) => m.method === '_lembas/complete').length, 1);
  assert.equal(s.messages.length, 1);
});

test('the two model settings: read, and saved in the account through the agent', async (t) => {
  const { sent, run, s } = host(t);
  s.picks.push((items) => {
    assert.deepEqual(items.map((i) => [i.label, i.description]), [['Autocomplete model', 'example/model-a'], ['Main model', 'not chosen']]);
    return items[1];
  });
  s.picks.push((items) => {
    assert.deepEqual(items.map((i) => i.label), ['Model A', 'Model B', 'Model C', "Use the server's default"]);
    return items[2];
  });
  s.picks.push((items) => items.find((i) => i.label === 'Save it'));
  await run('llembas.modelSettings');
  assert.deepEqual(sent().filter((m) => m.method === '_lembas/editor/settings').pop().params, { set: { main_model: 'example/model-c' } });

  s.picks.push((items) => items.find((i) => i.label === 'Model B'));
  s.picks.push((items) => items.find((i) => i.label === 'Save it'));
  await run('llembas.chooseAutocompleteModel');
  assert.deepEqual(sent().filter((m) => m.method === '_lembas/editor/settings').pop().params, { set: { autocomplete_model: 'example/model-b' } });
  assert.equal(s.statusItems[0].text, 'LLeMbas: model-b');

  s.picks.push((items) => items[items.length - 1]);
  await run('llembas.chooseAutocompleteModel');
  assert.deepEqual(sent().filter((m) => m.method === '_lembas/editor/settings').pop().params, { set: { autocomplete_model: null } });
});

test("the window's main model starts sessions and rewrites, and is saved nowhere", async (t) => {
  const { vscode, view, sent, run, items, idle, dir, s } = host(t);
  s.picks.push((items_) => items_.find((i) => i.label === 'Model C'));
  s.picks.push((items_) => items_.find((i) => i.label === 'Only this window'));
  await run('llembas.chooseMainModel');
  assert.ok(!sent().some((m) => m.method === '_lembas/editor/settings'));
  view.say({ type: 'send', text: 'hello' });
  await until(() => items().some((i) => i.kind === 'agent'));
  await idle();
  assert.equal(sent().find((m) => m.method === 'session/new').params._meta.model, 'example/model-c');
  vscode.__.open(path.join(dir, 'a.txt'), 'one', new vscode.Selection(0, 0, 0, 3));
  s.inputs.push('shout');
  await run('llembas.rewrite');
  const edit = sent().find((m) => m.method === '_lembas/edit');
  assert.equal(edit.params.model, 'example/model-c');
  assert.equal(edit.params.sessionId, 'ses_test');
});

test("an approval that carries a diff opens the editor's diff view before the answer, and closes it after", async (t) => {
  const { view, items, idle, dir, s } = host(t);
  const file = path.join(dir, 'waybread.py');
  fs.writeFileSync(file, 'old text\n');
  view.say({ type: 'send', text: `DIFFPERM ${file}` });
  await until(() => items().some((i) => i.kind === 'card'));
  const card = items().find((i) => i.kind === 'card');
  assert.equal(card.state, 'open');
  assert.deepEqual(card.files, [file]);
  const diff = s.executed.find((e) => e[0] === 'vscode.diff');
  const provider = s.contentProviders.get('llembas-diff');
  assert.equal(provider.provideTextDocumentContent(diff[1]), 'old text\n');
  assert.equal(provider.provideTextDocumentContent(diff[2]), 'rewritten by the agent\n');
  assert.equal(diff[3], 'LLeMbas: waybread.py (proposed change)');
  assert.ok(diff[1].path.endsWith('/waybread.py'), 'named like the file, so the editor colours it as one');
  assert.equal(fs.readFileSync(file, 'utf8'), 'old text\n');
  assert.deepEqual(view.shows, [true], 'the chat is shown without taking the keyboard');
  assert.equal(s.tabs.filter((tab) => tab.input.modified).length, 1);

  view.say({ type: 'answer', card: card.id, option: 'once' });
  await until(() => fs.readFileSync(file, 'utf8') === 'rewritten by the agent\n');
  await idle();
  await until(() => items().find((i) => i.kind === 'card').state === 'answered'); // items reach the page a moment after the state
  await until(() => s.tabs.filter((tab) => tab.input.modified).length === 0);
  assert.equal(provider.provideTextDocumentContent(diff[2]), '', 'the texts are let go');
  assert.deepEqual(items().find((i) => i.kind === 'tool').files, [file]);
});

test('unsaved text: the agent reads an open file from the editor, and any other file itself', async (t) => {
  const { vscode, view, items, idle, dir } = host(t);
  const file = path.join(dir, 'draft.md');
  fs.writeFileSync(file, 'saved text\n');
  vscode.__.open(file, 'unsaved text\nline two\n');
  view.say({ type: 'send', text: `READ ${file}` });
  await until(() => items().some((i) => i.kind === 'agent'));
  await idle();
  assert.match(flat(items().find((i) => i.kind === 'agent').ast), /read=\\"unsaved text\\\\nline two\\\\n\\"/);
  view.say({ type: 'send', text: `READ ${path.join(dir, 'not-open.md')}` });
  await until(() => items().filter((i) => i.kind === 'agent').length === 2);
  await idle();
  assert.match(flat(items().filter((i) => i.kind === 'agent')[1].ast), /read=null/);
});

test('media: a picture is shown in the chat; only kinds that are merely displayed open, the rest are shown in their folder', async (t) => {
  const { view, items, idle, dir, s } = host(t);
  const picture = path.join(dir, 'chart.png');
  fs.writeFileSync(picture, PNG);
  view.say({ type: 'send', text: `SHOW ${picture}` });
  await until(() => items().some((i) => i.kind === 'media'));
  await idle();
  const shown = items().find((i) => i.kind === 'media');
  assert.equal(shown.picture, true);
  assert.equal(shown.sizeWords, '3 KB');
  const root = view.webview.options.localResourceRoots[1].path;
  assert.ok(shown.src.startsWith('https://file.example' + root + '/') && shown.src.endsWith('-chart.png'), shown.src);
  assert.ok(fs.readFileSync(shown.src.slice('https://file.example'.length)).equals(PNG));
  assert.equal(shown.opens, true);
  view.say({ type: 'openMedia', key: shown.key });
  await until(() => s.executed.some((e) => e[0] === 'vscode.open'));

  // A new session clears the transcript, and the files that were shown in it go with it.
  const kept = shown.src.slice('https://file.example'.length);
  view.say({ type: 'new' });
  await until(() => items().length === 0);
  await until(() => !fs.existsSync(kept));
  view.say({ type: 'openMedia', key: shown.key });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(s.executed.filter((e) => e[0] === 'vscode.open').length, 1, 'its key opens nothing any more');
  const script = path.join(dir, 'setup.sh');
  fs.writeFileSync(script, '#!/bin/sh\necho hello from a script that must not run\n');
  view.say({ type: 'send', text: `SHOW ${script} WITHURI` });
  await until(() => items().some((i) => i.kind === 'media'));
  await idle();
  const line = items().find((i) => i.kind === 'media');
  assert.equal(line.picture, false);
  assert.equal(line.src, '');
  assert.equal(line.opens, false);
  view.say({ type: 'openMedia', key: line.key });
  await until(() => s.executed.some((e) => e[0] === 'revealFileInOS'));
  assert.equal(s.executed.find((e) => e[0] === 'revealFileInOS')[1].fsPath, script, 'shown in its folder');
  assert.deepEqual(s.external, [], 'not handed to the system');
  assert.equal(s.executed.filter((e) => e[0] === 'vscode.open').length, 1, 'and not opened in the editor');

  // A program that calls itself a PDF, and a document with macros: the same.
  for (const [name, content] of [['invoice.pdf', 'MZ\x90\x00 not a pdf at all'], ['letter.docm', 'PK\x03\x04 macros inside'], ['tool.pyw', 'import os\n']]) {
    view.say({ type: 'new' });
    await until(() => items().length === 0);
    const file = path.join(dir, name);
    fs.writeFileSync(file, content, 'latin1');
    const reveals = s.executed.filter((e) => e[0] === 'revealFileInOS').length;
    view.say({ type: 'send', text: `SHOW ${file} WITHURI` });
    await until(() => items().some((i) => i.kind === 'media'));
    await idle();
    assert.equal(items().find((i) => i.kind === 'media').opens, false, name);
    view.say({ type: 'openMedia', key: items().find((i) => i.kind === 'media').key });
    await until(() => s.executed.filter((e) => e[0] === 'revealFileInOS').length === reveals + 1);
    assert.deepEqual(s.external, [], name);
  }

  view.say({ type: 'new' });
  await until(() => items().length === 0);
  const pdf = path.join(dir, 'report.pdf');
  fs.writeFileSync(pdf, '%PDF-1.7\n' + 'x'.repeat(2000));
  view.say({ type: 'send', text: `SHOW ${pdf} WITHURI` });
  await until(() => items().some((i) => i.kind === 'media'));
  await idle();
  view.say({ type: 'openMedia', key: items().find((i) => i.kind === 'media').key });
  await until(() => s.external.length === 1);
  assert.equal(s.external[0], 'file://' + pdf);
});

test('a text the agent shows that is no file here opens as a read-only document, not as one that wants saving', async (t) => {
  const { view, items, idle, s } = host(t);
  const elsewhere = path.join(tempDir(t), 'page.html');
  fs.writeFileSync(elsewhere, '<script>alert(1)</script>\n');
  view.say({ type: 'send', text: `SHOWTEXT ${elsewhere}` });
  await until(() => items().some((i) => i.kind === 'note'));
  await idle();
  const [, doc] = s.executed.find((e) => e[0] === 'showTextDocument');
  assert.equal(doc.uri.scheme, 'llembas-diff', "the extension's own read-only documents");
  assert.ok(doc.uri.path.endsWith('/page.html'));
  assert.equal(doc.text, '<script>alert(1)</script>\n');
  assert.equal(doc.isDirty, false);
  view.say({ type: 'new' });
  await until(() => items().length === 0);
  assert.equal(s.contentProviders.get('llembas-diff').provideTextDocumentContent(doc.uri), '', 'let go with the transcript');
});

test("the agent's write: put into the open document and saved before the answer; a file not open is left to the agent", async (t) => {
  const { vscode, view, items, idle, sent, dir, s } = host(t);
  const open = path.join(dir, 'open.txt');
  const closed = path.join(dir, 'closed.txt');
  const other = path.join(dir, 'other.txt');
  fs.writeFileSync(open, 'on disk\n');
  fs.writeFileSync(other, 'untouched\n');
  const editor = vscode.__.open(open, 'typed and not saved\n');
  const bystander = vscode.__.open(other, 'unsaved here too\n');
  view.say({ type: 'send', text: `PUT ${open}` });
  await until(() => items().some((i) => i.kind === 'agent'));
  await idle();
  assert.deepEqual(sent().find((m) => m.method === 'initialize').params.clientCapabilities.fs, { readTextFile: true, writeTextFile: true });
  assert.match(flat(items().find((i) => i.kind === 'agent').ast), /put=client/);
  assert.equal(editor.document.text, 'put by the agent\n', 'in the document');
  assert.equal(fs.readFileSync(open, 'utf8'), 'put by the agent\n', 'and on disk');
  assert.equal(editor.document.isDirty, false);
  assert.equal(editor.document.saves, 1);
  assert.equal(bystander.document.text, 'unsaved here too\n', 'no other document is touched');
  assert.equal(bystander.document.saves, 0);
  assert.equal(fs.readFileSync(other, 'utf8'), 'untouched\n');

  view.say({ type: 'send', text: `PUT ${closed}` });
  await until(() => items().filter((i) => i.kind === 'agent').length === 2);
  await idle();
  assert.match(flat(items().filter((i) => i.kind === 'agent')[1].ast), /put=disk/);
  assert.ok(!vscode.workspace.textDocuments.some((d) => d.uri.fsPath === closed), 'nothing was opened for it');
});

test('the agent\'s write keeps a document\'s own line breaks, and saves a document that already has the text', async (t) => {
  const { vscode, view, items, idle, dir } = host(t);
  const file = path.join(dir, 'crlf.txt');
  fs.writeFileSync(file, 'old\r\n');
  const editor = vscode.__.open(file, 'old\r\n');
  editor.document.eol = 2;
  view.say({ type: 'send', text: `PUT ${file}` });
  await until(() => items().some((i) => i.kind === 'agent'));
  await idle();
  assert.equal(fs.readFileSync(file, 'utf8'), 'put by the agent\r\n');
  // Typed to exactly the wanted text, not saved: no edit is needed, the save still is.
  fs.writeFileSync(file, 'stale on disk\r\n');
  editor.document.isDirty = true;
  const version = editor.document.version;
  view.say({ type: 'send', text: `PUT ${file}` });
  await until(() => items().filter((i) => i.kind === 'agent').length === 2);
  await idle();
  assert.equal(editor.document.version, version);
  assert.equal(fs.readFileSync(file, 'utf8'), 'put by the agent\r\n');
});

test('two rewrites of one file do not overwrite each other; another file is not held up', async (t) => {
  const { vscode, run, sent, dir, s } = host(t);
  const a = vscode.__.open(path.join(dir, 'a.txt'), 'one\ntwo', new vscode.Selection(0, 0, 1, 3));
  s.inputs.push('SLOWE shout', 'shout again', 'shout');
  const first = run('llembas.rewrite');
  await until(() => sent().some((m) => m.method === '_lembas/edit'));
  await run('llembas.rewrite'); // the same file, while the first is being written
  assert.match(s.messages.pop().text, /a rewrite of this file is still being written/);
  assert.equal(s.inputs.length, 2, 'refused before anything was asked');
  assert.equal(sent().filter((m) => m.method === '_lembas/edit').length, 1);
  s.inputs.shift();
  // Another file meanwhile: proposed and accepted while the first still waits.
  const b = vscode.__.open(path.join(dir, 'b.txt'), 'three', new vscode.Selection(0, 0, 0, 5));
  await run('llembas.rewrite');
  assert.equal(s.lensProviders[0].provideCodeLenses(b.document).filter((l) => l.command.title === 'Accept').length, 1);
  // The other file's change is accepted while the first rewrite is still out.
  s.cancelProgress = undefined;
  vscode.window.activeTextEditor = b;
  await run('llembas.acceptAllChanges');
  assert.equal(b.document.text, 'THREE');
  assert.equal(a.document.text, 'one\ntwo');
  sent(); // (the slow one is still out)
  vscode.__.commands.get('llembas.restart')();
  await first;
  assert.deepEqual(s.lensProviders[0].provideCodeLenses(a.document), []);
});

test('typing in one file while a change is applied to another is still seen (no one flag for all documents)', async (t) => {
  const { vscode, run, dir, s } = host(t);
  const a = vscode.__.open(path.join(dir, 'a.txt'), 'one\ntwo\nthree', new vscode.Selection(0, 0, 2, 5));
  s.inputs.push('REPLACE ONE\\ntwo\\nTHREE');
  await run('llembas.rewrite');
  const b = vscode.__.open(path.join(dir, 'b.txt'), 'four', new vscode.Selection(0, 0, 0, 4));
  s.inputs.push('shout');
  await run('llembas.rewrite');
  const lines = () => s.lensProviders[0].provideCodeLenses(a.document).filter((l) => l.command.title === 'Accept').map((l) => l.range.start.line);
  assert.deepEqual(lines(), [0, 2]);
  // While the editor applies b's change, a line is typed at the top of a.
  const apply = vscode.workspace.applyEdit;
  vscode.workspace.applyEdit = async (edit) => {
    a.document.text = 'typed\n' + a.document.text;
    s.changed.fire({ document: a.document, contentChanges: [{ range: new vscode.Range(0, 0, 0, 0), text: 'typed\n' }] });
    return apply(edit);
  };
  await run('llembas.acceptAllChanges'); // b is in front
  vscode.workspace.applyEdit = apply;
  assert.equal(b.document.text, 'FOUR');
  assert.deepEqual(lines(), [3], "a's remaining change moved down with its line; the one on the line typed into was dropped");
  vscode.window.activeTextEditor = a;
  await run('llembas.acceptAllChanges');
  assert.equal(a.document.text, 'typed\none\ntwo\nTHREE');
});

test('Stop the Agent lets go of the session at once', async (t) => {
  const { view, items, idle, run, sent, state } = host(t);
  view.say({ type: 'send', text: 'hello' });
  await until(() => items().some((i) => i.kind === 'agent'));
  await idle();
  assert.equal(state().session, true);
  await run('llembas.restart');
  await until(() => state().session === false);
  view.say({ type: 'send', text: 'hello again' });
  await until(() => items().filter((i) => i.kind === 'agent').length === 2);
  await idle();
  assert.ok(!items().some((i) => i.kind === 'note' && /failed/.test(i.text)));
  assert.ok(sent().filter((m) => m.method === 'session/new').length >= 1);
});

test('media over the limit is refused in words', async (t) => {
  const { view, items, idle, dir, s } = host(t);
  s.config['llembas.media.maxMegabytes'] = 1;
  const big = path.join(dir, 'big.bin');
  fs.writeFileSync(big, Buffer.alloc(1024 * 1024 + 10));
  view.say({ type: 'send', text: `SHOW ${big}` });
  await until(() => items().some((i) => i.kind === 'note'));
  await idle();
  assert.equal(items().find((i) => i.kind === 'note').text, 'big.bin was not shown: The file is 1.0 MB; this editor takes files of up to 1 MB.');
});

test('a command that is not installed is said in the chat, and autocomplete stays quiet about it', async (t) => {
  const { vscode, view, items, dir, s } = host(t);
  s.config['llembas.command'] = path.join(dir, 'no-such-lembas');
  s.config['llembas.complete.debounce'] = 5;
  const editor = vscode.__.open(path.join(dir, 'a.py'), 'x = ', new vscode.Selection(0, 4, 0, 4));
  const got = await s.inlineProviders[0].provideInlineCompletionItems(editor.document, new vscode.Position(0, 4), { triggerKind: 1 }, { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) });
  assert.equal(got, undefined);
  assert.equal(s.messages.length, 0);
  assert.equal(items().length, 0);
  view.say({ type: 'send', text: 'hello' });
  await until(() => items().some((i) => i.kind === 'note'));
  assert.match(items().find((i) => i.kind === 'note').text, /^Could not start .*no-such-lembas: the command was not found\.$/);
});
