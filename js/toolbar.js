// MD.Toolbar — メニューバー直下の横並びツールバー
(function (root) {
  root.MD = root.MD || {};

  // 24x24 viewBox, stroke = currentColor. 各値は <svg> の中身。
  var ICONS = {
    'new': '<path d="M14 3H6.5A1.5 1.5 0 0 0 5 4.5v15A1.5 1.5 0 0 0 6.5 21h11a1.5 1.5 0 0 0 1.5-1.5V8z"/><path d="M14 3v5h5"/><path d="M12 11.5v6M9 14.5h6"/>',
    'folder': '<path d="M3 7.5V18a1.5 1.5 0 0 0 1.5 1.5h15A1.5 1.5 0 0 0 21 18V9.5A1.5 1.5 0 0 0 19.5 8h-8l-2-2.5h-5A1.5 1.5 0 0 0 3 7z"/>',
    'save': '<path d="M5 3.5h11.5L20.5 7.5V19a1.5 1.5 0 0 1-1.5 1.5H5A1.5 1.5 0 0 1 3.5 19V5A1.5 1.5 0 0 1 5 3.5z"/><path d="M7.5 3.5v5h8v-5"/><rect x="7" y="13" width="10" height="7.5"/>',
    'tiles': '<rect x="3.5" y="3.5" width="17" height="17" rx="1.5"/><path d="M3.5 12h17M12 3.5v17"/>',
    'drawing': '<rect x="3.5" y="4.5" width="17" height="15" rx="1.5"/><path d="M6.5 16.5l5-6 3 3 3-5"/><circle cx="9" cy="8.5" r="1.6"/>',
    'sima': '<path d="M4 18l5-7 5 3 6-9"/><circle cx="4" cy="18" r="1.6" fill="currentColor"/><circle cx="9" cy="11" r="1.6" fill="currentColor"/><circle cx="14" cy="14" r="1.6" fill="currentColor"/><circle cx="20" cy="5" r="1.6" fill="currentColor"/>',
    'pick': '<circle cx="12" cy="12" r="6.5"/><path d="M12 2.5v5M12 16.5v5M2.5 12h5M16.5 12h5"/><circle cx="12" cy="12" r="1.2" fill="currentColor"/>',
    'snap': '<path d="M5 3.5v8.5a7 7 0 0 0 14 0V3.5h-4.5V12a2.5 2.5 0 0 1-5 0V3.5z"/><path d="M5 8h4.5M14.5 8H19"/>',
    'home': '<path d="M3.5 11.5L12 4l8.5 7.5"/><path d="M6 9.5V20h4.5v-5.5h3V20H18V9.5"/>',
    'north': '<circle cx="12" cy="12" r="9"/><path d="M12 5l3.5 9.5L12 12.5l-3.5 2z" fill="currentColor"/><path d="M12 12.5V19"/>',
    'panel': '<rect x="3.5" y="4.5" width="17" height="15" rx="1.5"/><path d="M14.5 4.5v15"/><path d="M16.5 8.5h2M16.5 11h2M16.5 13.5h2"/>',
    'stations': '<path d="M3.5 6h17M3.5 4v4M9 4.5v3M15 4.5v3M20.5 4v4"/><rect x="3.5" y="11" width="17" height="9" rx="1"/><path d="M3.5 15.5h17M9 11v9"/>',
    'ipgrid': '<path d="M3.5 9L12 3.5 20.5 9"/><circle cx="12" cy="3.5" r="1.5" fill="currentColor"/><rect x="3.5" y="11" width="17" height="9" rx="1"/><path d="M3.5 15.5h17M9 11v9"/>',
    'points': '<path d="M12 9.5s-4-3.6-4-6a4 4 0 0 1 8 0c0 2.4-4 6-4 6z" transform="translate(0 1)"/><circle cx="12" cy="4.4" r="1.2" fill="currentColor"/><rect x="3.5" y="12" width="17" height="8" rx="1"/><path d="M3.5 16h17M9 12v8"/>',
    'csv': '<path d="M12 3.5v11M7.5 10l4.5 4.5 4.5-4.5"/><path d="M4 15v3.5A1.5 1.5 0 0 0 5.5 20h13a1.5 1.5 0 0 0 1.5-1.5V15"/>',
    'preview': '<path d="M13 21H6.5A1.5 1.5 0 0 1 5 19.5v-15A1.5 1.5 0 0 1 6.5 3h11A1.5 1.5 0 0 1 19 4.5V11"/><path d="M8.5 7.5h7M8.5 10.5h4"/><circle cx="16.5" cy="16.5" r="3"/><path d="M18.7 18.7L21 21"/>',
    'print': '<path d="M7 8V3.5h10V8"/><rect x="3.5" y="8" width="17" height="8.5" rx="1.5"/><path d="M7 14h10v6.5H7z"/><path d="M16.5 11h1"/>'
  };

  var DEFAULT_ITEMS = [
    { group: 'ファイル', id: 'file.new', label: '新規', icon: 'new', title: '新規プロジェクト (Ctrl+N)' },
    { group: 'ファイル', id: 'file.openProject', label: '開く', icon: 'folder', title: 'プロジェクトを開く (Ctrl+Shift+O)' },
    { group: 'ファイル', id: 'file.save', label: '保存', icon: 'save', title: 'プロジェクトを保存 (Ctrl+S)' },
    { group: '読込', id: 'file.openTiles', label: 'タイル', icon: 'tiles', title: 'タイルフォルダを開く (Ctrl+O)' },
    { group: '読込', id: 'file.openDrawing', label: '図面', icon: 'drawing', title: '図面 (DXF/画像) を読み込む (Ctrl+D)' },
    { group: '読込', id: 'file.openSima', label: 'SIMA', icon: 'sima', title: 'SIMA/線形データを読み込む (Ctrl+L)' },
    { group: '操作', id: 'tool.pick', label: '座標取得', icon: 'pick', title: '座標取得モード (P)', toggle: true },
    { group: '操作', id: 'tool.snapToggle', label: 'スナップ', icon: 'snap', title: 'スナップ ON/OFF (F3)', toggle: true },
    { group: '表示', id: 'view.home', label: 'ホーム', icon: 'home', title: '表示範囲をリセット (Home)' },
    { group: '表示', id: 'view.north', label: '北を上', icon: 'north', title: '北を上にする (回転リセット)' },
    { group: '表示', id: 'view.togglePanel', label: 'パネル', icon: 'panel', title: 'サイドパネルの表示/非表示 (Ctrl+B)' },
    { group: '編集', id: 'edit.stations', label: '測点表', icon: 'stations', title: '測点表を編集' },
    { group: '編集', id: 'edit.ipGrid', label: 'IP表', icon: 'ipgrid', title: 'IP表を編集' },
    { group: '編集', id: 'edit.pointsGrid', label: '取得点表', icon: 'points', title: '取得点表を編集' },
    { group: '出力', id: 'file.exportCsv', label: 'CSV出力', icon: 'csv', title: '取得点をCSVに出力' },
    { group: '出力', id: 'file.printPreview', label: 'プレビュー', icon: 'preview', title: '印刷プレビュー' },
    { group: '出力', id: 'file.print', label: '印刷', icon: 'print', title: '印刷 (Ctrl+P)' }
  ];

  var SVGNS = 'http://www.w3.org/2000/svg';
  var state = { root: null, buttons: {}, run: null, listening: false };

  function iconSvg(name) {
    return '<svg class="md-tb-icon" xmlns="' + SVGNS + '" viewBox="0 0 24 24" width="18" height="18" fill="none" ' +
      'stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">' +
      (ICONS[name] || '') + '</svg>';
  }

  function onState(ev) { if (ev && ev.detail) Toolbar.setState(ev.detail); }

  var Toolbar = {
    ICONS: ICONS,
    DEFAULT_ITEMS: DEFAULT_ITEMS,
    iconSvg: iconSvg,

    mount: function (containerEl, opts) {
      opts = opts || {};
      var doc = containerEl.ownerDocument;
      var items = opts.items || DEFAULT_ITEMS;
      state.run = typeof opts.run === 'function' ? opts.run : null;
      state.buttons = {};
      containerEl.innerHTML = '';
      var bar = doc.createElement('div');
      bar.className = 'md-tb';
      bar.setAttribute('role', 'toolbar');
      bar.setAttribute('aria-label', 'ツールバー');
      var grp = null, grpName;
      items.forEach(function (it) {
        if (!grp || it.group !== grpName) {
          if (grp) {
            var sep = doc.createElement('div');
            sep.className = 'md-tb-sep';
            sep.setAttribute('role', 'separator');
            sep.setAttribute('aria-orientation', 'vertical');
            bar.appendChild(sep);
          }
          grp = doc.createElement('div');
          grp.className = 'md-tb-group';
          grp.setAttribute('role', 'group');
          if (it.group) grp.setAttribute('aria-label', it.group);
          grpName = it.group;
          bar.appendChild(grp);
        }
        var b = doc.createElement('button');
        b.type = 'button';
        b.className = 'md-tb-btn' + (it.toggle ? ' md-tb-toggle' : '');
        b.title = it.title || it.label;
        b.dataset.action = it.id;
        if (it.toggle) b.setAttribute('aria-pressed', 'false');
        b.innerHTML = iconSvg(it.icon) + '<span class="md-tb-label">' + it.label + '</span>';
        b.addEventListener('click', function () {
          if (b.disabled) return;
          if (state.run) state.run(it.id);
        });
        // マウスクリックで地図からフォーカスを奪わない
        b.addEventListener('mousedown', function (e) { e.preventDefault(); });
        grp.appendChild(b);
        state.buttons[it.id] = b;
      });
      containerEl.appendChild(bar);
      state.root = bar;
      if (!state.listening && doc.addEventListener) {
        doc.addEventListener('md-state', onState);
        state.listening = true;
      }
      return bar;
    },

    setState: function (map) {
      Object.keys(map || {}).forEach(function (id) {
        var b = state.buttons[id];
        if (!b || !b.classList.contains('md-tb-toggle')) return;
        var on = !!map[id];
        b.setAttribute('aria-pressed', on ? 'true' : 'false');
        b.classList.toggle('md-tb-on', on);
      });
    },

    setEnabled: function (map) {
      Object.keys(map || {}).forEach(function (id) {
        var b = state.buttons[id];
        if (b) b.disabled = !map[id];
      });
    }
  };

  root.MD.Toolbar = Toolbar;
})(typeof window !== 'undefined' ? window : globalThis);
