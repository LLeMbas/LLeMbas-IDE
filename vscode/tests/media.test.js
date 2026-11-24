'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { sniffPicture, sizeInWords, safeName, openable, fetchShown } = require('../src/media');

test('a picture is known by its bytes, not by its name or by what the agent calls it', () => {
  const pad = Buffer.alloc(16);
  assert.equal(sniffPicture(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), pad])).mime, 'image/png');
  assert.equal(sniffPicture(Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), pad])).ext, 'jpg');
  assert.equal(sniffPicture(Buffer.concat([Buffer.from('GIF89a'), pad])).mime, 'image/gif');
  assert.equal(sniffPicture(Buffer.concat([Buffer.from('RIFF\x10\x00\x00\x00WEBPVP8 '), pad])).mime, 'image/webp');
  assert.equal(sniffPicture(Buffer.concat([Buffer.from('\x00\x00\x00\x1cftypavif', 'latin1'), pad])).mime, 'image/avif');
  for (const not of ['<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>', '<!DOCTYPE html><html>', '%PDF-1.7 and more bytes', 'RIFF\x10\x00\x00\x00WAVEfmt ', 'short', '']) {
    assert.equal(sniffPicture(Buffer.from(not, 'latin1')), null, not);
  }
  assert.equal(sniffPicture(null), null);
});

test('sizes are said in words', () => {
  assert.equal(sizeInWords(1), '1 byte');
  assert.equal(sizeInWords(640), '640 bytes');
  assert.equal(sizeInWords(48211), '47 KB');
  assert.equal(sizeInWords(1.5 * 1024 * 1024), '1.5 MB');
  assert.equal(sizeInWords(64 * 1024 * 1024), '64 MB');
  assert.equal(sizeInWords(3 * 1024 * 1024 * 1024), '3.0 GB');
});

test('a file name is made harmless', () => {
  assert.equal(safeName('out/chart.png'), 'chart.png');
  assert.equal(safeName('C:\\Users\\person\\shot 1.PNG'), 'shot_1.PNG');
  assert.equal(safeName('../../.bashrc'), 'bashrc');
  assert.equal(safeName('a/b/"; rm -rf ~ #.txt'), '___rm_-rf____.txt');
  assert.equal(safeName('', 'bin'), 'file.bin');
  assert.equal(safeName('noext', 'png'), 'noext.png');
  assert.ok(safeName('x'.repeat(500) + '.png').length <= 80);
});

const bytes = (text) => Buffer.concat([Buffer.from(text, 'latin1'), Buffer.alloc(16, 0x20)]);
const PNG_HEAD = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16)]);

test('Open is an allow-list: only kinds that are merely displayed, and only when bytes and name agree', () => {
  // What opens, and where.
  assert.deepEqual(openable(PNG_HEAD, 'chart.png'), { kind: 'image', how: 'editor' });
  assert.deepEqual(openable(bytes('\xff\xd8\xff\xe0'), 'photo.JPEG'), { kind: 'image', how: 'editor' });
  assert.deepEqual(openable(bytes('%PDF-1.7\n'), '/tmp/x/report.pdf'), { kind: 'pdf', how: 'system' });
  assert.deepEqual(openable(bytes('ID3\x04\x00'), 'song.mp3'), { kind: 'audio', how: 'system' });
  assert.deepEqual(openable(bytes('RIFF\x10\x00\x00\x00WAVEfmt '), 'beep.wav'), { kind: 'audio', how: 'system' });
  assert.deepEqual(openable(bytes('OggS\x00'), 'voice.ogg'), { kind: 'audio', how: 'system' });
  assert.deepEqual(openable(bytes('\x00\x00\x00\x20ftypisom'), 'clip.mp4'), { kind: 'video', how: 'system' });
  assert.deepEqual(openable(bytes('\x1a\x45\xdf\xa3'), 'clip.webm'), { kind: 'video', how: 'system' });
  assert.deepEqual(openable(Buffer.from('a,b\n1,2\n'), 'data.csv'), { kind: 'text', how: 'editor' }, 'plain text opens inside the editor, never in a spreadsheet');
  assert.deepEqual(openable(Buffer.from('žluťoučký 🍞\n'), 'notes.txt'), { kind: 'text', how: 'editor' });
  assert.deepEqual(openable(Buffer.from('abc 🍞').subarray(0, 6), 'cut.md'), { kind: 'text', how: 'editor' }, 'a window that ends inside a character');

  // Everything the review named, and the rest of what a system might run: never opened.
  const script = Buffer.from('#!/bin/sh\necho run\n');
  for (const name of ['run.sh', 'tool.py', 'tool.pyw', 'help.chm', 'console.msc', 'page.mht', 'app.jnlp', 'letter.docm', 'sheet.xlsm', 'mod.psm1', 'x.ws',
    'setup.application', 'a.settingcontent-ms', 'fix.diagcab', 'setup.exe', 'a.desktop', 'page.html', 'pic.svg', 'x.jar', 'x.AppImage', 'link.lnk', 'site.url', 'noending', 'a.unknownkind']) {
    assert.equal(openable(script, name), null, name);
    assert.equal(openable(PNG_HEAD, name), null, name + ' with a picture inside');
  }
  // A name that lies about its bytes, either way round.
  assert.equal(openable(script, 'report.pdf'), null, 'not a PDF inside');
  assert.equal(openable(bytes('%PDF-1.7\n'), 'report.txt'), null, 'a PDF called text');
  assert.equal(openable(bytes('MZ\x90\x00\x03\x00\x00\x00'), 'song.mp3'), null, 'a program called a song');
  assert.equal(openable(PNG_HEAD, 'chart.gif'), null);
  assert.equal(openable(Buffer.from([0x74, 0x65, 0x00, 0x78, 0x74]), 'notes.txt'), null, 'text does not hold a zero byte');
  assert.equal(openable(Buffer.from([0xff, 0xfe, 0x41, 0x00]), 'notes.txt'), null);
  assert.equal(openable(Buffer.alloc(0), 'notes.txt'), null);
  assert.equal(openable(null, 'notes.txt'), null);
});

function reader(bytes, part) {
  const calls = [];
  const read = async (p) => {
    calls.push(p);
    const chunk = bytes.subarray(p.offset, p.offset + Math.min(p.length, part));
    return { data: chunk.toString('base64'), offset: p.offset, eof: p.offset + chunk.length >= bytes.length };
  };
  return { read, calls };
}

test('a file is read part by part to its end and checked', async () => {
  const bytes = crypto.randomBytes(10500);
  const hash = 'sha256:' + crypto.createHash('sha256').update(bytes).digest('hex');
  const { read, calls } = reader(bytes, 4000);
  const got = await fetchShown(read, { handle: 'h_1', size: bytes.length, hash }, { maxBytes: 1e6 });
  assert.ok(got.equals(bytes));
  assert.deepEqual(calls.map((c) => c.offset), [0, 4000, 8000]);
  assert.ok(calls.every((c) => c.handle === 'h_1' && c.length === 1024 * 1024));
});

test('too large, cut short, the wrong size or the wrong checksum are refused in words', async () => {
  const bytes = crypto.randomBytes(5000);
  const { read, calls } = reader(bytes, 1000);
  await assert.rejects(fetchShown(read, { handle: 'h', size: 5000 }, { maxBytes: 4096 }), /The file is 5 KB; this editor takes files of up to 4 KB\./);
  assert.equal(calls.length, 0, 'a size over the limit is refused before anything is read');
  // The agent named no size, or a false one: the limit holds while reading.
  await assert.rejects(fetchShown(read, { handle: 'h' }, { maxBytes: 2500 }), /this editor takes files of up to 2 KB/);
  await assert.rejects(fetchShown(read, { handle: 'h', size: 100 }, { maxBytes: 1e6 }), /arrived as 5 KB, not the 100 bytes/);
  await assert.rejects(fetchShown(read, { handle: 'h', hash: 'sha256:' + 'a'.repeat(64) }, { maxBytes: 1e6 }), /checksum differs/);
  await assert.rejects(fetchShown(async () => ({ data: '', eof: false }), { handle: 'h' }, { maxBytes: 1e6 }), /stopped sending/);
  await assert.rejects(fetchShown(async () => ({}), { handle: 'h' }, { maxBytes: 1e6 }), /sent no data/);
  await assert.rejects(fetchShown(async () => { throw new Error('This file is no longer offered.'); }, { handle: 'h' }, { maxBytes: 1e6 }), /no longer offered/);
});
