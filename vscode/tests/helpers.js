'use strict';
// Shared by the tests: the stand-in agent, a place for files, and reading what the agent was sent.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Agent } = require('../src/agent');
const { Chat } = require('../src/chat');

const FAKE = path.join(__dirname, 'fake_agent.py');

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llembas-vscode-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** An Agent on the stand-in. `env` adds to the environment; the log of what it received is `agent.log()`. */
function fakeAgent(t, dir, env, more) {
  const logFile = path.join(dir, `agent-${Math.random().toString(36).slice(2)}.log`);
  const agent = new Agent({
    command: 'python3',
    args: [FAKE],
    cwd: dir,
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', FAKE_AGENT_LOG: logFile, ...(env || {}) },
    clientInfo: { name: 'test', version: '0' },
    ...(more || {}),
  });
  agent.log = () => (fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  t.after(() => agent.stop());
  return agent;
}

/** A Chat on the stand-in. Returns `{ chat, agents, dir }`; `agents` fills as the chat starts them. */
function fakeChat(t, options) {
  const o = options || {};
  const dir = o.dir || tempDir(t);
  const agents = [];
  const chat = new Chat({
    makeAgent: (m) => {
      const a = fakeAgent(t, dir, o.env, { cwd: m.cwd, onRequest: m.onRequest, ...(o.agent || {}) });
      agents.push(a);
      return a;
    },
    cwd: () => dir,
    options: () => o.options || {},
    hooks: o.hooks || {},
  });
  t.after(() => chat.dispose());
  return { chat, agents, dir };
}

/** Wait until `test()` is true (checked every few milliseconds). */
async function until(test, ms) {
  const end = Date.now() + (ms || 8000);
  for (;;) {
    if (test()) return true;
    if (Date.now() > end) throw new Error('waited too long for: ' + test);
    await new Promise((r) => setTimeout(r, 10));
  }
}

const text = (chat) =>
  chat.items
    .map((i) => {
      if (i.kind === 'user') return `You: ${i.label ? '[' + i.label + '] ' : ''}${i.text}`;
      if (i.kind === 'agent') return `LLeMbas: ${i.text}`;
      if (i.kind === 'thought') return `Thinking: ${i.text}`;
      if (i.kind === 'note') return `> ${i.text}`;
      if (i.kind === 'tool') return `tool ${i.status}: ${i.title}`;
      if (i.kind === 'card') return `card ${i.state}: ${i.title} (${i.answer})`;
      if (i.kind === 'media') return `media: ${i.name}`;
      return i.kind;
    })
    .join('\n');

module.exports = { FAKE, tempDir, fakeAgent, fakeChat, until, text };
