'use strict';
// A small Markdown reader for what a model writes. It makes a tree of plain objects and never
// a string of markup: the chat view builds elements from the tree with `createElement` and
// `textContent`, so nothing a model writes is ever parsed as HTML. Raw HTML in the text stays
// text. No `vscode` here.
//
// Blocks:  { t: 'p', c }  { t: 'h', l, c }  { t: 'pre', lang, v }  { t: 'hr' }
//          { t: 'quote', c: blocks }  { t: 'ul' | 'ol', items: [{ d, c }] }
// Inline:  { t: 'text', v }  { t: 'code', v }  { t: 'b', c }  { t: 'i', c }
//          { t: 'a', href, c }  { t: 'br' }

const MAX_DEPTH = 6;

/** A link the chat may offer to open: http, https or mailto, and nothing else. */
function safeHref(url) {
  if (typeof url !== 'string' || url.length > 2000) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000- \u007f"<>`\\]/.test(url)) return null;
  if (/^https?:\/\/[^/?#]+/i.test(url) || /^mailto:[^@\s]+@[^@\s]+$/i.test(url)) return url;
  return null;
}

function pushText(out, v) {
  if (!v) return;
  const last = out[out.length - 1];
  if (last && last.t === 'text') last.v += v;
  else out.push({ t: 'text', v });
}

function isWord(ch) {
  return ch !== undefined && /[\p{L}\p{N}]/u.test(ch);
}

function findClosing(s, from, marker) {
  for (let i = from; i < s.length; i++) {
    if (s[i] === '\\') {
      i++;
      continue;
    }
    if (s[i] === '`') {
      // Skip a code span whole.
      let n = 1;
      while (s[i + n] === '`') n++;
      const close = s.indexOf('`'.repeat(n), i + n);
      if (close < 0) return -1;
      i = close + n - 1;
      continue;
    }
    if (s.startsWith(marker, i)) {
      if (i === from) continue; // empty
      if (/\s/.test(s[i - 1])) continue;
      if (marker[0] === '_' && isWord(s[i + marker.length])) continue;
      if (marker.length === 1 && s[i + 1] === marker) {
        // A double marker inside single emphasis belongs to something else.
        i++;
        continue;
      }
      return i;
    }
  }
  return -1;
}

function parseInline(s, depth) {
  const out = [];
  const deep = (depth || 0) >= MAX_DEPTH;
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (ch === '\n') {
      out.push({ t: 'br' });
      i++;
      continue;
    }
    if (ch === '\\' && i + 1 < s.length && /[!-/:-@[-`{-~]/.test(s[i + 1])) {
      pushText(out, s[i + 1]);
      i += 2;
      continue;
    }
    if (ch === '`') {
      let n = 1;
      while (s[i + n] === '`') n++;
      const close = s.indexOf('`'.repeat(n), i + n);
      if (close >= 0) {
        let v = s.slice(i + n, close).replace(/\n/g, ' ');
        if (v.length > 2 && v.startsWith(' ') && v.endsWith(' ')) v = v.slice(1, -1);
        out.push({ t: 'code', v });
        i = close + n;
        continue;
      }
      pushText(out, '`'.repeat(n));
      i += n;
      continue;
    }
    if (!deep && (ch === '*' || ch === '_')) {
      const double = s[i + 1] === ch;
      const marker = double ? ch + ch : ch;
      const next = s[i + marker.length];
      const opens = next !== undefined && !/\s/.test(next) && !(ch === '_' && isWord(s[i - 1]));
      if (opens) {
        const close = findClosing(s, i + marker.length, marker);
        if (close > 0) {
          out.push({ t: double ? 'b' : 'i', c: parseInline(s.slice(i + marker.length, close), (depth || 0) + 1) });
          i = close + marker.length;
          continue;
        }
      }
      pushText(out, marker);
      i += marker.length;
      continue;
    }
    if (!deep && (ch === '[' || (ch === '!' && s[i + 1] === '['))) {
      const open = ch === '!' ? i + 1 : i;
      let level = 0;
      let close = -1;
      for (let j = open; j < s.length; j++) {
        if (s[j] === '\\') j++;
        else if (s[j] === '[') level++;
        else if (s[j] === ']' && --level === 0) {
          close = j;
          break;
        }
      }
      if (close > 0 && s[close + 1] === '(') {
        let end = -1;
        let parens = 0;
        for (let j = close + 1; j < s.length; j++) {
          if (s[j] === '(') parens++;
          else if (s[j] === ')' && --parens === 0) {
            end = j;
            break;
          } else if (s[j] === '\n') break;
        }
        if (end > 0) {
          const inside = s.slice(close + 2, end).trim();
          const url = inside.split(/\s+/)[0].replace(/^<|>$/g, '');
          const href = safeHref(url);
          const label = s.slice(open + 1, close);
          if (href) {
            // A picture is never loaded: it is a link like any other.
            const c = ch === '!' ? [{ t: 'text', v: label || href }] : parseInline(label, (depth || 0) + 1);
            out.push({ t: 'a', href, c: c.length ? c : [{ t: 'text', v: href }] });
            i = end + 1;
            continue;
          }
          // Not a link the chat opens: shown as it was written.
          pushText(out, s.slice(i, end + 1));
          i = end + 1;
          continue;
        }
      }
      pushText(out, ch);
      i++;
      continue;
    }
    if (ch === 'h' && !isWord(s[i - 1])) {
      const m = /^https?:\/\/[^\s<>()[\]"'`\\]+/i.exec(s.slice(i, i + 2000));
      if (m) {
        const raw = m[0].replace(/[.,;:!?*_]+$/, '');
        const href = safeHref(raw);
        if (href) {
          out.push({ t: 'a', href, c: [{ t: 'text', v: raw }] });
          i += raw.length;
          continue;
        }
      }
    }
    pushText(out, ch);
    i++;
  }
  return out;
}

const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([^\s`]*)[^`]*$/;
const HEADING = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const RULE = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/;
const ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const QUOTE = /^ {0,3}>\s?(.*)$/;

/** Markdown text to a list of blocks. */
function parse(src, depth) {
  const level = depth || 0;
  const lines = String(src === undefined || src === null ? '' : src).replace(/\r\n?/g, '\n').split('\n');
  const blocks = [];
  let para = [];
  const flush = () => {
    if (para.length) blocks.push({ t: 'p', c: parseInline(para.join('\n'), 0) });
    para = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = FENCE.exec(line);
    if (fence) {
      flush();
      const mark = fence[1];
      const body = [];
      let j = i + 1;
      for (; j < lines.length; j++) {
        const t = lines[j].trim();
        if (t.startsWith(mark[0].repeat(mark.length)) && /^(`+|~+)$/.test(t)) break;
        body.push(lines[j]);
      }
      blocks.push({ t: 'pre', lang: fence[2].replace(/[^A-Za-z0-9_+#.-]/g, '').slice(0, 30), v: body.join('\n') });
      i = j; // an unclosed fence runs to the end: the text is still being written
      continue;
    }
    if (line.trim() === '') {
      flush();
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      flush();
      blocks.push({ t: 'h', l: heading[1].length, c: parseInline(heading[2], 0) });
      continue;
    }
    if (RULE.test(line)) {
      flush();
      blocks.push({ t: 'hr' });
      continue;
    }
    if (QUOTE.test(line) && level < MAX_DEPTH) {
      flush();
      const body = [];
      let j = i;
      for (; j < lines.length; j++) {
        const q = QUOTE.exec(lines[j]);
        if (!q) break;
        body.push(q[1]);
      }
      blocks.push({ t: 'quote', c: parse(body.join('\n'), level + 1) });
      i = j - 1;
      continue;
    }
    if (/^\s*\|/.test(line)) {
      // A table is kept as written, in the fixed-width face, so its columns still line up.
      flush();
      const body = [];
      let j = i;
      for (; j < lines.length && /^\s*\|/.test(lines[j]); j++) body.push(lines[j].trim());
      blocks.push({ t: 'pre', lang: '', v: body.join('\n') });
      i = j - 1;
      continue;
    }
    const item = ITEM.exec(line);
    if (item) {
      flush();
      const ordered = /\d/.test(item[2]);
      const base = item[1].length;
      const items = [];
      let j = i;
      for (; j < lines.length; j++) {
        const m = ITEM.exec(lines[j]);
        if (m) {
          const d = Math.max(0, Math.min(MAX_DEPTH - 1, Math.floor((m[1].replace(/\t/g, '    ').length - base) / 2)));
          items.push({ d, text: [m[3]] });
        } else if (lines[j].trim() !== '' && /^\s+/.test(lines[j]) && items.length && !FENCE.test(lines[j])) {
          items[items.length - 1].text.push(lines[j].trim());
        } else {
          break;
        }
      }
      blocks.push({ t: ordered ? 'ol' : 'ul', items: items.map((it) => ({ d: it.d, c: parseInline(it.text.join('\n'), 0) })) });
      i = j - 1;
      continue;
    }
    para.push(line);
  }
  flush();
  return blocks;
}

module.exports = { parse, parseInline, safeHref };
