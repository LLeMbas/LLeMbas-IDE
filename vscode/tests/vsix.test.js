'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { zip, unzip, crc32 } = require('../tools/zip');
const { tempDir } = require('./helpers');

const ROOT = path.join(__dirname, '..');
const REPO = path.join(ROOT, '..');
const VERSION = fs.readFileSync(path.join(REPO, 'VERSION'), 'utf8').trim();
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

/** Whether a text is well-formed XML as far as elements and attributes go; returns its elements. */
function elements(xml) {
  const out = [];
  const stack = [];
  const body = xml.replace(/^<\?xml[^?]*\?>\s*/, '');
  assert.ok(!/<\?|<!/.test(body), 'no processing instructions, doctypes or comments');
  const re = /<(\/?)([A-Za-z_][\w:.-]*)((?:\s+[\w:.-]+="[^"<]*")*)\s*(\/?)>|([^<]+)/g;
  let at = 0;
  for (let m; (m = re.exec(body)); ) {
    assert.equal(m.index, at, 'nothing unreadable at ' + at);
    at = re.lastIndex;
    if (m[5] !== undefined) {
      assert.ok(!/&(?!(amp|lt|gt|quot|apos);)/.test(m[5]), 'text is escaped');
      if (stack.length) stack[stack.length - 1].text += m[5];
      else assert.equal(m[5].trim(), '');
      continue;
    }
    if (m[1]) {
      assert.equal(stack.pop().name, m[2], 'closing tag matches');
      continue;
    }
    const attrs = {};
    for (const a of m[3].matchAll(/([\w:.-]+)="([^"]*)"/g)) attrs[a[1]] = a[2].replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
    const el = { name: m[2], attrs, text: '' };
    out.push(el);
    if (!m[4]) stack.push(el);
  }
  assert.equal(at, body.length);
  assert.equal(stack.length, 0, 'every element is closed');
  return out;
}

test('the archive writer and reader agree, and with the system\'s unzip', (t) => {
  const files = [
    { name: 'a.txt', data: Buffer.from('hello\n'.repeat(100)) },
    { name: 'dir/ž 🍞.bin', data: Buffer.from([0, 1, 2, 3, 255]) },
    { name: 'empty', data: Buffer.alloc(0) },
  ];
  const archive = zip(files);
  assert.deepEqual(unzip(archive).map((f) => [f.name, f.data.toString('hex')]), files.map((f) => [f.name, f.data.toString('hex')]));
  assert.ok(archive.equals(zip(files)), 'the same input gives the same archive');
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
  assert.throws(() => zip([{ name: '../x', data: Buffer.alloc(0) }]));
  assert.throws(() => zip([{ name: 'a', data: Buffer.alloc(0) }, { name: 'a', data: Buffer.alloc(0) }]));
  const damaged = Buffer.from(archive);
  damaged[40] ^= 0xff;
  assert.throws(() => unzip(damaged));
  if (spawnSync('unzip', ['-v']).status === 0) {
    const file = path.join(tempDir(t), 'x.zip');
    fs.writeFileSync(file, archive);
    assert.match(execFileSync('unzip', ['-t', file], { encoding: 'utf8' }), /No errors detected/);
  }
});

test('the package script builds a .vsix that is what an editor expects', (t) => {
  const out = tempDir(t);
  const said = execFileSync('sh', [path.join(REPO, 'scripts', 'package-vscode.sh'), out], { encoding: 'utf8' });
  const file = path.join(out, `llembas-${VERSION}.vsix`);
  assert.ok(said.startsWith(file + '\n'), said);
  const entries = unzip(fs.readFileSync(file));
  const names = entries.map((e) => e.name);
  const get = (name) => entries.find((e) => e.name === name).data.toString('utf8');

  // The three things a .vsix is.
  assert.ok(names.includes('[Content_Types].xml') && names.includes('extension.vsixmanifest') && names.includes('extension/package.json'));
  assert.ok(names.every((n) => n === '[Content_Types].xml' || n === 'extension.vsixmanifest' || n.startsWith('extension/')), 'nothing outside extension/');

  // The manifest: well-formed, and it says the repository's version and this extension's identity.
  const manifest = elements(get('extension.vsixmanifest'));
  assert.equal(manifest[0].name, 'PackageManifest');
  assert.equal(manifest[0].attrs.xmlns, 'http://schemas.microsoft.com/developer/vsx-schema/2011');
  const identity = manifest.find((e) => e.name === 'Identity');
  assert.deepEqual(identity.attrs, { Language: 'en-US', Id: 'llembas', Version: VERSION, Publisher: 'llembas' });
  assert.equal(manifest.find((e) => e.name === 'DisplayName').text, 'LLeMbas');
  const prop = (id) => manifest.find((e) => e.name === 'Property' && e.attrs.Id === id).attrs.Value;
  assert.equal(prop('Microsoft.VisualStudio.Code.Engine'), pkg.engines.vscode);
  assert.equal(prop('Microsoft.VisualStudio.Code.ExtensionKind'), 'workspace');
  assert.equal(manifest.find((e) => e.name === 'InstallationTarget').attrs.Id, 'Microsoft.VisualStudio.Code');
  const assets = manifest.filter((e) => e.name === 'Asset');
  assert.equal(assets.find((a) => a.attrs.Type === 'Microsoft.VisualStudio.Code.Manifest').attrs.Path, 'extension/package.json');
  for (const a of assets) assert.ok(names.includes(a.attrs.Path), `the asset ${a.attrs.Path} is in the package`);
  assert.ok(names.includes(manifest.find((e) => e.name === 'License').text));

  // The content types name every kind of file in the package.
  const types = elements(get('[Content_Types].xml'));
  assert.equal(types[0].attrs.xmlns, 'http://schemas.openxmlformats.org/package/2006/content-types');
  const known = new Set(types.filter((e) => e.name === 'Default').map((e) => e.attrs.Extension));
  for (const n of names) if (n !== '[Content_Types].xml') assert.ok(known.has(path.extname(n)), `a content type for ${n}`);

  // The packaged manifest of the extension: the version written in, everything it points at present.
  const packed = JSON.parse(get('extension/package.json'));
  assert.equal(packed.version, VERSION);
  assert.deepEqual({ ...packed, version: pkg.version }, pkg, 'otherwise the source manifest, unchanged');
  assert.ok(names.includes('extension/' + packed.main.replace(/^\.\//, '')));
  assert.ok(names.includes('extension/' + packed.contributes.viewsContainers.activitybar[0].icon));
  for (const need of ['extension/README.md', 'extension/LICENSE.txt', 'extension/media/chat.js', 'extension/media/chat.css', 'extension/src/rpc.js']) assert.ok(names.includes(need), need);
  assert.equal(get('extension/LICENSE.txt'), fs.readFileSync(path.join(REPO, 'LICENSE'), 'utf8'));

  // Every module the code asks for is in the package, or is Node's or the editor's own.
  for (const e of entries.filter((x) => x.name.endsWith('.js') && !x.name.startsWith('extension/media/'))) {
    for (const m of e.data.toString('utf8').matchAll(/require\('([^']+)'\)/g)) {
      if (m[1] === 'vscode' || m[1].startsWith('node:')) continue;
      assert.ok(m[1].startsWith('.'), `${e.name} asks for ${m[1]}: no outside packages`);
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(e.name), m[1])) + (m[1].endsWith('.js') ? '' : '.js');
      assert.ok(names.includes(target), `${e.name} asks for ${target}`);
    }
  }

  // What does not ship.
  assert.ok(!names.some((n) => /\/(tests|tools|node_modules)\//.test(n)), 'no tests, tools or packages');
  assert.ok(!names.some((n) => /fake_agent|\.test\.js$|\.vsix$/.test(n)));

  if (spawnSync('unzip', ['-v']).status === 0) {
    assert.match(execFileSync('unzip', ['-t', file], { encoding: 'utf8' }), /No errors detected/);
  }
});

test('the manifest in the source tree: no dependencies, no build, the version only in VERSION', () => {
  assert.equal(pkg.version, '0.0.0', 'a placeholder: the package script writes the real one');
  assert.match(VERSION, /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/);
  for (const key of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies', 'scripts', 'extensionDependencies']) {
    assert.equal(pkg[key], undefined, `no ${key}`);
  }
  assert.match(pkg.engines.vscode, /^\^1\.\d+\.0$/);
  assert.ok(pkg.activationEvents.length > 0);
  assert.equal(pkg.contributes.configuration.properties['llembas.command'].scope, 'machine', 'a folder cannot say which program is started');
  assert.equal(pkg.capabilities.untrustedWorkspaces.supported, false);
  for (const file of fs.readdirSync(ROOT, { recursive: true })) {
    if (!/\.(js|json|css|md|py)$/.test(file) || /node_modules/.test(file)) continue;
    if (file === path.join('tests', 'vsix.test.js')) continue;
    const text = fs.readFileSync(path.join(ROOT, file), 'utf8');
    assert.ok(!text.includes(VERSION), `${file} repeats the version`);
  }
});

test('every command, key and menu entry names a command the extension registers, and the other way round', () => {
  const source = fs.readFileSync(path.join(ROOT, 'extension.js'), 'utf8');
  const registered = new Set([...source.matchAll(/command\('(llembas\.[A-Za-z]+)'/g)].map((m) => m[1]));
  const contributed = new Set(pkg.contributes.commands.map((c) => c.command));
  assert.deepEqual([...registered].sort(), [...contributed].sort());
  for (const k of pkg.contributes.keybindings) assert.ok(contributed.has(k.command), k.command);
  for (const list of Object.values(pkg.contributes.menus)) for (const m of list) assert.ok(contributed.has(m.command), m.command);
  // Every setting the code reads is declared, and every declared setting is read.
  const read = new Set([...source.matchAll(/config\(\)\.get\('([A-Za-z.]+)'\)/g)].map((m) => 'llembas.' + m[1]));
  assert.deepEqual([...read].sort(), Object.keys(pkg.contributes.configuration.properties).sort());
  assert.ok(source.includes(`const VIEW_ID = '${pkg.contributes.views.llembas[0].id}'`));
});

test('the modules that are tested without an editor do not ask for one, and nothing reaches the network', () => {
  for (const dir of ['src', 'tools', 'media']) {
    for (const file of fs.readdirSync(path.join(ROOT, dir))) {
      if (!file.endsWith('.js')) continue;
      const text = fs.readFileSync(path.join(ROOT, dir, file), 'utf8');
      assert.ok(!/require\(['"]vscode['"]\)/.test(text), `${dir}/${file} must not import vscode`);
    }
  }
  for (const file of ['extension.js', ...fs.readdirSync(path.join(ROOT, 'src')).map((f) => 'src/' + f), 'media/chat.js']) {
    const text = fs.readFileSync(path.join(ROOT, file), 'utf8');
    for (const banned of ["require('node:http')", "require('node:https')", "require('node:net')", "require('http')", "require('https')", 'fetch(', 'XMLHttpRequest', 'WebSocket', 'telemetry', 'eval(', 'new Function']) {
      assert.ok(!text.includes(banned), `${file} must not use ${banned}`);
    }
  }
});
