'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const h = require('../src/hunks');

/** Apply an edit of `editFor` to a list of lines, as an editor would to its text. */
function applyEdit(lines, e) {
  const text = lines.join('\n');
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1);
  const offset = (p) => (p.end ? (p.line + 1 < starts.length ? starts[p.line + 1] - 1 : text.length) : starts[p.line]);
  return (text.slice(0, offset(e.start)) + e.text + text.slice(offset(e.stop))).split('\n');
}

const apply = (a, hunks) => {
  const out = a.slice();
  for (const k of hunks.slice().reverse()) out.splice(k.aStart, k.aCount, ...k.b);
  return out;
};

test('the differences between two lists of lines', () => {
  const a = ['one', 'two', 'three', 'four', 'five'];
  assert.deepEqual(h.diffLines(a, a), []);
  assert.deepEqual(h.diffLines(a, ['one', 'TWO', 'three', 'four', 'five']), [{ aStart: 1, aCount: 1, bStart: 1, bCount: 1 }]);
  assert.deepEqual(h.diffLines(a, ['one', 'three', 'four', 'five']), [{ aStart: 1, aCount: 1, bStart: 1, bCount: 0 }]);
  assert.deepEqual(h.diffLines(a, ['zero', 'one', 'two', 'three', 'four', 'five']), [{ aStart: 0, aCount: 0, bStart: 0, bCount: 1 }]);
  assert.deepEqual(h.diffLines(a, [...a, 'six', 'seven']), [{ aStart: 5, aCount: 0, bStart: 5, bCount: 2 }]);
  assert.deepEqual(h.diffLines(a, ['ONE', 'two', 'three', 'four', 'FIVE']), [
    { aStart: 0, aCount: 1, bStart: 0, bCount: 1 },
    { aStart: 4, aCount: 1, bStart: 4, bCount: 1 },
  ]);
  assert.deepEqual(h.diffLines([], ['a']), [{ aStart: 0, aCount: 0, bStart: 0, bCount: 1 }]);
  assert.deepEqual(h.diffLines(['a'], []), [{ aStart: 0, aCount: 1, bStart: 0, bCount: 0 }]);
});

test('whatever the two texts, the hunks turn the one into the other', () => {
  let seed = 7;
  const rnd = (n) => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed % n;
  };
  for (let round = 0; round < 300; round++) {
    const a = Array.from({ length: rnd(14) }, () => 'line ' + rnd(5));
    const b = a.slice();
    for (let edits = rnd(5); edits > 0; edits--) {
      const at = rnd(b.length + 1);
      if (rnd(2)) b.splice(at, rnd(3), 'new ' + rnd(4));
      else b.splice(at, rnd(3));
    }
    const hunks = h.diffLines(a, b);
    const withB = hunks.map((k) => ({ ...k, b: b.slice(k.bStart, k.bStart + k.bCount) }));
    assert.deepEqual(apply(a, withB), b, `round ${round}`);
    for (let i = 1; i < hunks.length; i++) {
      assert.ok(hunks[i].aStart > hunks[i - 1].aStart + hunks[i - 1].aCount, 'an unchanged line lies between two hunks');
    }
  }
});

test('texts too different to compare come back as one hunk, still correct', () => {
  const a = Array.from({ length: 5000 }, (_, i) => 'a' + i);
  const b = Array.from({ length: 5000 }, (_, i) => 'b' + i);
  const hunks = h.diffLines(['same', ...a, 'end'], ['same', ...b, 'end']);
  assert.deepEqual(hunks, [{ aStart: 1, aCount: 5000, bStart: 1, bCount: 5000 }]);
});

const DOC = ['# bread', 'def a():', '    return 1', '', 'def b():', '    return 2', 'print(a())'];

test('a rewrite of lines 2-6 becomes hunks at the document\'s own lines', () => {
  const old = DOC.slice(1, 6);
  const fresh = ['def a():', '    return 10', '', 'def b():', '    """Two."""', '    return 2'];
  const hunks = h.propose(1, old, fresh);
  assert.deepEqual(hunks, [
    { id: 1, line: 2, old: ['    return 1'], new: ['    return 10'] },
    { id: 2, line: 5, old: [], new: ['    """Two."""'] },
  ]);
  assert.deepEqual(h.withAll(DOC, hunks), ['# bread', ...fresh, 'print(a())']);
});

const OLD = ['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7', 'a8', 'a9'];
const FRESH = ['A1', 'a2', 'a3', 'a5', 'a6', 'new', 'a7', 'a8', 'A9', 'tail'];
const AROUND = ['top', ...OLD, 'bottom'];

test('accepting hunks one by one, in any order, gives the rewrite; rejecting leaves the text', () => {
  const orders = [[0, 1, 2, 3], [3, 2, 1, 0], [1, 3, 0, 2], [2, 0, 3, 1]];
  for (const order of orders) {
    let lines = AROUND.slice();
    let hunks = h.propose(1, OLD, FRESH);
    assert.equal(hunks.length, 4); // a1 replaced, a4 taken away, "new" added, a9 replaced with two lines
    const ids = order.map((i) => hunks[i].id);
    for (const id of ids) {
      const hunk = hunks.find((k) => k.id === id);
      assert.ok(h.stillFits(hunk, (i) => lines[i], lines.length), `hunk ${id} fits in order ${order}`);
      lines = applyEdit(lines, h.editFor(hunk, lines.length));
      hunks = h.afterAccept(hunks, hunk);
    }
    assert.deepEqual(lines, ['top', ...FRESH, 'bottom'], `order ${order}`);
    assert.equal(hunks.length, 0);
  }
  // Accept only the second and the fourth: where the others were proposed, the old text stays.
  let lines = AROUND.slice();
  let hunks = h.propose(1, OLD, FRESH);
  for (const id of [2, 4]) {
    const hunk = hunks.find((k) => k.id === id);
    lines = applyEdit(lines, h.editFor(hunk, lines.length));
    hunks = h.afterAccept(hunks, hunk);
  }
  assert.deepEqual(lines, ['top', 'a1', 'a2', 'a3', 'a5', 'a6', 'a7', 'a8', 'A9', 'tail', 'bottom']);
  assert.deepEqual(hunks.map((k) => [k.id, k.line]), [[1, 1], [3, 6]]);
});

test('the edit for each kind of hunk, at the edges of a document', () => {
  // Lines added after the last line.
  let lines = ['a', 'b'];
  lines = applyEdit(lines, h.editFor({ line: 2, old: [], new: ['c', 'd'] }, 2));
  assert.deepEqual(lines, ['a', 'b', 'c', 'd']);
  // Lines added in front of the first.
  assert.deepEqual(applyEdit(['a', 'b'], h.editFor({ line: 0, old: [], new: ['z'] }, 2)), ['z', 'a', 'b']);
  // The last line taken away: the line break before it goes too.
  assert.deepEqual(applyEdit(['a', 'b', 'c'], h.editFor({ line: 2, old: ['c'], new: [] }, 3)), ['a', 'b']);
  // A middle line taken away.
  assert.deepEqual(applyEdit(['a', 'b', 'c'], h.editFor({ line: 1, old: ['b'], new: [] }, 3)), ['a', 'c']);
  // Every line taken away leaves one empty line, which is what an empty document is.
  assert.deepEqual(applyEdit(['a', 'b'], h.editFor({ line: 0, old: ['a', 'b'], new: [] }, 2)), ['']);
  // Lines replaced by more lines.
  assert.deepEqual(applyEdit(['a', 'b', 'c'], h.editFor({ line: 1, old: ['b'], new: ['x', 'y'] }, 3)), ['a', 'x', 'y', 'c']);
});

test('all hunks as one set of edits against the same text (accept all)', () => {
  const hunks = h.propose(1, OLD, FRESH);
  // An editor applies edits given against one state; from the bottom up is the same thing.
  let lines = AROUND.slice();
  for (const hunk of hunks.slice().sort((p, q) => q.line - p.line)) lines = applyEdit(lines, h.editFor(hunk, AROUND.length));
  assert.deepEqual(lines, ['top', ...FRESH, 'bottom']);
});

test('a hunk whose text was changed by hand no longer fits', () => {
  const [hunk] = h.propose(1, ['    return 1'], ['    return 10']);
  const lines = ['x', '    return 1'];
  assert.ok(h.stillFits(hunk, (i) => lines[i], lines.length));
  lines[1] = '    return 1  # edited';
  assert.ok(!h.stillFits(hunk, (i) => lines[i], lines.length));
  assert.ok(!h.stillFits({ line: 5, old: ['a'], new: [] }, (i) => lines[i], lines.length), 'past the end');
  assert.ok(h.stillFits({ line: 2, old: [], new: ['z'] }, (i) => lines[i], lines.length), 'adding after the last line');
  assert.ok(!h.stillFits({ line: 3, old: [], new: ['z'] }, (i) => lines[i], lines.length));
});

test('typing elsewhere moves the hunks below it; typing inside one drops it', () => {
  const hunks = [
    { id: 1, line: 2, old: ['b', 'c'], new: ['B'] },
    { id: 2, line: 8, old: [], new: ['added'] },
    { id: 3, line: 10, old: ['k'], new: [] },
  ];
  // A new line typed at the end of line 0.
  let out = h.afterChange(hunks, { startLine: 0, endLine: 0, newLineCount: 2 });
  assert.deepEqual(out.map((k) => k.line), [3, 9, 11]);
  // Two lines deleted between the first and the second hunk.
  out = h.afterChange(hunks, { startLine: 5, endLine: 7, newLineCount: 1 });
  assert.deepEqual(out.map((k) => [k.id, k.line]), [[1, 2], [2, 6], [3, 8]]);
  // A character typed inside the first hunk's lines.
  out = h.afterChange(hunks, { startLine: 3, endLine: 3, newLineCount: 1 });
  assert.deepEqual(out.map((k) => k.id), [2, 3]);
  // A change below everything.
  out = h.afterChange(hunks, { startLine: 20, endLine: 20, newLineCount: 3 });
  assert.deepEqual(out, hunks);
  // A deletion that swallows the place an addition was meant for.
  out = h.afterChange(hunks, { startLine: 7, endLine: 9, newLineCount: 1 });
  assert.deepEqual(out.map((k) => [k.id, k.line]), [[1, 2], [3, 8]]);
});

test('the lines a selection covers', () => {
  assert.deepEqual(h.wholeLines({ startLine: 3, endLine: 5, endCharacter: 4 }), { first: 3, last: 5 });
  assert.deepEqual(h.wholeLines({ startLine: 3, endLine: 6, endCharacter: 0 }), { first: 3, last: 5 }, 'not the line it only ends in front of');
  assert.deepEqual(h.wholeLines({ startLine: 3, endLine: 3, endCharacter: 0 }), { first: 3, last: 3 });
});

test('a text is split into lines whatever its line breaks', () => {
  assert.deepEqual(h.splitLines('a\r\nb\nc'), ['a', 'b', 'c']);
  assert.deepEqual(h.splitLines('a\n'), ['a', '']);
});
