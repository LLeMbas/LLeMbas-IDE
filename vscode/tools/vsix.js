#!/usr/bin/env node
'use strict';
// Builds the extension's .vsix without any packaging tool. A .vsix is a zip that holds
// `[Content_Types].xml`, `extension.vsixmanifest` and the extension itself under `extension/`.
// The version comes from the repository's VERSION file and is written into the packaged
// manifest; nothing in the source tree repeats it.
//
//   node vscode/tools/vsix.js [output directory]     (default: dist/)
const fs = require('node:fs');
const path = require('node:path');
const { zip } = require('./zip');

const ROOT = path.resolve(__dirname, '..');
const REPO = path.resolve(ROOT, '..');
// What ships: the code, the view's files and the read-me. Tests and tools stay behind.
const SHIPPED = ['extension.js', 'README.md', 'src', 'media'];
const SEMVER = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

function xml(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function walk(dir, base, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const full = path.join(dir, entry.name);
    const rel = base ? base + '/' + entry.name : entry.name;
    if (entry.isDirectory()) walk(full, rel, out);
    else if (entry.isFile()) out.push({ name: rel, data: fs.readFileSync(full) });
  }
  return out;
}

function manifestXml(pkg) {
  const kinds = Array.isArray(pkg.extensionKind) ? pkg.extensionKind.join(',') : 'workspace';
  return `<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011" xmlns:d="http://schemas.microsoft.com/developer/vsx-schema-design/2011">
  <Metadata>
    <Identity Language="en-US" Id="${xml(pkg.name)}" Version="${xml(pkg.version)}" Publisher="${xml(pkg.publisher)}" />
    <DisplayName>${xml(pkg.displayName || pkg.name)}</DisplayName>
    <Description xml:space="preserve">${xml(pkg.description || '')}</Description>
    <Tags>${xml((pkg.keywords || []).join(','))}</Tags>
    <Categories>${xml((pkg.categories || []).join(','))}</Categories>
    <GalleryFlags>Public</GalleryFlags>
    <Properties>
      <Property Id="Microsoft.VisualStudio.Code.Engine" Value="${xml(pkg.engines.vscode)}" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionDependencies" Value="" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionPack" Value="" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionKind" Value="${xml(kinds)}" />
      <Property Id="Microsoft.VisualStudio.Code.LocalizedLanguages" Value="" />
      <Property Id="Microsoft.VisualStudio.Services.GitHubFlavoredMarkdown" Value="true" />
      <Property Id="Microsoft.VisualStudio.Services.Content.Pricing" Value="Free" />
    </Properties>
    <License>extension/LICENSE.txt</License>
  </Metadata>
  <Installation>
    <InstallationTarget Id="Microsoft.VisualStudio.Code" />
  </Installation>
  <Dependencies />
  <Assets>
    <Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true" />
    <Asset Type="Microsoft.VisualStudio.Services.Content.Details" Path="extension/README.md" Addressable="true" />
    <Asset Type="Microsoft.VisualStudio.Services.Content.License" Path="extension/LICENSE.txt" Addressable="true" />
  </Assets>
</PackageManifest>
`;
}

const TYPES = {
  '.json': 'application/json',
  '.vsixmanifest': 'text/xml',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.md': 'text/markdown',
  '.txt': 'text/plain',
  '.svg': 'image/svg+xml',
};

function contentTypesXml(names) {
  const used = new Set(['.vsixmanifest']);
  for (const n of names) used.add(path.extname(n).toLowerCase());
  const lines = [];
  for (const ext of [...used].sort()) {
    if (!TYPES[ext]) throw new Error(`a file of a kind the package does not know: ${ext || '(no ending)'}`);
    lines.push(`<Default Extension="${ext}" ContentType="${TYPES[ext]}" />`);
  }
  return `<?xml version="1.0" encoding="utf-8"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">${lines.join('')}</Types>\n`;
}

/** The files of the archive, in order, and the manifest they were made from. */
function build(options) {
  const root = (options && options.root) || ROOT;
  const repo = (options && options.repo) || REPO;
  const version = fs.readFileSync(path.join(repo, 'VERSION'), 'utf8').trim();
  if (!SEMVER.test(version)) throw new Error(`VERSION is not a version: ${version}`);
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  pkg.version = version;
  const files = [{ name: 'package.json', data: Buffer.from(JSON.stringify(pkg, null, 2) + '\n') }];
  for (const item of SHIPPED) {
    const full = path.join(root, item);
    if (fs.statSync(full).isDirectory()) walk(full, item, files);
    else files.push({ name: item, data: fs.readFileSync(full) });
  }
  files.push({ name: 'LICENSE.txt', data: fs.readFileSync(path.join(repo, 'LICENSE')) });
  // Everything the manifest points at has to be in the package.
  const have = new Set(files.map((f) => f.name));
  const main = String(pkg.main || '').replace(/^\.\//, '');
  for (const need of [main, 'README.md', 'LICENSE.txt']) if (!have.has(need)) throw new Error('missing from the package: ' + need);
  const entries = [
    { name: 'extension.vsixmanifest', data: Buffer.from(manifestXml(pkg)) },
    { name: '[Content_Types].xml', data: Buffer.from(contentTypesXml(files.map((f) => f.name))) },
    ...files.map((f) => ({ name: 'extension/' + f.name, data: f.data })),
  ];
  return { pkg, version, entries, fileName: `${pkg.name}-${version}.vsix` };
}

function main() {
  const outDir = path.resolve(process.argv[2] || path.join(REPO, 'dist'));
  const built = build();
  fs.mkdirSync(outDir, { recursive: true });
  const out = path.join(outDir, built.fileName);
  const archive = zip(built.entries);
  fs.writeFileSync(out, archive);
  process.stdout.write(`${out}\n${built.entries.length} files, ${archive.length} bytes, version ${built.version}\n`);
}

if (require.main === module) {
  try {
    main();
  } catch (e) {
    process.stderr.write(`package-vscode: ${e.message}\n`);
    process.exit(1);
  }
}

module.exports = { build, manifestXml, contentTypesXml };
