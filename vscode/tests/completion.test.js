'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Completer, windowAround } = require('../src/completion');
const { fakeChat, until } = require('./helpers');

/** A Completer on a hand-wound clock and a hand-answered agent. */
function rig(options) {
  const timers = [];
  const sent = [];
  const notes = [];
  const refusals = [];
  const errors = [];
  let now = 0;
  const completer = new Completer({
    request: (method, params) => new Promise((resolve, reject) => sent.push({ method, params, resolve, reject })),
    notify: (method, params) => notes.push({ method, params }),
    debounceMs: () => 250,
    model: () => (options && options.model) || undefined,
    onRefusal: (reason, message, manual) => refusals.push({ reason, message, manual }),
    onError: (message, manual) => errors.push({ message, manual }),
    setTimeout: (fn, ms) => {
      const timer = { fn, at: now + ms, dead: false };
      timers.push(timer);
      return timer;
    },
    clearTimeout: (timer) => {
      timer.dead = true;
    },
    now: () => now,
  });
  const tick = (ms) => {
    now += ms;
    for (const timer of timers.splice(0)) {
      if (timer.dead) continue;
      if (timer.at <= now) timer.fn();
      else timers.push(timer);
    }
  };
  const settle = () => new Promise((r) => setImmediate(r));
  return { completer, sent, notes, refusals, errors, tick, settle };
}

const refusal = (reason, message) => Object.assign(new Error(message), { code: -32602, data: { reason } });

test('nothing is sent until the pause is over', async () => {
  const { completer, sent, tick } = rig();
  const p = completer.ask({ prefix: 'def bake(', suffix: '):', path: '/p/oven.py', language: 'python' });
  tick(249);
  assert.equal(sent.length, 0);
  tick(1);
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0], { method: '_lembas/complete', params: { id: 'c1', prefix: 'def bake(', suffix: '):', path: '/p/oven.py', language: 'python' }, resolve: sent[0].resolve, reject: sent[0].reject });
  sent[0].resolve({ text: 'flour', model: 'm', finish: 'stop' });
  assert.equal(await p, 'flour');
});

test('typing on before the pause is over: the earlier request is never sent', async () => {
  const { completer, sent, notes, tick } = rig();
  const first = completer.ask({ prefix: 'a' });
  tick(100);
  const second = completer.ask({ prefix: 'ab' });
  assert.equal(await first, null);
  tick(250);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].params.prefix, 'ab');
  assert.equal(notes.length, 0, 'nothing was under way, so nothing is cancelled');
  sent[0].resolve({ text: 'c' });
  assert.equal(await second, 'c');
});

test('a request under way is cancelled by its own id when the next keystroke comes', async () => {
  const { completer, sent, notes, tick, settle } = rig();
  const first = completer.ask({ prefix: 'a' });
  tick(250);
  const second = completer.ask({ prefix: 'ab' });
  assert.deepEqual(notes, [{ method: '_lembas/complete/cancel', params: { id: 'c1' } }]);
  assert.equal(await first, null, 'answered at once, without waiting for the agent');
  // The agent's late answer to the first, whatever it says, is thrown away.
  sent[0].resolve({ text: 'STALE', model: 'm', finish: 'stop' });
  await settle();
  tick(250);
  assert.equal(sent[1].params.id, 'c2');
  sent[1].resolve({ text: 'fresh' });
  assert.equal(await second, 'fresh');
});

test('a late error of a request that was replaced does not stop the newer one', async () => {
  const { completer, sent, errors, tick, settle } = rig();
  completer.ask({ prefix: 'a' });
  tick(250);
  const second = completer.ask({ prefix: 'ab' }, { manual: true });
  sent[0].reject(new Error('socket closed'));
  await settle();
  assert.equal(errors.length, 1);
  sent[1].resolve({ text: 'ok' });
  assert.equal(await second, 'ok');
});

test('a result that says cancelled, or carries no text, shows nothing', async () => {
  const { completer, sent, tick } = rig();
  let p = completer.ask({ prefix: 'a' });
  tick(250);
  sent[0].resolve({ text: '', cancelled: true });
  assert.equal(await p, null);
  p = completer.ask({ prefix: 'a' });
  tick(250);
  sent[1].resolve({ text: '', model: 'm', finish: 'stop' });
  assert.equal(await p, null);
  p = completer.ask({ prefix: 'a' });
  tick(250);
  sent[2].resolve(null);
  assert.equal(await p, null);
});

test('the editor moving on cancels only the request it meant', async () => {
  const { completer, sent, notes, tick } = rig();
  const first = completer.ask({ prefix: 'a' });
  const seq = completer.current;
  tick(250);
  completer.cancel(seq + 5);
  assert.equal(notes.length, 0);
  completer.cancel(seq);
  assert.equal(await first, null);
  assert.deepEqual(notes.map((n) => n.params.id), ['c1']);
  assert.equal(completer.current, 0);
  completer.cancel(seq); // again: nothing happens
  assert.equal(notes.length, 1);
  assert.equal(sent.length, 1);
});

test('asked by hand, it is sent at once', async () => {
  const { completer, sent } = rig();
  const p = completer.ask({ prefix: 'a' }, { manual: true });
  assert.equal(sent.length, 1);
  sent[0].resolve({ text: 'b' });
  assert.equal(await p, 'b');
});

test('the quick switch of this window is the request\'s model', () => {
  const { completer, sent } = rig({ model: 'example/model-b' });
  completer.ask({ prefix: 'a' }, { manual: true });
  assert.equal(sent[0].params.model, 'example/model-b');
});

test('no autocomplete model: said once, then quiet until one is set', async () => {
  const { completer, sent, refusals, tick } = rig();
  let p = completer.ask({ prefix: 'a' });
  tick(250);
  sent[0].reject(refusal('no_model', 'No autocomplete model is chosen. Choose one in your settings.'));
  assert.equal(await p, null);
  assert.deepEqual(refusals, [{ reason: 'no_model', message: 'No autocomplete model is chosen. Choose one in your settings.', manual: false }]);

  for (let i = 0; i < 5; i++) {
    p = completer.ask({ prefix: 'more' + i });
    tick(250);
    assert.equal(await p, null);
  }
  assert.equal(sent.length, 1, 'no further request while typing');
  assert.equal(refusals.length, 1, 'and it is not said again');

  completer.unblock(); // a model was chosen
  p = completer.ask({ prefix: 'a' });
  tick(250);
  assert.equal(sent.length, 2);
  sent[1].resolve({ text: 'x' });
  assert.equal(await p, 'x');
});

test('asked by hand while it is quiet: the server is asked again, and its answer counts', async () => {
  const { completer, sent, refusals, tick } = rig();
  let p = completer.ask({ prefix: 'a' });
  tick(250);
  sent[0].reject(refusal('no_model', 'No autocomplete model is chosen.'));
  await p;
  p = completer.ask({ prefix: 'a' }, { manual: true });
  sent[1].reject(refusal('no_model', 'No autocomplete model is chosen.'));
  await p;
  assert.equal(refusals.length, 2, 'asked on purpose, so it is said again');
  assert.equal(refusals[1].manual, true);
  // Meanwhile a model was chosen elsewhere: the next request by hand works, and typing asks again.
  p = completer.ask({ prefix: 'a' }, { manual: true });
  sent[2].resolve({ text: 'yes' });
  assert.equal(await p, 'yes');
  p = completer.ask({ prefix: 'ab' });
  tick(250);
  assert.equal(sent.length, 4);
});

test('another failure is not a refusal: typing pauses a while and then asks again', async () => {
  const { completer, sent, refusals, errors, tick } = rig();
  let p = completer.ask({ prefix: 'a' });
  tick(250);
  sent[0].reject(Object.assign(new Error('The server did not answer.'), { code: -32603 }));
  assert.equal(await p, null);
  assert.equal(refusals.length, 0);
  assert.deepEqual(errors, [{ message: 'The server did not answer.', manual: false }]);
  p = completer.ask({ prefix: 'ab' });
  tick(250);
  assert.equal(await p, null);
  assert.equal(sent.length, 1);
  tick(15000);
  completer.ask({ prefix: 'abc' });
  tick(250);
  assert.equal(sent.length, 2);
});

test('the window around the cursor: the end of what is before, the start of what is after', () => {
  const text = 'a'.repeat(50) + '|' + 'b'.repeat(50);
  const w = windowAround(text, 51, { prefixMax: 10, suffixMax: 5 });
  assert.equal(w.prefix, 'aaaaaaaaa|');
  assert.equal(w.suffix, 'bbbbb');
  assert.deepEqual(windowAround('short', 2), { prefix: 'sh', suffix: 'ort' });
  assert.deepEqual(windowAround('x', 99), { prefix: 'x', suffix: '' });
  // A character of two units is never cut in half.
  const bread = 'ab🍞cd🍞ef';
  const cut = windowAround(bread, 5, { prefixMax: 2, suffixMax: 2 });
  assert.equal(cut.prefix, 'c');
  assert.equal(cut.suffix, 'd');
});

// ---- against the stand-in agent, on the real clock ----------------------------------------

function onAgent(t, env, extra) {
  const { chat, agents } = fakeChat(t, { env });
  const refusals = [];
  const completer = new Completer({
    request: (m, p) => chat.request(m, p, true),
    notify: (m, p) => chat.notify(m, p),
    debounceMs: () => 20,
    onRefusal: (reason, message) => refusals.push({ reason, message }),
    ...(extra || {}),
  });
  return { chat, agents, completer, refusals };
}

test('agent: a completion comes back as text to insert', async (t) => {
  const { completer, agents } = onAgent(t);
  assert.equal(await completer.ask({ prefix: 'def bake', suffix: '', language: 'python' }), '<bake|example/model-a>');
  const sent = agents[0].log().find((m) => m.method === '_lembas/complete');
  assert.deepEqual(sent.params, { id: 'c1', prefix: 'def bake', suffix: '', language: 'python' });
  assert.ok(!agents[0].log().some((m) => m.method === 'session/new'), 'a completion needs no session');
});

test('agent: a slow completion is cancelled by the next one, and only the newest is shown', async (t) => {
  const { completer, agents, chat } = onAgent(t);
  await chat.connect(true);
  const slow = completer.ask({ prefix: 'SLOWC one' }, { manual: true });
  await until(() => agents[0].log().some((m) => m.method === '_lembas/complete'));
  const fast = completer.ask({ prefix: 'two' }, { manual: true });
  assert.equal(await slow, null);
  assert.equal(await fast, '<two|example/model-a>');
  assert.deepEqual(agents[0].log().find((m) => m.method === '_lembas/complete/cancel').params, { id: 'c1' });
});

test('agent: nobody has chosen a model — said once with the server\'s sentence, then a window choice works', async (t) => {
  let model;
  const { completer, agents, refusals } = onAgent(t, { FAKE_AGENT_AUTOCOMPLETE: 'none' }, { model: () => model });
  assert.equal(await completer.ask({ prefix: 'a' }), null);
  assert.equal(await completer.ask({ prefix: 'ab' }), null);
  assert.equal(await completer.ask({ prefix: 'abc' }), null);
  assert.deepEqual(refusals, [{ reason: 'no_model', message: 'No autocomplete model is chosen. Choose one in your settings on the server.' }]);
  assert.equal(agents[0].log().filter((m) => m.method === '_lembas/complete').length, 1);
  model = 'example/model-b';
  completer.unblock();
  assert.equal(await completer.ask({ prefix: 'abc' }), '<abc|example/model-b>');
});

test('agent: a model not allowed for autocomplete is a refusal of its own', async (t) => {
  const { completer, refusals } = onAgent(t, {}, { model: () => 'example/model-c' });
  assert.equal(await completer.ask({ prefix: 'a' }), null);
  assert.equal(refusals[0].reason, 'not_allowed');
});
