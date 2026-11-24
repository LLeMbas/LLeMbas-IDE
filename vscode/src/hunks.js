'use strict';
// A rewrite shown before it is made: the proposed lines against the lines now, as hunks that are
// accepted or rejected one by one. Lines are 0-based here. No `vscode` here.

const MAX_EDIT_DISTANCE = 4000;

function splitLines(text) {
  return String(text).replace(/\r\n/g, '\n').split('\n');
}

/**
 * The differences between two lists of lines (Myers' algorithm), as
 * `{ aStart, aCount, bStart, bCount }` in order. Lists too different to compare in reasonable
 * time come back as one hunk that replaces everything between their common ends.
 */
function diffLines(a, b) {
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const n = a.length - head - tail;
  const m = b.length - head - tail;
  if (n === 0 && m === 0) return [];
  if (n === 0 || m === 0) return [{ aStart: head, aCount: n, bStart: head, bCount: m }];

  const max = Math.min(n + m, MAX_EDIT_DISTANCE);
  const offset = max + 1;
  let v = new Int32Array(2 * max + 3);
  const trace = [];
  let found = -1;
  for (let d = 0; d <= max && found < 0; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x;
      if (k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])) x = v[offset + k + 1];
      else x = v[offset + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[head + x] === b[head + y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) {
        found = d;
        break;
      }
    }
  }
  if (found < 0) return [{ aStart: head, aCount: n, bStart: head, bCount: m }];

  // Walk back from the end, collecting the single steps.
  const steps = []; // { x, y, del } : a line of a deleted at x, or a line of b inserted at y
  let x = n;
  let y = m;
  for (let d = found; d > 0; d--) {
    const prev = trace[d];
    const k = x - y;
    let prevK;
    if (k === -d || (k !== d && prev[offset + k - 1] < prev[offset + k + 1])) prevK = k + 1;
    else prevK = k - 1;
    const prevX = prev[offset + prevK];
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      x--;
      y--;
    }
    if (x === prevX) steps.push({ x: prevX, y: prevY, del: false });
    else steps.push({ x: prevX, y: prevY, del: true });
    x = prevX;
    y = prevY;
  }
  steps.reverse();

  const hunks = [];
  let cur = null;
  for (const s of steps) {
    const ax = head + s.x;
    const by = head + s.y;
    if (cur && cur.aStart + cur.aCount === ax && cur.bStart + cur.bCount === by) {
      if (s.del) cur.aCount++;
      else cur.bCount++;
    } else {
      cur = { aStart: ax, aCount: s.del ? 1 : 0, bStart: by, bCount: s.del ? 0 : 1 };
      hunks.push(cur);
    }
  }
  return hunks;
}

/**
 * A rewrite of the document's lines `first .. first + oldLines.length - 1` as pending hunks.
 * Each hunk: `{ id, line, old: string[], new: string[] }` — `line` is where its old lines start
 * in the document now, or, when it only adds lines, the line they go in front of.
 */
function propose(first, oldLines, newLines) {
  return diffLines(oldLines, newLines).map((h, i) => ({
    id: i + 1,
    line: first + h.aStart,
    old: oldLines.slice(h.aStart, h.aStart + h.aCount),
    new: newLines.slice(h.bStart, h.bStart + h.bCount),
  }));
}

/** Whether the document still says, at the hunk, what the hunk was made against. */
function stillFits(hunk, lineAt, lineCount) {
  if (hunk.line < 0 || hunk.line + hunk.old.length > lineCount) return false;
  if (hunk.old.length === 0) return hunk.line <= lineCount;
  for (let i = 0; i < hunk.old.length; i++) if (lineAt(hunk.line + i) !== hunk.old[i]) return false;
  return true;
}

/**
 * The one text edit that accepts a hunk in a document of `lineCount` lines:
 * `{ start: { line, end }, stop: { line, end }, text }` — a position is the start of its line,
 * or the line's end when `end` is true. Line breaks in `text` are "\n"; the caller puts the
 * document's own in.
 */
function editFor(hunk, lineCount) {
  const text = hunk.new.join('\n');
  if (hunk.old.length === 0) {
    if (hunk.line >= lineCount) {
      // After the last line.
      const last = Math.max(0, lineCount - 1);
      return { start: { line: last, end: true }, stop: { line: last, end: true }, text: '\n' + text };
    }
    return { start: { line: hunk.line, end: false }, stop: { line: hunk.line, end: false }, text: text + '\n' };
  }
  const lastOld = hunk.line + hunk.old.length - 1;
  if (hunk.new.length > 0) {
    return { start: { line: hunk.line, end: false }, stop: { line: lastOld, end: true }, text };
  }
  // Lines taken away, with their line break.
  if (lastOld + 1 < lineCount) {
    return { start: { line: hunk.line, end: false }, stop: { line: lastOld + 1, end: false }, text: '' };
  }
  if (hunk.line > 0) {
    return { start: { line: hunk.line - 1, end: true }, stop: { line: lastOld, end: true }, text: '' };
  }
  return { start: { line: 0, end: false }, stop: { line: lastOld, end: true }, text: '' };
}

/** The hunks left after one was accepted: those below it move by what it added or took away. */
function afterAccept(hunks, accepted) {
  const delta = accepted.new.length - accepted.old.length;
  return hunks
    .filter((h) => h !== accepted)
    .map((h) => (h.line > accepted.line || (h.line === accepted.line && h.id > accepted.id) ? { ...h, line: h.line + delta } : h));
}

/**
 * The hunks left after the document changed by somebody else's hand: lines `startLine ..
 * endLine` (inclusive) were replaced by `newLineCount` lines. A hunk above the change stays, one
 * below it moves, and one the change reaches into is dropped — its text is no longer what was
 * shown.
 */
function afterChange(hunks, change) {
  const delta = change.newLineCount - (change.endLine - change.startLine + 1);
  const out = [];
  for (const h of hunks) {
    if (h.old.length === 0) {
      // Lines to add in front of `line`: a change at or below that line leaves the place alone.
      if (change.startLine >= h.line) out.push(h);
      else if (change.endLine < h.line) out.push({ ...h, line: h.line + delta });
      continue;
    }
    const last = h.line + h.old.length - 1;
    if (last < change.startLine) out.push(h);
    else if (h.line > change.endLine) out.push({ ...h, line: h.line + delta });
  }
  return out;
}

/** The whole text as it would be with every pending hunk accepted (for the diff view). */
function withAll(lines, hunks) {
  const out = lines.slice();
  const ordered = hunks.slice().sort((p, q) => q.line - p.line || q.id - p.id);
  for (const h of ordered) out.splice(h.line, h.old.length, ...h.new);
  return out;
}

/** The lines a selection covers: whole lines, and not the line a selection merely ends in front of. */
function wholeLines(sel) {
  let last = sel.endLine;
  if (last > sel.startLine && sel.endCharacter === 0) last -= 1;
  return { first: sel.startLine, last };
}

module.exports = { splitLines, diffLines, propose, stillFits, editFor, afterAccept, afterChange, withAll, wholeLines };
