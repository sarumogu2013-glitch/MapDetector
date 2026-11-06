// メニューバー定義 (Electron ネイティブメニューとブラウザ版HTMLメニューで共通)。
// id を持つ項目はクリック時に id がレンダラーへ通知される。role はElectron標準動作。
// main 側で処理する id: app.quit, help.checkUpdate, view.devtools, view.reload, view.fullscreen
(function (root) {
  root.MD = root.MD || {};
  root.MD.MenuDef = [
    { label: 'ファイル', items: [
      { id: 'file.new', label: '新規', accel: 'CmdOrCtrl+N' },
      { id: 'file.openProject', label: 'プロジェクトを開く...', accel: 'CmdOrCtrl+Shift+O' },
      { id: 'file.save', label: '上書き保存', accel: 'CmdOrCtrl+S' },
      { id: 'file.saveAs', label: '名前を付けて保存...', accel: 'CmdOrCtrl+Shift+S' },
      { type: 'separator' },
      { id: 'file.openTiles', label: 'タイルフォルダを開く...', accel: 'CmdOrCtrl+O' },
      { id: 'file.openDrawing', label: '図面を開く (DXF/GeoJSON/画像)...', accel: 'CmdOrCtrl+D' },
      { id: 'file.openSima', label: '線形SIMAを開く (CSV/XML)...', accel: 'CmdOrCtrl+L' },
      { type: 'separator' },
      { id: 'file.exportCsv', label: '取得座標をCSV出力...', accel: 'CmdOrCtrl+E' },
      { id: 'file.exportSima', label: '取得座標をSIMA出力...' },
      { id: 'file.exportStations', label: '横断線(測点)座標をCSV出力...' },
      { type: 'separator' },
      { id: 'app.quit', label: '終了', accel: 'Alt+F4' }
    ]},
    { label: '編集', items: [
      { id: 'edit.undoPoint', label: '最後の取得点を削除', accel: 'CmdOrCtrl+Z' },
      { id: 'edit.clearPoints', label: '取得点をすべて削除' },
      { id: 'edit.copyPoints', label: '取得座標をクリップボードへコピー', accel: 'CmdOrCtrl+Shift+C' }
    ]},
    { label: '表示', items: [
      { id: 'view.fit', label: 'タイル全体を表示', accel: 'CmdOrCtrl+0' },
      { id: 'view.fitAlignment', label: '線形全体を表示' },
      { id: 'view.togglePanel', label: 'サイドパネル表示切替', accel: 'F2' },
      { id: 'view.toggleBase', label: '背景地図(地理院)表示切替' },
      { type: 'separator' },
      { id: 'view.reload', label: '再読み込み', accel: 'CmdOrCtrl+R' },
      { id: 'view.fullscreen', label: '全画面', accel: 'F11' },
      { id: 'view.devtools', label: '開発者ツール', accel: 'CmdOrCtrl+Shift+I' }
    ]},
    { label: 'ツール', items: [
      { id: 'tool.pick', label: '座標取得モード', accel: 'P' },
      { id: 'tool.pan', label: '移動モード', accel: 'Escape' },
      { id: 'tool.snapToggle', label: 'スナップ ON/OFF', accel: 'F3' },
      { id: 'tool.alignmentFromPoints', label: '取得点から線形(IP)を作成' }
    ]},
    { label: 'ヘルプ', items: [
      { id: 'help.checkUpdate', label: '更新を確認...' },
      { id: 'help.about', label: 'バージョン情報' }
    ]}
  ];
})(typeof window !== 'undefined' ? window : globalThis);
