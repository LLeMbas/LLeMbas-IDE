'use strict';
// LLeMbas in VS Code and VSCodium. The agent is the LLeMbas CLI, unchanged: this extension
// starts `lembas serve --stdio` and is its client (Agent Client Protocol, version 1). The
// sign-in, the models, the tools and the permissions are the CLI's; the only thing set here is
// which command starts it.
//
// This file is the glue to the editor. Everything that can be tested without an editor lives
// in src/ and never imports `vscode`.
const vscode = require('vscode');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { Agent } = require('./src/agent');
const { Chat } = require('./src/chat');
const { Completer, windowAround } = require('./src/completion');
const { editorContext, selectionLabel, sliceLines } = require('./src/context');
const hunksOf = require('./src/hunks');
const markdown = require('./src/markdown');
const media = require('./src/media');
const { chatHtml } = require('./src/webview');

const DIFF_SCHEME = 'llembas-diff';
const VIEW_ID = 'llembas.chat';

function config() {
  return vscode.workspace.getConfiguration('llembas');
}

/** The folder the agent works in: the first folder of the window, else the open file's, else home. */
function workingDirectory() {
  for (const f of vscode.workspace.workspaceFolders || []) if (f.uri.scheme === 'file') return f.uri.fsPath;
  const active = vscode.window.activeTextEditor;
  if (active && active.document.uri.scheme === 'file') return path.dirname(active.document.uri.fsPath);
  return os.homedir();
}

function samePath(a, b) {
  const x = path.normalize(a);
  const y = path.normalize(b);
  return process.platform === 'win32' ? x.toLowerCase() === y.toLowerCase() : x === y;
}

function say(e) {
  const text = String((e && e.message) || e || 'it failed').trim();
  return 'LLeMbas: ' + text + (/[.!?…]$/.test(text) ? '' : '.');
}

// ---- texts shown in a diff view ----------------------------------------------------------

class DiffTexts {
  constructor() {
    this.texts = new Map(); // uri path -> string | () => string
    this.changed = new vscode.EventEmitter();
    this.onDidChange = this.changed.event;
  }

  uri(key, name) {
    const safe = media.safeName(name) || 'text';
    return vscode.Uri.from({ scheme: DIFF_SCHEME, path: `/${key}/${safe}` });
  }

  set(uri, text) {
    this.texts.set(uri.path, text);
    this.changed.fire(uri);
  }

  dropUnder(prefix) {
    for (const key of [...this.texts.keys()]) if (key.startsWith(prefix)) this.texts.delete(key);
  }

  provideTextDocumentContent(uri) {
    const t = this.texts.get(uri.path);
    return typeof t === 'function' ? t() : t || '';
  }
}

async function closeDiffTabs(prefix) {
  const tabs = [];
  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      const input = tab.input;
      if (input instanceof vscode.TabInputTextDiff && input.modified.scheme === DIFF_SCHEME && input.modified.path.startsWith(prefix)) tabs.push(tab);
    }
  }
  if (tabs.length) await vscode.window.tabGroups.close(tabs, true);
}

// ---- a rewrite, shown before it is made --------------------------------------------------

class Proposals {
  constructor(texts) {
    this.texts = texts;
    this.byDoc = new Map(); // document uri string -> { uri, hunks, n }
    this.applying = false;
    this.count = 0;
    this.lensChanged = new vscode.EventEmitter();
    this.onDidChangeCodeLenses = this.lensChanged.event;
    this.removed = vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      backgroundColor: new vscode.ThemeColor('diffEditor.removedLineBackground'),
      overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.modifiedForeground'),
      overviewRulerLane: vscode.OverviewRulerLane.Left,
    });
    this.added = vscode.window.createTextEditorDecorationType({
      overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.addedForeground'),
      overviewRulerLane: vscode.OverviewRulerLane.Left,
    });
  }

  entry(doc) {
    return this.byDoc.get(doc.uri.toString());
  }

  pending(doc) {
    const e = doc && this.entry(doc);
    return e ? e.hunks.length : 0;
  }

  set(doc, hunks) {
    const n = ++this.count;
    const entry = { uri: doc.uri, hunks, n, proposal: null };
    entry.proposal = this.texts.uri(`proposal/${n}`, path.basename(doc.uri.path) || 'untitled');
    this.texts.set(entry.proposal, () => {
      const lines = [];
      for (let i = 0; i < doc.lineCount; i++) lines.push(doc.lineAt(i).text);
      return hunksOf.withAll(lines, entry.hunks).join(doc.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n');
    });
    this.byDoc.set(doc.uri.toString(), entry);
    this.refresh(doc);
    return entry;
  }

  clear(doc) {
    const entry = this.entry(doc);
    if (!entry) return;
    this.byDoc.delete(doc.uri.toString());
    this.texts.dropUnder(`/proposal/${entry.n}/`);
    closeDiffTabs(`/proposal/${entry.n}/`).then(undefined, () => {});
    this.refresh(doc);
  }

  refresh(doc) {
    const entry = this.entry(doc);
    if (entry && entry.hunks.length === 0) return this.clear(doc);
    if (entry) this.texts.changed.fire(entry.proposal);
    this.lensChanged.fire();
    for (const editor of vscode.window.visibleTextEditors) if (editor.document === doc) this.decorate(editor);
    const active = vscode.window.activeTextEditor;
    vscode.commands.executeCommand('setContext', 'llembas.hasProposal', !!(active && this.pending(active.document)));
  }

  decorate(editor) {
    const entry = this.entry(editor.document);
    const removed = [];
    const added = [];
    const doc = editor.document;
    for (const h of entry ? entry.hunks : []) {
      const anchor = Math.min(Math.max(0, h.old.length ? h.line + h.old.length - 1 : h.line), doc.lineCount - 1);
      const hover = new vscode.MarkdownString();
      hover.appendText(h.new.length ? 'LLeMbas proposes here:\n' : 'LLeMbas proposes to take these lines away.');
      if (h.new.length) hover.appendCodeblock(h.new.join('\n').replace(/```/g, '`​``'), doc.languageId);
      if (h.old.length) {
        removed.push({ range: new vscode.Range(h.line, 0, h.line + h.old.length - 1, 0), hoverMessage: hover });
      }
      const first = h.new.length ? h.new[0].replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 100) : '';
      const more = h.new.length > 1 ? ` (+${h.new.length - 1} more line${h.new.length > 2 ? 's' : ''})` : '';
      const what = h.new.length === 0 ? 'taken away' : (h.old.length ? '→ ' : h.line >= doc.lineCount ? 'added below: ' : 'added above: ') + first + more;
      added.push({
        range: new vscode.Range(anchor, 0, anchor, 0),
        hoverMessage: hover,
        renderOptions: {
          after: {
            contentText: what,
            margin: '0 0 0 2em',
            color: new vscode.ThemeColor('editorGhostText.foreground'),
            backgroundColor: new vscode.ThemeColor('diffEditor.insertedTextBackground'),
          },
        },
      });
    }
    editor.setDecorations(this.removed, removed);
    editor.setDecorations(this.added, added);
  }

  provideCodeLenses(doc) {
    const entry = this.entry(doc);
    if (!entry) return [];
    const out = [];
    const uri = doc.uri.toString();
    const ordered = entry.hunks.slice().sort((a, b) => a.line - b.line);
    ordered.forEach((h, i) => {
      const line = Math.min(h.line, doc.lineCount - 1);
      const range = new vscode.Range(line, 0, line, 0);
      out.push(new vscode.CodeLens(range, { title: 'Accept', command: 'llembas.acceptChange', arguments: [uri, h.id] }));
      out.push(new vscode.CodeLens(range, { title: 'Reject', command: 'llembas.rejectChange', arguments: [uri, h.id] }));
      if (i === 0) {
        if (ordered.length > 1) {
          out.push(new vscode.CodeLens(range, { title: `Accept all ${ordered.length}`, command: 'llembas.acceptAllChanges', arguments: [uri] }));
          out.push(new vscode.CodeLens(range, { title: 'Reject all', command: 'llembas.rejectAllChanges', arguments: [uri] }));
        }
        out.push(new vscode.CodeLens(range, { title: 'Show as a diff', command: 'llembas.showChanges', arguments: [uri] }));
      }
    });
    return out;
  }

  /** The document a command means: the one a code lens named, else the one in front. */
  docFor(uri) {
    if (typeof uri === 'string') return vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri);
    const active = vscode.window.activeTextEditor;
    return active && active.document;
  }

  /** The hunk a command means: the one a code lens named, else the one at or below the cursor. */
  hunkFor(doc, id) {
    const entry = this.entry(doc);
    if (!entry) return undefined;
    if (id !== undefined) return entry.hunks.find((h) => h.id === id);
    const active = vscode.window.activeTextEditor;
    const cur = active && active.document === doc ? active.selection.active.line : 0;
    const ordered = entry.hunks.slice().sort((a, b) => a.line - b.line);
    return ordered.find((h) => cur <= h.line + Math.max(h.old.length, 1) - 1) || ordered[ordered.length - 1];
  }

  async accept(doc, wanted) {
    const entry = this.entry(doc);
    if (!entry) return;
    const lineAt = (i) => doc.lineAt(i).text;
    const fits = wanted.filter((h) => hunksOf.stillFits(h, lineAt, doc.lineCount));
    const stale = wanted.filter((h) => !fits.includes(h));
    const eol = doc.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
    const at = (p) => (p.end ? doc.lineAt(p.line).range.end : new vscode.Position(p.line, 0));
    const edit = new vscode.WorkspaceEdit();
    for (const h of fits) {
      const e = hunksOf.editFor(h, doc.lineCount);
      edit.replace(doc.uri, new vscode.Range(at(e.start), at(e.stop)), e.text.replace(/\n/g, eol));
    }
    let ok = true;
    if (fits.length) {
      this.applying = true;
      try {
        ok = await vscode.workspace.applyEdit(edit);
      } finally {
        this.applying = false;
      }
    }
    if (ok) {
      // From the bottom up, so every hunk still waiting keeps a true line number.
      for (const h of fits.slice().sort((a, b) => b.line - a.line)) entry.hunks = hunksOf.afterAccept(entry.hunks, h);
    }
    entry.hunks = entry.hunks.filter((h) => !stale.some((s) => s.id === h.id));
    this.refresh(doc);
    if (!ok) vscode.window.showWarningMessage('LLeMbas: the editor did not take the change.');
    else if (stale.length) {
      vscode.window.showWarningMessage(
        `LLeMbas: the text changed where ${stale.length === 1 ? 'a change was' : stale.length + ' changes were'} proposed; ${stale.length === 1 ? 'it was' : 'they were'} dropped.`,
      );
    }
  }

  reject(doc, wanted) {
    const entry = this.entry(doc);
    if (!entry) return;
    entry.hunks = entry.hunks.filter((h) => !wanted.includes(h));
    this.refresh(doc);
  }

  /** Somebody typed in a document that has proposals. */
  documentChanged(ev) {
    if (this.applying) return;
    const entry = this.entry(ev.document);
    if (!entry) return;
    const changes = ev.contentChanges.slice().sort((a, b) => b.range.start.line - a.range.start.line);
    for (const c of changes) {
      entry.hunks = hunksOf.afterChange(entry.hunks, {
        startLine: c.range.start.line,
        endLine: c.range.end.line,
        newLineCount: c.text.split('\n').length,
      });
    }
    this.refresh(ev.document);
  }

  async showDiff(doc) {
    const entry = this.entry(doc);
    if (!entry) return;
    await vscode.commands.executeCommand('vscode.diff', doc.uri, entry.proposal, `LLeMbas: ${path.basename(doc.uri.path)} (proposed)`, {
      preview: true,
      preserveFocus: true,
      viewColumn: vscode.ViewColumn.Beside,
    });
  }
}

// ---- the chat view -----------------------------------------------------------------------

class ChatView {
  constructor(context, chat, shown, actions) {
    this.context = context;
    this.chat = chat;
    this.shown = shown; // key -> a file the agent showed
    this.actions = actions;
    this.view = undefined;
    this.attached = null; // { editor, label }
    this.dirty = new Map();
    this.timer = null;
    chat.on('item', (item) => this.queue(item));
    chat.on('reset', () => this.reset());
    chat.on('state', () => this.post({ type: 'state', state: chat.state() }));
  }

  resolveWebviewView(view) {
    this.view = view;
    const webview = view.webview;
    webview.options = {
      enableScripts: true,
      enableCommandUris: false,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media'), vscode.Uri.file(this.actions.mediaDir)],
    };
    webview.html = chatHtml({
      cspSource: webview.cspSource,
      nonce: crypto.randomBytes(18).toString('base64url'),
      scriptUri: webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'chat.js')).toString(),
      styleUri: webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'chat.css')).toString(),
    });
    webview.onDidReceiveMessage((m) => this.receive(m));
    view.onDidDispose(() => {
      if (this.view === view) this.view = undefined;
    });
  }

  post(message) {
    if (this.view) this.view.webview.postMessage(message).then(undefined, () => {});
  }

  /** An item as the page is given it: a model's text as a tree, a picture as an address the page may load. */
  present(item) {
    if (item.kind === 'agent') return { id: item.id, kind: 'agent', ast: markdown.parse(item.text) };
    if (item.kind === 'media') {
      const entry = this.shown.get(item.key);
      const src = item.picture && entry && entry.file && this.view ? this.view.webview.asWebviewUri(vscode.Uri.file(entry.file)).toString() : '';
      return { ...item, src, sizeWords: item.size ? media.sizeInWords(item.size) : '' };
    }
    return item;
  }

  queue(item) {
    // A reply arrives in many small pieces; the page is told at most twenty times a second.
    this.dirty.set(item.id, item);
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      const items = [...this.dirty.values()];
      this.dirty.clear();
      for (const it of items) this.post({ type: 'item', item: this.present(it) });
    }, 50);
  }

  reset() {
    this.dirty.clear();
    this.post({
      type: 'reset',
      items: this.chat.items.map((i) => this.present(i)),
      state: this.chat.state(),
      attached: this.attached ? this.attached.label : '',
    });
  }

  attach(attached) {
    this.attached = attached;
    this.post({ type: 'attached', label: attached ? attached.label : '' });
  }

  /** Bring the view forward. `keepFocus`: without taking the keyboard from the editor. */
  async reveal(focusPrompt, keepFocus) {
    if (keepFocus && this.view) return this.view.show(true);
    await vscode.commands.executeCommand(VIEW_ID + '.focus');
    if (focusPrompt) this.post({ type: 'focus' });
    return undefined;
  }

  receive(m) {
    if (!m || typeof m !== 'object' || typeof m.type !== 'string') return;
    const a = this.actions;
    switch (m.type) {
      case 'ready':
        return this.reset();
      case 'send':
        if (typeof m.text === 'string' && m.text.trim() && m.text.length <= 1000000) a.sendTyped(m.text);
        return undefined;
      case 'stop':
        return this.chat.stop();
      case 'new':
        return a.newSession();
      case 'detach':
        return this.attach(null);
      case 'setMode':
        if (typeof m.id === 'string') a.guard(this.chat.setMode(m.id));
        return undefined;
      case 'setModel':
        if (typeof m.id === 'string') a.guard(this.chat.setModel(m.id));
        return undefined;
      case 'answer':
        if (typeof m.card === 'string' && typeof m.option === 'string') this.chat.answer(m.card, m.option);
        return undefined;
      case 'showDiff':
        if (typeof m.card === 'string') this.chat.reshow(m.card);
        return undefined;
      case 'openLink': {
        // The page is not trusted with the decision: the address is checked again here.
        const href = markdown.safeHref(m.href);
        if (href) vscode.env.openExternal(vscode.Uri.parse(href, true));
        return undefined;
      }
      case 'openFile':
        if (typeof m.path === 'string' && path.isAbsolute(m.path)) {
          vscode.window.showTextDocument(vscode.Uri.file(m.path), { preview: true }).then(undefined, (e) => vscode.window.showWarningMessage(say(e)));
        }
        return undefined;
      case 'openMedia':
        if (typeof m.key === 'string') a.openShown(m.key);
        return undefined;
      default:
        return undefined;
    }
  }
}

// ---- activation --------------------------------------------------------------------------

let chat = null;
let mediaDir = null;

function activate(context) {
  const output = vscode.window.createOutputChannel('LLeMbas');
  context.subscriptions.push(output);
  mediaDir = fs.mkdtempSync(path.join(os.tmpdir(), 'llembas-vscode-'));
  const version = String((context.extension && context.extension.packageJSON && context.extension.packageJSON.version) || '0');
  const windowModel = { autocomplete: undefined, main: undefined }; // the quick switch: this window only, saved nowhere
  const shown = new Map();
  let shownCount = 0;
  let rewrites = 0;

  const texts = new DiffTexts();
  const proposals = new Proposals(texts);
  context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider(DIFF_SCHEME, texts));

  // ---- the agent's questions to the editor ----

  const hooks = {
    /** ACP `fs/read_text_file`: a file open here is answered from the editor, saved or not. */
    readTextFile(p) {
      if (!p || typeof p.path !== 'string' || !path.isAbsolute(p.path)) throw { code: -32602, message: 'an absolute path is needed' };
      const doc = vscode.workspace.textDocuments.find((d) => d.uri.scheme === 'file' && samePath(d.uri.fsPath, p.path));
      // A file that is not open is the agent's to read from the disk itself, under its own permissions.
      if (!doc) throw { code: -32002, message: 'not open in the editor: ' + p.path };
      return { content: sliceLines(doc.getText(), p.line, p.limit) };
    },

    /** An approval card that carries diffs: each opens in the editor's own diff view before the answer. */
    showDiffs(cardId, diffs) {
      diffs.slice(0, 8).forEach((d, i) => {
        const name = path.basename(d.path) || 'file';
        const left = texts.uri(`card/${cardId}/${i}/now`, name);
        const right = texts.uri(`card/${cardId}/${i}/proposed`, name);
        texts.set(left, d.oldText === null ? '' : d.oldText);
        texts.set(right, d.newText);
        const what = d.deleted ? 'would be deleted' : d.oldText === null ? 'would be created' : 'proposed change';
        vscode.commands
          .executeCommand('vscode.diff', left, right, `LLeMbas: ${name} (${what})`, { preview: false, preserveFocus: true })
          .then(undefined, (e) => output.appendLine('diff: ' + e));
      });
    },

    closeDiffs(cardId) {
      texts.dropUnder(`/card/${cardId}/`);
      closeDiffTabs(`/card/${cardId}/`).then(undefined, () => {});
    },

    /** `_lembas/show` with a handle: fetch the file, find out what it is, keep it for the chat. */
    async showMedia(p, read) {
      const megabytes = Math.max(1, Math.min(64, Number(config().get('media.maxMegabytes')) || 64));
      const got = await media.receiveShown(p, read, { dir: mediaDir, maxBytes: megabytes * 1024 * 1024 });
      if (!got.ok) return got;
      const key = 'm' + ++shownCount;
      shown.set(key, got);
      return { ...got, key };
    },

    /** `_lembas/show` with text: opened as a document. HTML is opened as its text, never drawn. */
    async showText(p) {
      const file = typeof p.path === 'string' && p.path ? path.resolve(workingDirectory(), p.path) : '';
      const line = Number.isInteger(p.line) && p.line > 0 ? p.line - 1 : 0;
      try {
        let doc;
        if (file && fs.existsSync(file)) doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
        else doc = await vscode.workspace.openTextDocument({ content: String(p.text) });
        const at = new vscode.Position(Math.min(line, doc.lineCount - 1), 0);
        await vscode.window.showTextDocument(doc, { preview: true, preserveFocus: true, selection: new vscode.Range(at, at) });
        return { shown: true };
      } catch (e) {
        return { shown: false, reason: 'The editor could not open it: ' + e.message };
      }
    },
  };

  chat = new Chat({
    makeAgent: (o) =>
      new Agent({
        command: String(config().get('command') || 'lembas'),
        args: ['serve', '--stdio'],
        cwd: o.cwd,
        onRequest: o.onRequest,
        clientInfo: { name: 'llembas-vscode', version },
      }),
    cwd: workingDirectory,
    options: () => ({
      mode: String(config().get('chat.startMode') || '') || undefined,
      model: windowModel.main,
      showThoughts: !!config().get('chat.showThinking'),
    }),
    hooks,
  });
  chat.on('stderr', (text) => output.append(text));
  context.subscriptions.push({ dispose: () => chat.dispose() });

  const guard = (promise) => Promise.resolve(promise).then(undefined, (e) => vscode.window.showErrorMessage(say(e)));

  // ---- what the editor shows, told to the agent ----

  function seen(editor, needSelection) {
    if (!editor) return null;
    const doc = editor.document;
    const file = doc.uri.scheme === 'file' ? doc.uri.fsPath : undefined;
    const sel = editor.selection;
    const out = { path: file, cursorLine: sel.active.line + 1, open: [] };
    let first = sel.active.line;
    let last = sel.active.line;
    if (!sel.isEmpty) {
      const lines = hunksOf.wholeLines({ startLine: sel.start.line, endLine: sel.end.line, endCharacter: sel.end.character });
      first = lines.first;
      last = lines.last;
      out.selection = { start: first + 1, end: last + 1, text: doc.getText(sel) };
    } else if (needSelection) {
      return null;
    }
    const severity = ['error', 'warning', 'info', 'hint'];
    out.diagnostics = vscode.languages
      .getDiagnostics(doc.uri)
      .filter((d) => (sel.isEmpty ? d.severity <= vscode.DiagnosticSeverity.Warning : d.range.end.line >= first && d.range.start.line <= last))
      .sort((a, b) => a.severity - b.severity || a.range.start.line - b.range.start.line)
      .map((d) => ({ line: d.range.start.line + 1, severity: severity[d.severity] || 'info', message: d.message, source: d.source }));
    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        if (tab.input instanceof vscode.TabInputText && tab.input.uri.scheme === 'file') out.open.push(tab.input.uri.fsPath);
      }
    }
    const name = file ? vscode.workspace.asRelativePath(doc.uri, false) : 'untitled';
    return { editor: editorContext(out), label: out.selection ? selectionLabel(name, first + 1, last + 1) : '' };
  }

  // ---- the chat ----

  const actions = {
    mediaDir,
    guard,
    async sendTyped(text) {
      if (chat.busy) return vscode.window.showWarningMessage('LLeMbas is still working on the last message. Stop it first.');
      let w = view.attached;
      if (!w && config().get('chat.sendEditorContext') && !text.startsWith('/')) w = seen(vscode.window.activeTextEditor, false);
      view.attach(null);
      return chat.send(text, w ? { editor: w.editor, label: w.label } : undefined);
    },
    async newSession() {
      if (!(await chat.newSession())) vscode.window.showWarningMessage('LLeMbas is working. Stop it first.');
    },
    async openShown(key) {
      const entry = shown.get(key);
      if (!entry) return;
      if (entry.picture && entry.file) return vscode.commands.executeCommand('vscode.open', vscode.Uri.file(entry.file));
      const target = entry.original || entry.file;
      if (!target) return;
      if (media.mayRun(path.basename(target))) {
        const pick = await vscode.window.showWarningMessage(
          `${path.basename(target)} is a kind of file your system may run rather than show, so LLeMbas does not open it.`,
          'Show it in its folder',
        );
        if (pick) vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(target));
        return;
      }
      vscode.env.openExternal(vscode.Uri.file(target));
    },
  };
  const view = new ChatView(context, chat, shown, actions);
  context.subscriptions.push(vscode.window.registerWebviewViewProvider(VIEW_ID, view, { webviewOptions: { retainContextWhenHidden: true } }));

  // A card must be seen to be answered: the view is brought forward when one arrives.
  chat.on('item', (item) => {
    if (item.kind === 'card' && item.state === 'open') view.reveal(false, true).then(undefined, () => {});
  });

  async function ask() {
    const editor = vscode.window.activeTextEditor;
    const w = seen(editor, true);
    if (!w) return vscode.window.showInformationMessage('LLeMbas: select the text you want to ask about first.');
    const question = await vscode.window.showInputBox({
      title: `Ask LLeMbas about ${w.label}`,
      placeHolder: 'Your question (leave empty to send the selection with your next message)',
    });
    if (question === undefined) return undefined;
    await view.reveal(!question.trim());
    if (!question.trim()) return view.attach(w);
    if (chat.busy) return vscode.window.showWarningMessage('LLeMbas is still working on the last message. Stop it first.');
    return chat.send(question, { editor: w.editor, label: w.label });
  }

  // ---- rewrite a selection ----

  async function rewrite() {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.selection.isEmpty) return vscode.window.showInformationMessage('LLeMbas: select the lines to rewrite first.');
    const doc = editor.document;
    if (proposals.pending(doc)) return vscode.window.showWarningMessage('LLeMbas: accept or reject the changes shown in this file first.');
    const sel = editor.selection;
    const { first, last } = hunksOf.wholeLines({ startLine: sel.start.line, endLine: sel.end.line, endCharacter: sel.end.character });
    const name = doc.uri.scheme === 'file' ? vscode.workspace.asRelativePath(doc.uri, false) : 'untitled';
    const instruction = await vscode.window.showInputBox({
      title: `Rewrite ${selectionLabel(name, first + 1, last + 1)}`,
      placeHolder: 'What should change?',
    });
    if (!instruction || !instruction.trim()) return undefined;
    if (!(await chat.connect(false))) return vscode.window.showErrorMessage(say(chat.startError || 'the agent did not start'));
    if (!chat.has('editor')) {
      return vscode.window.showWarningMessage('LLeMbas: this LLeMbas CLI cannot rewrite a selection yet. Update the CLI.');
    }
    const lines = (from, to) => {
      const out = [];
      for (let i = Math.max(0, from); i <= Math.min(doc.lineCount - 1, to); i++) out.push(doc.lineAt(i).text);
      return out;
    };
    const old = lines(first, last);
    const versionThen = doc.version;
    const id = 'e' + ++rewrites;
    const params = {
      id,
      cwd: workingDirectory(),
      text: old.join('\n'),
      before: lines(first - 40, first - 1).join('\n'),
      after: lines(last + 1, last + 40).join('\n'),
      language: doc.languageId,
      instruction: instruction.trim(),
    };
    if (doc.uri.scheme === 'file') params.path = doc.uri.fsPath;
    if (chat.session) params.sessionId = chat.session;
    if (windowModel.main) params.model = windowModel.main;
    let r;
    try {
      r = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'LLeMbas is rewriting…', cancellable: true },
        async (progress, token) => {
          let written = 0;
          const onDelta = (p) => {
            if (!p || p.id !== id || typeof p.delta !== 'string') return;
            written += p.delta.length;
            progress.report({ message: `${written} characters` });
          };
          chat.on('editDelta', onDelta);
          token.onCancellationRequested(() => chat.notify('_lembas/edit/cancel', { id }));
          try {
            return await chat.request('_lembas/edit', params);
          } finally {
            chat.off('editDelta', onDelta);
          }
        },
      );
    } catch (e) {
      return vscode.window.showErrorMessage(say(e));
    }
    if (!r || r.cancelled || typeof r.text !== 'string') return undefined;
    if (doc.isClosed) return undefined;
    if (doc.version !== versionThen) {
      return vscode.window.showWarningMessage('LLeMbas: the file changed while the rewrite was written, so nothing is shown. Ask again.');
    }
    const fresh = hunksOf.splitLines(r.text);
    if (fresh.length > 1 && fresh[fresh.length - 1] === '') fresh.pop();
    const hunks = hunksOf.propose(first, old, fresh);
    if (!hunks.length) return vscode.window.showInformationMessage('LLeMbas: the rewrite changes nothing.');
    const made = proposals.set(doc, hunks);
    if (config().get('rewrite.openDiff')) proposals.showDiff(doc).then(undefined, () => {});
    const n = hunks.length;
    const pick = await vscode.window.showInformationMessage(
      `LLeMbas proposes ${n} change${n === 1 ? '' : 's'}. Nothing is written until you accept.`,
      'Accept all',
      'Reject all',
    );
    const entry = proposals.entry(doc);
    if (!pick || entry !== made) return undefined; // answered through the code lenses meanwhile
    if (pick === 'Accept all') return proposals.accept(doc, entry.hunks.slice());
    return proposals.reject(doc, entry.hunks.slice());
  }

  // ---- autocomplete ----

  const completer = new Completer({
    request: async (method, params) => {
      const agent = await chat.connect(true);
      if (!agent) throw new Error(chat.startError || 'the agent is not running');
      if (!agent.has('editor')) {
        throw Object.assign(new Error('This LLeMbas CLI has no autocomplete yet. Update the CLI.'), { data: { reason: 'unsupported' } });
      }
      return agent.request(method, params);
    },
    notify: (method, params) => chat.notify(method, params),
    debounceMs: () => Number(config().get('complete.debounce')),
    model: () => windowModel.autocomplete,
    maxTokens: () => Number(config().get('complete.maxTokens')) || undefined,
    onRefusal(reason, message) {
      if (reason === 'no_model' || reason === 'not_allowed') {
        const text = reason === 'no_model' ? message || 'No autocomplete model is chosen.' : message || 'That model is not allowed for autocomplete.';
        vscode.window.showInformationMessage('LLeMbas: ' + text, 'Choose a model').then((pick) => {
          if (pick) guard(pickModel('autocomplete'));
        });
      } else if (reason === 'not_logged_in') {
        vscode.window.showWarningMessage('LLeMbas: ' + (message || 'The LLeMbas CLI is not signed in.') + ' Sign in with `lembas login` in a terminal.');
      } else {
        vscode.window.showInformationMessage('LLeMbas: ' + (message || 'Autocomplete is not available here yet.'));
      }
    },
    onError(message, manual) {
      output.appendLine('autocomplete: ' + message);
      if (manual) vscode.window.showWarningMessage(say(message));
    },
  });
  chat.on('connected', () => completer.unblock());

  const inline = {
    async provideInlineCompletionItems(document, position, ctx, token) {
      const manual = ctx.triggerKind === vscode.InlineCompletionTriggerKind.Invoke;
      if (!manual && !config().get('complete.auto')) return undefined;
      if (!manual && ctx.selectedCompletionInfo) return undefined; // the editor's own list is open
      const offset = document.offsetAt(position);
      const from = document.positionAt(Math.max(0, offset - 12000));
      const to = document.positionAt(offset + 4000);
      const around = document.getText(new vscode.Range(from, to));
      const { prefix, suffix } = windowAround(around, offset - document.offsetAt(from));
      if (!manual && !prefix.trim() && !suffix.trim()) return undefined;
      const asked = completer.ask(
        { prefix, suffix, path: document.uri.scheme === 'file' ? document.uri.fsPath : undefined, language: document.languageId },
        { manual },
      );
      const seq = completer.current;
      const sub = token.onCancellationRequested(() => completer.cancel(seq));
      const text = await asked;
      sub.dispose();
      if (!text || token.isCancellationRequested) return undefined;
      return [new vscode.InlineCompletionItem(text, new vscode.Range(position, position))];
    },
  };
  const editable = [{ scheme: 'file' }, { scheme: 'untitled' }, { scheme: 'vscode-notebook-cell' }];
  context.subscriptions.push(vscode.languages.registerInlineCompletionItemProvider(editable, inline));

  // ---- the two model settings ----

  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90);
  status.command = 'llembas.modelSettings';
  context.subscriptions.push(status);
  function showStatus() {
    const saved = chat.settings && chat.settings.autocomplete && chat.settings.autocomplete.model;
    const model = windowModel.autocomplete || saved;
    status.text = 'LLeMbas' + (model ? ': ' + String(model).split('/').pop() : '');
    status.tooltip = model
      ? `Autocomplete model: ${model}${windowModel.autocomplete ? ' (this window only)' : ''}. Click to change the models.`
      : 'LLeMbas: choose the models';
    status.show();
  }
  showStatus();
  chat.on('state', showStatus);

  /** Choose the autocomplete or the main model: saved in the account, or for this window only. */
  async function pickModel(kind) {
    const data = await chat.loadModels();
    const setting = kind === 'autocomplete' ? data.autocomplete : data.main;
    if (!setting) {
      return vscode.window.showInformationMessage('LLeMbas: this LLeMbas CLI or its server does not keep the editor\'s model settings yet. Update them.');
    }
    const savedNow = setting.model || null;
    const windowNow = windowModel[kind];
    const items = data.models
      .filter((m) => !Array.isArray(m.for) || m.for.includes(kind))
      .map((m) => ({
        label: String(m.name || m.id),
        description: [m.id, m.id === savedNow ? (setting.source === 'instance' ? "the server's default" : 'saved') : '', m.id === windowNow ? 'this window' : '']
          .filter(Boolean)
          .join(' · '),
        id: m.id,
      }));
    items.push({ label: "Use the server's default", description: 'forget my saved choice and the one of this window', id: null });
    const title = kind === 'autocomplete' ? 'LLeMbas: autocomplete model' : 'LLeMbas: main model (chat, rewrite)';
    const picked = await vscode.window.showQuickPick(items, { title, placeHolder: 'Any model your server offers', matchOnDescription: true });
    if (!picked) return undefined;
    const key = kind === 'autocomplete' ? 'autocomplete_model' : 'main_model';
    if (picked.id === null) {
      windowModel[kind] = undefined;
      await chat.editorSettings({ [key]: null });
    } else {
      const where = await vscode.window.showQuickPick(
        [
          { label: 'Save it', description: 'kept in your account: every editor you sign in from uses it', save: true },
          { label: 'Only this window', description: 'a quick switch, saved nowhere', save: false },
        ],
        { title: `${title}: ${picked.label}` },
      );
      if (!where) return undefined;
      if (where.save) {
        await chat.editorSettings({ [key]: picked.id });
        windowModel[kind] = undefined;
      } else {
        windowModel[kind] = picked.id;
        if (kind === 'main' && chat.session && !chat.busy) await chat.setModel(picked.id);
      }
    }
    if (kind === 'autocomplete') completer.unblock();
    showStatus();
    return undefined;
  }

  async function modelSettings() {
    let data;
    try {
      data = await chat.loadModels();
    } catch (e) {
      return vscode.window.showErrorMessage(say(e));
    }
    const name = (kind) => {
      const s = kind === 'autocomplete' ? data.autocomplete : data.main;
      if (windowModel[kind]) return `${windowModel[kind]} (this window only)`;
      if (!s || !s.model) return 'not chosen';
      return s.model + (s.source === 'instance' ? " (the server's default)" : '');
    };
    const picked = await vscode.window.showQuickPick(
      [
        { label: 'Autocomplete model', description: name('autocomplete'), kind: 'autocomplete' },
        { label: 'Main model', description: name('main'), detail: 'chat and rewriting a selection', kind: 'main' },
      ],
      { title: 'LLeMbas: models' },
    );
    return picked ? pickModel(picked.kind) : undefined;
  }

  async function chooseSessionModel() {
    const data = await chat.loadModels();
    const picked = await vscode.window.showQuickPick(
      data.models.map((m) => ({ label: String(m.name || m.id), description: m.id + (m.id === chat.model ? ' · now' : ''), id: m.id })),
      { title: "LLeMbas: this session's model" },
    );
    return picked ? chat.setModel(picked.id) : undefined;
  }

  async function chooseMode() {
    if (!(await chat.ensureSession())) return undefined;
    const picked = await vscode.window.showQuickPick(
      chat.modes.map((m) => ({ label: String(m.name || m.id), description: m.id === chat.mode ? 'now' : '', id: m.id })),
      { title: 'LLeMbas: mode' },
    );
    return picked ? chat.setMode(picked.id) : undefined;
  }

  // ---- commands ----

  const command = (name, fn) => context.subscriptions.push(vscode.commands.registerCommand(name, (...args) => guard(Promise.resolve().then(() => fn(...args)))));
  command('llembas.open', () => view.reveal(true));
  command('llembas.newSession', actions.newSession);
  command('llembas.stop', () => chat.stop());
  command('llembas.restart', () => {
    if (chat.agent) chat.agent.stop();
  });
  command('llembas.ask', ask);
  command('llembas.rewrite', rewrite);
  command('llembas.complete', () => vscode.commands.executeCommand('editor.action.inlineSuggest.trigger'));
  command('llembas.chooseMode', chooseMode);
  command('llembas.chooseModel', chooseSessionModel);
  command('llembas.modelSettings', modelSettings);
  command('llembas.chooseAutocompleteModel', () => pickModel('autocomplete'));
  command('llembas.chooseMainModel', () => pickModel('main'));
  command('llembas.acceptChange', (uri, id) => {
    const doc = proposals.docFor(uri);
    const hunk = doc && proposals.hunkFor(doc, id);
    return hunk ? proposals.accept(doc, [hunk]) : undefined;
  });
  command('llembas.rejectChange', (uri, id) => {
    const doc = proposals.docFor(uri);
    const hunk = doc && proposals.hunkFor(doc, id);
    return hunk ? proposals.reject(doc, [hunk]) : undefined;
  });
  command('llembas.acceptAllChanges', (uri) => {
    const doc = proposals.docFor(uri);
    const entry = doc && proposals.entry(doc);
    return entry ? proposals.accept(doc, entry.hunks.slice()) : undefined;
  });
  command('llembas.rejectAllChanges', (uri) => {
    const doc = proposals.docFor(uri);
    const entry = doc && proposals.entry(doc);
    return entry ? proposals.reject(doc, entry.hunks.slice()) : undefined;
  });
  command('llembas.showChanges', (uri) => {
    const doc = proposals.docFor(uri);
    return doc ? proposals.showDiff(doc) : undefined;
  });

  context.subscriptions.push(
    vscode.languages.registerCodeLensProvider([{ scheme: 'file' }, { scheme: 'untitled' }], proposals),
    vscode.workspace.onDidChangeTextDocument((ev) => proposals.documentChanged(ev)),
    vscode.workspace.onDidCloseTextDocument((doc) => proposals.clear(doc)),
    vscode.window.onDidChangeVisibleTextEditors((editors) => editors.forEach((e) => proposals.decorate(e))),
    vscode.window.onDidChangeActiveTextEditor((e) =>
      vscode.commands.executeCommand('setContext', 'llembas.hasProposal', !!(e && proposals.pending(e.document))),
    ),
    vscode.workspace.onDidChangeConfiguration((ev) => {
      // Another command for the agent: the running one is stopped, and the next request starts the new one.
      if (ev.affectsConfiguration('llembas.command') && chat.agent) chat.agent.stop();
    }),
    proposals.removed,
    proposals.added,
  );
}

function deactivate() {
  if (chat) chat.dispose();
  if (mediaDir) {
    try {
      fs.rmSync(mediaDir, { recursive: true, force: true });
    } catch {
      // the system clears its temporary files in its own time
    }
  }
}

module.exports = { activate, deactivate };
