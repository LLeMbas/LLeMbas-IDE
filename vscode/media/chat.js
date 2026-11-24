// The chat view's one script. It draws what the extension sends: items of a transcript, and
// the Markdown of a model's text as a tree of plain objects (src/markdown.js). Everything is
// built with createElement and textContent; no markup is ever parsed from a string here.
(function () {
  'use strict';

  var MARKS = { pending: '…', in_progress: '…', completed: '✓', failed: '✗' };
  var MAX_DEPTH = 8;

  function el(doc, tag, cls, text) {
    var e = doc.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null) e.textContent = String(text);
    return e;
  }

  function buildInline(doc, nodes, parent, depth) {
    if (!Array.isArray(nodes) || depth > MAX_DEPTH) return;
    for (var i = 0; i < nodes.length; i++) {
      var n = nodes[i];
      if (!n || typeof n !== 'object') continue;
      if (n.t === 'text') parent.appendChild(doc.createTextNode(String(n.v)));
      else if (n.t === 'br') parent.appendChild(doc.createElement('br'));
      else if (n.t === 'code') parent.appendChild(el(doc, 'code', '', n.v));
      else if (n.t === 'b' || n.t === 'i') {
        var e = doc.createElement(n.t === 'b' ? 'strong' : 'em');
        buildInline(doc, n.c, e, depth + 1);
        parent.appendChild(e);
      } else if (n.t === 'a') {
        // Not an anchor that navigates: the extension is asked to open the address, and checks it again.
        var a = doc.createElement('span');
        a.className = 'link';
        a.setAttribute('role', 'link');
        a.setAttribute('tabindex', '0');
        a.setAttribute('title', String(n.href));
        a.setAttribute('data-href', String(n.href));
        buildInline(doc, n.c, a, depth + 1);
        parent.appendChild(a);
      }
    }
  }

  function buildBlocks(doc, blocks, parent, depth) {
    if (!Array.isArray(blocks) || depth > MAX_DEPTH) return;
    for (var i = 0; i < blocks.length; i++) {
      var b = blocks[i];
      if (!b || typeof b !== 'object') continue;
      var e;
      if (b.t === 'p') {
        e = doc.createElement('p');
        buildInline(doc, b.c, e, 0);
      } else if (b.t === 'h') {
        var level = Math.max(1, Math.min(6, Number(b.l) || 1));
        e = doc.createElement('h' + level);
        buildInline(doc, b.c, e, 0);
      } else if (b.t === 'pre') {
        e = doc.createElement('pre');
        e.appendChild(el(doc, 'code', '', b.v));
      } else if (b.t === 'plain') {
        // A text too long to be read as Markdown: shown as it was written.
        e = el(doc, 'div', 'plain', b.v);
      } else if (b.t === 'hr') {
        e = doc.createElement('hr');
      } else if (b.t === 'quote') {
        e = doc.createElement('blockquote');
        buildBlocks(doc, b.c, e, depth + 1);
      } else if (b.t === 'ul' || b.t === 'ol') {
        e = doc.createElement(b.t);
        var items = Array.isArray(b.items) ? b.items : [];
        for (var j = 0; j < items.length; j++) {
          var d = Math.max(0, Math.min(5, Number(items[j] && items[j].d) || 0));
          var li = el(doc, 'li', d ? 'depth-' + d : '');
          buildInline(doc, items[j] && items[j].c, li, 0);
          e.appendChild(li);
        }
      } else {
        continue;
      }
      parent.appendChild(e);
    }
  }

  function button(doc, text, cls, onClick) {
    var b = el(doc, 'button', cls || '', text);
    b.setAttribute('type', 'button');
    b.addEventListener('click', onClick);
    return b;
  }

  /** One item of the transcript as an element. `post` sends a message to the extension. */
  function renderItem(doc, item, post) {
    var root = el(doc, 'div', 'item ' + String(item.kind).replace(/[^a-z]/g, ''));
    root.setAttribute('data-id', String(item.id));
    if (item.kind === 'user') {
      root.appendChild(el(doc, 'div', 'who', 'You'));
      var body = el(doc, 'div', 'body');
      if (item.label) body.appendChild(el(doc, 'div', 'label', '[' + item.label + ']'));
      body.appendChild(el(doc, 'div', 'text', item.text));
      root.appendChild(body);
    } else if (item.kind === 'agent') {
      root.appendChild(el(doc, 'div', 'who', 'LLeMbas'));
      var md = el(doc, 'div', 'md');
      if (Array.isArray(item.ast)) buildBlocks(doc, item.ast, md, 0);
      else md.textContent = String(item.text || '');
      root.appendChild(md);
    } else if (item.kind === 'thought') {
      root.appendChild(el(doc, 'div', 'who', 'Thinking'));
      root.appendChild(el(doc, 'div', 'text', item.text));
    } else if (item.kind === 'note') {
      root.textContent = String(item.text);
    } else if (item.kind === 'tool') {
      if (item.status === 'failed') root.className += ' failed';
      root.appendChild(el(doc, 'span', 'mark', MARKS[item.status] || '…'));
      root.appendChild(el(doc, 'span', 'title', String(item.title) + (item.denied ? ' (not allowed)' : '')));
      var files = Array.isArray(item.files) ? item.files : [];
      if (files.length) {
        var list = el(doc, 'div', 'files');
        files.slice(0, 20).forEach(function (path, i) {
          if (i) list.appendChild(doc.createTextNode(', '));
          var f = el(doc, 'span', 'link', String(path).split(/[\\/]/).pop());
          f.setAttribute('role', 'link');
          f.setAttribute('tabindex', '0');
          f.setAttribute('title', String(path));
          f.setAttribute('data-file', String(path));
          list.appendChild(f);
        });
        root.appendChild(list);
      }
    } else if (item.kind === 'plan') {
      root.appendChild(el(doc, 'span', 'mark', item.done >= item.all ? '✓' : '…'));
      root.appendChild(el(doc, 'span', 'title', 'Plan: ' + Number(item.done) + ' of ' + Number(item.all) + ' tasks done'));
    } else if (item.kind === 'card') {
      var open = item.state === 'open';
      if (!open) root.className += ' closed';
      root.appendChild(el(doc, 'div', 'who', open ? 'LLeMbas asks' + (item.tool ? ' (' + item.tool + ')' : '') : 'Asked'));
      root.appendChild(el(doc, 'div', 'title', item.title));
      if (open && item.reason) root.appendChild(el(doc, 'div', 'reason', item.reason));
      if (open && item.detail) root.appendChild(el(doc, 'pre', '', item.detail));
      if (open) {
        var row = el(doc, 'div', 'buttons');
        (Array.isArray(item.options) ? item.options : []).forEach(function (o) {
          var deny = String(o.kind).indexOf('reject') === 0;
          row.appendChild(button(doc, o.name, deny ? 'second' : '', function () {
            post({ type: 'answer', card: item.id, option: o.optionId });
          }));
        });
        if (Array.isArray(item.files) && item.files.length) {
          row.appendChild(button(doc, 'Show the change', 'second', function () {
            post({ type: 'showDiff', card: item.id });
          }));
        }
        root.appendChild(row);
      } else {
        root.appendChild(el(doc, 'div', 'reason', item.answer));
      }
    } else if (item.kind === 'media') {
      if (item.picture && item.src) {
        var img = doc.createElement('img');
        img.setAttribute('src', String(item.src));
        img.setAttribute('alt', String(item.name));
        img.addEventListener('click', function () {
          post({ type: 'openMedia', key: item.key });
        });
        root.appendChild(img);
      }
      var cap = el(doc, 'div', 'caption');
      cap.appendChild(el(doc, 'span', 'name', String(item.name) + (item.sizeWords ? ' (' + item.sizeWords + ')' : '')));
      cap.appendChild(button(doc, item.opens ? 'Open' : 'Show in folder', 'second', function () {
        post({ type: 'openMedia', key: item.key });
      }));
      root.appendChild(cap);
    }
    return root;
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { buildBlocks: buildBlocks, buildInline: buildInline, renderItem: renderItem };
    return;
  }

  // ---- in the view ----------------------------------------------------------------------

  var vscode = acquireVsCodeApi();
  var doc = document;
  var log = doc.getElementById('log');
  var prompt = doc.getElementById('prompt');
  var send = doc.getElementById('send');
  var mode = doc.getElementById('mode');
  var model = doc.getElementById('model');
  var attached = doc.getElementById('attached');
  var attachedLabel = doc.getElementById('attached-label');
  var working = doc.getElementById('working');
  var state = { busy: false, modes: [], models: [], mode: null, model: null };
  var nodes = {};

  function post(msg) {
    vscode.postMessage(msg);
  }

  function atBottom() {
    return log.scrollHeight - log.scrollTop - log.clientHeight < 40;
  }

  function upsert(item) {
    var stick = atBottom();
    var fresh = renderItem(doc, item, post);
    var old = nodes[item.id];
    if (old && old.parentNode === log) log.replaceChild(fresh, old);
    else log.appendChild(fresh);
    nodes[item.id] = fresh;
    if (stick) log.scrollTop = log.scrollHeight;
  }

  function reset(items) {
    while (log.firstChild) log.removeChild(log.firstChild);
    nodes = {};
    (items || []).forEach(upsert);
    log.scrollTop = log.scrollHeight;
  }

  function fill(select, options, current, placeholder) {
    while (select.firstChild) select.removeChild(select.firstChild);
    var seen = false;
    options.forEach(function (o) {
      var opt = el(doc, 'option', '', o.name);
      opt.value = o.id;
      if (o.id === current) {
        opt.selected = true;
        seen = true;
      }
      select.appendChild(opt);
    });
    if (!seen) {
      var opt = el(doc, 'option', '', current || placeholder);
      opt.value = current || '';
      opt.selected = true;
      select.insertBefore(opt, select.firstChild);
    }
    select.disabled = options.length === 0;
  }

  function showState(s) {
    state = s;
    fill(mode, s.modes || [], s.mode, 'Mode');
    fill(model, s.models || [], s.model, 'Model');
    send.textContent = s.busy ? 'Stop' : 'Send';
    working.hidden = !s.busy;
    mode.disabled = mode.disabled || !!s.busy;
    model.disabled = model.disabled || !!s.busy;
  }

  function submit() {
    if (state.busy) return post({ type: 'stop' });
    var text = prompt.value;
    if (!text.trim()) return;
    post({ type: 'send', text: text });
    prompt.value = '';
    vscode.setState({ draft: '' });
  }

  send.addEventListener('click', submit);
  prompt.addEventListener('keydown', function (ev) {
    if (ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing) {
      ev.preventDefault();
      if (!state.busy) submit();
    }
  });
  prompt.addEventListener('input', function () {
    vscode.setState({ draft: prompt.value });
  });
  doc.getElementById('new').addEventListener('click', function () {
    post({ type: 'new' });
  });
  doc.getElementById('detach').addEventListener('click', function () {
    post({ type: 'detach' });
  });
  mode.addEventListener('change', function () {
    if (mode.value) post({ type: 'setMode', id: mode.value });
  });
  model.addEventListener('change', function () {
    if (model.value) post({ type: 'setModel', id: model.value });
  });

  function follow(target) {
    var t = target;
    while (t && t !== log) {
      if (t.getAttribute && t.getAttribute('data-href')) return post({ type: 'openLink', href: t.getAttribute('data-href') });
      if (t.getAttribute && t.getAttribute('data-file')) return post({ type: 'openFile', path: t.getAttribute('data-file') });
      t = t.parentNode;
    }
  }
  log.addEventListener('click', function (ev) {
    follow(ev.target);
  });
  log.addEventListener('keydown', function (ev) {
    if (ev.key === 'Enter') follow(ev.target);
  });

  window.addEventListener('message', function (ev) {
    var m = ev.data;
    if (!m || typeof m !== 'object') return;
    if (m.type === 'reset') {
      reset(m.items);
      showState(m.state);
      showAttached(m.attached);
    } else if (m.type === 'item') upsert(m.item);
    else if (m.type === 'state') showState(m.state);
    else if (m.type === 'attached') showAttached(m.label);
    else if (m.type === 'focus') prompt.focus();
  });

  function showAttached(label) {
    attached.hidden = !label;
    attachedLabel.textContent = label ? 'With ' + label : '';
  }

  var saved = vscode.getState();
  if (saved && typeof saved.draft === 'string') prompt.value = saved.draft;
  post({ type: 'ready' });
})();
