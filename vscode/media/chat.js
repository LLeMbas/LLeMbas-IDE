// The chat view's one script. It draws what the extension sends: items of a transcript, and
// the Markdown of a model's text as a tree of plain objects (src/markdown.js). Everything is
// built with createElement and textContent; no markup is ever parsed from a string here.
(function () {
  'use strict';

  var MARKS = { pending: '…', in_progress: '◐', completed: '✓', failed: '✗' };
  var PLAN_MARKS = { pending: '☐', in_progress: '▸', completed: '✓' };
  var MAX_DEPTH = 8;
  var FILE_REF_RE = /^([A-Za-z0-9_.\-/]+\.[A-Za-z0-9]{1,10})(?::(\d+)(?:-\d+)?)?$/;

  function el(doc, tag, cls, text) {
    var e = doc.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null) e.textContent = String(text);
    return e;
  }

  function formatTokens(n) {
    var v = Number(n) || 0;
    if (v >= 1000000) return (v / 1000000).toFixed(1) + 'M';
    if (v >= 1000) return (v / 1000).toFixed(1) + 'k';
    return String(v);
  }

  function formatMs(ms) {
    var v = Number(ms);
    if (!Number.isFinite(v) || v < 0) return '';
    if (v < 1000) return Math.round(v) + ' ms';
    return (v / 1000).toFixed(1) + ' s';
  }

  function escapeAtPath(p) {
    return String(p || '').replace(/([ #])/g, '\\$1');
  }

  function buildInline(doc, nodes, parent, depth) {
    if (!Array.isArray(nodes) || depth > MAX_DEPTH) return;
    for (var i = 0; i < nodes.length; i++) {
      var n = nodes[i];
      if (!n || typeof n !== 'object') continue;
      if (n.t === 'text') parent.appendChild(doc.createTextNode(String(n.v)));
      else if (n.t === 'br') parent.appendChild(doc.createElement('br'));
      else if (n.t === 'code') {
        var raw = String(n.v || '');
        var isRef = FILE_REF_RE.test(raw.trim());
        var code = el(doc, 'code', isRef ? 'file-ref' : '', raw);
        if (isRef) code.setAttribute('title', 'Open ' + raw.trim());
        parent.appendChild(code);
      } else if (n.t === 'b' || n.t === 'i' || n.t === 'del') {
        var e = doc.createElement(n.t === 'b' ? 'strong' : n.t === 'i' ? 'em' : 'del');
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

  function buildBlocks(doc, blocks, parent, depth, post) {
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
        var pre = doc.createElement('pre');
        pre.appendChild(el(doc, 'code', '', b.v));
        if (post) {
          e = el(doc, 'div', 'code-block');
          var head = el(doc, 'div', 'code-head');
          head.appendChild(el(doc, 'span', 'code-lang', b.lang || 'code'));
          var tools = el(doc, 'div', 'code-tools');
          (function (codeText) {
            var copyBtn = button(doc, 'Copy', 'mini', function () {
              post({ type: 'copyCode', text: codeText });
              copyBtn.textContent = 'Copied';
              setTimeout(function () {
                copyBtn.textContent = 'Copy';
              }, 1200);
            });
            var insBtn = button(doc, 'Insert', 'mini', function () {
              post({ type: 'insertCode', text: codeText });
            });
            tools.appendChild(copyBtn);
            tools.appendChild(insBtn);
          })(String(b.v || ''));
          head.appendChild(tools);
          e.appendChild(head);
          e.appendChild(pre);
        } else {
          e = pre;
        }
      } else if (b.t === 'table') {
        e = el(doc, 'div', 'table-wrap');
        var table = doc.createElement('table');
        var align = Array.isArray(b.align) ? b.align : [];
        if (Array.isArray(b.head) && b.head.length) {
          var thead = doc.createElement('thead');
          var htr = doc.createElement('tr');
          for (var c = 0; c < b.head.length; c++) {
            var th = el(doc, 'th', align[c] ? 'align-' + align[c] : '');
            buildInline(doc, b.head[c], th, 0);
            htr.appendChild(th);
          }
          thead.appendChild(htr);
          table.appendChild(thead);
        }
        var rows = Array.isArray(b.rows) ? b.rows : [];
        if (rows.length) {
          var tbody = doc.createElement('tbody');
          for (var r = 0; r < rows.length; r++) {
            var tr = doc.createElement('tr');
            var cells = Array.isArray(rows[r]) ? rows[r] : [];
            for (var k = 0; k < cells.length; k++) {
              var td = el(doc, 'td', align[k] ? 'align-' + align[k] : '');
              buildInline(doc, cells[k], td, 0);
              tr.appendChild(td);
            }
            tbody.appendChild(tr);
          }
          table.appendChild(tbody);
        }
        e.appendChild(table);
      } else if (b.t === 'plain') {
        // A text too long to be read as Markdown: shown as it was written.
        e = el(doc, 'div', 'plain', b.v);
      } else if (b.t === 'hr') {
        e = doc.createElement('hr');
      } else if (b.t === 'quote') {
        e = doc.createElement('blockquote');
        buildBlocks(doc, b.c, e, depth + 1, post);
      } else if (b.t === 'ul' || b.t === 'ol') {
        e = doc.createElement(b.t);
        var items = Array.isArray(b.items) ? b.items : [];
        for (var j = 0; j < items.length; j++) {
          var it = items[j] || {};
          var d = Math.max(0, Math.min(5, Number(it.d) || 0));
          var liCls = d ? 'depth-' + d : '';
          if (typeof it.checked === 'boolean') liCls = (liCls ? liCls + ' ' : '') + 'task-item' + (it.checked ? ' checked' : '');
          var li = el(doc, 'li', liCls);
          if (typeof it.checked === 'boolean') {
            li.appendChild(el(doc, 'span', 'task-box', it.checked ? '☑ ' : '☐ '));
          }
          buildInline(doc, it.c, li, 0);
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
  function renderItem(doc, item, post, uiState) {
    var root = el(doc, 'div', 'item ' + String(item.kind).replace(/[^a-z]/g, ''));
    root.setAttribute('data-id', String(item.id));
    if (item.kind === 'user') {
      var uHead = el(doc, 'div', 'who-row');
      uHead.appendChild(el(doc, 'span', 'who', 'You'));
      if (item.label) uHead.appendChild(el(doc, 'span', 'badge', '[' + item.label + ']'));
      root.appendChild(uHead);
      var body = el(doc, 'div', 'body');
      body.appendChild(el(doc, 'div', 'text', item.text));
      root.appendChild(body);
    } else if (item.kind === 'agent') {
      root.appendChild(el(doc, 'div', 'who', 'LLeMbas'));
      var md = el(doc, 'div', 'md');
      if (Array.isArray(item.ast)) buildBlocks(doc, item.ast, md, 0, post);
      else md.textContent = String(item.text || '');
      root.appendChild(md);
    } else if (item.kind === 'thought') {
      var details = el(doc, 'details', 'thought-box');
      if (uiState && uiState.openDetails && uiState.openDetails[item.id]) details.open = true;
      details.addEventListener('toggle', function () {
        if (uiState && uiState.openDetails) uiState.openDetails[item.id] = !!details.open;
      });
      var txt = String(item.text || '');
      details.appendChild(el(doc, 'summary', 'thought-summary', 'Thinking · ' + txt.length + ' chars'));
      details.appendChild(el(doc, 'div', 'text', txt));
      root.appendChild(details);
    } else if (item.kind === 'note') {
      if (item.level === 'error' || item.level === 'warn') root.className += ' ' + item.level;
      root.textContent = String(item.text);
    } else if (item.kind === 'tool') {
      var stCls = item.denied ? 'denied' : item.status === 'failed' ? 'failed' : item.status === 'completed' ? 'completed' : 'running';
      root.className += ' ' + stCls;
      var markTxt = item.denied ? '⊘' : MARKS[item.status] || '…';
      root.appendChild(el(doc, 'span', 'mark', markTxt));
      var main = el(doc, 'div', 'tool-main');
      var headRow = el(doc, 'div', 'tool-head');
      if (item.toolKind) headRow.appendChild(el(doc, 'span', 'tool-kind', item.toolKind));
      headRow.appendChild(el(doc, 'span', 'title', String(item.title) + (item.denied ? ' (not allowed)' : '')));
      if (typeof item.ms === 'number') headRow.appendChild(el(doc, 'span', 'tool-ms', formatMs(item.ms)));
      main.appendChild(headRow);
      var files = Array.isArray(item.files) ? item.files : [];
      if (files.length) {
        var list = el(doc, 'div', 'files');
        files.slice(0, 20).forEach(function (path) {
          var f = el(doc, 'span', 'file-chip', String(path).split(/[\\/]/).pop());
          f.setAttribute('role', 'link');
          f.setAttribute('tabindex', '0');
          f.setAttribute('title', String(path));
          f.setAttribute('data-file', String(path));
          list.appendChild(f);
        });
        main.appendChild(list);
      }
      if (item.output && typeof item.output === 'string' && item.output.trim()) {
        var outDet = el(doc, 'details', 'tool-output');
        if (uiState && uiState.openDetails && uiState.openDetails[item.id]) outDet.open = true;
        outDet.addEventListener('toggle', function () {
          if (uiState && uiState.openDetails) uiState.openDetails[item.id] = !!outDet.open;
        });
        outDet.appendChild(el(doc, 'summary', 'tool-output-summary', item.status === 'failed' ? 'Error output' : 'Output'));
        outDet.appendChild(el(doc, 'pre', '', item.output));
        main.appendChild(outDet);
      }
      root.appendChild(main);
    } else if (item.kind === 'plan') {
      var done = Number(item.done) || 0;
      var all = Number(item.all) || 0;
      var pHead = el(doc, 'div', 'plan-head');
      pHead.appendChild(el(doc, 'span', 'mark', all > 0 && done >= all ? '✓' : '▸'));
      pHead.appendChild(el(doc, 'span', 'title', (item.title ? item.title + ' — ' : 'Plan: ') + done + ' of ' + all + ' done'));
      root.appendChild(pHead);
      if (all > 0) {
        var bar = doc.createElement('progress');
        bar.className = 'plan-progress';
        bar.setAttribute('value', String(done));
        bar.setAttribute('max', String(all));
        root.appendChild(bar);
      }
      var entries = Array.isArray(item.entries) ? item.entries : [];
      if (entries.length) {
        var plist = el(doc, 'div', 'plan-entries');
        entries.slice(0, 24).forEach(function (ent) {
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
      var who = open ? 'LLeMbas asks' + (item.tool ? ' (' + item.tool + ')' : '') : 'Asked';
      if (item.subagent) who += ' · ' + item.subagent;
      root.appendChild(el(doc, 'div', 'who', who));
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
      root.className += ' card info-card' + (qOpen ? '' : ' closed');
      root.appendChild(el(doc, 'div', 'who', qOpen ? 'LLeMbas asks a question' : 'Question'));
      if (item.why) root.appendChild(el(doc, 'div', 'reason', item.why));
      var qs = Array.isArray(item.questions) ? item.questions : [];
      if (qOpen) {
        var chosen = qs.map(function () { return []; });
        var inputs = [];
        qs.forEach(function (q, qi) {
          var blk = el(doc, 'div', 'q-block');
          if (q.header) blk.appendChild(el(doc, 'div', 'q-header', q.header + (q.multiple ? ' (choose any)' : '')));
          blk.appendChild(el(doc, 'div', 'title', q.question));
          var opts = Array.isArray(q.options) ? q.options : [];
          if (opts.length) {
            var optWrap = el(doc, 'div', 'q-options');
            var btns = [];
            opts.forEach(function (o) {
              var labelTxt = o.label + (o.recommended ? ' ★' : '') + (o.description ? ' — ' + o.description : '');
              var b = button(doc, labelTxt, 'second q-opt', function () {
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
            if (typed && !list.length) return { kind: 'custom', text: typed };
            if (typed && list.length) return { kind: 'custom', text: list.join(', ') + ' — ' + typed };
            if (list.length) return { kind: 'options', labels: list };
            return { kind: 'skipped' };
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
      root.className += ' card plan-approval' + (pOpen ? '' : ' closed');
      root.appendChild(el(doc, 'div', 'who', pOpen ? 'Plan ready for approval' : 'Plan'));
      root.appendChild(el(doc, 'div', 'title', item.title || 'Plan'));
      if (pOpen) {
        if (Array.isArray(item.ast) && item.ast.length) {
          var pmd = el(doc, 'div', 'md plan-md');
          buildBlocks(doc, item.ast, pmd, 0, post);
          root.appendChild(pmd);
        } else if (item.text) {
          root.appendChild(el(doc, 'pre', '', item.text));
        }
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
          post({ type: 'answerPlan', card: item.id, outcome: 'dismissed', value: '' });
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
  var empty = doc.getElementById('empty');
  var teamBar = doc.getElementById('team-bar');
  var connDot = doc.getElementById('conn-dot');
  var modeDot = doc.getElementById('mode-dot');
  var sessionTitle = doc.getElementById('session-title');
  var compactBtn = doc.getElementById('compact');
  var settingsToggle = doc.getElementById('settings-toggle');
  var settingsPanel = doc.getElementById('settings-panel');
  var acTokens = doc.getElementById('ac-tokens');
  var acTokensVal = doc.getElementById('ac-tokens-val');
  var acLength = doc.getElementById('ac-length');
  var acInstructions = doc.getElementById('ac-instructions');
  var acAuto = doc.getElementById('ac-auto');
  var chatThinking = doc.getElementById('chat-thinking');
  var prompt = doc.getElementById('prompt');
  var send = doc.getElementById('send');
  var stopBtn = doc.getElementById('stop');
  var mode = doc.getElementById('mode');
  var model = doc.getElementById('model');
  var attached = doc.getElementById('attached');
  var attachedLabel = doc.getElementById('attached-label');
  var working = doc.getElementById('working');
  var workingText = doc.getElementById('working-text');
  var usageEl = doc.getElementById('usage');
  var popup = doc.getElementById('popup');
  var state = { busy: false, connected: false, modes: [], models: [], mode: null, model: null, commands: [], progress: '', canSteer: false, canCompact: false, title: '', usage: null, team: null };
  var nodes = {};
  var uiState = { openDetails: {} };
  var popupState = { kind: '', tokenStart: 0, tokenEnd: 0, items: [], index: 0 };
  var fileSearchSeq = 0;

  function post(msg) {
    vscode.postMessage(msg);
  }

  function atBottom() {
    return log.scrollHeight - log.scrollTop - log.clientHeight < 40;
  }

  function syncEmpty() {
    if (!empty) return;
    empty.hidden = Object.keys(nodes).length > 0;
  }

  function autoRows() {
    var lines = (prompt.value || '').split('\n').length;
    prompt.setAttribute('rows', String(Math.max(3, Math.min(8, lines))));
  }

  function upsert(item) {
    var stick = atBottom();
    var fresh = renderItem(doc, item, post, uiState);
    var old = nodes[item.id];
    if (old && old.parentNode === log) log.replaceChild(fresh, old);
    else log.appendChild(fresh);
    nodes[item.id] = fresh;
    syncEmpty();
    if (stick) log.scrollTop = log.scrollHeight;
  }

  function reset(items) {
    var children = Array.prototype.slice.call(log.childNodes);
    children.forEach(function (ch) {
      if (ch !== empty) log.removeChild(ch);
    });
    nodes = {};
    uiState.openDetails = {};
    (items || []).forEach(upsert);
    syncEmpty();
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

  function renderTeam(tree) {
    if (!teamBar) return;
    while (teamBar.firstChild) teamBar.removeChild(teamBar.firstChild);
    var members = [];
    function walk(node) {
      if (!node || typeof node !== 'object') return;
      if (node.id && node.name) members.push(node);
      var kids = Array.isArray(node.children) ? node.children : Array.isArray(node.agents) ? node.agents : [];
      kids.forEach(walk);
    }
    if (Array.isArray(tree)) tree.forEach(walk);
    else walk(tree);
    if (!members.length) {
      teamBar.hidden = true;
      return;
    }
    teamBar.appendChild(el(doc, 'span', 'team-label', 'Agents'));
    members.slice(0, 8).forEach(function (m) {
      var chip = el(doc, 'span', 'team-chip ' + String(m.state || '').replace(/[^a-z]/g, ''));
      chip.textContent = String(m.name) + (m.state ? ' · ' + m.state : '');
      teamBar.appendChild(chip);
    });
    teamBar.hidden = false;
  }

  function showState(s) {
    state = s;
    fill(mode, s.modes || [], s.mode, 'Mode');
    fill(model, s.models || [], s.model, 'Model');
    if (stopBtn) stopBtn.hidden = !s.busy;
    send.textContent = s.busy ? (s.canSteer ? 'Steer' : 'Stop') : 'Send';
    if (working) working.hidden = !s.busy;
    if (workingText) workingText.textContent = s.progress || 'Working…';
    if (connDot) {
      connDot.className = 'dot' + (s.busy ? ' is-busy' : s.connected ? ' is-ok' : '');
      connDot.setAttribute('title', s.busy ? 'Working' : s.connected ? 'Connected' : 'Ready');
    }
    if (modeDot) {
      var mCls = String(s.mode || '').replace(/[^a-z]/g, '');
      modeDot.className = 'dot mode-dot' + (mCls ? ' mode-' + mCls : '');
    }
    if (sessionTitle) sessionTitle.textContent = s.title || 'LLeMbas';
    if (compactBtn) compactBtn.hidden = !s.canCompact;
    if (usageEl) {
      if (s.usage && (s.usage.input || s.usage.output)) {
        usageEl.textContent = '↑' + formatTokens(s.usage.input) + ' ↓' + formatTokens(s.usage.output);
        usageEl.hidden = false;
      } else {
        usageEl.hidden = true;
      }
    }
    renderTeam(s.team);
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
      var left = el(doc, 'span', 'popup-left');
      if (it.badge) left.appendChild(el(doc, 'span', 'popup-badge', it.badge));
      left.appendChild(el(doc, 'span', 'popup-label', it.label));
      row.appendChild(left);
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
    autoRows();
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
        .map(function (c) {
          return {
            badge: c.kind || 'cmd',
            label: '/' + c.name + (c.hint ? ' ' + c.hint : ''),
            detail: c.description || '',
            insert: '/' + c.name,
          };
        });
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
        autoRows();
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
    autoRows();
    vscode.setState({ draft: '' });
    hidePopup();
  }

  send.addEventListener('click', submit);
  if (stopBtn) {
    stopBtn.addEventListener('click', function () {
      post({ type: 'stop' });
    });
  }
  if (compactBtn) {
    compactBtn.addEventListener('click', function () {
      post({ type: 'compact' });
    });
  }
  if (empty) {
    empty.addEventListener('click', function (ev) {
      var btn = ev.target;
      while (btn && btn !== empty) {
        var act = btn.getAttribute && btn.getAttribute('data-action');
        if (act) {
          post({ type: act });
          return;
        }
        btn = btn.parentNode;
      }
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
    autoRows();
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
        var fm = FILE_REF_RE.exec(raw);
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

  function formatTokenReadout(n) {
    var v = Number(n) || 0;
    return v <= 0 ? 'Default' : v + ' tokens';
  }

  function applySettingsUi(cfg) {
    if (!cfg || typeof cfg !== 'object') return;
    var tokens = Math.max(0, Math.min(4096, Number(cfg.maxTokens) || 0));
    var len = typeof cfg.length === 'string' ? cfg.length : 'auto';
    if (acTokens) acTokens.value = String(tokens);
    if (acTokensVal) acTokensVal.textContent = formatTokenReadout(tokens);
    if (acLength) acLength.value = len;
    if (acInstructions && doc.activeElement !== acInstructions) acInstructions.value = String(cfg.instructions || '');
    if (acAuto) acAuto.checked = cfg.auto !== false;
    if (chatThinking) chatThinking.checked = !!cfg.showThinking;
    if (settingsPanel) {
      var btns = settingsPanel.querySelectorAll('.preset-btn');
      for (var i = 0; i < btns.length; i++) {
        var b = btns[i];
        var match = b.getAttribute('data-length') === len && Number(b.getAttribute('data-tokens')) === tokens;
        b.className = 'mini preset-btn' + (match ? ' active' : '');
      }
    }
  }

  function pushSettings(patch) {
    post({ type: 'updateSettings', settings: patch });
  }

  if (settingsToggle && settingsPanel) {
    settingsToggle.addEventListener('click', function () {
      var open = settingsPanel.hidden;
      settingsPanel.hidden = !open;
      settingsToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
    settingsPanel.addEventListener('click', function (ev) {
      var btn = ev.target;
      if (btn && btn.className && String(btn.className).indexOf('preset-btn') >= 0) {
        var len = btn.getAttribute('data-length') || 'auto';
        var toks = Number(btn.getAttribute('data-tokens')) || 0;
        applySettingsUi({
          maxTokens: toks,
          length: len,
          instructions: acInstructions ? acInstructions.value : '',
          auto: acAuto ? acAuto.checked : true,
          showThinking: chatThinking ? chatThinking.checked : false,
        });
        pushSettings({ maxTokens: toks, length: len });
      }
    });
  }
  if (acTokens) {
    acTokens.addEventListener('input', function () {
      if (acTokensVal) acTokensVal.textContent = formatTokenReadout(acTokens.value);
    });
    acTokens.addEventListener('change', function () {
      pushSettings({ maxTokens: Number(acTokens.value) || 0 });
    });
  }
  if (acLength) {
    acLength.addEventListener('change', function () {
      pushSettings({ length: acLength.value });
    });
  }
  var instrTimer = null;
  if (acInstructions) {
    acInstructions.addEventListener('input', function () {
      if (instrTimer) clearTimeout(instrTimer);
      instrTimer = setTimeout(function () {
        pushSettings({ instructions: acInstructions.value });
      }, 300);
    });
    acInstructions.addEventListener('change', function () {
      if (instrTimer) clearTimeout(instrTimer);
      pushSettings({ instructions: acInstructions.value });
    });
  }
  if (acAuto) {
    acAuto.addEventListener('change', function () {
      pushSettings({ auto: !!acAuto.checked });
    });
  }
  if (chatThinking) {
    chatThinking.addEventListener('change', function () {
      pushSettings({ showThinking: !!chatThinking.checked });
    });
  }

  window.addEventListener('message', function (ev) {
    var m = ev.data;
    if (!m || typeof m !== 'object') return;
    if (m.type === 'reset') {
      reset(m.items);
      showState(m.state);
      showAttached(m.attached);
      if (m.settings) applySettingsUi(m.settings);
    } else if (m.type === 'item') upsert(m.item);
    else if (m.type === 'state') showState(m.state);
    else if (m.type === 'settings') applySettingsUi(m.settings);
    else if (m.type === 'attached') showAttached(m.label);
    else if (m.type === 'focus') prompt.focus();
    else if (m.type === 'insertText' && typeof m.text === 'string') {
      var cur = prompt.value;
      prompt.value = cur && !/\s$/.test(cur) ? cur + ' ' + m.text : cur + m.text;
      autoRows();
      vscode.setState({ draft: prompt.value });
      prompt.focus();
    } else if (m.type === 'files' && m.seq === fileSearchSeq && popupState.kind === 'file') {
      popupState.items = (Array.isArray(m.files) ? m.files : []).slice(0, 14).map(function (entry) {
        var p = typeof entry === 'string' ? entry : String((entry && entry.path) || '');
        var isDir = typeof entry === 'object' && entry && entry.kind === 'dir';
        var slashIdx = p.lastIndexOf('/');
        var base = slashIdx >= 0 ? p.slice(slashIdx + 1) : p;
        var dir = slashIdx >= 0 ? p.slice(0, slashIdx) : '';
        var insertPath = escapeAtPath(p) + (isDir ? '/' : '');
        return {
          badge: isDir ? 'dir' : 'file',
          label: base + (isDir ? '/' : ''),
          detail: dir,
          insert: '@' + insertPath,
        };
      });
      popupState.index = 0;
      renderPopup();
    }
  });

  function showAttached(label) {
    attached.hidden = !label;
    attachedLabel.textContent = label ? 'Selection: ' + label : '';
  }

  var saved = vscode.getState();
  if (saved && typeof saved.draft === 'string') {
    prompt.value = saved.draft;
    autoRows();
  }
  post({ type: 'ready' });
})();
