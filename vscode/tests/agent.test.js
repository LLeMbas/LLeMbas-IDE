'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Agent } = require('../src/agent');
const { tempDir, fakeAgent, until } = require('./helpers');

test('the hello says what this client is: an editor that shows media and has unsaved text', async (t) => {
  const agent = fakeAgent(t, tempDir(t));
  await agent.connect();
  const hello = agent.log().find((m) => m.method === 'initialize');
  assert.equal(hello.params.protocolVersion, 1);
  assert.deepEqual(hello.params.clientCapabilities._meta.lembas, { protocol: 2, editor: true, media: true, show: true });
  assert.deepEqual(hello.params.clientCapabilities.fs, { readTextFile: true, writeTextFile: false }, 'writing is offered only by a client that can do it');
  assert.ok(agent.ready && agent.has('editor') && agent.has('media') && !agent.has('fs'));
});

test('a client that can put text into its documents says so', async (t) => {
  const agent = fakeAgent(t, tempDir(t), {}, { writeTextFile: true });
  await agent.connect();
  assert.deepEqual(agent.log().find((m) => m.method === 'initialize').params.clientCapabilities.fs, { readTextFile: true, writeTextFile: true });
});

test('every caller of connect gets the same start', async (t) => {
  const agent = fakeAgent(t, tempDir(t));
  const [a, b] = await Promise.all([agent.connect(), agent.connect()]);
  assert.equal(a, b);
  assert.equal(agent.log().filter((m) => m.method === 'initialize').length, 1);
});

test('an agent from before the editor methods has no capabilities', async (t) => {
  const agent = fakeAgent(t, tempDir(t), { FAKE_AGENT_PLAIN: '1' });
  await agent.connect();
  assert.ok(!agent.has('editor'));
  await assert.rejects(agent.request('_lembas/models', {}), (e) => e.code === -32601);
});

test('a command that does not exist is said in words, once', async (t) => {
  const agent = new Agent({ command: 'lembas-that-is-not-installed', cwd: tempDir(t) });
  const exits = [];
  agent.on('exit', (e) => exits.push(e));
  await assert.rejects(agent.connect(), /could not start lembas-that-is-not-installed: the command was not found/);
  await assert.rejects(agent.request('x', {}), /not running/);
  assert.equal(exits.length, 1);
  assert.equal(exits[0].started, false);
});

test('an agent that exits fails what was asked and says its last words', async (t) => {
  const agent = fakeAgent(t, tempDir(t));
  await agent.connect();
  const exits = [];
  agent.on('exit', (e) => exits.push(e));
  const r = await agent.request('session/new', { cwd: '/', mcpServers: [] });
  const turn = agent.request('session/prompt', { sessionId: r.sessionId, prompt: [{ type: 'text', text: 'CRASH' }] });
  await assert.rejects(turn, /the agent stopped \(exit 3\): not signed in: run lembas login/);
  await until(() => exits.length === 1);
  assert.equal(exits[0].code, 3);
  assert.equal(exits[0].started, true);
  assert.match(exits[0].last, /not signed in/);
});

test('stop ends the process', async (t) => {
  const agent = fakeAgent(t, tempDir(t));
  await agent.connect();
  let gone = false;
  agent.on('exit', () => (gone = true));
  agent.stop();
  await until(() => gone);
  await assert.rejects(agent.request('x', {}), /not running/);
});
