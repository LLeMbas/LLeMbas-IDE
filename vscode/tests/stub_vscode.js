'use strict';
// A stand-in for the `vscode` module, for tests/extension.test.js: just enough of the editor's
// API, in memory, for extension.js to be loaded and driven. It is NOT VS Code — what passes
// here shows that the glue code runs and calls the API the way it means to, not that the
// editor behaves that way.
const path = require('node:path');

class Position {
  constructor(line, character) {
    this.line = line;
    this.character = character;
  }
}

class Range {
  constructor(a, b, c, d) {
    if (a instanceof Position) {
      this.start = a;
      this.end = b;
    } else {
      this.start = new Position(a, b);
      this.end = new Position(c, d);
    }
  }
  get isEmpty() {
    return this.start.line === this.end.line && this.start.character === this.end.character;
  }
}

class Selection extends Range {
  constructor(a, b, c, d) {
    super(a, b, c, d);
    this.anchor = this.start;
    this.active = this.end;
  }
}

class Uri {
  constructor(scheme, p) {
    this.scheme = scheme;
    this.path = p;
  }
  get fsPath() {
    return this.path;
  }
  toString() {
    return `${this.scheme}:${this.scheme === 'file' ? '//' : ''}${this.path}`;
  }
  static file(p) {
    return new Uri('file', p);
  }
  static from(o) {
    return new Uri(o.scheme, o.path);
  }
  static parse(text) {
    const m = /^([a-z][a-z0-9+.-]*):(.*)$/i.exec(text);
    return new Uri(m[1], m[2]);
  }
  static joinPath(base, ...parts) {
    return new Uri(base.scheme, path.posix.join(base.path, ...parts));
  }
}

class EventEmitter {
  constructor() {
    this.listeners = [];
    this.event = (fn) => {
      this.listeners.push(fn);
      return { dispose: () => (this.listeners = this.listeners.filter((l) => l !== fn)) };
    };
  }
  fire(value) {
    for (const l of this.listeners.slice()) l(value);
  }
}

class TextDocument {
  constructor(uri, text, languageId) {
    this.uri = uri;
    this.languageId = languageId || 'plaintext';
    this.version = 1;
    this.eol = 1;
    this.isClosed = false;
    this.isDirty = false;
    this.saves = 0;
    this.text = text;
  }
  get lines() {
    return this.text.split('\n');
  }
  get lineCount() {
    return this.lines.length;
  }
  lineAt(i) {
    const text = this.lines[i];
    if (text === undefined) throw new Error('no line ' + i);
    return { text, range: new Range(i, 0, i, text.length) };
  }
  offsetAt(pos) {
    const lines = this.lines;
    let offset = 0;
    for (let i = 0; i < Math.min(pos.line, lines.length); i++) offset += lines[i].length + 1;
    return Math.min(this.text.length, offset + Math.min(pos.character, (lines[pos.line] || '').length));
  }
  positionAt(offset) {
    const before = this.text.slice(0, Math.max(0, Math.min(offset, this.text.length))).split('\n');
    return new Position(before.length - 1, before[before.length - 1].length);
  }
  async save() {
    if (this.uri.scheme !== 'file') return false;
    require('node:fs').writeFileSync(this.uri.fsPath, this.text);
    this.isDirty = false;
    this.saves += 1;
    return true;
  }
  getText(range) {
    return range ? this.text.slice(this.offsetAt(range.start), this.offsetAt(range.end)) : this.text;
  }
}

class TextEditor {
  constructor(document, selection) {
    this.document = document;
    this.selection = selection || new Selection(0, 0, 0, 0);
    this.decorations = new Map();
  }
  setDecorations(type, list) {
    this.decorations.set(type, list);
  }
}

class WorkspaceEdit {
  constructor() {
    this.edits = [];
  }
  replace(uri, range, text) {
    this.edits.push({ uri, range, text });
  }
}

class MarkdownString {
  constructor() {
    this.value = '';
  }
  appendText(t) {
    this.value += t;
    return this;
  }
  appendCodeblock(code, lang) {
    this.value += '\n```' + (lang || '') + '\n' + code + '\n```\n';
    return this;
  }
}

class TabInputText {
  constructor(uri) {
    this.uri = uri;
  }
}
class TabInputTextDiff {
  constructor(original, modified) {
    this.original = original;
    this.modified = modified;
  }
}

function make(pkg) {
  const state = {
    config: {}, // 'llembas.command' -> value
    inputs: [], // answers to showInputBox, in order
    picks: [], // functions (items) => item, answers to showQuickPick, in order
    answers: [], // answers to show…Message, in order (undefined: dismissed)
    messages: [], // { level, text, buttons }
    executed: [], // commands of the editor's own that were run
    external: [],
    commands: new Map(),
    contentProviders: new Map(),
    viewProviders: new Map(),
    inlineProviders: [],
    lensProviders: [],
    statusItems: [],
    output: [],
    diagnostics: new Map(),
    tabs: [],
    changed: new EventEmitter(),
    closed: new EventEmitter(),
    configured: new EventEmitter(),
    visible: new EventEmitter(),
    active: new EventEmitter(),
  };
  const defaults = {};
  for (const [key, def] of Object.entries(pkg.contributes.configuration.properties)) defaults[key] = def.default;

  const message = (level) => (text, ...buttons) => {
    state.messages.push({ level, text, buttons: buttons.filter((b) => typeof b === 'string') });
    return Promise.resolve(state.answers.length ? state.answers.shift() : undefined);
  };

  const api = {
    __: state,
    Position,
    Range,
    Selection,
    Uri,
    EventEmitter,
    WorkspaceEdit,
    MarkdownString,
    TabInputText,
    TabInputTextDiff,
    TextDocument,
    TextEditor,
    ThemeColor: class {
      constructor(id) {
        this.id = id;
      }
    },
    CodeLens: class {
      constructor(range, command) {
        this.range = range;
        this.command = command;
      }
    },
    InlineCompletionItem: class {
      constructor(insertText, range) {
        this.insertText = insertText;
        this.range = range;
      }
    },
    EndOfLine: { LF: 1, CRLF: 2 },
    OverviewRulerLane: { Left: 1 },
    StatusBarAlignment: { Left: 1, Right: 2 },
    ProgressLocation: { Notification: 15 },
    ViewColumn: { Beside: -2 },
    InlineCompletionTriggerKind: { Invoke: 0, Automatic: 1 },
    DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
    ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
    workspace: {
      workspaceFolders: undefined,
      textDocuments: [],
      getConfiguration: (section) => ({
        get: (key) => {
          const full = `${section}.${key}`;
          if (!(full in defaults)) throw new Error('a setting that is not declared: ' + full);
          return full in state.config ? state.config[full] : defaults[full];
        },
        update: async (key, value) => {
          const full = `${section}.${key}`;
          if (!(full in defaults)) throw new Error('a setting that is not declared: ' + full);
          state.config[full] = value;
        },
      }),
      registerTextDocumentContentProvider: (scheme, provider) => {
        state.contentProviders.set(scheme, provider);
        return { dispose() {} };
      },
      onDidChangeTextDocument: state.changed.event,
      onDidCloseTextDocument: state.closed.event,
      onDidChangeConfiguration: state.configured.event,
      asRelativePath: (uri) => path.basename(uri.path),
      openTextDocument: async (what) => {
        let doc;
        if (!(what instanceof Uri)) {
          doc = new TextDocument(new Uri('untitled', 'Untitled-1'), what.content);
          doc.isDirty = true; // as the editor has it: a document made from content wants saving
        } else if (what.scheme === 'file') doc = new TextDocument(what, require('node:fs').readFileSync(what.fsPath, 'utf8'));
        else doc = new TextDocument(what, await state.contentProviders.get(what.scheme).provideTextDocumentContent(what));
        api.workspace.textDocuments.push(doc);
        return doc;
      },
      applyEdit: async (edit) => {
        // Every range is against the text as it was; applied from the end of the text backwards.
        const byDoc = new Map();
        for (const e of edit.edits) {
          const doc = api.workspace.textDocuments.find((d) => d.uri.toString() === e.uri.toString());
          if (!doc) return false;
          if (!byDoc.has(doc)) byDoc.set(doc, []);
          byDoc.get(doc).push({ from: doc.offsetAt(e.range.start), to: doc.offsetAt(e.range.end), text: e.text, range: e.range });
        }
        for (const [doc, edits] of byDoc) {
          edits.sort((a, b) => b.from - a.from);
          for (let i = 1; i < edits.length; i++) if (edits[i].to > edits[i - 1].from) throw new Error('overlapping edits');
          for (const e of edits) doc.text = doc.text.slice(0, e.from) + e.text + doc.text.slice(e.to);
          doc.version += 1;
          doc.isDirty = true;
          state.changed.fire({ document: doc, contentChanges: edits.map((e) => ({ range: e.range, text: e.text })) });
        }
        return true;
      },
    },
    window: {
      activeTextEditor: undefined,
      visibleTextEditors: [],
      tabGroups: {
        get all() {
          return [{ tabs: state.tabs }];
        },
        close: async (tabs) => {
          state.tabs = state.tabs.filter((t) => !tabs.includes(t));
          return true;
        },
      },
      createOutputChannel: () => ({ append: (t) => state.output.push(t), appendLine: (t) => state.output.push(t + '\n'), dispose() {} }),
      registerWebviewViewProvider: (id, provider, options) => {
        state.viewProviders.set(id, { provider, options });
        return { dispose() {} };
      },
      createTextEditorDecorationType: (options) => ({ options, dispose() {} }),
      createStatusBarItem: () => {
        const item = { text: '', tooltip: '', command: '', shown: false, show: () => (item.shown = true), dispose() {} };
        state.statusItems.push(item);
        return item;
      },
      showInputBox: async () => state.inputs.shift(),
      showQuickPick: async (items, options) => {
        const pick = state.picks.shift();
        if (!pick) return undefined;
        const chosen = pick(items, options);
        if (chosen === undefined) throw new Error('the test picked nothing from: ' + items.map((i) => i.label).join(', '));
        return chosen;
      },
      showInformationMessage: message('info'),
      showWarningMessage: message('warning'),
      showErrorMessage: message('error'),
      showTextDocument: async (doc) => {
        state.executed.push(['showTextDocument', doc]);
        return new TextEditor(doc);
      },
      withProgress: (options, task) => {
        const cancel = new EventEmitter();
        state.cancelProgress = () => cancel.fire();
        return task({ report: (r) => state.executed.push(['progress', r.message]) }, { onCancellationRequested: cancel.event, isCancellationRequested: false });
      },
      onDidChangeVisibleTextEditors: state.visible.event,
      onDidChangeActiveTextEditor: state.active.event,
    },
    commands: {
      registerCommand: (name, fn) => {
        state.commands.set(name, fn);
        return { dispose() {} };
      },
      executeCommand: async (name, ...args) => {
        if (state.commands.has(name)) return state.commands.get(name)(...args);
        state.executed.push([name, ...args]);
        if (name === 'vscode.diff') state.tabs.push({ input: new TabInputTextDiff(args[0], args[1]), label: args[2] });
        return undefined;
      },
    },
    languages: {
      registerInlineCompletionItemProvider: (selector, provider) => {
        state.inlineProviders.push(provider);
        return { dispose() {} };
      },
      registerCodeLensProvider: (selector, provider) => {
        state.lensProviders.push(provider);
        return { dispose() {} };
      },
      getDiagnostics: (uri) => state.diagnostics.get(uri.toString()) || [],
    },
    env: {
      clipboard: {
        writeText: async (text) => {
          state.copied = text;
        },
      },
      openExternal: async (uri) => {
        state.external.push(uri.toString());
        return true;
      },
    },
  };

  /** Open a document in an editor, in front. */
  api.__.open = (file, text, selection, languageId) => {
    const doc = new TextDocument(typeof file === 'string' ? Uri.file(file) : file, text, languageId);
    const editor = new TextEditor(doc, selection);
    api.workspace.textDocuments.push(doc);
    api.window.visibleTextEditors.push(editor);
    api.window.activeTextEditor = editor;
    state.tabs.push({ input: new TabInputText(doc.uri) });
    return editor;
  };
  /** A view of the chat: what the page was sent is `view.posted`; `view.say(m)` is the page speaking. */
  api.__.view = () => {
    const posted = [];
    let listener = () => {};
    const view = {
      posted,
      shows: [],
      webview: {
        options: null,
        html: '',
        cspSource: 'https://file.example',
        asWebviewUri: (uri) => Uri.parse('https://file.example' + uri.path),
        postMessage: async (m) => {
          posted.push(JSON.parse(JSON.stringify(m)));
          return true;
        },
        onDidReceiveMessage: (fn) => {
          listener = fn;
        },
      },
      show: (preserveFocus) => view.shows.push(preserveFocus),
      onDidDispose: () => {},
      say: (m) => listener(m),
    };
    return view;
  };
  return api;
}

module.exports = { make };
