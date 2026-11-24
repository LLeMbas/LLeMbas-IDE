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

const RUNNABLE = new Set([
  'exe', 'bat', 'cmd', 'com', 'scr', 'msi', 'msp', 'pif', 'lnk', 'ps1', 'vbs', 'vbe', 'js', 'jse', 'wsf', 'wsh', 'hta', 'cpl', 'reg',
  'sh', 'bash', 'zsh', 'fish', 'command', 'desktop', 'appimage', 'run', 'bin', 'app', 'jar', 'py', 'pl', 'rb', 'php', 'scpt', 'workflow',
  'action', 'url', 'html', 'htm', 'xhtml', 'svg', 'dmg', 'pkg', 'deb', 'rpm',
]);

/** Whether the system might run a file of this name instead of showing it. */
function mayRun(name) {
  const m = /\.([A-Za-z0-9]+)$/.exec(String(name));
  return !m || RUNNABLE.has(m[1].toLowerCase());
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
 *                     mime?: string, file?: string, original?: string }>}
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
    if (!picture && original) return { ...base, ok: true, original, size: size === undefined ? 0 : size };
    const bytes = head && head.eof && (size === undefined || first.length === size) && !p.hash
      ? first
      : await fetchShown(read, { handle: p.handle, size, hash: p.hash }, { maxBytes: where.maxBytes, length: where.length });
    receiveShown.count = (receiveShown.count || 0) + 1;
    let name = safeName(p.path, picture ? picture.ext : 'bin');
    // A picture is served by its name's ending, so the ending is what the bytes are.
    if (picture && !name.toLowerCase().endsWith('.' + picture.ext)) name = name.replace(/\.[A-Za-z0-9]{1,8}$/, '') + '.' + picture.ext;
    const file = path.join(where.dir, `${receiveShown.count}-${name}`);
    await fs.writeFile(file, bytes, { mode: 0o600, flag: 'wx' });
    return { ok: true, name, size: bytes.length, picture: !!picture, mime: picture ? picture.mime : undefined, file, original };
  } catch (e) {
    return { ...base, reason: (e && e.message) || 'The file could not be fetched.' };
  }
}

module.exports = { sniffPicture, sizeInWords, safeName, mayRun, fetchShown, receiveShown, PART };
