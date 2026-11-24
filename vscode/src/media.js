'use strict';
// Files the agent shows (`_lembas/show`): what a file is, read from its bytes, and the fetching
// of those bytes through `_lembas/show/read`. No `vscode` here.
const crypto = require('node:crypto');

const PART = 1024 * 1024; // the most one answer carries

/** What the bytes are, when they are a picture the chat can draw; otherwise `null`. */
function sniffPicture(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0x89 && buf.toString('latin1', 1, 4) === 'PNG' && buf[4] === 0x0d && buf[5] === 0x0a) return { mime: 'image/png', ext: 'png' };
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { mime: 'image/jpeg', ext: 'jpg' };
  const head = buf.toString('latin1', 0, 12);
  if (head.startsWith('GIF87a') || head.startsWith('GIF89a')) return { mime: 'image/gif', ext: 'gif' };
  if (head.startsWith('RIFF') && head.slice(8, 12) === 'WEBP') return { mime: 'image/webp', ext: 'webp' };
  if (head.slice(4, 8) === 'ftyp' && (head.slice(8, 12) === 'avif' || head.slice(8, 12) === 'avis')) return { mime: 'image/avif', ext: 'avif' };
  return null;
}

/** A size in words: "640 bytes", "48 KB", "1.4 MB" (1 MB is 1024 KB). */
function sizeInWords(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} byte${n === 1 ? '' : 's'}`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  const mb = n / (1024 * 1024);
  if (mb < 1024) return `${Number.isInteger(mb) || mb >= 10 ? Math.round(mb) : mb.toFixed(1)} MB`;
  return `${(mb / 1024).toFixed(1)} GB`;
}

/** A file name made only of harmless characters, from whatever path the agent gave. */
function safeName(path, fallbackExt) {
  const base = String(path || '').split(/[\\/]/).pop() || '';
  let name = base.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '').slice(-80);
  if (!name) name = 'file';
  if (fallbackExt && !/\.[A-Za-z0-9]{1,8}$/.test(name)) name += '.' + fallbackExt;
  return name;
}

// What Open may do with a shown file. Only kinds that are merely displayed are ever opened, and
// only when the file's first bytes are that kind AND its name ends as that kind does: the system
// chooses its program by the name, so a name the bytes do not back is never handed to it.
// Everything else can only be shown in its folder.
const TEXT_ENDINGS = new Set(['txt', 'text', 'log', 'md', 'markdown', 'csv', 'tsv', 'json', 'jsonl', 'yaml', 'yml', 'toml', 'ini', 'diff', 'patch']);
const SHOWN_KINDS = [
  { kind: 'pdf', endings: ['pdf'], is: (b) => b.toString('latin1', 0, 5) === '%PDF-' },
  { kind: 'audio', endings: ['mp3'], is: (b) => b.toString('latin1', 0, 3) === 'ID3' || (b[0] === 0xff && (b[1] & 0xe6) === 0xe2) },
  { kind: 'audio', endings: ['wav'], is: (b) => b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WAVE' },
  { kind: 'audio', endings: ['ogg', 'oga', 'opus'], is: (b) => b.toString('latin1', 0, 4) === 'OggS' },
  { kind: 'audio', endings: ['flac'], is: (b) => b.toString('latin1', 0, 4) === 'fLaC' },
  { kind: 'audio', endings: ['m4a'], is: (b) => b.toString('latin1', 4, 8) === 'ftyp' && /^(M4A |M4B |mp42|isom)$/.test(b.toString('latin1', 8, 12)) },
  { kind: 'video', endings: ['mp4', 'm4v'], is: (b) => b.toString('latin1', 4, 8) === 'ftyp' && /^(isom|iso[2-9]|mp41|mp42|avc1|M4V |dash)$/.test(b.toString('latin1', 8, 12)) },
  { kind: 'video', endings: ['mov'], is: (b) => b.toString('latin1', 4, 8) === 'ftyp' && b.toString('latin1', 8, 12) === 'qt  ' },
  { kind: 'video', endings: ['webm', 'mkv'], is: (b) => b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3 },
];
const PICTURE_ENDINGS = { png: ['png'], jpg: ['jpg', 'jpeg'], gif: ['gif'], webp: ['webp'], avif: ['avif'] };

function ending(name) {
  const m = /\.([A-Za-z0-9]+)$/.exec(String(name || ''));
  return m ? m[1].toLowerCase() : '';
}

function looksLikeText(buf) {
  if (!buf || buf.length === 0) return false;
  for (let i = 0; i < buf.length; i++) {
    const c = buf[i];
    if (c === 0 || (c < 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d && c !== 0x0c)) return false;
  }
  // The window may end inside a character; up to three bytes are let go before judging.
  for (let cut = 0; cut <= 3 && cut < buf.length; cut++) {
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(buf.subarray(0, buf.length - cut));
      return true;
    } catch {
      // try a shorter window
    }
  }
  return false;
}

/**
 * How a shown file may be opened, from its first bytes and its name:
 * `{ kind, how }` — `how` is `'editor'` (pictures and plain text: opened inside the editor, which
 * runs nothing) or `'system'` (pdf, sound, video: the system's viewer); or `null` when the file
 * may only be shown in its folder.
 */
function openable(head, name) {
  const end = ending(name);
  if (!head || !end) return null;
  const picture = sniffPicture(head);
  if (picture) return PICTURE_ENDINGS[picture.ext].includes(end) ? { kind: 'image', how: 'editor' } : null;
  let known = false;
  for (const k of SHOWN_KINDS) {
    if (head.length < 12 || !k.is(head)) continue;
    if (k.endings.includes(end)) return { kind: k.kind, how: 'system' };
    known = true;
  }
  if (known) return null; // the bytes are a kind the name does not say
  if (TEXT_ENDINGS.has(end) && looksLikeText(head)) return { kind: 'text', how: 'editor' };
  return null;
}

/**
 * Read a shown file to its end through `_lembas/show/read`.
 * @param {(params: object) => Promise<{ data: string, offset?: number, eof?: boolean }>} read
 * @param {{ handle: string, size?: number, hash?: string }} file
 * @param {{ maxBytes: number, length?: number }} limits
 * @returns {Promise<Buffer>} rejects with an Error whose message is a sentence for the person
 */
async function fetchShown(read, file, limits) {
  const max = limits.maxBytes;
  if (typeof file.size === 'number' && file.size > max) throw tooLarge(file.size, max);
  const parts = [];
  let offset = 0;
  for (let turn = 0; turn < 100000; turn++) {
    const r = await read({ handle: file.handle, offset, length: limits.length || PART });
    if (!r || typeof r.data !== 'string') throw new Error('The agent sent no data for the file.');
    const bytes = Buffer.from(r.data, 'base64');
    if (bytes.length > 0) {
      parts.push(bytes);
      offset += bytes.length;
    }
    if (offset > max) throw tooLarge(offset, max);
    if (r.eof) break;
    if (bytes.length === 0) throw new Error('The agent stopped sending the file before its end.');
  }
  const all = Buffer.concat(parts);
  if (typeof file.size === 'number' && all.length !== file.size) {
    throw new Error(`The file arrived as ${sizeInWords(all.length)}, not the ${sizeInWords(file.size)} the agent named.`);
  }
  if (typeof file.hash === 'string' && file.hash.startsWith('sha256:')) {
    const got = crypto.createHash('sha256').update(all).digest('hex');
    if (got !== file.hash.slice(7).toLowerCase()) throw new Error('The file did not arrive whole (its checksum differs).');
  }
  return all;
}

function tooLarge(size, max) {
  return new Error(`The file is ${sizeInWords(size)}; this editor takes files of up to ${sizeInWords(max)}.`);
}

/**
 * Take in a file the agent shows: find out what it is from its first bytes, and put it where
 * the editor can show or open it. A picture is always fetched into `dir`; anything else is
 * fetched only when the agent named no file on this machine (`uri`).
 * @param {object} p the params of `_lembas/show` (with a `handle`)
 * @param {(params: object) => Promise<object>} read `_lembas/show/read`
 * @param {{ dir: string, maxBytes: number, length?: number, fs?: object }} where
 * @returns {Promise<{ ok: boolean, reason?: string, name: string, size: number, picture: boolean,
 *                     mime?: string, file?: string, original?: string,
 *                     open: { kind: string, how: 'editor' | 'system' } | null }>}
 */
async function receiveShown(p, read, where) {
  const fs = where.fs || require('node:fs/promises');
  const path = require('node:path');
  const size = typeof p.size === 'number' ? p.size : undefined;
  const base = { ok: false, name: safeName(p.path), size: size || 0, picture: false };
  if (typeof p.handle !== 'string' || !p.handle) return { ...base, reason: 'The agent named no file to fetch.' };
  if (size !== undefined && size > where.maxBytes) return { ...base, reason: tooLarge(size, where.maxBytes).message };
  let original;
  if (typeof p.uri === 'string' && p.uri.startsWith('file:')) {
    try {
      original = require('node:url').fileURLToPath(p.uri);
    } catch {
      original = undefined;
    }
  }
  try {
    const head = await read({ handle: p.handle, offset: 0, length: 4096 });
    const first = Buffer.from(head && typeof head.data === 'string' ? head.data : '', 'base64');
    const picture = sniffPicture(first);
    if (!picture && original) return { ...base, ok: true, original, size: size === undefined ? 0 : size, open: openable(first, original) };
    const bytes = head && head.eof && (size === undefined || first.length === size) && !p.hash
      ? first
      : await fetchShown(read, { handle: p.handle, size, hash: p.hash }, { maxBytes: where.maxBytes, length: where.length });
    receiveShown.count = (receiveShown.count || 0) + 1;
    let name = safeName(p.path, picture ? picture.ext : 'bin');
    // A picture is served by its name's ending, so the ending is what the bytes are.
    if (picture && !name.toLowerCase().endsWith('.' + picture.ext)) name = name.replace(/\.[A-Za-z0-9]{1,8}$/, '') + '.' + picture.ext;
    const file = path.join(where.dir, `${receiveShown.count}-${name}`);
    await fs.writeFile(file, bytes, { mode: 0o600, flag: 'wx' });
    return { ok: true, name, size: bytes.length, picture: !!picture, mime: picture ? picture.mime : undefined, file, original, open: openable(bytes.subarray(0, 4096), file) };
  } catch (e) {
    return { ...base, reason: (e && e.message) || 'The file could not be fetched.' };
  }
}

module.exports = { sniffPicture, sizeInWords, safeName, openable, fetchShown, receiveShown, PART };
