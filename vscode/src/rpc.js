'use strict';
// JSON-RPC 2.0 over lines: the framing the Agent Client Protocol uses on stdio. No `vscode` here.
const { StringDecoder } = require('node:string_decoder');

class RpcError extends Error {
  constructor(error) {
    super(error && typeof error.message === 'string' ? error.message : 'the request failed');
    this.name = 'RpcError';
    this.code = error && typeof error.code === 'number' ? error.code : -32603;
    this.data = error ? error.data : undefined;
  }

  /** The `data.reason` word of a refusal, or ''. */
  get reason() {
    return this.data && typeof this.data.reason === 'string' ? this.data.reason : '';
  }
}

class Rpc {
  /**
   * @param {{ write: (line: string) => void,
   *           onRequest?: (method: string, params: any) => any,
   *           onNotify?: (method: string, params: any) => void }} io
   * `onRequest` returns the result (or a promise of it); to refuse it throws an object with
   * `code` and `message`.
   */
  constructor(io) {
    this.io = io;
    this.nextId = 1;
    this.waiting = new Map();
    this.buffer = '';
    this.decoder = new StringDecoder('utf8');
    this.closed = false;
  }

  /** Bytes (or text) from the other side. */
  feed(chunk) {
    this.buffer += typeof chunk === 'string' ? chunk : this.decoder.write(chunk);
    for (;;) {
      const nl = this.buffer.indexOf('\n');
      if (nl < 0) break;
      const line = this.buffer.slice(0, nl);
      this.buffer = this.buffer.slice(nl + 1);
      if (line.trim() === '') continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue; // not ours: a stray line on stdout
      }
      if (msg && typeof msg === 'object' && !Array.isArray(msg)) this._message(msg);
    }
  }

  _message(msg) {
    if (typeof msg.method === 'string') {
      const params = msg.params === undefined || msg.params === null ? {} : msg.params;
      if (msg.id !== undefined && msg.id !== null) {
        this._serve(msg.id, msg.method, params);
      } else if (this.io.onNotify) {
        try {
          this.io.onNotify(msg.method, params);
        } catch {
          // a notification has nobody to tell
        }
      }
      return;
    }
    if (msg.id === undefined || msg.id === null) return;
    const entry = this.waiting.get(msg.id);
    if (!entry) return;
    this.waiting.delete(msg.id);
    if (msg.error) entry.reject(new RpcError(msg.error));
    else entry.resolve(msg.result === undefined ? null : msg.result);
  }

  _serve(id, method, params) {
    let answered = false;
    const reply = (result, error) => {
      if (answered) return;
      answered = true;
      if (error) {
        const out = { code: typeof error.code === 'number' ? error.code : -32603, message: String(error.message || error) };
        if (error.data !== undefined) out.data = error.data;
        this._write({ jsonrpc: '2.0', id, error: out });
      } else {
        this._write({ jsonrpc: '2.0', id, result: result === undefined ? null : result });
      }
    };
    if (!this.io.onRequest) return reply(null, { code: -32601, message: 'Method not found: ' + method });
    let out;
    try {
      out = this.io.onRequest(method, params);
    } catch (e) {
      return reply(null, e || { message: 'failed' });
    }
    Promise.resolve(out).then((r) => reply(r), (e) => reply(null, e || { message: 'failed' }));
  }

  _write(msg) {
    if (this.closed) return;
    try {
      this.io.write(JSON.stringify(msg) + '\n');
    } catch {
      // the process is gone; its exit says so
    }
  }

  /** A request; resolves with the result, rejects with an RpcError. */
  request(method, params) {
    if (this.closed) return Promise.reject(new RpcError({ code: -32000, message: 'the agent is not running' }));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.waiting.set(id, { resolve, reject });
      this._write({ jsonrpc: '2.0', id, method, params: params === undefined ? {} : params });
    });
  }

  notify(method, params) {
    this._write({ jsonrpc: '2.0', method, params: params === undefined ? {} : params });
  }

  /** The other side is gone: everything still waited for fails. */
  close(message) {
    if (this.closed) return;
    this.closed = true;
    const waiting = [...this.waiting.values()];
    this.waiting.clear();
    for (const w of waiting) w.reject(new RpcError({ code: -32000, message: message || 'the agent stopped' }));
  }
}

module.exports = { Rpc, RpcError };
