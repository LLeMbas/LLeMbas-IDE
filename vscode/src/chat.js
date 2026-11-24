'use strict';
// The chat: one agent process, one session, and the transcript as a list of plain items the
// view draws. Everything the editor itself must do — show a diff, read an open document, take
// in a shown file — is a hook. No `vscode` here.
const { EventEmitter } = require('node:events');
const { promptParams } = require('./context');

const DETAIL_MAX = 20000;

function sentence(text) {
  const s = String(text || '').trim();
  return s ? s[0].toUpperCase() + s.slice(1) + (/[.!?…]$/.test(s) ? '' : '.') : '';
}

class Chat extends EventEmitter {
  /**
   * @param {{ makeAgent: (o: { cwd: string, onRequest: Function }) => import('./agent').Agent,
   *           cwd: () => string,
   *           options?: () => { mode?: string, model?: string, showThoughts?: boolean },
   *           hooks?: { readTextFile?: Function, showDiffs?: Function, closeDiffs?: Function,
   *                     showMedia?: Function, showText?: Function, filesChanged?: Function },
   *           now?: () => number }} io
   * Events: `item (item)`, `reset`, `state`, `connected (agent)`, `stopped`, `editDelta (params)`, `stderr (text)`.
   */
  constructor(io) {
    super();
    this.io = io;
    this.hooks = io.hooks || {};
    this.now = io.now || Date.now;
    this.agent = null;
    this.failedAt = 0;
    this.items = [];
    this.nextItem = 1;
    this._clearSession();
    this.models = [];
    this.settings = null;
  }

  _clearSession() {
    this.session = null;
    this.sessionStarting = null;
    this.busy = false;
    this.modes = [];
    this.mode = null;
    this.model = null;
    this.said = null;
    this.tools = new Map();
    this.cards = new Map();
  }

  options() {
    return (this.io.options && this.io.options()) || {};
  }

  // ---- the transcript -------------------------------------------------------------------

  add(item) {
    item.id = 'i' + this.nextItem++;
    this.items.push(item);
    this.emit('item', item);
    return item;
  }

  changed(item) {
    this.emit('item', item);
  }

  note(text) {
    this.said = null;
    return this.add({ kind: 'note', text: String(text) });
  }

  /** What the view needs besides the items. */
  state() {
    return {
      busy: this.busy,
      session: !!this.session,
      mode: this.mode,
      modes: this.modes.map((m) => ({ id: String(m.id), name: String(m.name || m.id) })),
      model: this.model,
      models: this.models.filter((m) => !Array.isArray(m.for) || m.for.includes('main')).map((m) => ({ id: String(m.id), name: String(m.name || m.id) })),
    };
  }

  // ---- the agent ------------------------------------------------------------------------

  /** A running agent that has answered `initialize`, or `null`. `quiet`: a failure is not written into the chat. */
  async connect(quiet) {
    if (this.agent && !this.agent.stopped) {
      try {
        return await this.agent.connect();
      } catch {
        return null;
      }
    }
    // An agent that was told to stop but has not gone yet: its session goes now, not when its
    // exit is heard — by then a new agent is the current one and the exit would be ignored.
    if (this.agent) this._retire(this.agent, null);
    // Completion asks at every pause in typing: a command that is not there is not tried each time.
    if (quiet && this.failedAt && this.now() - this.failedAt < 60000) return null;
    const agent = this.io.makeAgent({ cwd: this.io.cwd(), onRequest: (method, params) => this._onRequest(agent, method, params) });
    this.agent = agent;
    agent.on('notify', (method, params) => this._onNotify(agent, method, params));
    agent.on('stderr', (text) => this.emit('stderr', text));
    agent.on('exit', (e) => this._onExit(agent, e));
    try {
      await agent.connect();
      this.failedAt = 0;
      this.startError = null;
      this.emit('connected', agent);
      return agent;
    } catch (e) {
      if (this.agent === agent) this.agent = null;
      this.failedAt = this.now();
      this.startError = e.message;
      if (!quiet) this.note(sentence(e.message));
      return null;
    }
  }

  _onExit(agent, e) {
    this._retire(agent, e);
  }

  /** The agent is gone, or going: everything that belonged to it is let go. Once per agent. */
  _retire(agent, e) {
    if (this.agent !== agent) return;
    const had = this.session !== null || this.sessionStarting !== null || this.busy;
    this.agent = null;
    for (const card of [...this.cards.values()]) this._settle(card, 'The agent stopped before this was answered.');
    this._clearSession();
    if (e && e.started && had) this.note(`The agent stopped (${e.signal || 'exit ' + e.code})${e.last ? ': ' + e.last : '.'}`);
    else if (!e && had) this.note('The agent was stopped. The next message starts a new session.');
    this.emit('stopped');
    this.emit('state');
  }

  /** Stop the agent on purpose (another command, or the person asked). It starts again when needed. */
  stopAgent() {
    const agent = this.agent;
    if (!agent) return;
    agent.stop();
    this._retire(agent, null);
  }

  /** A request of the editor's own (`_lembas/complete`, `_lembas/edit`, …). Rejects when the agent cannot be had. */
  async request(method, params, quiet) {
    const agent = await this.connect(quiet);
    if (!agent) throw new Error(this.startError || 'the agent is not running');
    return agent.request(method, params);
  }

  notify(method, params) {
    if (this.agent && this.agent.ready) this.agent.notify(method, params);
  }

  has(capability) {
    return !!(this.agent && this.agent.ready && this.agent.has(capability));
  }

  /** An open session, started when there is none. Resolves `false` when that failed (the chat says why). */
  ensureSession() {
    if (this.session) return Promise.resolve(true);
    if (this.sessionStarting) return this.sessionStarting;
    const starting = (async () => {
      const agent = await this.connect(false);
      if (!agent) return false;
      const o = this.options();
      const meta = {};
      if (o.mode) meta.mode = o.mode;
      if (o.model) meta.model = o.model;
      let r;
      try {
        r = await agent.request('session/new', { cwd: this.io.cwd(), mcpServers: [], _meta: meta });
      } catch (e) {
        if (this.agent === agent) this.note('No session: ' + sentence(e.message));
        return false;
      }
      if (this.agent !== agent || !r || typeof r.sessionId !== 'string') return false;
      this.session = r.sessionId;
      const lembas = (r._meta && r._meta.lembas) || {};
      this.modes = (r.modes && Array.isArray(r.modes.availableModes) && r.modes.availableModes) || [];
      this.mode = (r.modes && r.modes.currentModeId) || lembas.mode || null;
      this.model = lembas.model || null;
      this.emit('state');
      if (agent.has('editor')) this.loadModels().catch(() => {});
      return true;
    })();
    this.sessionStarting = starting;
    const done = () => {
      if (this.sessionStarting === starting) this.sessionStarting = null;
    };
    starting.then(done, done);
    return starting;
  }

  /**
   * Send a prompt. `editor` is what the editor shows (`editorContext`), `label` how the
   * transcript names an attached selection. Resolves `false` when a turn already runs.
   */
  async send(text, with_) {
    if (this.busy) return false;
    const w = with_ || {};
    this.add({ kind: 'user', text, label: w.label || '' });
    this.said = 'user';
    this.busy = true;
    this.emit('state');
    try {
      if (!(await this.ensureSession())) return true;
      const agent = this.agent;
      try {
        const r = await agent.request('session/prompt', promptParams(this.session, text, w.editor, agent.has('editor')));
        const lembas = (r && r._meta && r._meta.lembas) || {};
        if (typeof lembas.message === 'string' && lembas.message) this.note(lembas.message);
        if (r && r.stopReason && r.stopReason !== 'end_turn') {
          this.note(r.stopReason === 'cancelled' ? 'Stopped.' : 'The turn ended: ' + String(r.stopReason).replace(/_/g, ' ') + '.');
        }
      } catch (e) {
        if (this.agent === agent) this.note('The turn failed: ' + sentence(e.message));
      }
      return true;
    } finally {
      this.busy = false;
      this.said = null;
      this.emit('state');
    }
  }

  /** Stop the running turn. Cards still open are answered as cancelled, as ACP asks. */
  stop() {
    if (!this.agent || !this.session || !this.busy) return;
    this.agent.notify('session/cancel', { sessionId: this.session });
    for (const card of [...this.cards.values()]) this._settle(card, 'Not answered: the turn was stopped.');
  }

  /** A new session; the old one stays in the agent's own store. Resolves `false` while a turn runs. */
  async newSession() {
    if (this.busy) return false;
    for (const card of [...this.cards.values()]) this._settle(card, 'Not answered.');
    const agent = this.agent;
    const models = this.models;
    this._clearSession();
    this.agent = agent;
    this.models = models;
    this.items = [];
    this.emit('reset');
    this.emit('state');
    return true;
  }

  async setMode(id) {
    if (!(await this.ensureSession())) return false;
    await this.agent.request('session/set_mode', { sessionId: this.session, modeId: id });
    this.mode = id;
    this.emit('state');
    return true;
  }

  /** The session's model, for this session only. */
  async setModel(id) {
    if (!(await this.ensureSession())) return false;
    const r = await this.agent.request('_lembas/configure', { sessionId: this.session, model: id });
    this.model = (r && r.model) || id;
    this.emit('state');
    return true;
  }

  /** The models the sign-in offers, and the person's two settings (`_lembas/models`). */
  async loadModels(quiet) {
    const r = await this.request('_lembas/models', {}, quiet);
    this.models = r && Array.isArray(r.models) ? r.models.filter((m) => m && typeof m.id === 'string') : [];
    this.settings = { autocomplete: (r && r.autocomplete) || null, main: (r && r.main) || null };
    this.emit('state');
    return { models: this.models, ...this.settings };
  }

  /** Read the two saved model settings, or save `set` first (`_lembas/editor/settings`). */
  async editorSettings(set) {
    const r = await this.request('_lembas/editor/settings', set ? { set } : {});
    this.settings = { autocomplete: (r && r.autocomplete) || null, main: (r && r.main) || null };
    return this.settings;
  }

  // ---- what the agent sends -------------------------------------------------------------

  _onNotify(agent, method, params) {
    if (this.agent !== agent || !params) return;
    if (method === 'session/update') {
      if (params.sessionId === this.session && params.update) this._onUpdate(params.update);
    } else if (method === '_lembas/edit/delta') {
      this.emit('editDelta', params);
    } else if (method === '_lembas/permission/settled') {
      for (const card of [...this.cards.values()]) {
        if (card.item.toolCallId === params.toolCallId) this._settle(card, 'Answered elsewhere, or no longer waited for.');
      }
    } else if (method === '_lembas/event') {
      const ev = params.event;
      if (params.sessionId !== this.session || !ev) return;
      if (ev.type === 'model' && typeof ev.ref === 'string') {
        this.model = ev.ref;
        this.emit('state');
      } else if (ev.type === 'mode' && typeof ev.mode === 'string') {
        this.mode = ev.mode;
        this.emit('state');
      }
    }
  }

  _onUpdate(u) {
    const kind = u.sessionUpdate;
    if (kind === 'agent_message_chunk' || kind === 'agent_thought_chunk') {
      const thought = kind === 'agent_thought_chunk';
      if (thought && !this.options().showThoughts) return;
      if (!u.content || u.content.type !== 'text' || typeof u.content.text !== 'string') return;
      const want = thought ? 'thought' : 'agent';
      if (this.said !== want || !this.current) {
        this.current = this.add({ kind: want, text: '' });
        this.said = want;
      }
      this.current.text += u.content.text;
      this.changed(this.current);
    } else if (kind === 'tool_call' || kind === 'tool_call_update') {
      const id = String(u.toolCallId);
      let item = this.tools.get(id);
      const fresh = !item;
      if (!item) {
        item = { kind: 'tool', toolCallId: id, title: 'tool', status: 'pending', files: [], denied: false };
        this.tools.set(id, item);
      }
      if (typeof u.title === 'string' && u.title) item.title = u.title;
      if (typeof u.status === 'string') item.status = u.status;
      if (u._meta && u._meta.lembas && u._meta.lembas.denied) item.denied = true;
      const files = diffItems(u.content).map((d) => d.path);
      if (files.length) item.files = [...new Set(files)];
      this.said = 'tool';
      if (fresh) this.add(item);
      else this.changed(item);
      if (item.status === 'completed' && item.files.length && this.hooks.filesChanged) this.hooks.filesChanged(item.files);
    } else if (kind === 'plan') {
      const entries = Array.isArray(u.entries) ? u.entries : [];
      if (!entries.length) return;
      const done = entries.filter((e) => e && e.status === 'completed').length;
      if (!this.planItem || !this.items.includes(this.planItem)) this.planItem = this.add({ kind: 'plan', done, all: entries.length });
      else {
        this.planItem.done = done;
        this.planItem.all = entries.length;
        this.changed(this.planItem);
      }
      this.said = 'tool';
    } else if (kind === 'current_mode_update') {
      if (typeof u.currentModeId === 'string') this.mode = u.currentModeId;
      this.emit('state');
    }
  }

  _onRequest(agent, method, params) {
    if (this.agent !== agent) throw { code: -32000, message: 'this client has moved on' };
    if (method === 'session/request_permission') return this._onPermission(params);
    if (method === 'fs/read_text_file') {
      if (!this.hooks.readTextFile) throw { code: -32601, message: 'Method not found: ' + method };
      return this.hooks.readTextFile(params);
    }
    if (method === 'fs/write_text_file') {
      if (!this.hooks.writeTextFile) throw { code: -32601, message: 'Method not found: ' + method };
      return Promise.resolve(this.hooks.writeTextFile(params)).then(() => ({}));
    }
    if (method === '_lembas/show') return this._onShow(agent, params);
    throw { code: -32601, message: 'Method not found: ' + method };
  }

  _onPermission(p) {
    const call = (p && p.toolCall) || {};
    const lembas = (p && p._meta && p._meta.lembas) || {};
    const options = (Array.isArray(p && p.options) ? p.options : [])
      .filter((o) => o && typeof o.optionId === 'string')
      .map((o) => ({ optionId: o.optionId, name: String(o.name || o.optionId), kind: String(o.kind || '') }));
    const diffs = diffItems(call.content);
    const text = (Array.isArray(call.content) ? call.content : [])
      .map((c) => (c && c.type === 'content' && c.content && c.content.type === 'text' ? c.content.text : c && c.type === 'text' ? c.text : ''))
      .filter((t) => typeof t === 'string' && t)
      .join('\n');
    const item = this.add({
      kind: 'card',
      toolCallId: String(call.toolCallId || ''),
      title: String(call.title || lembas.tool || 'a tool'),
      tool: typeof lembas.tool === 'string' ? lembas.tool : '',
      reason: typeof lembas.reason === 'string' ? lembas.reason : '',
      detail: text.length > DETAIL_MAX ? text.slice(0, DETAIL_MAX) + '\n…' : text,
      files: diffs.map((d) => d.path),
      options,
      state: 'open',
      answer: '',
    });
    this.said = 'tool';
    return new Promise((resolve) => {
      const card = { item, resolve, diffs };
      this.cards.set(item.id, card);
      if (diffs.length && this.hooks.showDiffs) {
        try {
          this.hooks.showDiffs(item.id, diffs, item.title);
        } catch {
          // the card itself still asks
        }
      }
    });
  }

  /** The person's answer to a card. */
  answer(cardId, optionId) {
    const card = this.cards.get(cardId);
    if (!card) return false;
    const option = card.item.options.find((o) => o.optionId === optionId);
    if (!option) return false;
    this._close(card, 'answered', option.name);
    card.resolve({ outcome: { outcome: 'selected', optionId } });
    return true;
  }

  /** Show a card's diffs again. */
  reshow(cardId) {
    const card = this.cards.get(cardId);
    if (card && card.diffs.length && this.hooks.showDiffs) this.hooks.showDiffs(cardId, card.diffs, card.item.title);
  }

  _settle(card, why) {
    this._close(card, 'settled', why);
    card.resolve({ outcome: { outcome: 'cancelled' } });
  }

  _close(card, state, answer) {
    this.cards.delete(card.item.id);
    card.item.state = state;
    card.item.answer = answer;
    this.changed(card.item);
    if (card.diffs.length && this.hooks.closeDiffs) {
      try {
        this.hooks.closeDiffs(card.item.id);
      } catch {
        // a tab that is already closed
      }
    }
  }

  async _onShow(agent, p) {
    if (!p || p.sessionId !== this.session) return { shown: false, reason: 'This is not the session the editor shows.' };
    if (typeof p.handle === 'string') {
      if (!this.hooks.showMedia) return { shown: false, reason: 'This editor cannot show files.' };
      const got = await this.hooks.showMedia(p, (q) => agent.request('_lembas/show/read', q));
      if (!got || !got.ok) {
        const reason = (got && got.reason) || 'The file could not be shown.';
        this.note(`${(got && got.name) || 'A file'} was not shown: ${reason}`);
        return { shown: false, reason };
      }
      this.add({ kind: 'media', name: got.name, size: got.size, picture: !!got.picture, src: got.src || '', key: got.key || '', opens: !!got.open });
      this.said = 'tool';
      return { shown: true };
    }
    if (typeof p.text === 'string' && this.hooks.showText) {
      const r = await this.hooks.showText(p);
      if (r && r.shown) {
        this.note(`Shown: ${String(p.path || 'a file')}`);
        return { shown: true };
      }
      return { shown: false, reason: (r && r.reason) || 'The file could not be shown.' };
    }
    return { shown: false, reason: 'This editor cannot show that.' };
  }

  dispose() {
    if (this.agent) this.agent.stop();
  }
}

function diffItems(content) {
  const out = [];
  for (const c of Array.isArray(content) ? content : []) {
    if (c && c.type === 'diff' && typeof c.path === 'string' && typeof c.newText === 'string') {
      out.push({
        path: c.path,
        oldText: typeof c.oldText === 'string' ? c.oldText : null,
        newText: c.newText,
        deleted: !!(c._meta && c._meta.lembas && c._meta.lembas.deleted),
      });
    }
  }
  return out;
}

module.exports = { Chat, diffItems };
