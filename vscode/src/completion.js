'use strict';
// Autocomplete on `_lembas/complete`: the waiting before a request is sent, the cancelling of
// the one before it, and what happens to an answer nobody waits for any more. No `vscode` here.

const REFUSALS = new Set(['no_model', 'not_allowed', 'not_logged_in', 'unsupported']);

const LENGTH_PRESETS = {
  auto: { tokens: 0, instruction: '' },
  words: {
    tokens: 24,
    instruction: 'Predict only a few words to finish the current expression or identifier. Stop immediately once the current token or phrase is complete.',
  },
  line: {
    tokens: 64,
    instruction: 'Predict at most the remainder of the current line. Do not start a new line.',
  },
  block: {
    tokens: 256,
    instruction: 'Predict a complete statement, block, or function body fitting the surrounding code.',
  },
  file: {
    tokens: 2048,
    instruction: 'Predict a comprehensive continuation, up to a full multi-function section or file implementation when appropriate.',
  },
};

/** Resolve effective `max_tokens` and guidance instruction from user settings. */
function resolvePrediction(o) {
  const opts = o || {};
  const mode = typeof opts.length === 'string' && Object.prototype.hasOwnProperty.call(LENGTH_PRESETS, opts.length) ? opts.length : 'auto';
  const preset = LENGTH_PRESETS[mode];
  const explicitTokens = Number.isFinite(Number(opts.maxTokens)) && Number(opts.maxTokens) > 0 ? Math.floor(Number(opts.maxTokens)) : 0;
  const maxTokens = explicitTokens || preset.tokens || undefined;
  const parts = [];
  if (preset.instruction) parts.push(preset.instruction);
  if (typeof opts.instructions === 'string' && opts.instructions.trim()) parts.push(opts.instructions.trim());
  const guidance = parts.join('\n');
  return { mode, maxTokens, guidance };
}

/** The text around the cursor that is sent: a window, not the file. */
function windowAround(text, offset, limits) {
  const prefixMax = (limits && limits.prefixMax) || 12000;
  const suffixMax = (limits && limits.suffixMax) || 4000;
  const at = Math.max(0, Math.min(offset, text.length));
  let start = Math.max(0, at - prefixMax);
  let end = Math.min(text.length, at + suffixMax);
  // Never cut a surrogate pair in two.
  if (start > 0 && isLow(text.charCodeAt(start))) start += 1;
  if (end < text.length && isLow(text.charCodeAt(end))) end -= 1;
  return { prefix: text.slice(start, at), suffix: text.slice(at, end) };
}

function isLow(code) {
  return code >= 0xdc00 && code <= 0xdfff;
}

class Completer {
  /**
   * @param {{ request: (method: string, params: object) => Promise<any>,
   *           notify: (method: string, params: object) => void,
   *           debounceMs?: () => number,
   *           model?: () => string | undefined,
   *           maxTokens?: () => number | undefined,
   *           length?: () => string | undefined,
   *           instructions?: () => string | undefined,
   *           onRefusal?: (reason: string, message: string, manual: boolean) => void,
   *           onError?: (message: string, manual: boolean) => void,
   *           setTimeout?: Function, clearTimeout?: Function, now?: () => number }} io
   */
  constructor(io) {
    this.io = io;
    this.seq = 0;
    this.pending = null; // { seq, timer, id, sent, finish }
    this.blocked = ''; // the refusal that stopped asking as you type
    this.pausedUntil = 0;
    this.lastWarmed = '';
    this.setTimeout = io.setTimeout || setTimeout;
    this.clearTimeout = io.clearTimeout || clearTimeout;
    this.now = io.now || Date.now;
  }

  /**
   * Ask for the text that belongs at the cursor. Resolves with the text, or with `null` when
   * there is nothing to show: a newer request took its place, it was cancelled, the answer was
   * empty, or asking is stopped. Never rejects.
   * @param {{ prefix: string, suffix?: string, path?: string, language?: string }} what
   * @param {{ manual?: boolean }} [how]
   */
  ask(what, how) {
    const manual = !!(how && how.manual);
    this.cancel(); // the one before this, waiting or sent
    if (!manual && (this.blocked || this.now() < this.pausedUntil)) return Promise.resolve(null);
    const seq = ++this.seq;
    return new Promise((resolve) => {
      const entry = { seq, id: 'c' + seq, sent: false, timer: null, finish: null };
      entry.finish = (value) => {
        if (entry.timer !== null) this.clearTimeout(entry.timer);
        entry.timer = null;
        if (this.pending === entry) this.pending = null;
        entry.finish = () => {};
        resolve(value);
      };
      this.pending = entry;
      const wait = manual ? 0 : Math.max(0, Number(this.io.debounceMs ? this.io.debounceMs() : 250) || 0);
      const go = () => {
        entry.timer = null;
        this._send(entry, what, manual);
      };
      if (wait === 0) go();
      else entry.timer = this.setTimeout(go, wait);
    });
  }

  _send(entry, what, manual) {
    entry.sent = true;
    const params = { id: entry.id, prefix: what.prefix, suffix: what.suffix || '' };
    if (what.path) params.path = what.path;
    if (what.language) params.language = what.language;
    if (what.cwd) params.cwd = what.cwd;
    if (what.sessionId) params.sessionId = what.sessionId;
    if (Array.isArray(what.open) && what.open.length) params.open = what.open;
    const pred = resolvePrediction({
      maxTokens: this.io.maxTokens ? this.io.maxTokens() : undefined,
      length: this.io.length ? this.io.length() : undefined,
      instructions: this.io.instructions ? this.io.instructions() : undefined,
    });
    const ctx = Array.isArray(what.context) ? what.context.slice() : [];
    if (pred.guidance) ctx.unshift({ path: 'llembas:autocomplete-instructions', text: pred.guidance });
    if (ctx.length) params.context = ctx;
    const model = this.io.model ? this.io.model() : undefined;
    if (model) params.model = model;
    if (pred.maxTokens) params.max_tokens = pred.maxTokens;
    let asked;
    try {
      asked = Promise.resolve(this.io.request('_lembas/complete', params));
    } catch (e) {
      asked = Promise.reject(e);
    }
    asked.then(
      (r) => {
        // An answer to a request that is no longer the newest is thrown away, whatever it says.
        if (this.pending !== entry) return;
        if (manual && this.blocked) this.blocked = '';
        if (!r || r.cancelled || typeof r.text !== 'string' || r.text === '') return entry.finish(null);
        entry.finish(r.text);
      },
      (e) => {
        const reason = e && e.data && typeof e.data.reason === 'string' ? e.data.reason : '';
        const message = (e && e.message) || 'the completion failed';
        if (REFUSALS.has(reason)) {
          // Said once; as-you-type then stays quiet until a model is set (or it is asked by hand).
          const first = this.blocked !== reason;
          this.blocked = reason;
          if ((first || manual) && this.io.onRefusal) this.io.onRefusal(reason, message, manual);
        } else {
          this.pausedUntil = this.now() + 15000;
          if (this.io.onError) this.io.onError(message, manual);
        }
        if (this.pending === entry) entry.finish(null);
      },
    );
  }

  /** Stop what is waited for: the editor moved on. `seq` limits it to that request. */
  cancel(seq) {
    const entry = this.pending;
    if (!entry || (seq !== undefined && entry.seq !== seq)) return;
    if (entry.sent) this.io.notify('_lembas/complete/cancel', { id: entry.id });
    entry.finish(null);
  }

  /** The number of the request now waited for, for `cancel(seq)`. */
  get current() {
    return this.pending ? this.pending.seq : 0;
  }

  /** A model was chosen, or the agent started again: ask as you type again. */
  unblock() {
    this.blocked = '';
    this.pausedUntil = 0;
    this.lastWarmed = '';
  }

  /** Pre-warm the CLI's session file index & direct imports for a file before the person pauses typing. */
  warm(what) {
    if (!what || (!what.cwd && !what.sessionId)) return;
    const key = `${what.sessionId || ''}|${what.cwd || ''}|${what.path || ''}`;
    if (key === this.lastWarmed) return;
    this.lastWarmed = key;
    const params = {};
    if (what.cwd) params.cwd = what.cwd;
    if (what.sessionId) params.sessionId = what.sessionId;
    if (what.path) params.path = what.path;
    if (typeof what.text === 'string' && what.text.length <= 65536) params.text = what.text;
    this.io.notify('_lembas/complete/warm', params);
  }
}

module.exports = { Completer, windowAround, resolvePrediction, LENGTH_PRESETS, REFUSALS };
