'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Rpc, RpcError } = require('../src/rpc');

function pair(handlers) {
  const sent = [];
  const rpc = new Rpc({ write: (line) => sent.push(line), ...(handlers || {}) });
  return { rpc, sent, last: () => JSON.parse(sent[sent.length - 1]) };
}

test('a request is one line of JSON-RPC 2.0 and its answer resolves it', async () => {
  const { rpc, sent, last } = pair();
  const p = rpc.request('initialize', { protocolVersion: 1 });
  assert.equal(sent.length, 1);
  assert.ok(sent[0].endsWith('\n') && !sent[0].slice(0, -1).includes('\n'));
  assert.deepEqual(last(), { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1 } });
  rpc.feed('{"jsonrpc":"2.0","id":1,"result":{"ok":true}}\n');
  assert.deepEqual(await p, { ok: true });
});

test('messages split across chunks, several in one chunk, and a character split in two', async () => {
  const got = [];
  const { rpc } = pair({ onNotify: (m, p) => got.push([m, p]) });
  const line = Buffer.from('{"jsonrpc":"2.0","method":"note","params":{"t":"žluťoučký 🍞"}}\n');
  const cut = line.indexOf(0xf0) + 2; // inside the four bytes of the bread
  rpc.feed(line.subarray(0, cut));
  assert.equal(got.length, 0);
  rpc.feed(Buffer.concat([line.subarray(cut), line, Buffer.from('\n   \n')]));
  assert.equal(got.length, 2);
  assert.equal(got[0][1].t, 'žluťoučký 🍞');
});

test('a line that is not JSON, or not an object, is skipped', () => {
  const got = [];
  const { rpc } = pair({ onNotify: (m) => got.push(m) });
  rpc.feed('warming up...\n[1,2]\n"text"\n{"jsonrpc":"2.0","method":"ok"}\n');
  assert.deepEqual(got, ['ok']);
});

test('an error answer rejects with its code, message and reason', async () => {
  const { rpc } = pair();
  const p = rpc.request('_lembas/complete', {});
  rpc.feed('{"jsonrpc":"2.0","id":1,"error":{"code":-32602,"message":"No autocomplete model is chosen.","data":{"reason":"no_model"}}}\n');
  await assert.rejects(p, (e) => e instanceof RpcError && e.code === -32602 && e.reason === 'no_model' && /No autocomplete/.test(e.message));
});

test('a request from the other side is answered: a value, a promise, a refusal, a throw', async () => {
  const { rpc, sent } = pair({
    onRequest: (method, params) => {
      if (method === 'value') return { echo: params.x };
      if (method === 'later') return new Promise((r) => setTimeout(() => r('done'), 5));
      if (method === 'refuse') throw { code: -32002, message: 'cannot read', data: { reason: 'missing' } };
      if (method === 'nothing') return undefined;
      throw new Error('boom');
    },
  });
  rpc.feed('{"jsonrpc":"2.0","id":"a","method":"value","params":{"x":7}}\n');
  rpc.feed('{"jsonrpc":"2.0","id":2,"method":"later"}\n');
  rpc.feed('{"jsonrpc":"2.0","id":3,"method":"refuse"}\n');
  rpc.feed('{"jsonrpc":"2.0","id":4,"method":"nothing"}\n');
  rpc.feed('{"jsonrpc":"2.0","id":5,"method":"other"}\n');
  await new Promise((r) => setTimeout(r, 30));
  const byId = Object.fromEntries(sent.map((l) => JSON.parse(l)).map((m) => [m.id, m]));
  assert.deepEqual(byId.a.result, { echo: 7 });
  assert.equal(byId[2].result, 'done');
  assert.deepEqual(byId[3].error, { code: -32002, message: 'cannot read', data: { reason: 'missing' } });
  assert.equal(byId[4].result, null);
  assert.equal(byId[5].error.code, -32603);
  assert.match(byId[5].error.message, /boom/);
});

test('without a handler a request is method-not-found', () => {
  const { rpc, last } = pair();
  rpc.feed('{"jsonrpc":"2.0","id":9,"method":"_lembas/question"}\n');
  assert.equal(last().error.code, -32601);
});

test('closing fails everything waited for, and later requests too', async () => {
  const { rpc, sent } = pair();
  const p = rpc.request('session/prompt', {});
  rpc.close('the agent stopped (exit 3)');
  await assert.rejects(p, /the agent stopped \(exit 3\)/);
  await assert.rejects(rpc.request('x', {}), /not running/);
  rpc.notify('y', {});
  assert.equal(sent.length, 1);
});

test('an answer nobody waits for is ignored', () => {
  const { rpc } = pair();
  rpc.feed('{"jsonrpc":"2.0","id":77,"result":1}\n');
});
