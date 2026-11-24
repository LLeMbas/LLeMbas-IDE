'use strict';
// Autocomplete on `_lembas/complete`: the waiting before a request is sent, the cancelling of
// the one before it, and what happens to an answer nobody waits for any more. No `vscode` here.

const REFUSALS = new Set(['no_model', 'not_allowed', 'not_logged_in', 'unsupported']);

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
    const model = this.io.model ? this.io.model() : undefined;
    if (model) params.model = model;
    const maxTokens = this.io.maxTokens ? this.io.maxTokens() : undefined;
    if (maxTokens) params.max_tokens = maxTokens;
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
  }
}

module.exports = { Completer, windowAround, REFUSALS };
