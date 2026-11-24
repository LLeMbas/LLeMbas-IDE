'use strict';
// The agent: `lembas serve --stdio` as a child process, spoken to over the Agent Client Protocol
// (version 1). Everything about models, tools, permissions and the sign-in is the agent's own.
// No `vscode` here.
const { EventEmitter } = require('node:events');
const childProcess = require('node:child_process');
const { Rpc, RpcError } = require('./rpc');

const PROTOCOL_VERSION = 1;

class Agent extends EventEmitter {
  /**
   * @param {{ command: string, args?: string[], cwd?: string, env?: object,
   *           clientInfo?: { name: string, version: string },
   *           onRequest?: (method: string, params: any) => any }} options
   * Events: `notify (method, params)`, `stderr (text)`, `exit ({ code, last })`.
   */
  constructor(options) {
    super();
    this.options = options;
    this.capabilities = new Set();
    this.info = null;
    this.ready = false;
    this.stopped = false;
    this.stderr = [];
    this.proc = null;
    this.rpc = null;
    this.starting = null;
  }

  /** Start the process and say hello. The same promise for every caller. */
  connect() {
    if (!this.starting) this.starting = this._start();
    return this.starting;
  }

  _start() {
    const o = this.options;
    return new Promise((resolve, reject) => {
      let settled = false;
      const fail = (message) => {
        this.stopped = true;
        if (this.rpc) this.rpc.close(message);
        if (!settled) {
          settled = true;
          reject(new Error(message));
        }
      };
      let proc;
      try {
        proc = childProcess.spawn(o.command, o.args || ['serve', '--stdio'], {
          cwd: o.cwd,
          env: o.env || process.env,
          stdio: ['pipe', 'pipe', 'pipe'],
          shell: false,
          windowsHide: true,
        });
      } catch (e) {
        return fail(`could not start ${o.command}: ${e.message}`);
      }
      this.proc = proc;
      this.rpc = new Rpc({
        write: (line) => proc.stdin.write(line),
        onRequest: (method, params) => {
          if (!o.onRequest) throw { code: -32601, message: 'Method not found: ' + method };
          return o.onRequest(method, params);
        },
        onNotify: (method, params) => this.emit('notify', method, params),
      });
      proc.stdin.on('error', () => {});
      proc.stdout.on('data', (d) => this.rpc.feed(d));
      proc.stderr.on('data', (d) => {
        const text = d.toString('utf8');
        for (const line of text.split(/\r?\n/)) if (line.trim()) this.stderr.push(line);
        while (this.stderr.length > 40) this.stderr.shift();
        this.emit('stderr', text);
      });
      proc.on('error', (e) => {
        const why = e.code === 'ENOENT' ? 'the command was not found' : e.message;
        fail(`could not start ${o.command}: ${why}`);
        this.emit('exit', { code: null, last: why, started: false });
      });
      proc.on('exit', (code, signal) => {
        const last = this.stderr.length ? this.stderr[this.stderr.length - 1] : '';
        const was = this.ready;
        this.ready = false;
        fail(`the agent stopped (${signal || 'exit ' + code})${last ? ': ' + last : ''}`);
        this.emit('exit', { code, signal, last, started: was });
      });
      this.rpc
        .request('initialize', {
          protocolVersion: PROTOCOL_VERSION,
          clientCapabilities: {
            fs: { readTextFile: true, writeTextFile: false },
            // `show` with `media`: the spec offers the show tool to a client that says `show`,
            // and hands over files that are not text to one that also says `media`.
            _meta: { lembas: { editor: true, media: true, show: true } },
          },
          clientInfo: o.clientInfo || { name: 'llembas-vscode', version: '0' },
        })
        .then(
          (r) => {
            if (settled) return;
            const lembas = (r && r._meta && r._meta.lembas) || {};
            this.capabilities = new Set(Array.isArray(lembas.capabilities) ? lembas.capabilities : []);
            this.info = r || {};
            this.ready = true;
            settled = true;
            resolve(this);
          },
          (e) => {
            if (settled) return;
            this.stop();
            fail('the agent refused to start: ' + e.message);
          },
        );
    });
  }

  has(capability) {
    return this.capabilities.has(capability);
  }

  request(method, params) {
    if (!this.rpc || this.stopped) return Promise.reject(new RpcError({ code: -32000, message: 'the agent is not running' }));
    return this.rpc.request(method, params);
  }

  notify(method, params) {
    if (this.rpc && !this.stopped) this.rpc.notify(method, params);
  }

  stop() {
    if (!this.proc || this.stopped) return;
    this.stopped = true;
    try {
      this.proc.stdin.end();
    } catch {
      // already closed
    }
    try {
      this.proc.kill('SIGTERM');
    } catch {
      // already gone
    }
  }
}

module.exports = { Agent, PROTOCOL_VERSION };
