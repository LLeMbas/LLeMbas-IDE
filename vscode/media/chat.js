// The chat view's one script. It draws what the extension sends: items of a transcript, and
// the Markdown of a model's text as a tree of plain objects (src/markdown.js). Everything is
// built with createElement and textContent; no markup is ever parsed from a string here.
(function () {
  'use strict';

  var MARKS = { pending: '…', in_progress: '…', completed: '✓', failed: '✗' };
  var PLAN_MARKS = { pending: '☐', in_progress: '▸', completed: '✓' };
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
      var entries = Array.isArray(item.entries) ? item.entries : [];
      if (entries.length) {
        var plist = el(doc, 'div', 'plan-entries');
        entries.slice(0, 20).forEach(function (ent) {
          var row = el(doc, 'div', 'plan-entry ' + String(ent.status || 'pending').replace(/[^a-z_]/g, ''));
          row.appendChild(el(doc, 'span', 'pmark', PLAN_MARKS[ent.status] || '☐'));
          row.appendChild(el(doc, 'span', 'ptext', String(ent.content || '')));
          plist.appendChild(row);
        });
        root.appendChild(plist);
      }
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
    } else if (item.kind === 'question') {
      var qOpen = item.state === 'open';
      root.className += ' card' + (qOpen ? '' : ' closed');
      root.appendChild(el(doc, 'div', 'who', qOpen ? 'LLeMbas asks a question' : 'Question'));
      if (item.why) root.appendChild(el(doc, 'div', 'reason', item.why));
      var qs = Array.isArray(item.questions) ? item.questions : [];
      if (qOpen) {
        var chosen = qs.map(function () { return []; });
        var inputs = [];
        qs.forEach(function (q, qi) {
          var blk = el(doc, 'div', 'q-block');
          if (q.header) blk.appendChild(el(doc, 'div', 'q-header', q.header));
          blk.appendChild(el(doc, 'div', 'title', q.question));
          var opts = Array.isArray(q.options) ? q.options : [];
          if (opts.length) {
            var optWrap = el(doc, 'div', 'q-options');
            var btns = [];
            opts.forEach(function (o) {
              var b = button(doc, o.label + (o.description ? ' — ' + o.description : ''), 'second q-opt', function () {
                if (q.multiple) {
                  var idx = chosen[qi].indexOf(o.label);
                  if (idx >= 0) {
                    chosen[qi].splice(idx, 1);
                    b.className = 'second q-opt';
                  } else {
                    chosen[qi].push(o.label);
                    b.className = 'q-opt selected';
                  }
                } else {
                  chosen[qi] = [o.label];
                  btns.forEach(function (other) { other.className = 'second q-opt'; });
                  b.className = 'q-opt selected';
                }
              });
              btns.push(b);
              optWrap.appendChild(b);
            });
            blk.appendChild(optWrap);
          }
          var inp = el(doc, 'input', 'q-input');
          inp.setAttribute('type', 'text');
          inp.setAttribute('placeholder', opts.length ? 'Or write your own answer…' : 'Your answer…');
          inputs.push(inp);
          blk.appendChild(inp);
          root.appendChild(blk);
        });
        var qRow = el(doc, 'div', 'buttons');
        qRow.appendChild(button(doc, 'Submit', '', function () {
          var answers = qs.map(function (q, qi) {
            var typed = (inputs[qi] && typeof inputs[qi].value === 'string' ? inputs[qi].value.trim() : '');
            var list = chosen[qi].slice();
            if (typed) list.push(typed);
            if (!list.length && q.options && q.options[0]) list.push(q.options[0].label);
            return list;
          });
          post({ type: 'answerQuestion', card: item.id, answers: answers });
        }));
        qRow.appendChild(button(doc, 'Dismiss', 'second', function () {
          post({ type: 'dismissQuestion', card: item.id });
        }));
        root.appendChild(qRow);
      } else {
        root.appendChild(el(doc, 'div', 'reason', item.answer));
      }
    } else if (item.kind === 'plancard') {
      var pOpen = item.state === 'open';
      root.className += ' card' + (pOpen ? '' : ' closed');
      root.appendChild(el(doc, 'div', 'who', pOpen ? 'Plan ready for approval' : 'Plan'));
      root.appendChild(el(doc, 'div', 'title', item.title || 'Plan'));
      if (pOpen && item.text) root.appendChild(el(doc, 'pre', '', item.text));
      if (pOpen) {
        var fb = el(doc, 'input', 'q-input');
        fb.setAttribute('type', 'text');
        fb.setAttribute('placeholder', 'Optional feedback to revise the plan…');
        root.appendChild(fb);
        var pRow = el(doc, 'div', 'buttons');
        pRow.appendChild(button(doc, 'Approve (Edit)', '', function () {
          post({ type: 'answerPlan', card: item.id, outcome: 'approve', value: 'edit' });
        }));
        pRow.appendChild(button(doc, 'Approve (Manual)', 'second', function () {
          post({ type: 'answerPlan', card: item.id, outcome: 'approve', value: 'manual' });
        }));
        pRow.appendChild(button(doc, 'Revise', 'second', function () {
          post({ type: 'answerPlan', card: item.id, outcome: 'revise', value: fb.value || '' });
        }));
        pRow.appendChild(button(doc, 'Dismiss', 'second', function () {
          post({ type: 'answerPlan', card: item.id, outcome: 'dismiss', value: '' });
        }));
        root.appendChild(pRow);
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
  var stopBtn = doc.getElementById('stop');
  var mode = doc.getElementById('mode');
  var model = doc.getElementById('model');
  var attached = doc.getElementById('attached');
  var attachedLabel = doc.getElementById('attached-label');
  var working = doc.getElementById('working');
  var popup = doc.getElementById('popup');
  var state = { busy: false, modes: [], models: [], mode: null, model: null, commands: [], progress: '', canSteer: false };
  var nodes = {};
  var popupState = { kind: '', tokenStart: 0, tokenEnd: 0, items: [], index: 0 };
  var fileSearchSeq = 0;

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
    if (stopBtn) stopBtn.hidden = !s.busy;
    send.textContent = s.busy ? (s.canSteer ? 'Steer' : 'Stop') : 'Send';
    working.hidden = !s.busy;
    working.textContent = s.progress || 'Working…';
    // Mode can be switched live mid-run (Edit <-> Auto, etc.).
    mode.disabled = (s.modes || []).length === 0;
    model.disabled = model.disabled || !!s.busy;
  }

  // ---- @file and /command autocomplete popup -------------------------------------------

  function hidePopup() {
    popupState = { kind: '', tokenStart: 0, tokenEnd: 0, items: [], index: 0 };
    if (popup) {
      popup.hidden = true;
      while (popup.firstChild) popup.removeChild(popup.firstChild);
    }
  }

  function renderPopup() {
    if (!popup || !popupState.items.length) return hidePopup();
    while (popup.firstChild) popup.removeChild(popup.firstChild);
    popupState.items.forEach(function (it, idx) {
      var row = el(doc, 'div', 'popup-row' + (idx === popupState.index ? ' active' : ''));
      row.setAttribute('role', 'option');
      row.appendChild(el(doc, 'span', 'popup-label', it.label));
      if (it.detail) row.appendChild(el(doc, 'span', 'popup-detail', it.detail));
      row.addEventListener('mousedown', function (ev) {
        ev.preventDefault();
        applyPopup(idx);
      });
      popup.appendChild(row);
    });
    popup.hidden = false;
  }

  function applyPopup(idx) {
    var it = popupState.items[idx];
    if (!it) return hidePopup();
    var before = prompt.value.slice(0, popupState.tokenStart);
    var after = prompt.value.slice(popupState.tokenEnd);
    var inserted = it.insert + (after.startsWith(' ') ? '' : ' ');
    prompt.value = before + inserted + after;
    var pos = (before + inserted).length;
    prompt.setSelectionRange(pos, pos);
    vscode.setState({ draft: prompt.value });
    hidePopup();
    prompt.focus();
  }

  function checkPopup() {
    var pos = prompt.selectionStart || 0;
    var before = prompt.value.slice(0, pos);
    var slash = /^\/([A-Za-z0-9_:-]*)$/.exec(before);
    if (slash) {
      var q = slash[1].toLowerCase();
      var matches = (state.commands || [])
        .filter(function (c) { return !q || c.name.toLowerCase().indexOf(q) >= 0; })
        .slice(0, 12)
        .map(function (c) { return { label: '/' + c.name, detail: c.description || '', insert: '/' + c.name }; });
      popupState = { kind: 'command', tokenStart: 0, tokenEnd: pos, items: matches, index: 0 };
      renderPopup();
      return;
    }
    var at = /(?:^|\s)@([^\s@]*)$/.exec(before);
    if (at) {
      var start = pos - at[1].length - 1;
      var seq = ++fileSearchSeq;
      popupState = { kind: 'file', tokenStart: start, tokenEnd: pos, items: popupState.kind === 'file' ? popupState.items : [], index: 0 };
      post({ type: 'searchFiles', query: at[1], seq: seq });
      return;
    }
    hidePopup();
  }

  function submit() {
    var text = prompt.value;
    if (state.busy) {
      if (state.canSteer && text.trim()) {
        post({ type: 'steer', text: text });
        prompt.value = '';
        vscode.setState({ draft: '' });
        hidePopup();
        return;
      }
      if (!state.canSteer) post({ type: 'stop' });
      return;
    }
    if (!text.trim()) return;
    post({ type: 'send', text: text });
    prompt.value = '';
    vscode.setState({ draft: '' });
    hidePopup();
  }

  send.addEventListener('click', submit);
  if (stopBtn) {
    stopBtn.addEventListener('click', function () {
      post({ type: 'stop' });
    });
  }
  prompt.addEventListener('keydown', function (ev) {
    if (popup && !popup.hidden && popupState.items.length) {
      if (ev.key === 'ArrowDown') {
        ev.preventDefault();
        popupState.index = (popupState.index + 1) % popupState.items.length;
        return renderPopup();
      }
      if (ev.key === 'ArrowUp') {
        ev.preventDefault();
        popupState.index = (popupState.index - 1 + popupState.items.length) % popupState.items.length;
        return renderPopup();
      }
      if (ev.key === 'Tab' || (ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing)) {
        ev.preventDefault();
        return applyPopup(popupState.index);
      }
      if (ev.key === 'Escape') {
        ev.preventDefault();
        return hidePopup();
      }
    }
    if (ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing) {
      ev.preventDefault();
      if (!state.busy || (state.canSteer && prompt.value.trim())) submit();
    }
  });
  prompt.addEventListener('input', function () {
    vscode.setState({ draft: prompt.value });
    checkPopup();
  });
  doc.getElementById('new').addEventListener('click', function () {
    post({ type: 'new' });
  });
  var sessionsBtn = doc.getElementById('sessions');
  if (sessionsBtn) {
    sessionsBtn.addEventListener('click', function () {
      post({ type: 'sessions' });
    });
  }
  var addFileBtn = doc.getElementById('add-file');
  if (addFileBtn) {
    addFileBtn.addEventListener('click', function () {
      post({ type: 'addFile' });
    });
  }
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
      if (t.getAttribute && t.getAttribute('data-file')) {
        var lineAttr = t.getAttribute('data-line');
        return post({ type: 'openFile', path: t.getAttribute('data-file'), line: lineAttr ? Number(lineAttr) : undefined });
      }
      if (t.tagName === 'CODE' && (!t.parentNode || t.parentNode.tagName !== 'PRE')) {
        var raw = (t.textContent || '').trim();
        var fm = /^([A-Za-z0-9_.\-\/]+\.[A-Za-z0-9]{1,10})(?::(\d+)(?:-\d+)?)?$/.exec(raw);
        if (fm) {
          return post({ type: 'openFile', path: fm[1], line: fm[2] ? Number(fm[2]) : undefined, soft: true });
        }
      }
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
    else if (m.type === 'insertText' && typeof m.text === 'string') {
      var cur = prompt.value;
      prompt.value = cur && !/\s$/.test(cur) ? cur + ' ' + m.text : cur + m.text;
      vscode.setState({ draft: prompt.value });
      prompt.focus();
    } else if (m.type === 'files' && m.seq === fileSearchSeq && popupState.kind === 'file') {
      popupState.items = (Array.isArray(m.files) ? m.files : []).slice(0, 14).map(function (f) {
        return { label: f, detail: '', insert: '@' + f };
      });
      popupState.index = 0;
      renderPopup();
    }
  });

  function showAttached(label) {
    attached.hidden = !label;
    attachedLabel.textContent = label ? 'With ' + label : '';
  }

  var saved = vscode.getState();
  if (saved && typeof saved.draft === 'string') prompt.value = saved.draft;
  post({ type: 'ready' });
})();
