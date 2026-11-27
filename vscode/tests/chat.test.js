'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { receiveShown } = require('../src/media');
const { editorContext } = require('../src/context');
const { fakeChat, tempDir, until, text } = require('./helpers');

const lastPrompt = (agent) => agent.log().filter((m) => m.method === 'session/prompt').pop();

test('a typed prompt is answered: what was typed, then the reply, in order', async (t) => {
  const { chat, agents } = fakeChat(t);
  const states = [];
  chat.on('state', () => states.push(chat.state().busy));
  assert.equal(await chat.send('hello'), true);
  assert.equal(text(chat), 'You: hello\nLLeMbas: Hello there.\nSecond line');
  assert.equal(chat.busy, false);
  assert.ok(states.includes(true), 'the view heard that a turn runs');
  assert.deepEqual(chat.state().modes, [{ id: 'ask', name: 'Ask' }, { id: 'edit', name: 'Edit' }]);
  assert.equal(chat.state().mode, 'ask');
  assert.equal(chat.state().model, 'example/model-a');
  const sent = lastPrompt(agents[0]);
  assert.deepEqual(sent.params.prompt, [{ type: 'text', text: 'hello' }]);
  assert.equal(sent.params._meta, undefined);
});

test('thinking is hidden unless asked for', async (t) => {
  const a = fakeChat(t);
  await a.chat.send('hello');
  assert.ok(!text(a.chat).includes('hidden thought'));
  const b = fakeChat(t, { options: { showThoughts: true } });
  await b.chat.send('hello');
  assert.equal(text(b.chat), 'You: hello\nThinking: hidden thought\nLLeMbas: Hello there.\nSecond line');
});

test('a second prompt while one runs is refused, and Stop ends the turn', async (t) => {
  const { chat, agents } = fakeChat(t);
  const turn = chat.send('SLOW please');
  await until(() => chat.items.some((i) => i.kind === 'agent'));
  assert.equal(await chat.send('another'), false);
  chat.stop();
  await turn;
  assert.match(text(chat), /> Stopped\.$/);
  assert.ok(agents[0].log().some((m) => m.method === 'session/cancel' && m.params.sessionId === 'ses_test'));
  assert.equal(agents[0].log().filter((m) => m.method === 'session/prompt').length, 1);
});

test('the editor context goes in _meta.lembas.editor, not into the prompt', async (t) => {
  const { chat, agents } = fakeChat(t);
  const editor = editorContext({
    path: '/home/user/project/src/oven.py',
    cursorLine: 12,
    selection: { start: 10, end: 14, text: 'def bake():\n    pass' },
    diagnostics: [{ line: 12, severity: 'error', message: "name 'crumbs' is not defined", source: 'pyflakes' }],
    open: ['/home/user/project/src/oven.py', '/home/user/project/src/flour.py'],
  });
  await chat.send('META what is this', { editor, label: 'src/oven.py:10-14' });
  const sent = lastPrompt(agents[0]);
  assert.deepEqual(sent.params.prompt, [{ type: 'text', text: 'META what is this' }]);
  assert.deepEqual(sent.params._meta.lembas.editor, {
    path: '/home/user/project/src/oven.py',
    cursor: { line: 12 },
    selection: { start: 10, end: 14, text: 'def bake():\n    pass' },
    diagnostics: [{ message: "name 'crumbs' is not defined", line: 12, severity: 'error', source: 'pyflakes' }],
    open: ['/home/user/project/src/flour.py'],
  });
  assert.match(text(chat), /^You: \[src\/oven\.py:10-14\] META what is this/);
  assert.match(text(chat), /editor=\{"cursor": \{"line": 12\}/);
});

test('an agent that does not read the editor context gets it as blocks in front of the prompt', async (t) => {
  const { chat, agents } = fakeChat(t, { env: { FAKE_AGENT_PLAIN: '1' } });
  const editor = editorContext({ path: '/p/a.py', selection: { start: 3, end: 4, text: 'x = 1\ny = 2' }, diagnostics: [{ line: 3, severity: 'warning', message: 'unused' }] });
  await chat.send('why', { editor });
  const sent = lastPrompt(agents[0]);
  assert.equal(sent.params._meta, undefined);
  assert.deepEqual(sent.params.prompt.map((b) => b.type), ['text', 'resource', 'text', 'text']);
  assert.equal(sent.params.prompt[0].text, 'Selected in the editor: /p/a.py, lines 3-4.');
  assert.equal(sent.params.prompt[1].resource.text, 'x = 1\ny = 2');
  assert.match(sent.params.prompt[2].text, /- line 3, warning: unused/);
  assert.equal(sent.params.prompt[3].text, 'why');
});

test('an approval card waits for the answer, and the answer reaches the agent', async (t) => {
  const { chat } = fakeChat(t);
  const turn = chat.send('PERM');
  await until(() => chat.cards.size === 1);
  const card = chat.items.find((i) => i.kind === 'card');
  assert.equal(card.title, 'rm -r build');
  assert.equal(card.tool, 'bash');
  assert.equal(card.reason, 'deletes files');
  assert.deepEqual(card.options.map((o) => o.optionId), ['once', 'deny']);
  assert.equal(card.state, 'open');
  assert.equal(chat.answer(card.id, 'no-such-option'), false);
  assert.equal(chat.answer(card.id, 'deny'), true);
  assert.equal(chat.answer(card.id, 'once'), false, 'a card is answered once');
  await turn;
  assert.equal(card.state, 'answered');
  assert.equal(card.answer, 'Deny');
  assert.match(text(chat), /answer=deny/);
});

test('a card with a diff is shown as a diff before the answer, and nothing is written until then', async (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, 'waybread.py');
  fs.writeFileSync(file, 'old text\n');
  const calls = [];
  const { chat } = fakeChat(t, {
    dir,
    hooks: {
      showDiffs: (cardId, diffs) => calls.push(['show', cardId, diffs, fs.readFileSync(file, 'utf8')]),
      closeDiffs: (cardId) => calls.push(['close', cardId]),
      filesChanged: (files) => calls.push(['changed', files]),
    },
  });
  const turn = chat.send(`DIFFPERM ${file}`);
  await until(() => chat.cards.size === 1);
  const card = chat.items.find((i) => i.kind === 'card');
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'show');
  assert.equal(calls[0][1], card.id);
  assert.deepEqual(calls[0][2], [{ path: file, oldText: 'old text\n', newText: 'rewritten by the agent\n', deleted: false }]);
  assert.equal(calls[0][3], 'old text\n', 'the file is as it was while the card is open');
  assert.deepEqual(card.files, [file]);
  chat.answer(card.id, 'once');
  await turn;
  assert.equal(fs.readFileSync(file, 'utf8'), 'rewritten by the agent\n');
  assert.deepEqual(calls[1], ['close', card.id]);
  assert.deepEqual(calls[2], ['changed', [file]]);
  const tool = chat.items.find((i) => i.kind === 'tool');
  assert.equal(tool.status, 'completed');
  assert.deepEqual(tool.files, [file]);
});

test('a rejected diff leaves the file alone', async (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, 'a.txt');
  fs.writeFileSync(file, 'keep me\n');
  const { chat } = fakeChat(t, { dir });
  const turn = chat.send(`DIFFPERM ${file}`);
  await until(() => chat.cards.size === 1);
  chat.answer(chat.items.find((i) => i.kind === 'card').id, 'deny');
  await turn;
  assert.equal(fs.readFileSync(file, 'utf8'), 'keep me\n');
  assert.ok(!chat.items.some((i) => i.kind === 'tool'));
});

test('a card the agent withdraws is taken down', async (t) => {
  const { chat } = fakeChat(t);
  await chat.send('SETTLE');
  const card = chat.items.find((i) => i.kind === 'card');
  assert.equal(card.state, 'settled');
  assert.equal(chat.cards.size, 0);
  assert.match(text(chat), /answer=cancelled/);
});

test('Stop answers an open card as cancelled', async (t) => {
  const { chat } = fakeChat(t);
  const turn = chat.send('PERM');
  await until(() => chat.cards.size === 1);
  chat.stop();
  await turn;
  assert.equal(chat.items.find((i) => i.kind === 'card').state, 'settled');
  assert.match(text(chat), /answer=cancelled/);
});

test('a tool call is one line that changes as the call goes on', async (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, 'b.txt');
  const { chat } = fakeChat(t, { dir });
  await chat.send(`WRITE ${file}`);
  const tools = chat.items.filter((i) => i.kind === 'tool');
  assert.equal(tools.length, 1);
  assert.equal(tools[0].title, 'edit b.txt');
  assert.equal(tools[0].status, 'completed');
});

test("the agent's question for a file's text is the hook's to answer", async (t) => {
  const asked = [];
  const { chat } = fakeChat(t, {
    hooks: {
      readTextFile: (p) => {
        asked.push(p);
        if (p.path.endsWith('open.py')) return { content: 'unsaved text' };
        throw { code: -32002, message: 'not open in the editor' };
      },
    },
  });
  await chat.send('READ /p/open.py');
  assert.match(text(chat), /read="unsaved text"/);
  assert.deepEqual(asked[0], { sessionId: 'ses_test', path: '/p/open.py' });
  await chat.send('READ /p/closed.py');
  assert.match(text(chat), /read=null/, 'an error: the agent reads the disk itself');
});

test("the agent's write of a file goes to the hook; an error tells it to write the disk itself", async (t) => {
  const dir = tempDir(t);
  const open = path.join(dir, 'open.txt');
  const closed = path.join(dir, 'closed.txt');
  const asked = [];
  const { chat } = fakeChat(t, {
    dir,
    hooks: {
      writeTextFile: async (p) => {
        asked.push(p);
        if (p.path !== open) throw { code: -32002, message: 'not open in the editor' };
      },
    },
  });
  await chat.send(`PUT ${open}`);
  assert.match(text(chat), /put=client/);
  assert.deepEqual(asked[0], { sessionId: 'ses_test', path: open, content: 'put by the agent\n' });
  assert.ok(!fs.existsSync(open), 'the stand-in did not write: the client said it had');
  await chat.send(`PUT ${closed}`);
  assert.match(text(chat), /put=disk/);
  assert.equal(fs.readFileSync(closed, 'utf8'), 'put by the agent\n');
});

test('without a write hook the method is not there', async (t) => {
  const dir = tempDir(t);
  const { chat } = fakeChat(t, { dir });
  await chat.send(`PUT ${path.join(dir, 'a.txt')}`);
  assert.match(text(chat), /put=disk/);
});

test('an agent stopped on purpose takes its session with it at once, before its exit is heard', async (t) => {
  const { chat, agents } = fakeChat(t);
  await chat.send('hello');
  assert.equal(chat.session, 'ses_test');
  const turn = chat.send('PERM');
  await until(() => chat.cards.size === 1);
  // The old way: the process is told to stop, and something asks for the agent before it has gone.
  agents[0].stop();
  const second = await chat.connect(true);
  assert.equal(agents.length, 2);
  assert.equal(second, agents[1]);
  assert.equal(chat.session, null, 'no session id of the agent that is going');
  assert.equal(chat.cards.size, 0);
  assert.equal(chat.items.find((i) => i.kind === 'card').state, 'settled');
  await turn;
  assert.equal(chat.busy, false);
  await new Promise((r) => setTimeout(r, 150)); // the old agent's exit arrives and changes nothing
  assert.equal(chat.agent, agents[1]);
  await chat.send('hello again');
  assert.match(text(chat), /You: hello again\nLLeMbas: Hello there\.\nSecond line$/);
  assert.equal(agents[1].log().filter((m) => m.method === 'session/new').length, 1);

  chat.stopAgent();
  assert.equal(chat.agent, null);
  assert.equal(chat.session, null);
  assert.match(text(chat), /> The agent was stopped\. The next message starts a new session\.$/);
  await chat.send('once more');
  assert.equal(agents.length, 3);
});

test('the models, the session model and the mode', async (t) => {
  const { chat, agents } = fakeChat(t);
  await chat.ensureSession();
  await until(() => chat.models.length === 3);
  assert.deepEqual(chat.state().models.map((m) => m.id), ['example/model-a', 'example/model-b', 'example/model-c']);
  assert.equal(await chat.setModel('example/model-b'), true);
  assert.equal(chat.model, 'example/model-b');
  const conf = agents[0].log().find((m) => m.method === '_lembas/configure');
  assert.deepEqual(conf.params, { sessionId: 'ses_test', model: 'example/model-b' });
  await chat.setMode('edit');
  assert.equal(chat.mode, 'edit');
  assert.deepEqual(agents[0].log().find((m) => m.method === 'session/set_mode').params, { sessionId: 'ses_test', modeId: 'edit' });
});

test('the two saved model settings are read and saved through the agent', async (t) => {
  const { chat, agents } = fakeChat(t, { env: { FAKE_AGENT_AUTOCOMPLETE: 'none' } });
  const data = await chat.loadModels();
  assert.equal(data.autocomplete.model, null);
  assert.deepEqual(data.autocomplete.allowed, ['example/model-a', 'example/model-b']);
  assert.equal(data.main.model, null);
  const saved = await chat.editorSettings({ autocomplete_model: 'example/model-b' });
  assert.equal(saved.autocomplete.model, 'example/model-b');
  assert.equal(saved.autocomplete.source, 'person');
  assert.deepEqual(agents[0].log().filter((m) => m.method === '_lembas/editor/settings').pop().params, { set: { autocomplete_model: 'example/model-b' } });
  assert.equal((await chat.editorSettings({ main_model: 'example/model-c' })).main.model, 'example/model-c');
  assert.equal((await chat.editorSettings()).autocomplete.model, 'example/model-b');
  assert.equal(chat.session, null, 'settings need no session');
});

test("the window's own model and mode start a session", async (t) => {
  const { chat, agents } = fakeChat(t, { options: { model: 'example/model-c', mode: 'manual' } });
  await chat.ensureSession();
  assert.deepEqual(agents[0].log().find((m) => m.method === 'session/new').params._meta, { mode: 'manual', model: 'example/model-c' });
  assert.equal(chat.model, 'example/model-c');
});

test('an agent that dies is said in the chat, and the next message starts a new one', async (t) => {
  const { chat, agents } = fakeChat(t);
  await chat.send('CRASH');
  assert.match(text(chat), /> The agent stopped \(exit 3\): not signed in: run lembas login$/);
  assert.equal(chat.session, null);
  assert.equal(chat.busy, false);
  await chat.send('hello again');
  assert.equal(agents.length, 2);
  assert.match(text(chat), /You: hello again\nLLeMbas: Hello there\.\nSecond line$/);
});

test('a command that is not there is said once in the chat, and not tried at every keystroke', async (t) => {
  const { Agent } = require('../src/agent');
  const { Chat } = require('../src/chat');
  let made = 0;
  let now = 1000;
  const chat = new Chat({
    makeAgent: (o) => {
      made++;
      return new Agent({ command: 'lembas-that-is-not-installed', cwd: o.cwd, onRequest: o.onRequest });
    },
    cwd: () => tempDir(t),
    now: () => now,
  });
  assert.equal(await chat.connect(true), null);
  assert.equal(chat.items.length, 0, 'quietly');
  assert.equal(await chat.connect(true), null);
  assert.equal(made, 1, 'not started again within the minute');
  now += 61000;
  assert.equal(await chat.connect(true), null);
  assert.equal(made, 2);
  await chat.send('hello');
  assert.equal(made, 3, 'a message always tries');
  assert.match(text(chat), /> Could not start lembas-that-is-not-installed: the command was not found\.$/);
  assert.equal(chat.busy, false);
});

test('a new session clears the transcript and keeps the agent', async (t) => {
  const { chat, agents } = fakeChat(t);
  await chat.send('hello');
  let resets = 0;
  chat.on('reset', () => resets++);
  assert.equal(await chat.newSession(), true);
  assert.equal(resets, 1);
  assert.equal(chat.items.length, 0);
  assert.equal(chat.session, null);
  await chat.send('again');
  assert.equal(agents.length, 1);
  assert.equal(agents[0].log().filter((m) => m.method === 'session/new').length, 2);
});

// ---- files the agent shows ---------------------------------------------------------------

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), crypto.randomBytes(5000)]);

function mediaChat(t, maxBytes) {
  const dir = tempDir(t);
  const store = path.join(dir, 'store');
  fs.mkdirSync(store);
  const got = [];
  const made = fakeChat(t, {
    dir,
    hooks: {
      showMedia: async (p, read) => {
        const r = await receiveShown(p, read, { dir: store, maxBytes: maxBytes || 1024 * 1024 });
        got.push(r);
        return r.ok ? { ...r, key: 'm' + got.length } : r;
      },
    },
  });
  return { ...made, got, store };
}

test('a picture the agent shows is fetched in parts, checked, and kept for the chat', async (t) => {
  const { chat, agents, dir, got } = mediaChat(t);
  const file = path.join(dir, 'chart.html'); // the name lies; the bytes are a picture
  fs.writeFileSync(file, PNG);
  await chat.send(`SHOW ${file}`);
  assert.match(text(chat), /shown=\{"shown": true\}/);
  const item = chat.items.find((i) => i.kind === 'media');
  assert.equal(item.picture, true);
  assert.equal(item.name, 'chart.png', 'named by what the bytes are');
  assert.equal(item.size, PNG.length);
  assert.ok(fs.readFileSync(got[0].file).equals(PNG));
  assert.equal(got[0].mime, 'image/png');
  const reads = agents[0].log().filter((m) => m.method === '_lembas/show/read');
  assert.ok(reads.length >= 6, 'the stand-in gives a thousand bytes a time');
  assert.ok(reads.every((m) => m.params.handle === reads[0].params.handle));
});

test('a file that is not a picture is a line with Open; one on this machine is not fetched', async (t) => {
  const { chat, agents, dir, got } = mediaChat(t);
  const file = path.join(dir, 'report.pdf');
  fs.writeFileSync(file, Buffer.concat([Buffer.from('%PDF-1.7\n'), crypto.randomBytes(3000)]));
  await chat.send(`SHOW ${file} WITHURI`);
  const item = chat.items.find((i) => i.kind === 'media');
  assert.equal(item.picture, false);
  assert.equal(item.name, 'report.pdf');
  assert.equal(got[0].original, file);
  assert.equal(got[0].file, undefined);
  assert.deepEqual(got[0].open, { kind: 'pdf', how: 'system' });
  assert.equal(item.opens, true);
  assert.equal(agents[0].log().filter((m) => m.method === '_lembas/show/read').length, 1, 'only its first bytes were read');
});

test('without a file on this machine, the bytes are fetched and written to the store', async (t) => {
  const { chat, dir, got, store } = mediaChat(t);
  const file = path.join(dir, 'notes.bin');
  const bytes = crypto.randomBytes(2500);
  fs.writeFileSync(file, bytes);
  await chat.send(`SHOW ${file}`);
  assert.equal(got[0].picture, false);
  assert.ok(got[0].file.startsWith(store + path.sep));
  assert.ok(fs.readFileSync(got[0].file).equals(bytes));
  assert.equal(got[0].open, null, 'a kind nobody knows is never opened');
  assert.equal(chat.items.find((i) => i.kind === 'media').opens, false);
});

test('a file over the limit is refused in words, to the person and to the agent', async (t) => {
  const { chat, agents, dir } = mediaChat(t, 2048);
  const file = path.join(dir, 'big.png');
  fs.writeFileSync(file, PNG);
  await chat.send(`SHOW ${file}`);
  assert.match(text(chat), /> big\.png was not shown: The file is 5 KB; this editor takes files of up to 2 KB\./);
  assert.match(text(chat), /shown=\{"reason": "The file is 5 KB; this editor takes files of up to 2 KB\.", "shown": false\}/);
  assert.equal(agents[0].log().filter((m) => m.method === '_lembas/show/read').length, 0);
  assert.ok(!chat.items.some((i) => i.kind === 'media'));
});

test('a file whose checksum differs is not shown', async (t) => {
  const { chat, dir, store } = mediaChat(t);
  const file = path.join(dir, 'pic.png');
  fs.writeFileSync(file, PNG);
  await chat.send(`SHOW ${file} BADHASH`);
  assert.match(text(chat), /was not shown: The file did not arrive whole/);
  assert.deepEqual(fs.readdirSync(store), []);
});

test('a text file the agent shows goes to the hook that opens it', async (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, 'page.html');
  fs.writeFileSync(file, '<script>alert(1)</script>');
  const opened = [];
  const { chat } = fakeChat(t, { dir, hooks: { showText: async (p) => (opened.push(p), { shown: true }) } });
  await chat.send(`SHOWTEXT ${file}`);
  assert.equal(opened[0].path, 'page.html');
  assert.equal(opened[0].text, '<script>alert(1)</script>');
  assert.match(text(chat), /> Shown: page\.html/);
});

test('real CLI shapes: files/search objects, historyTurns resume, question Answer[], plan dismissed, and compact', async (t) => {
  const { chat } = fakeChat(t);
  const files = await chat.searchFiles('src');
  assert.deepEqual(files, [
    { path: 'src/app.py', kind: 'file' },
    { path: 'src/utils.py', kind: 'file' },
    { path: 'src', kind: 'dir' },
  ]);

  assert.equal(await chat.resumeSession('ses_prev'), true);
  assert.equal(chat.title, 'Earlier work');
  assert.ok(chat.items.some((i) => i.kind === 'user' && i.text === 'earlier question'));
  assert.ok(chat.items.some((i) => i.kind === 'tool' && i.title === 'read' && i.output === 'ok'));
  assert.ok(chat.items.some((i) => i.kind === 'agent' && i.text === 'earlier answer'));

  const qTurn = chat.send('QUESTION');
  await until(() => chat.questions.size === 1);
  const qItem = chat.items.find((i) => i.kind === 'question');
  chat.answerQuestion(qItem.id, [{ kind: 'options', labels: ['SQLite'] }]);
  await qTurn;
  assert.match(text(chat), /"kind": "options".*"SQLite"/);

  const pTurn = chat.send('PLANCARD');
  await until(() => chat.planCards.size === 1);
  const pItem = chat.items.find((i) => i.kind === 'plancard');
  chat.answerPlan(pItem.id, 'dismissed');
  await pTurn;
  assert.match(text(chat), /"outcome": "dismissed"/);

  assert.equal(await chat.compact(), true);
  assert.match(text(chat), /> Session compacted: Compacted 2 turns\./);
});
