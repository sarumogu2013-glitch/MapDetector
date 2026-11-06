// MD.Grid — 軽量スプレッドシート風テーブルエディタ (測点リスト・IP表などの編集用)
// - 行仮想化 (表示範囲 + バッファのみ描画) で数千行でも軽快
// - 常時フォーカスされた隠し textarea で キー入力 / IME / copy・cut・paste イベント を受ける
// - 純粋関数 (parseClipboard / toTSV / parseNumber / applyPaste ほか) は MD.Grid.* として公開 (node テスト用)
(function (root) {
  'use strict';
  root.MD = root.MD || {};

  var ROW_H = 22;          // px (css/grid.css の .md-grid-row の高さと一致させる)
  var RH_W = 44;           // 行番号列の幅
  var BUFFER = 12;         // 表示範囲外に余分に描画する行数
  var HISTORY_MAX = 100;

  // ================================================================ pure helpers

  // 全角数字・全角記号・各種マイナス・カンマ を正規化して数値化。空 → null、不正 → NaN
  function parseNumber(str) {
    if (str === null || str === undefined) return null;
    if (typeof str === 'number') return isFinite(str) ? str : NaN;
    var s = String(str);
    s = s.replace(/[０-９]/g, function (ch) { return String.fromCharCode(ch.charCodeAt(0) - 0xFF10 + 48); });
    s = s.replace(/[．。]/g, '.')              // ．。
      .replace(/[，、]/g, ',')                 // ，、
      .replace(/[－−‐‑‒–—―ーｰ﹣]/g, '-') // 各種マイナス・長音
      .replace(/＋/g, '+')
      .replace(/[ｅ]/g, 'e').replace(/[Ｅ]/g, 'E')
      .replace(/[\s　 ]+/g, '');
    if (s === '') return null;
    s = s.replace(/,/g, '');
    if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(s)) return NaN;
    var v = Number(s);
    return isFinite(v) ? v : NaN;
  }

  var THOUSANDS_RE = /^\s*[-+]?\d{1,3}(,\d{3})+(\.\d+)?\s*$/;

  // 区切り文字の推定: タブがあればタブ。無ければカンマ区切り (CSV) らしいときだけカンマ。
  function guessDelimiter(text) {
    if (text.indexOf('\t') >= 0) return '\t';
    if (text.indexOf(',') < 0) return null;
    var lines = text.replace(/\r\n?/g, '\n').replace(/\n+$/, '').split('\n').filter(function (l) { return l !== ''; });
    if (!lines.length) return null;
    if (lines.every(function (l) { return THOUSANDS_RE.test(l); })) return null; // 桁区切りの数値列
    return ',';
  }

  // Excel のクリップボード TSV (引用符付きセル内のタブ/改行, "" エスケープ, CRLF) → 2次元配列。
  // 末尾の改行は無視。delim を省略すると推定 (タブ / カンマ / 単一列)。
  function parseClipboard(text, delim) {
    if (text === null || text === undefined) return [];
    text = String(text);
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    if (delim === undefined) delim = guessDelimiter(text);
    var rows = [], row = [], field = '', i = 0, n = text.length;
    var atFieldStart = true;
    while (i < n) {
      var ch = text[i];
      if (atFieldStart && ch === '"') {
        // 引用符付きフィールド
        var j = i + 1, buf = '', closed = false;
        while (j < n) {
          var cj = text[j];
          if (cj === '"') {
            if (text[j + 1] === '"') { buf += '"'; j += 2; continue; }
            closed = true; j++; break;
          }
          buf += cj; j++;
        }
        var nx = text[j];
        if (closed && (j >= n || nx === delim || nx === '\n' || nx === '\r')) {
          field = buf.replace(/\r\n?/g, '\n'); i = j; atFieldStart = false; continue;
        }
        // 閉じ引用符の後に余計な文字 → 引用符はリテラル扱い (Excel と同様に寛容に)
        field += ch; i++; atFieldStart = false; continue;
      }
      atFieldStart = false;
      if (delim && ch === delim) { row.push(field); field = ''; i++; atFieldStart = true; continue; }
      if (ch === '\r' || ch === '\n') {
        row.push(field); rows.push(row); row = []; field = ''; atFieldStart = true;
        i += (ch === '\r' && text[i + 1] === '\n') ? 2 : 1;
        continue;
      }
      field += ch; i++;
    }
    if (!atFieldStart || field !== '' || row.length) { row.push(field); rows.push(row); }
    return rows;
  }

  function cellToString(v) {
    if (v === null || v === undefined) return '';
    if (typeof v === 'number') return isFinite(v) ? String(v) : '';
    return String(v);
  }

  // 2次元配列 → TSV (行 \r\n, セル \t)。タブ/改行/引用符を含むセルは "..." で囲む。
  function toTSV(matrix) {
    return (matrix || []).map(function (r) {
      return r.map(function (v) {
        var s = cellToString(v);
        return /[\t\r\n"]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
      }).join('\t');
    }).join('\r\n');
  }

  // 入力文字列 → 格納値。数値列: 空 → null, 数値 → number, 不正 → 文字列そのまま (赤表示)
  function convertValue(col, text) {
    if (col.type === 'number') {
      if (typeof text === 'number') return isFinite(text) ? text : null;
      var v = parseNumber(text);
      if (v === null) return null;
      if (isNaN(v)) return String(text);
      return v;
    }
    return text === null || text === undefined ? '' : String(text);
  }

  // 表示文字列 (数値列は decimals で丸め表示; 元の値は保持)
  function formatValue(col, v) {
    if (v === null || v === undefined || v === '') return '';
    if (col.type === 'number' && typeof v === 'number') {
      if (!isFinite(v)) return '';
      return col.decimals != null ? v.toFixed(col.decimals) : String(v);
    }
    return String(v);
  }

  function isInvalid(col, v) {
    if (col.type !== 'number') return false;
    if (v === null || v === undefined || v === '') return false;
    if (typeof v === 'number') return !isFinite(v);
    return true;
  }

  function defaultRow(columns) {
    var o = {};
    columns.forEach(function (c) { o[c.key] = c.type === 'number' ? null : ''; });
    return o;
  }

  function makeNewRow(columns, newRow, index) {
    var base = defaultRow(columns);
    var r = newRow ? newRow(index) : null;
    return r ? Object.assign(base, r) : base;
  }

  // 貼り付け (startRow,startCol 起点)。既存行は変更分だけ新オブジェクトに置換、行末を超えたら newRow() で追加。
  // 列数を超えたセルは無視、readOnly 列は飛ばす (位置は消費)。新しい rows 配列を返す。
  function applyPaste(rows, columns, startRow, startCol, matrix, newRow) {
    var out = rows.slice();
    for (var i = 0; i < matrix.length; i++) {
      var r = startRow + i;
      while (out.length < r) out.push(makeNewRow(columns, newRow, out.length));
      var obj = r < out.length ? Object.assign({}, out[r]) : makeNewRow(columns, newRow, r);
      var line = matrix[i];
      for (var j = 0; j < line.length; j++) {
        var c = startCol + j;
        if (c >= columns.length) break;
        var col = columns[c];
        if (col.readOnly) continue;
        obj[col.key] = convertValue(col, line[j]);
      }
      out[r] = obj;
    }
    return out;
  }

  function escHtml(s) {
    return s.replace(/[&<>"]/g, function (c) { return c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&quot;'; });
  }

  function cloneRows(rows) { return rows.map(function (o) { return Object.assign({}, o); }); }

  // ================================================================ component

  function Grid(container, opts) {
    if (!(this instanceof Grid)) return new Grid(container, opts);
    opts = opts || {};
    var self = this;
    this.container = container;
    this.columns = (opts.columns || []).map(function (c) {
      var o = Object.assign({}, c);
      if (!o.type) o.type = 'text';
      if (!o.width) o.width = o.type === 'number' ? 90 : 100;
      if (o.label == null) o.label = o.key;
      return o;
    });
    this.opts = opts;
    this.rows = cloneRows(opts.rows || []);
    this.undoStack = []; this.redoStack = [];
    this.anchor = { r: 0, c: 0 };   // アクティブセル
    this.cursor = { r: 0, c: 0 };   // 範囲のもう一方の端 (shift 操作で動く)
    this.editing = null;            // {r, c, mode:'enter'|'edit', orig}
    this.drag = null;
    this.lastSelRow = -1;
    this.colLeft = [];
    var x = RH_W;
    this.columns.forEach(function (c, i) { self.colLeft[i] = x; x += c.width; });
    this.totalW = x;

    // ---- DOM
    var rootEl = this.el = document.createElement('div');
    rootEl.className = 'md-grid';
    var scroll = this.scrollEl = document.createElement('div');
    scroll.className = 'md-grid-scroll';
    if (opts.height != null) scroll.style.maxHeight = typeof opts.height === 'number' ? opts.height + 'px' : opts.height;
    var inner = document.createElement('div');
    inner.className = 'md-grid-inner';
    inner.style.width = this.totalW + 'px';
    var head = this.headEl = document.createElement('div');
    head.className = 'md-grid-row md-grid-head';
    var hh = '<div class="md-grid-corner" style="width:' + RH_W + 'px" title="すべて選択"></div>';
    this.columns.forEach(function (c, i) {
      hh += '<div class="md-grid-ch' + (c.type === 'number' ? ' md-grid-num' : '') + '" data-c="' + i + '" style="width:' + c.width + 'px" title="' + escHtml(String(c.label)) + '">' + escHtml(String(c.label)) + '</div>';
    });
    head.innerHTML = hh;
    var body = this.bodyEl = document.createElement('div');
    body.className = 'md-grid-body';
    var layer = this.layerEl = document.createElement('div');
    layer.className = 'md-grid-layer';
    var ta = this.input = document.createElement('textarea');
    ta.className = 'md-grid-input';
    ta.setAttribute('autocomplete', 'off'); ta.setAttribute('autocorrect', 'off');
    ta.setAttribute('autocapitalize', 'off'); ta.setAttribute('spellcheck', 'false');
    ta.setAttribute('wrap', 'off');
    ta.setAttribute('aria-label', '表のセル入力');
    body.appendChild(layer); body.appendChild(ta);
    inner.appendChild(head); inner.appendChild(body);
    scroll.appendChild(inner);
    var toastEl = this.toastEl = document.createElement('div');
    toastEl.className = 'md-grid-toast'; toastEl.hidden = true;
    rootEl.appendChild(scroll); rootEl.appendChild(toastEl);
    container.appendChild(rootEl);

    // ---- events
    this._h = {};
    var on = function (el, type, fn, name, cap) { el.addEventListener(type, fn, !!cap); self._h[name || type] = { el: el, type: type, fn: fn, cap: !!cap }; };
    on(scroll, 'scroll', function () { self._scheduleRender(); });
    on(scroll, 'mousedown', function (e) { self._onMouseDown(e); });
    on(scroll, 'contextmenu', function (e) { self._onContextMenu(e); });
    on(ta, 'keydown', function (e) { self._onKeyDown(e); });
    on(ta, 'keypress', function (e) { if (!e.ctrlKey && !e.metaKey) e.stopPropagation(); });
    on(ta, 'keyup', function (e) { if (!e.ctrlKey && !e.metaKey && !e.altKey) e.stopPropagation(); });
    on(ta, 'compositionstart', function () { if (!self.editing) self._beginEdit('', 'enter', true); });
    on(ta, 'input', function () {
      if (!self.editing && ta.value !== '') { var v = ta.value; self._beginEdit(v, 'enter', true); }
      if (self.editing) self._autoSizeEditor();
    });
    on(ta, 'copy', function (e) { self._onCopy(e, false); });
    on(ta, 'cut', function (e) { self._onCopy(e, true); });
    on(ta, 'paste', function (e) { self._onPaste(e); });
    on(ta, 'focus', function () { rootEl.classList.add('md-grid-focused'); });
    on(ta, 'blur', function () {
      rootEl.classList.remove('md-grid-focused');
      if (self.editing && !self._keepEditOnBlur) self._commitEdit();
    });
    on(document, 'mousemove', function (e) { self._onMouseMove(e); }, 'docmove');
    on(document, 'mouseup', function () { self._onMouseUp(); }, 'docup');
    on(document, 'mousedown', function (e) { if (self.menuEl && !self.menuEl.contains(e.target)) self._closeMenu(); }, 'docdown', true);
    on(window, 'resize', function () { self._scheduleRender(); }, 'resize');

    if (typeof ResizeObserver !== 'undefined') {
      this._ro = new ResizeObserver(function () { self._scheduleRender(); });
      this._ro.observe(scroll);
    }
    this._render();
  }

  var P = Grid.prototype;

  // ---------------------------------------------------------------- public API
  P.setRows = function (rows) {
    if (this.editing) this._cancelEdit();
    this.rows = cloneRows(rows || []);
    this.undoStack = []; this.redoStack = [];
    this._clampSel();
    this._render();
  };
  P.getRows = function () { return cloneRows(this.rows); };
  P.focus = function () { try { this.input.focus({ preventScroll: true }); } catch (e) { this.input.focus(); } };
  P.hasFocus = function () { return document.activeElement === this.input || !!(this.menuEl); };
  P.selectRow = function (i, silent) {
    if (this.editing) this._commitEdit();
    i = Math.max(0, Math.min(this.rows.length - 1, i | 0));
    if (!this.rows.length) i = 0;
    this.anchor = { r: i, c: Math.min(this.anchor.c, this.columns.length - 1) };
    this.cursor = { r: i, c: this.anchor.c };
    this._scrollIntoView(i, this.anchor.c, true);
    this._afterSelChange(silent);
  };
  P.getSelection = function () {
    var s = this._range();
    return { row: this.anchor.r, col: this.anchor.c, r0: s.r0, c0: s.c0, r1: s.r1, c1: s.c1 };
  };
  P.insertRow = function (atIndex, count) {
    if (this.editing) this._commitEdit();
    var n = this.rows.length;
    var at = atIndex == null ? Math.min(this.anchor.r, n) : Math.max(0, Math.min(n, atIndex | 0));
    count = Math.max(1, count | 0 || 1);
    this._pushHistory();
    var add = [];
    for (var k = 0; k < count; k++) add.push(makeNewRow(this.columns, this.opts.newRow, at + k));
    this.rows = this.rows.slice(0, at).concat(add, this.rows.slice(at));
    this.anchor = { r: at, c: this.anchor.c }; this.cursor = { r: at + count - 1, c: this.anchor.c };
    this._changed('insert');
    this._scrollIntoView(at, this.anchor.c);
    this._afterSelChange();
  };
  P.deleteSelectedRows = function () {
    if (this.editing) this._cancelEdit();
    var s = this._range();
    var r1 = Math.min(s.r1, this.rows.length - 1);
    if (s.r0 > r1) return;
    this._pushHistory();
    this.rows = this.rows.slice(0, s.r0).concat(this.rows.slice(r1 + 1));
    var r = Math.min(s.r0, Math.max(0, this.rows.length - 1));
    this.anchor = { r: r, c: this.anchor.c }; this.cursor = { r: r, c: this.anchor.c };
    this._changed('delete');
    this._afterSelChange();
  };
  P.undo = function () { this._undoRedo(this.undoStack, this.redoStack, 'undo'); };
  P.redo = function () { this._undoRedo(this.redoStack, this.undoStack, 'redo'); };
  P.destroy = function () {
    this._closeMenu();
    var h = this._h;
    Object.keys(h).forEach(function (k) { h[k].el.removeEventListener(h[k].type, h[k].fn, h[k].cap); });
    this._h = {};
    if (this._ro) this._ro.disconnect();
    if (this._raf) cancelAnimationFrame(this._raf);
    clearTimeout(this._toastTimer);
    if (this.el.parentNode) this.el.parentNode.removeChild(this.el);
  };
  P.refresh = function () { this._render(); };

  // ---------------------------------------------------------------- selection helpers
  P._maxRow = function () { return this.rows.length; }; // rows.length = 末尾の新規入力行
  P._range = function () {
    return {
      r0: Math.min(this.anchor.r, this.cursor.r), r1: Math.max(this.anchor.r, this.cursor.r),
      c0: Math.min(this.anchor.c, this.cursor.c), c1: Math.max(this.anchor.c, this.cursor.c)
    };
  };
  P._clampSel = function () {
    var mr = this._maxRow(), mc = Math.max(0, this.columns.length - 1);
    [this.anchor, this.cursor].forEach(function (p) { p.r = Math.max(0, Math.min(mr, p.r)); p.c = Math.max(0, Math.min(mc, p.c)); });
  };
  P._setActive = function (r, c, extend) {
    var mr = this._maxRow(), mc = this.columns.length - 1;
    r = Math.max(0, Math.min(mr, r)); c = Math.max(0, Math.min(mc, c));
    if (extend) this.cursor = { r: r, c: c };
    else { this.anchor = { r: r, c: c }; this.cursor = { r: r, c: c }; }
    this._scrollIntoView(extend ? r : this.anchor.r, extend ? c : this.anchor.c);
    this._afterSelChange();
  };
  P._afterSelChange = function (silent) {
    this._render();
    var r = this.anchor.r;
    if (r !== this.lastSelRow) {
      this.lastSelRow = r;
      if (!silent && this.opts.onSelect && r < this.rows.length) this.opts.onSelect(r);
    }
  };
  P._pageRows = function () { return Math.max(1, Math.floor((this.scrollEl.clientHeight - ROW_H) / ROW_H) - 1); };
  P._scrollIntoView = function (r, c, center) {
    var sc = this.scrollEl, top = r * ROW_H, viewH = sc.clientHeight - ROW_H; // ヘッダ分を除く
    var bodyTop = sc.scrollTop;
    if (center && (top < bodyTop || top + ROW_H > bodyTop + viewH)) sc.scrollTop = Math.max(0, top - viewH / 2);
    else if (top < bodyTop) sc.scrollTop = top;
    else if (top + ROW_H > bodyTop + viewH) sc.scrollTop = top + ROW_H - viewH;
    if (c != null && this.columns[c]) {
      var l = this.colLeft[c], w = this.columns[c].width, vl = sc.scrollLeft, vw = sc.clientWidth;
      if (l - RH_W < vl) sc.scrollLeft = l - RH_W;
      else if (l + w > vl + vw) sc.scrollLeft = l + w - vw;
    }
  };

  // ---------------------------------------------------------------- rendering
  P._scheduleRender = function () {
    var self = this;
    if (this._raf) return;
    this._raf = requestAnimationFrame(function () { self._raf = 0; self._render(); });
  };
  P._render = function () {
    var cols = this.columns, rows = this.rows, n = rows.length, total = n + 1;
    var sc = this.scrollEl;
    this.bodyEl.style.height = (total * ROW_H) + 'px';
    var viewH = sc.clientHeight || 300;
    var start = Math.max(0, Math.floor(sc.scrollTop / ROW_H) - BUFFER);
    var end = Math.min(total, Math.ceil((sc.scrollTop + viewH) / ROW_H) + BUFFER);
    var s = this._range();
    var html = [];
    for (var r = start; r < end; r++) {
      var isNew = r === n;
      var rowSel = r >= s.r0 && r <= s.r1;
      html.push('<div class="md-grid-row' + (isNew ? ' md-grid-newrow' : '') + '" style="top:' + (r * ROW_H) + 'px">');
      html.push('<div class="md-grid-rh' + (rowSel ? ' md-grid-rh-sel' : '') + '" data-r="' + r + '" style="width:' + RH_W + 'px">' + (isNew ? '*' : (r + 1)) + '</div>');
      var obj = isNew ? null : rows[r];
      for (var c = 0; c < cols.length; c++) {
        var col = cols[c], v = obj ? obj[col.key] : null;
        var cls = 'md-grid-cell';
        if (col.type === 'number') cls += ' md-grid-num';
        if (col.readOnly) cls += ' md-grid-ro';
        if (rowSel && c >= s.c0 && c <= s.c1) cls += ' md-grid-sel';
        if (r === this.anchor.r && c === this.anchor.c) cls += ' md-grid-active';
        if (obj && isInvalid(col, v)) cls += ' md-grid-invalid';
        var txt = obj ? escHtml(formatValue(col, v)) : '';
        html.push('<div class="' + cls + '" data-r="' + r + '" data-c="' + c + '" style="width:' + col.width + 'px">' + txt + '</div>');
      }
      html.push('</div>');
    }
    this.layerEl.innerHTML = html.join('');
    // 列見出しの選択表示
    var hc = this.headEl.children;
    for (var k = 1; k < hc.length; k++) {
      var ci = k - 1;
      hc[k].classList.toggle('md-grid-ch-sel', ci >= s.c0 && ci <= s.c1);
    }
    this._placeInput();
  };
  P._placeInput = function () {
    var ta = this.input, a = this.editing || this.anchor, col = this.columns[a.c];
    if (!col) return;
    ta.style.top = (a.r * ROW_H) + 'px';
    ta.style.left = this.colLeft[a.c] + 'px';
    if (this.editing) {
      ta.style.width = col.width + 'px';
      ta.style.height = ROW_H + 'px';
      this._autoSizeEditor();
    } else {
      ta.style.width = '2px';
      ta.style.height = ROW_H + 'px';
    }
  };
  P._autoSizeEditor = function () {
    var ta = this.input, col = this.columns[this.editing.c];
    ta.style.width = col.width + 'px';
    var need = ta.scrollWidth + 4;
    if (need > col.width) ta.style.width = Math.min(need, 600) + 'px';
  };

  // ---------------------------------------------------------------- editing
  P._beginEdit = function (text, mode, keepValue) {
    var a = this.anchor, col = this.columns[a.c];
    if (!col || col.readOnly) { if (keepValue) this.input.value = ''; return false; }
    this.cursor = { r: a.r, c: a.c };
    var obj = this.rows[a.r];
    this.editing = { r: a.r, c: a.c, mode: mode, orig: obj ? obj[col.key] : null };
    var ta = this.input;
    if (!keepValue) ta.value = text;
    this.el.classList.add('md-grid-is-editing');
    ta.classList.add('md-grid-editing');
    ta.classList.toggle('md-grid-input-num', col.type === 'number');
    this._render();
    if (!keepValue) { var L = ta.value.length; try { ta.setSelectionRange(L, L); } catch (e) { /* ignore */ } }
    return true;
  };
  P._endEditUi = function () {
    this.editing = null;
    this.input.value = '';
    this.input.classList.remove('md-grid-editing');
    this.el.classList.remove('md-grid-is-editing');
  };
  P._cancelEdit = function () { this._endEditUi(); this._render(); };
  P._commitEdit = function () {
    var ed = this.editing;
    if (!ed) return;
    var text = this.input.value.replace(/\r?\n/g, ' ');
    this._endEditUi();
    var col = this.columns[ed.c];
    var nv = convertValue(col, text);
    var obj = this.rows[ed.r];
    if (!obj && (nv === null || nv === '')) { this._render(); return; } // 新規行に空入力 → 何もしない
    if (obj && sameValue(obj[col.key], nv)) { this._render(); return; }
    this._pushHistory();
    this.rows = applyPaste(this.rows, this.columns, ed.r, 0, [[]], this.opts.newRow); // 行確保
    var o = Object.assign({}, this.rows[ed.r]); o[col.key] = nv;
    this.rows[ed.r] = o;
    this._changed('edit');
    this._render();
  };
  function sameValue(a, b) {
    if ((a === null || a === undefined || a === '') && (b === null || b === undefined || b === '')) return true;
    return a === b;
  }

  // ---------------------------------------------------------------- history / change
  P._snapshot = function () { return { rows: this.rows.slice(), anchor: Object.assign({}, this.anchor), cursor: Object.assign({}, this.cursor) }; };
  P._pushHistory = function () {
    this.undoStack.push(this._snapshot());
    if (this.undoStack.length > HISTORY_MAX) this.undoStack.shift();
    this.redoStack = [];
  };
  P._undoRedo = function (from, to, type) {
    if (this.editing) this._cancelEdit();
    if (!from.length) return;
    to.push(this._snapshot());
    if (to.length > HISTORY_MAX) to.shift();
    var s = from.pop();
    this.rows = s.rows; this.anchor = s.anchor; this.cursor = s.cursor;
    this._clampSel();
    this._changed(type);
    this._scrollIntoView(this.anchor.r, this.anchor.c);
    this._afterSelChange();
  };
  P._changed = function (type) {
    if (this.opts.onChange) this.opts.onChange(cloneRows(this.rows), { type: type });
  };

  // ---------------------------------------------------------------- clipboard
  P._selectionMatrix = function () {
    var s = this._range(), out = [];
    var r1 = Math.min(s.r1, this.rows.length - 1);
    for (var r = s.r0; r <= r1; r++) {
      var line = [];
      for (var c = s.c0; c <= s.c1; c++) line.push(this.rows[r][this.columns[c].key]);
      out.push(line);
    }
    return out;
  };
  P.copyText = function () { return toTSV(this._selectionMatrix()); };
  P._onCopy = function (e, cut) {
    if (this.editing) return; // 編集中はテキストの通常コピー
    var text = this.copyText();
    if (e.clipboardData) { e.clipboardData.setData('text/plain', text); e.preventDefault(); }
    else if (navigator.clipboard) navigator.clipboard.writeText(text).catch(function () { /* ignore */ });
    if (cut) this.clearSelection('clear');
  };
  P._onPaste = function (e) {
    if (this.editing) return; // 編集中は textarea へ通常貼り付け
    var text = e.clipboardData ? e.clipboardData.getData('text/plain') || e.clipboardData.getData('text') : '';
    e.preventDefault();
    this.pasteText(text);
  };
  P.pasteText = function (text) {
    if (this.editing) this._commitEdit();
    var m = parseClipboard(text);
    if (!m.length) return;
    var s = this._range();
    var multi = s.r0 !== s.r1 || s.c0 !== s.c1;
    if (m.length === 1 && m[0].length === 1 && multi) {
      // 単一値を選択範囲に埋める
      var r1 = Math.min(s.r1, this.rows.length - 1), fill = [];
      for (var r = s.r0; r <= r1; r++) { var l = []; for (var c = s.c0; c <= s.c1; c++) l.push(m[0][0]); fill.push(l); }
      if (!fill.length) fill = [[m[0][0]]];
      m = fill;
    }
    var wmax = 0; m.forEach(function (l) { wmax = Math.max(wmax, l.length); });
    this._pushHistory();
    this.rows = applyPaste(this.rows, this.columns, s.r0, s.c0, m, this.opts.newRow);
    this.anchor = { r: s.r0, c: s.c0 };
    this.cursor = { r: s.r0 + m.length - 1, c: Math.min(this.columns.length - 1, s.c0 + wmax - 1) };
    this._changed('paste');
    this._scrollIntoView(this.anchor.r, this.anchor.c);
    this._afterSelChange();
  };
  P.clearSelection = function (type) {
    var s = this._range(), cols = this.columns;
    var r1 = Math.min(s.r1, this.rows.length - 1);
    var changed = false, out = this.rows.slice();
    for (var r = s.r0; r <= r1; r++) {
      var o = null;
      for (var c = s.c0; c <= s.c1; c++) {
        var col = cols[c];
        if (col.readOnly) continue;
        var empty = col.type === 'number' ? null : '';
        if (sameValue(out[r][col.key], empty)) continue;
        if (!o) o = Object.assign({}, out[r]);
        o[col.key] = empty;
      }
      if (o) { out[r] = o; changed = true; }
    }
    if (!changed) return;
    this._pushHistory();
    this.rows = out;
    this._changed(type || 'clear');
    this._render();
  };

  // ---------------------------------------------------------------- keyboard
  P._onKeyDown = function (e) {
    if (e.isComposing || e.keyCode === 229) { e.stopPropagation(); return; } // IME 変換中
    var key = e.key, ctrl = e.ctrlKey || e.metaKey, shift = e.shiftKey;
    var handled = true, ed = this.editing;
    var a = this.anchor, cur = this.cursor;
    var lastC = this.columns.length - 1, maxR = this._maxRow();

    if (this.menuEl && key === 'Escape') { this._closeMenu(); e.preventDefault(); e.stopPropagation(); return; }

    if (ed) {
      var enterMode = ed.mode === 'enter';
      switch (key) {
        case 'Enter':
          if (e.altKey) { handled = false; break; }
          this._commitEdit(); this._setActive(a.r + (shift ? -1 : 1), a.c); break;
        case 'Tab': this._commitEdit(); this._moveTab(shift); break;
        case 'Escape': this._cancelEdit(); break;
        case 'ArrowUp': case 'ArrowDown': case 'ArrowLeft': case 'ArrowRight':
          if (enterMode) { this._commitEdit(); this._arrow(key, false, false); }
          else { e.stopPropagation(); return; } // 編集モード: キャレット移動 (既定動作)
          break;
        case 'F2': ed.mode = enterMode ? 'edit' : 'enter'; break;
        default:
          // 編集中のその他キー (文字入力, Backspace, Ctrl+C/V/Z 等) は textarea の既定動作。アプリへは漏らさない
          if (!ctrl || 'acvxyz'.indexOf(key.toLowerCase()) >= 0 || key.length > 1) e.stopPropagation();
          return;
      }
      if (handled) { e.preventDefault(); e.stopPropagation(); }
      return;
    }

    var lower = key.length === 1 ? key.toLowerCase() : key;
    if (ctrl && !e.altKey) {
      switch (lower) {
        case 'c': case 'x': case 'v': e.stopPropagation(); return; // copy/cut/paste イベントで処理
        case 'a': this.anchor = { r: 0, c: 0 }; this.cursor = { r: Math.max(0, this.rows.length - 1), c: lastC }; this._afterSelChange(); break;
        case 'z': if (shift) this.redo(); else this.undo(); break;
        case 'y': this.redo(); break;
        case 'Home': this._setActive(0, 0, shift); break;
        case 'End': this._setActive(Math.max(0, this.rows.length - 1), lastC, shift); break;
        case 'ArrowUp': this._setActive(0, (shift ? cur : a).c, shift); break;
        case 'ArrowDown': this._setActive(Math.max(0, this.rows.length - 1), (shift ? cur : a).c, shift); break;
        case 'ArrowLeft': this._setActive((shift ? cur : a).r, 0, shift); break;
        case 'ArrowRight': this._setActive((shift ? cur : a).r, lastC, shift); break;
        case 'Enter': handled = false; break;
        default: handled = false;
      }
    } else if (e.altKey) {
      handled = false;
    } else {
      switch (key) {
        case 'ArrowUp': case 'ArrowDown': case 'ArrowLeft': case 'ArrowRight':
          this._arrow(key, shift); break;
        case 'Tab': this._moveTab(shift); break;
        case 'Enter': this._setActive(a.r + (shift ? -1 : 1), a.c); break;
        case 'Home': this._setActive((shift ? cur : a).r, 0, shift); break;
        case 'End': this._setActive((shift ? cur : a).r, lastC, shift); break;
        case 'PageUp': case 'PageDown': {
          var d = this._pageRows() * (key === 'PageUp' ? -1 : 1);
          var p = shift ? cur : a;
          this._setActive(Math.max(0, Math.min(maxR, p.r + d)), p.c, shift); break;
        }
        case 'F2': this._beginEdit(this._cellText(a.r, a.c), 'edit'); break;
        case 'Delete': case 'Backspace': this.clearSelection('clear'); break;
        case 'Escape':
          // 複数選択の解除のみ処理。単一セル時はアプリ (ダイアログを閉じる等) へ渡す
          if (a.r !== cur.r || a.c !== cur.c) { this.cursor = { r: a.r, c: a.c }; this._render(); } else handled = false;
          break;
        default:
          if (key.length === 1) {
            // 印字可能文字 → 置換入力開始。文字自体は既定動作で textarea に入る
            if (!this._beginEdit('', 'enter')) { e.preventDefault(); }
            e.stopPropagation();
            return;
          }
          handled = false;
      }
    }
    if (handled) { e.preventDefault(); e.stopPropagation(); }
  };
  P._arrow = function (key, shift) {
    var p = shift ? this.cursor : this.anchor;
    var dr = key === 'ArrowUp' ? -1 : key === 'ArrowDown' ? 1 : 0;
    var dc = key === 'ArrowLeft' ? -1 : key === 'ArrowRight' ? 1 : 0;
    this._setActive(p.r + dr, p.c + dc, shift);
  };
  P._moveTab = function (back) {
    var a = this.anchor, lastC = this.columns.length - 1, r = a.r, c = a.c + (back ? -1 : 1);
    if (c > lastC) { if (r < this._maxRow()) { r++; c = 0; } else c = lastC; }
    else if (c < 0) { if (r > 0) { r--; c = lastC; } else c = 0; }
    this._setActive(r, c);
  };
  P._cellText = function (r, c) {
    var obj = this.rows[r], col = this.columns[c];
    return obj ? cellToString(obj[col.key]) : '';
  };

  // ---------------------------------------------------------------- mouse
  P._hit = function (e) {
    var rect = this.bodyEl.getBoundingClientRect();
    var y = e.clientY - rect.top, x = e.clientX - rect.left;
    var r = Math.floor(y / ROW_H), c = 0;
    for (var i = 0; i < this.columns.length; i++) if (x >= this.colLeft[i]) c = i;
    return { r: Math.max(0, Math.min(this._maxRow(), r)), c: c };
  };
  P._onMouseDown = function (e) {
    var t = e.target;
    if (t === this.input && this.editing) return; // 編集中のテキスト操作
    if (this.editing) this._commitEdit();
    var right = e.button === 2;
    if (e.button !== 0 && !right) return;
    e.preventDefault();
    this.focus();
    var lastC = this.columns.length - 1;
    var s = this._range();
    if (t.closest && t.closest('.md-grid-corner')) {
      this.anchor = { r: 0, c: 0 }; this.cursor = { r: Math.max(0, this.rows.length - 1), c: lastC }; this._afterSelChange(); return;
    }
    var ch = t.closest && t.closest('.md-grid-ch');
    if (ch) {
      var cc = +ch.getAttribute('data-c'), lastR = Math.max(0, this.rows.length - 1);
      if (right && cc >= s.c0 && cc <= s.c1) return;
      if (e.shiftKey && !right) { this.anchor = { r: 0, c: this.anchor.c }; this.cursor = { r: lastR, c: cc }; }
      else { this.anchor = { r: 0, c: cc }; this.cursor = { r: lastR, c: cc }; }
      if (!right) this.drag = { mode: 'col' };
      this._afterSelChange(); return;
    }
    var rh = t.closest && t.closest('.md-grid-rh');
    var h = this._hit(e);
    if (rh) {
      var rr = +rh.getAttribute('data-r');
      if (right && rr >= s.r0 && rr <= s.r1) return;
      if (e.shiftKey && !right) { this.anchor = { r: this.anchor.r, c: 0 }; this.cursor = { r: rr, c: lastC }; }
      else { this.anchor = { r: rr, c: 0 }; this.cursor = { r: rr, c: lastC }; }
      if (!right) this.drag = { mode: 'row' };
      this._afterSelChange(); return;
    }
    if (!t.closest || !t.closest('.md-grid-cell')) return;
    if (right && h.r >= s.r0 && h.r <= s.r1 && h.c >= s.c0 && h.c <= s.c1) return;
    // ダブルクリック判定 (mousedown で再描画されるため dblclick イベントは当てにしない)
    var now = Date.now(), lc = this._lastClick;
    this._lastClick = right || e.shiftKey ? null : { r: h.r, c: h.c, t: now };
    if (!right && !e.shiftKey && lc && lc.r === h.r && lc.c === h.c && now - lc.t < 500) {
      this._lastClick = null;
      this.anchor = { r: h.r, c: h.c }; this.cursor = { r: h.r, c: h.c };
      this._afterSelChange();
      this._beginEdit(this._cellText(h.r, h.c), 'edit');
      return;
    }
    if (e.shiftKey && !right) this.cursor = { r: h.r, c: h.c };
    else { this.anchor = { r: h.r, c: h.c }; this.cursor = { r: h.r, c: h.c }; }
    if (!right) this.drag = { mode: 'cell' };
    this._afterSelChange();
  };
  P._onMouseMove = function (e) {
    if (!this.drag) return;
    var sc = this.scrollEl, sr = sc.getBoundingClientRect();
    if (e.clientY > sr.bottom) sc.scrollTop += Math.min(60, e.clientY - sr.bottom);
    else if (e.clientY < sr.top + ROW_H) sc.scrollTop -= Math.min(60, sr.top + ROW_H - e.clientY);
    var h = this._hit(e), lastC = this.columns.length - 1;
    var nc;
    if (this.drag.mode === 'row') nc = { r: h.r, c: lastC };
    else if (this.drag.mode === 'col') nc = { r: Math.max(0, this.rows.length - 1), c: h.c };
    else nc = h;
    if (nc.r !== this.cursor.r || nc.c !== this.cursor.c) { this.cursor = nc; this._render(); }
  };
  P._onMouseUp = function () { this.drag = null; };
  // ---------------------------------------------------------------- context menu / toast
  P._onContextMenu = function (e) {
    e.preventDefault(); e.stopPropagation();
    if (e.target === this.input && this.editing) return;
    this._openMenu(e.clientX, e.clientY);
  };
  P._openMenu = function (x, y) {
    var self = this;
    this._closeMenu();
    var s = this._range();
    var nSel = Math.max(1, Math.min(s.r1, this.rows.length - 1) - s.r0 + 1);
    var items = [
      { label: '上に行を挿入', fn: function () { self.insertRow(Math.min(s.r0, self.rows.length), nSel); } },
      { label: '下に行を挿入', fn: function () { self.insertRow(Math.min(s.r1 + 1, self.rows.length), nSel); } },
      { label: '行を削除', fn: function () { self.deleteSelectedRows(); }, disabled: s.r0 >= this.rows.length },
      null,
      { label: 'コピー', key: 'Ctrl+C', fn: function () { self._menuCopy(); } },
      { label: '貼り付け', key: 'Ctrl+V', fn: function () { self._menuPaste(); } },
      { label: 'クリア', key: 'Delete', fn: function () { self.clearSelection('clear'); } }
    ];
    var m = this.menuEl = document.createElement('div');
    m.className = 'md-grid-menu';
    items.forEach(function (it) {
      if (!it) { var sep = document.createElement('div'); sep.className = 'md-grid-menu-sep'; m.appendChild(sep); return; }
      var d = document.createElement('div');
      d.className = 'md-grid-menu-item' + (it.disabled ? ' md-grid-menu-disabled' : '');
      d.innerHTML = '<span>' + escHtml(it.label) + '</span>' + (it.key ? '<span class="md-grid-menu-key">' + it.key + '</span>' : '');
      d.addEventListener('mousedown', function (ev) { ev.preventDefault(); ev.stopPropagation(); });
      d.addEventListener('click', function (ev) {
        ev.stopPropagation();
        if (it.disabled) return;
        self._closeMenu(); self.focus(); it.fn();
      });
      m.appendChild(d);
    });
    m.addEventListener('contextmenu', function (ev) { ev.preventDefault(); });
    document.body.appendChild(m);
    var w = m.offsetWidth, h = m.offsetHeight;
    var vw = window.innerWidth, vh = window.innerHeight;
    m.style.left = Math.max(0, Math.min(x, vw - w - 4)) + 'px';
    m.style.top = Math.max(0, Math.min(y, vh - h - 4)) + 'px';
  };
  P._closeMenu = function () {
    if (this.menuEl) { if (this.menuEl.parentNode) this.menuEl.parentNode.removeChild(this.menuEl); this.menuEl = null; }
  };
  P._menuCopy = function () {
    var ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    if (!ok) {
      var self = this, text = this.copyText();
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).catch(function () { self.toast('コピーできませんでした (Ctrl+C を使用してください)'); });
      else this.toast('コピーできませんでした (Ctrl+C を使用してください)');
    }
  };
  P._menuPaste = function () {
    var self = this;
    if (!navigator.clipboard || !navigator.clipboard.readText) { this.toast('クリップボードを読み取れません。Ctrl+V で貼り付けてください'); return; }
    navigator.clipboard.readText().then(function (text) { self.focus(); self.pasteText(text); })
      .catch(function () { self.toast('クリップボードを読み取れません。Ctrl+V で貼り付けてください'); });
  };
  P.toast = function (msg, ms) {
    var t = this.toastEl, self = this;
    t.textContent = msg; t.hidden = false;
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(function () { t.hidden = true; }, ms || 2500);
  };

  // ---------------------------------------------------------------- exports
  Grid.parseNumber = parseNumber;
  Grid.parseClipboard = parseClipboard;
  Grid.guessDelimiter = guessDelimiter;
  Grid.toTSV = toTSV;
  Grid.applyPaste = applyPaste;
  Grid.convertValue = convertValue;
  Grid.formatValue = formatValue;
  Grid.isInvalid = isInvalid;
  Grid.ROW_HEIGHT = ROW_H;

  root.MD.Grid = Grid;
})(typeof window !== 'undefined' ? window : globalThis);
