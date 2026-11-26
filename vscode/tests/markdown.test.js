'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parse, parseInline, safeHref, Growing, MAX_CHARS } = require('../src/markdown');
const { chatHtml } = require('../src/webview');
const page = require('../media/chat.js');

// A document that can only do what the chat page is allowed to do: make elements and text.
// It has no way to parse markup, so a test that passes here cannot have used one.
class Node {
  constructor(tag, text) {
    this.tag = tag;
    this.text = text;
    this.children = [];
    this.attrs = {};
    this.className = '';
    this.listeners = {};
  }
  appendChild(c) {
    this.children.push(c);
    return c;
  }
  setAttribute(k, v) {
    this.attrs[k] = String(v);
  }
  addEventListener(name, fn) {
    this.listeners[name] = fn;
  }
  set textContent(v) {
    this.children = [new Node('#text', String(v))];
  }
  get textContent() {
    return this.tag === '#text' ? this.text : this.children.map((c) => c.textContent).join('');
  }
  all(out) {
    const list = out || [];
    for (const c of this.children) {
      list.push(c);
      c.all(list);
    }
    return list;
  }
  /** A picture of the tree, for comparing: text in quotes, elements as tag(children). */
  show() {
    if (this.tag === '#text') return JSON.stringify(this.text);
    return `${this.tag}(${this.children.map((c) => c.show()).join(' ')})`;
  }
}
const doc = { createElement: (tag) => new Node(tag), createTextNode: (text) => new Node('#text', text) };

function render(src) {
  const root = new Node('div');
  page.buildBlocks(doc, parse(src), root, 0);
  return root;
}
const ALLOWED = new Set(['#text', 'div', 'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'pre', 'code', 'hr', 'blockquote', 'ul', 'ol', 'li', 'strong', 'em', 'span', 'br']);

test('paragraphs, emphasis, code and line breaks', () => {
  assert.equal(render('Hello **bold** and *it* and `x < y`.\nnext').show(), 'div(p("Hello " strong("bold") " and " em("it") " and " code("x < y") "." br() "next"))');
  assert.equal(render('one\n\ntwo').show(), 'div(p("one") p("two"))');
  assert.equal(render('snake_case_name and 2 * 3 * 4').show(), 'div(p("snake_case_name and 2 * 3 * 4"))');
  assert.equal(render('__bold__ _it_ **a *b* c**').show(), 'div(p(strong("bold") " " em("it") " " strong("a " em("b") " c")))');
  assert.equal(render('\\*not\\* \\`code\\`').show(), 'div(p("*not* `code`"))');
});

test('headings, rules, quotes and lists', () => {
  assert.equal(render('# One\n## Two ##\n####### seven').show(), 'div(h1("One") h2("Two") p("####### seven"))');
  assert.equal(render('a\n\n---\n\nb').show(), 'div(p("a") hr() p("b"))');
  assert.equal(render('> quoted **text**\n> more\n\nafter').show(), 'div(blockquote(p("quoted " strong("text") br() "more")) p("after"))');
  const list = render('- one\n- two\n  - inner\n    still inner\n- three\n\n1. first\n2) second');
  assert.equal(list.show(), 'div(ul(li("one") li("two") li("inner" br() "still inner") li("three")) ol(li("first") li("second")))');
  assert.equal(list.children[0].children[2].className, 'depth-1');
});

test('a fenced block is text as written, and one still being written is a block already', () => {
  assert.equal(render('```python\nprint("<b>hi</b>")\n**not bold**\n```\nafter').show(), 'div(pre(code("print(\\"<b>hi</b>\\")\\n**not bold**")) p("after"))');
  assert.equal(render('text\n```js\nconst a = 1;').show(), 'div(p("text") pre(code("const a = 1;")))');
  assert.equal(parse('```js title="<x>"\n1\n```')[0].lang, 'js');
  assert.equal(render('~~~\na\n~~~').show(), 'div(pre(code("a")))');
});

test('a table is kept as written, in a block that scrolls on its own', () => {
  assert.equal(render('| a | b |\n|---|---|\n| 1 | 2 |').show(), 'div(pre(code("| a | b |\\n|---|---|\\n| 1 | 2 |")))');
});

test('markup a model writes is text, never elements', () => {
  const hostile = [
    '<script>alert(1)</script>',
    '<img src=x onerror=alert(1)>',
    'Click <a href="javascript:alert(1)">here</a>',
    '**<iframe src="https://example.org"></iframe>**',
    '# <style>body{display:none}</style>',
    '- <svg onload=alert(1)>',
    '> </div><script src="https://example.org/x.js"></script>',
    '```\n</code></pre><script>alert(1)</script>\n```',
    '`</code><script>alert(1)</script>`',
    '&lt;script&gt; &#60;b&#62;',
  ].join('\n\n');
  const root = render(hostile);
  const nodes = root.all();
  for (const n of nodes) assert.ok(ALLOWED.has(n.tag), `unexpected element: ${n.tag}`);
  for (const n of nodes) for (const k of Object.keys(n.attrs)) assert.ok(['role', 'tabindex', 'title', 'data-href'].includes(k), `unexpected attribute: ${k}`);
  // Every character the model wrote is still there, as text.
  const text = root.textContent;
  for (const piece of ['<script>alert(1)</script>', '<img src=x onerror=alert(1)>', 'javascript:alert(1)', '<iframe src="', '<svg onload=alert(1)>', '&lt;script&gt; &#60;b&#62;']) {
    assert.ok(text.includes(piece), `kept as text: ${piece}`);
  }
});

test('only http, https and mailto become links, and a link never navigates by itself', () => {
  const root = render(
    '[site](https://example.org/a?b=c) [mail](mailto:person@example.org) [bad](javascript:alert(1)) [data](data:text/html,<b>) [file](file:///etc/passwd) [vs](vscode://x) [cmd](command:workbench.action.terminal.new) bare https://example.org/path. and ![pic](https://example.org/p.png)',
  );
  const links = root.all().filter((n) => n.attrs['data-href']);
  assert.deepEqual(links.map((n) => n.attrs['data-href']), ['https://example.org/a?b=c', 'mailto:person@example.org', 'https://example.org/path', 'https://example.org/p.png']);
  for (const n of links) {
    assert.equal(n.tag, 'span', 'not an anchor: the extension is asked to open it');
    assert.equal(n.attrs.href, undefined);
    assert.equal(n.attrs.title, n.attrs['data-href'], 'the address is shown before it is opened');
  }
  assert.ok(!root.all().some((n) => n.tag === 'img' || n.tag === 'a'), 'a picture in a reply is a link, never loaded');
  const text = root.textContent;
  assert.ok(text.includes('[bad](javascript:alert(1))') && text.includes('[cmd](command:workbench.action.terminal.new)'));
});

test('what counts as a safe address', () => {
  for (const ok of ['https://example.org', 'http://192.0.2.7:8080/x?y#z', 'HTTPS://EXAMPLE.ORG/', 'mailto:a@example.org']) assert.equal(safeHref(ok), ok);
  for (const bad of ['javascript:alert(1)', ' https://example.org', 'https://exa mple.org', 'https://example.org/"onmouseover="x', 'data:text/html,x', 'file:///etc/passwd', 'command:x', 'vscode://file/x', '//example.org', 'https://', 'mailto:nobody', 'https://example.org/\u0000', 'ftp://example.org', '', null, 42, 'https://example.org/' + 'a'.repeat(3000)]) {
    assert.equal(safeHref(bad), null, String(bad));
  }
});

test('deeply nested or enormous input does not hang or overflow', () => {
  const deep = '*a '.repeat(2000) + ' b*'.repeat(2000);
  assert.ok(parseInline(deep).length > 0);
  assert.ok(parse('> '.repeat(500) + 'x').length > 0);
  assert.ok(parse('['.repeat(5000) + 'x' + ']'.repeat(5000) + '(https://example.org)').length > 0);
  const big = ('word '.repeat(20) + '\n').repeat(5000);
  const started = Date.now();
  parse(big);
  assert.ok(Date.now() - started < 2000);
  assert.deepEqual(parse(''), []);
  assert.deepEqual(parse(null), []);
});

test('hostile and very long replies are read in linear time', () => {
  const n = 200000;
  const cases = {
    'unclosed brackets': '['.repeat(n),
    'brackets with a far close': '[a '.repeat(n / 4) + ']',
    'unclosed emphasis': '*a '.repeat(n / 3),
    'unclosed double emphasis': '**a '.repeat(n / 4),
    'underscores': '_a '.repeat(n / 3),
    'mixed marks': '*_[`'.repeat(n / 4),
    'backtick runs of every length': Array.from({ length: 600 }, (_, i) => '`'.repeat(i + 1)).join(' '),
    'a heading of spaces and hashes': '# ' + ' #'.repeat(n / 2) + ' x',
    'a heading of spaces': '# a' + ' '.repeat(n) + 'b',
    'a rule that is not one': '- '.repeat(n / 2) + 'x',
    'one enormous line': 'word '.repeat(n / 5),
    'a list marker and spaces': '-' + ' '.repeat(n) + 'x',
    'links without an end': '[a](https://example.org/'.repeat(n / 24),
    'many paragraphs of marks': '*a [b `c\n\n'.repeat(n / 12),
    'quotes in quotes': '> '.repeat(n / 2) + 'x',
  };
  for (const [name, text] of Object.entries(cases)) {
    const started = process.hrtime.bigint();
    const blocks = parse(text);
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    assert.ok(ms < 1500, `${name}: ${Math.round(ms)} ms for ${text.length} characters`);
    assert.ok(blocks.length > 0, name);
  }
  // Nothing is lost when the budget runs out: the rest is text.
  const spent = parse('*a '.repeat(n / 3));
  const flatten = (nodes) => nodes.map((x) => (x.v !== undefined ? x.v : x.c ? flatten(x.c) : x.t === 'br' ? '\n' : '')).join('');
  assert.equal(flatten(spent), '*a '.repeat(n / 3));
});

test('a text beyond the limit is shown as it was written', () => {
  const big = '**x** <b>'.repeat(MAX_CHARS / 9 + 10);
  assert.deepEqual(parse(big), [{ t: 'plain', v: big }]);
  const root = render(big);
  assert.equal(root.show().slice(0, 30), 'div(div("**x** <b>**x** <b>**x');
  assert.equal(root.textContent, big);
});

test('a heading keeps its text and loses only a closing run of hashes', () => {
  assert.equal(render('## Two ##   ').show(), 'div(h2("Two"))');
  assert.equal(render('# C# and F#').show(), 'div(h1("C# and F#"))');
  assert.equal(render('# a # b').show(), 'div(h1("a # b"))');
  assert.equal(render('###### deep').show(), 'div(h6("deep"))');
  assert.equal(render('#notaheading').show(), 'div(p("#notaheading"))');
});

test('a reply read as it grows is read the same as the whole, and old text is not read again', () => {
  const reply = [
    '# Bread', '', 'Some **bold** text with `code` and a [link](https://example.org).', 'second line', '',
    '- one', '- two', '  - inner', '', '1. first', '2. second', '', '> quoted', '> more', '',
    '```python', 'def bake():', '', '    return "**not bold**"', '', '```', '', '| a | b |', '|---|---|', '', '---', '',
    'A last paragraph that ends without', 'a line break, then an open fence:', '', '~~~', 'still', '', 'open',
  ].join('\n');
  // Fed in pieces of every size, as a model sends it.
  for (const step of [1, 2, 3, 7, 19, 64, 1000]) {
    const growing = new Growing();
    for (let end = step; end < reply.length + step; end += step) {
      const part = reply.slice(0, end);
      assert.deepEqual(growing.update(part), parse(part), `step ${step}, ${end} characters`);
    }
  }
  // What is settled is kept: a long reply costs its tail each time, not the whole of it.
  const growing = new Growing();
  const para = 'word '.repeat(40) + '\n\n';
  growing.update(para.repeat(500) + 'the tail');
  assert.equal(growing.done, para.length * 500);
  assert.equal(growing.blocks.length, 500);
  const before = growing.blocks;
  const out = growing.update(para.repeat(500) + 'the tail grows');
  assert.equal(growing.blocks, before);
  assert.equal(out.length, 501);
  // Inside an open fence nothing is settled, however many blank lines it holds.
  const fenced = new Growing();
  fenced.update('intro\n\n```\na\n\nb\n\nc');
  assert.equal(fenced.done, 'intro\n\n'.length);
  // A text that is not a continuation starts over.
  assert.deepEqual(growing.update('new text'), parse('new text'));
});

test('an item of the transcript is drawn from its fields as text', () => {
  const posted = [];
  const post = (m) => posted.push(m);
  const card = page.renderItem(doc, {
    id: 'i7', kind: 'card', state: 'open', title: 'rm -rf <b>build</b>', tool: 'bash', reason: '<i>deletes</i> files', detail: '--- a\n+++ b',
    files: ['/p/a.py'], options: [{ optionId: 'once', name: 'Allow <once>', kind: 'allow_once' }, { optionId: 'deny', name: 'Deny', kind: 'reject_once' }],
  }, post);
  for (const n of card.all()) assert.ok(['#text', 'div', 'pre', 'button'].includes(n.tag), n.tag);
  assert.ok(card.textContent.includes('rm -rf <b>build</b>') && card.textContent.includes('<i>deletes</i> files'));
  const buttons = card.all().filter((n) => n.tag === 'button');
  assert.deepEqual(buttons.map((b) => b.textContent), ['Allow <once>', 'Deny', 'Show the change']);
  buttons[1].listeners.click();
  buttons[2].listeners.click();
  assert.deepEqual(posted, [{ type: 'answer', card: 'i7', option: 'deny' }, { type: 'showDiff', card: 'i7' }]);

  const closed = page.renderItem(doc, { id: 'i7', kind: 'card', state: 'answered', title: 't', answer: 'Deny', options: [{ optionId: 'once', name: 'Allow' }] }, post);
  assert.equal(closed.all().filter((n) => n.tag === 'button').length, 0, 'an answered card has no buttons');

  const user = page.renderItem(doc, { id: 'i1', kind: 'user', text: '<script>x</script>', label: 'a.py:1-2' }, post);
  assert.ok(user.textContent.includes('<script>x</script>') && user.textContent.includes('[a.py:1-2]'));
  assert.ok(!user.all().some((n) => n.tag === 'script'));

  const picture = page.renderItem(doc, { id: 'i2', kind: 'media', picture: true, src: 'https://file.example/1-chart.png', name: 'chart.png', sizeWords: '5 KB', key: 'm1' }, post);
  const img = picture.all().find((n) => n.tag === 'img');
  assert.equal(img.attrs.src, 'https://file.example/1-chart.png');
  assert.ok(picture.textContent.includes('chart.png (5 KB)'));
  const other = page.renderItem(doc, { id: 'i3', kind: 'media', picture: false, name: 'report.pdf', key: 'm2' }, post);
  assert.ok(!other.all().some((n) => n.tag === 'img'));
  const folder = other.all().find((n) => n.tag === 'button');
  assert.equal(folder.textContent, 'Show in folder', 'a file that may not be opened says so on its button');
  folder.listeners.click();
  assert.deepEqual(posted.pop(), { type: 'openMedia', key: 'm2' });
  const opens = page.renderItem(doc, { id: 'i5', kind: 'media', picture: false, name: 'report.pdf', key: 'm3', opens: true }, post);
  assert.equal(opens.all().find((n) => n.tag === 'button').textContent, 'Open');

  const unknown = page.renderItem(doc, { id: 'i4', kind: 'surprise<script>', text: 'x' }, post);
  assert.equal(unknown.children.length, 0);
  assert.equal(unknown.className, 'item surprisescript');
});

test("the page's script never parses markup and never evaluates text", () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'media', 'chat.js'), 'utf8');
  for (const banned of ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write', 'eval(', 'new Function', 'DOMParser', 'srcdoc', 'setTimeout("', "setTimeout('"]) {
    assert.ok(!src.includes(banned), `chat.js must not use ${banned}`);
  }
});

test('the page: a strict policy, one script with a nonce, nothing from elsewhere', () => {
  const html = chatHtml({ cspSource: 'https://file.example', nonce: 'abc123', scriptUri: 'https://file.example/media/chat.js', styleUri: 'https://file.example/media/chat.css' });
  const csp = /<meta http-equiv="Content-Security-Policy" content="([^"]+)">/.exec(html)[1];
  const rules = Object.fromEntries(csp.split('; ').map((r) => [r.split(' ')[0], r.split(' ').slice(1)]));
  assert.deepEqual(rules['default-src'], ["'none'"]);
  assert.deepEqual(rules['script-src'], ["'nonce-abc123'"]);
  assert.deepEqual(rules['style-src'], ['https://file.example']);
  assert.deepEqual(rules['img-src'], ['https://file.example']);
  assert.ok(!/unsafe-inline|unsafe-eval|\*|data:|blob:|http:/.test(csp));
  assert.equal((html.match(/<script/g) || []).length, 1);
  assert.match(html, /<script nonce="abc123" src="https:\/\/file\.example\/media\/chat\.js"><\/script>/);
  assert.ok(!/\son[a-z]+=/.test(html), 'no inline handlers');
  assert.ok(!/style=/.test(html), 'no inline styles');
  assert.throws(() => chatHtml({ cspSource: 'x', nonce: 'a"b', scriptUri: 's', styleUri: 't' }));
  // Real VSCodium passes space-separated CSP sources (e.g. "vscode-resource: https://*.vscode-cdn.net").
  const multi = chatHtml({
    cspSource: 'vscode-resource: https://file+.vscode-resource.vscode-cdn.net',
    nonce: 'abc123',
    scriptUri: 'https://file.example/media/chat.js',
    styleUri: 'https://file.example/media/chat.css',
  });
  assert.ok(multi.includes('style-src vscode-resource: https://file+.vscode-resource.vscode-cdn.net;'));
  assert.throws(() => chatHtml({ cspSource: "https://a.example; script-src 'unsafe-inline'", nonce: 'abc', scriptUri: 's', styleUri: 't' }));
});

test('the stylesheet takes every colour from the editor\'s theme', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'media', 'chat.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(css), 'no hex colours');
  assert.ok(!/\b(rgb|rgba|hsl|hsla)\(/.test(css), 'no colour functions');
  assert.ok(!/url\(|@import/.test(css), 'nothing loaded from a stylesheet');
  for (const m of css.matchAll(/(?:^|[;{\s])(color|background|background-color|border(?:-[a-z]+)*|outline)\s*:\s*([^;}]+)/g)) {
    const value = m[2].trim();
    if (/^(0|none|transparent|inherit)$/.test(value)) continue;
    const colourless = value.replace(/var\(--vscode-[A-Za-z0-9-]+(?:,\s*(?:transparent|var\(--vscode-[A-Za-z0-9-]+\)))?\)/g, '').replace(/\b(\d+(\.\d+)?(px|em)?|solid|transparent)\b/g, '').trim();
    assert.equal(colourless, '', `${m[1]}: ${value}`);
  }
});
