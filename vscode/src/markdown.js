'use strict';
// A small Markdown reader for what a model writes. It makes a tree of plain objects and never
// a string of markup: the chat view builds elements from the tree with `createElement` and
// `textContent`, so nothing a model writes is ever parsed as HTML. Raw HTML in the text stays
// text. No `vscode` here.
//
// Blocks:  { t: 'p', c }  { t: 'h', l, c }  { t: 'pre', lang, v }  { t: 'hr' }
//          { t: 'quote', c: blocks }  { t: 'ul' | 'ol', items: [{ d, checked?, c }] }
//          { t: 'table', align: string[], head: Inline[][], rows: Inline[][][] }  { t: 'plain', v }
// Inline:  { t: 'text', v }  { t: 'code', v }  { t: 'b', c }  { t: 'i', c }  { t: 'del', c }
//          { t: 'a', href, c }  { t: 'br' }

const MAX_DEPTH = 6;
// What a model writes is not trusted to be short or kind. Three bounds keep the reading of it
// linear: a text longer than MAX_CHARS is shown as it was written; a line longer than MAX_LINE
// is never matched against the block patterns; and the searches for a closing mark (emphasis,
// a link's bracket) draw on one budget of steps per parse — when it is spent, the rest of the
// text is plain text.
const MAX_CHARS = 400000;
const MAX_LINE = 4000;
const BUDGET = 400000;
const LABEL_MAX = 1000;
const MAX_TABLE_COLS = 24;

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

function findClosing(s, from, marker, work) {
  for (let i = from; i < s.length; i++) {
    if (--work.left < 0) return -1;
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

function parseInline(s, depth, budget) {
  const out = [];
  const deep = (depth || 0) >= MAX_DEPTH;
  const work = budget || { left: BUDGET };
  const noTicks = {}; // run length -> no closing run of that length from here on
  let i = 0;
  while (i < s.length) {
    if (work.left < 0) {
      // The budget is spent: the rest is text, line breaks kept.
      const rest = s.slice(i).split('\n');
      rest.forEach((line, n) => {
        if (n) out.push({ t: 'br' });
        pushText(out, line);
      });
      break;
    }
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
      const close = noTicks[n] ? -1 : s.indexOf('`'.repeat(n), i + n);
      if (close < 0) noTicks[n] = true;
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
    if (!deep && ch === '~' && s[i + 1] === '~') {
      const next = s[i + 2];
      if (next !== undefined && !/\s/.test(next)) {
        const close = findClosing(s, i + 2, '~~', work);
        if (close > 0) {
          out.push({ t: 'del', c: parseInline(s.slice(i + 2, close), (depth || 0) + 1, work) });
          i = close + 2;
          continue;
        }
      }
      pushText(out, '~~');
      i += 2;
      continue;
    }
    if (!deep && (ch === '*' || ch === '_')) {
      const double = s[i + 1] === ch;
      const marker = double ? ch + ch : ch;
      const next = s[i + marker.length];
      const opens = next !== undefined && !/\s/.test(next) && !(ch === '_' && isWord(s[i - 1]));
      if (opens) {
        const close = findClosing(s, i + marker.length, marker, work);
        if (close > 0) {
          out.push({ t: double ? 'b' : 'i', c: parseInline(s.slice(i + marker.length, close), (depth || 0) + 1, work) });
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
      for (let j = open; j < s.length && j < open + LABEL_MAX; j++) {
        if (--work.left < 0) break;
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
        for (let j = close + 1; j < s.length && j < close + 2100; j++) {
          if (--work.left < 0) break;
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
            const c = ch === '!' ? [{ t: 'text', v: label || href }] : parseInline(label, (depth || 0) + 1, work);
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
const HEADING = /^ {0,3}(#{1,6})[ \t]+(\S.*)$/;
const RULE = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/;
const ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const TASK = /^\[([ xX])\]\s+(.*)$/;
const QUOTE = /^ {0,3}>\s?(.*)$/;
const TABLE_SEP_CELL = /^:?-{1,}:?$/;

function splitTableCells(line) {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  const cells = [];
  let cur = '';
  let inCode = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '\\' && i + 1 < s.length && s[i + 1] === '|') {
      cur += '|';
      i++;
      continue;
    }
    if (ch === '`') inCode = !inCode;
    if (ch === '|' && !inCode) {
      cells.push(cur.trim());
      cur = '';
      if (cells.length >= MAX_TABLE_COLS) break;
      continue;
    }
    cur += ch;
  }
  if (cells.length < MAX_TABLE_COLS) cells.push(cur.trim());
  return cells;
}

function parseTableAlign(line) {
  if (!line || line.length > MAX_LINE || !line.includes('|')) return null;
  const cells = splitTableCells(line);
  if (!cells.length) return null;
  const align = [];
  for (const c of cells) {
    if (!TABLE_SEP_CELL.test(c)) return null;
    const left = c.startsWith(':');
    const right = c.endsWith(':');
    align.push(left && right ? 'center' : right ? 'right' : left ? 'left' : '');
  }
  return align;
}

/** A heading's text without the closing run of # some write after it. */
function headingText(text) {
  let end = text.length;
  while (end > 0 && (text[end - 1] === ' ' || text[end - 1] === '\t')) end--;
  let hashes = end;
  while (hashes > 0 && text[hashes - 1] === '#') hashes--;
  if (hashes < end && (hashes === 0 || text[hashes - 1] === ' ' || text[hashes - 1] === '\t')) end = hashes;
  while (end > 0 && (text[end - 1] === ' ' || text[end - 1] === '\t')) end--;
  return text.slice(0, end);
}

/** Markdown text to a list of blocks. */
function parse(src, depth, budget) {
  return read(src, depth, budget).blocks;
}

/** As `parse`, and whether the text ended inside a fenced block that was not closed. */
function read(src, depth, budget) {
  const level = depth || 0;
  const text = String(src === undefined || src === null ? '' : src).replace(/\r\n?/g, '\n');
  if (text.length > MAX_CHARS) return { blocks: [{ t: 'plain', v: text }], open: false };
  const work = budget || { left: BUDGET };
  const lines = text.split('\n');
  const blocks = [];
  let open = false;
  let openAt = -1; // where the fence that was not closed begins
  let para = [];
  const flush = () => {
    if (para.length) blocks.push({ t: 'p', c: parseInline(para.join('\n'), 0, work) });
    para = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.length > MAX_LINE) {
      para.push(line);
      continue;
    }
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
      if (j >= lines.length) {
        open = true;
        openAt = 0;
        for (let k = 0; k < i; k++) openAt += lines[k].length + 1;
      }
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
      blocks.push({ t: 'h', l: heading[1].length, c: parseInline(headingText(heading[2]), 0, work) });
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
      blocks.push({ t: 'quote', c: parse(body.join('\n'), level + 1, work) });
      i = j - 1;
      continue;
    }
    if (line.includes('|') && i + 1 < lines.length) {
      const align = parseTableAlign(lines[i + 1]);
      if (align) {
        const headRaw = splitTableCells(line);
        if (headRaw.length === align.length) {
          flush();
          const cols = align.length;
          const head = headRaw.map((c) => parseInline(c, 0, work));
          const rows = [];
          let j = i + 2;
          for (; j < lines.length && lines[j].length <= MAX_LINE && lines[j].trim() !== '' && lines[j].includes('|'); j++) {
            const cells = splitTableCells(lines[j]);
            while (cells.length < cols) cells.push('');
            rows.push(cells.slice(0, cols).map((c) => parseInline(c, 0, work)));
          }
          blocks.push({ t: 'table', align, head, rows });
          i = j - 1;
          continue;
        }
      }
    }
    if (/^\s*\|/.test(line)) {
      // Pipe lines without a valid separator row stay in a fixed-width block.
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
          let bodyText = m[3];
          let checked = null;
          if (!ordered) {
            const tm = TASK.exec(bodyText);
            if (tm) {
              checked = tm[1].toLowerCase() === 'x';
              bodyText = tm[2];
            }
          }
          items.push({ d, checked, text: [bodyText] });
        } else if (lines[j].trim() !== '' && /^\s+/.test(lines[j]) && items.length && !FENCE.test(lines[j])) {
          items[items.length - 1].text.push(lines[j].trim());
        } else {
          break;
        }
      }
      blocks.push({
        t: ordered ? 'ol' : 'ul',
        items: items.map((it) => {
          const node = { d: it.d, c: parseInline(it.text.join('\n'), 0, work) };
          if (it.checked !== null) node.checked = it.checked;
          return node;
        }),
      });
      i = j - 1;
      continue;
    }
    para.push(line);
  }
  flush();
  return { blocks, open, openAt };
}

/**
 * A reply read as it grows. Text that ends at a blank line outside a fenced block will never be
 * read differently, whatever follows, so it is read once and kept; only what comes after the
 * last such place is read again when more arrives. The result is always what `parse` gives for
 * the whole text.
 */
class Growing {
  constructor() {
    this.text = '';
    this.done = 0; // characters of `text` already read for good
    this.blocks = [];
  }

  update(text) {
    const whole = String(text === undefined || text === null ? '' : text).replace(/\r\n?/g, '\n');
    if (whole.length > MAX_CHARS) return [{ t: 'plain', v: whole }];
    if (!whole.startsWith(this.text.slice(0, this.done))) {
      this.done = 0;
      this.blocks = [];
    }
    this.text = whole;
    let cut = whole.lastIndexOf('\n\n');
    for (let tries = 0; tries < 2 && cut >= this.done; tries++) {
      const piece = read(whole.slice(this.done, cut));
      if (!piece.open) {
        this.blocks.push(...piece.blocks);
        this.done = cut + 2;
        break;
      }
      // The blank line is inside a fenced block still being written: settle what is before it.
      cut = piece.openAt > 0 ? whole.lastIndexOf('\n\n', this.done + piece.openAt - 1) : -1;
    }
    return this.blocks.concat(read(whole.slice(this.done)).blocks);
  }
}

module.exports = { parse, parseInline, safeHref, Growing, MAX_CHARS };
