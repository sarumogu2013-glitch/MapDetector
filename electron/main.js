// MapDetector — Electron メインプロセス
// ・ネイティブメニュー (js/menu-def.js 共通定義)
// ・mdtile:// プロトコルでローカルタイルを配信
// ・ファイル入出力 IPC、設定保存、electron-updater による自動更新
'use strict';

const { app, BrowserWindow, Menu, dialog, ipcMain, protocol, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const crypto = require('crypto');

const ROOT_DIR = path.join(__dirname, '..');
const PRODUCT = require('../package.json').productName || 'MapDetector';

// ---------------------------------------------------------------------------
// 設定 (userData/settings.json)
// ---------------------------------------------------------------------------
let settings = {};
let settingsPath = null;
let saveTimer = null;

function loadSettings() {
  settingsPath = path.join(app.getPath('userData'), 'settings.json');
  try {
    settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) || {};
    if (typeof settings !== 'object' || Array.isArray(settings)) settings = {};
  } catch (_) {
    settings = {};
  }
}

function saveSettingsNow() {
  if (!settingsPath) return;
  clearTimeout(saveTimer);
  saveTimer = null;
  try {
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    const tmp = settingsPath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(settings, null, 2), 'utf8');
    fs.renameSync(tmp, settingsPath);
  } catch (e) {
    console.error('settings save failed:', e);
  }
}

function saveSettingsSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveSettingsNow, 300);
}

// ---------------------------------------------------------------------------
// mdtile:// プロトコル
// ---------------------------------------------------------------------------
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'mdtile',
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true }
  }
]);

const tileRoots = new Map(); // token -> {root, ext}
const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' };
const FALLBACK_EXTS = ['png', 'jpg', 'jpeg', 'webp'];

function registerTileRoot(root, ext) {
  for (const [tok, info] of tileRoots) {
    if (info.root === root) { info.ext = ext; return tok; }
  }
  const token = crypto.randomBytes(8).toString('hex'); // 小文字hex (standard scheme の host は小文字化される)
  tileRoots.set(token, { root, ext });
  return token;
}

function notFound() {
  return new Response('not found', {
    status: 404,
    headers: { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-cache' }
  });
}

async function handleTile(request) {
  let u;
  try { u = new URL(request.url); } catch (_) { return notFound(); }
  const info = tileRoots.get(u.hostname.toLowerCase());
  if (!info) return notFound();
  // /z/x/y もしくは /z/x/y.ext (クエリは無視)
  const m = /^\/(\d{1,2})\/(\d{1,9})\/(\d{1,9})(?:\.([a-z0-9]{2,5}))?\/?$/i.exec(u.pathname);
  if (!m) return notFound();
  const [, z, x, y, reqExt] = m;
  const exts = [];
  if (reqExt) exts.push(reqExt.toLowerCase());
  if (info.ext && !exts.includes(info.ext)) exts.push(info.ext);
  for (const e of FALLBACK_EXTS) if (!exts.includes(e)) exts.push(e);

  for (const ext of exts) {
    const file = path.join(info.root, z, x, `${y}.${ext}`);
    let buf;
    try {
      buf = await fsp.readFile(file);
    } catch (_) {
      continue;
    }
    return new Response(buf, {
      status: 200,
      headers: {
        'Content-Type': MIME[ext] || 'application/octet-stream',
        'Content-Length': String(buf.length),
        'Cache-Control': 'public, max-age=86400',
        'Access-Control-Allow-Origin': '*'
      }
    });
  }
  return notFound();
}

// ---------------------------------------------------------------------------
// タイルフォルダ検出
// ---------------------------------------------------------------------------
const isInt = (s) => /^\d+$/.test(s);

async function listDir(dir) {
  try { return await fsp.readdir(dir, { withFileTypes: true }); } catch (_) { return []; }
}

// dir 直下の z (0..30 の数値名) ディレクトリ一覧。x ディレクトリを誤認しないよう z<=30 に限定し、
// 最初の z の中に数値名ディレクトリがあることも確認する。
async function zoomLevelsOf(dir) {
  const ents = await listDir(dir);
  const levels = ents
    .filter((e) => e.isDirectory() && isInt(e.name) && Number(e.name) <= 30)
    .map((e) => Number(e.name))
    .sort((a, b) => a - b);
  if (!levels.length) return [];
  for (const z of levels) {
    const sub = await listDir(path.join(dir, String(z)));
    if (sub.some((e) => e.isDirectory() && isInt(e.name))) return levels;
  }
  return [];
}

async function findTileRoot(dir, depth = 0) {
  if ((await zoomLevelsOf(dir)).length) return dir;
  if (depth >= 3) return null;
  const children = (await listDir(dir))
    .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
    .map((e) => path.join(dir, e.name));
  // 直下の子に z ディレクトリを持つものがあればそれ
  for (const c of children.slice(0, 50)) {
    if ((await zoomLevelsOf(c)).length) return c;
  }
  if (children.length === 1) return findTileRoot(children[0], depth + 1);
  for (const c of children.slice(0, 20)) {
    const r = await findTileRoot(c, depth + 1);
    if (r) return r;
  }
  return null;
}

// 指定ズームの x/y 範囲。maxXDirs を超える x ディレクトリがある場合、y は先頭/末尾/等間隔の一部から推定。
async function boundsAt(root, z, maxXDirs = Infinity) {
  const zDir = path.join(root, String(z));
  const xs = (await listDir(zDir)).filter((e) => e.isDirectory() && isInt(e.name)).map((e) => Number(e.name)).sort((a, b) => a - b);
  if (!xs.length) return null;
  let sampleXs = xs;
  if (xs.length > maxXDirs) {
    sampleXs = [];
    const step = (xs.length - 1) / (maxXDirs - 1);
    for (let i = 0; i < maxXDirs; i++) sampleXs.push(xs[Math.round(i * step)]);
  }
  let ymin = Infinity, ymax = -Infinity, ext = null;
  for (const x of sampleXs) {
    for (const e of await listDir(path.join(zDir, String(x)))) {
      if (!e.isFile()) continue;
      const m = /^(\d+)\.([A-Za-z0-9]+)$/.exec(e.name);
      if (!m) continue;
      const y = Number(m[1]);
      if (y < ymin) ymin = y;
      if (y > ymax) ymax = y;
      if (!ext && MIME[m[2].toLowerCase()]) ext = m[2].toLowerCase();
    }
  }
  if (ymin === Infinity) return null;
  return { z, xmin: xs[0], xmax: xs[xs.length - 1], ymin, ymax, ext, exact: sampleXs === xs };
}

async function exists(p) {
  try { await fsp.access(p); return true; } catch (_) { return false; }
}

async function detectTiles(dirPath) {
  if (!dirPath) return null;
  let st;
  try { st = await fsp.stat(dirPath); } catch (_) { return null; }
  if (!st.isDirectory()) dirPath = path.dirname(dirPath);
  const root = await findTileRoot(path.resolve(dirPath));
  if (!root) return null;
  const levels = await zoomLevelsOf(root);
  if (!levels.length) return null;

  // タイルを持つ最小ズームを探す
  let sampleBounds = null;
  for (const z of levels) {
    sampleBounds = await boundsAt(root, z, 200);
    if (sampleBounds) break;
  }
  if (!sampleBounds) return null;
  const ext = sampleBounds.ext || 'png';
  delete sampleBounds.ext;

  const levelsInfo = [Object.assign({}, sampleBounds)];
  const maxZ = levels[levels.length - 1];
  if (maxZ !== sampleBounds.z) {
    const mb = await boundsAt(root, maxZ, 30); // 最大ズームは y を一部の x からのみ推定 (高速化)
    if (mb) { delete mb.ext; levelsInfo.push(mb); }
  }

  const tms = (await exists(path.join(root, 'tilemapresource.xml'))) ||
    (await exists(path.join(path.dirname(root), 'tilemapresource.xml')));

  const token = registerTileRoot(root, ext);
  settings.lastTileFolder = root;
  saveSettingsSoon();
  return { root, token, levels, ext, tms, sampleBounds, levelsInfo };
}

// ---------------------------------------------------------------------------
// ウィンドウ
// ---------------------------------------------------------------------------
let mainWindow = null;

function createWindow() {
  const b = settings.windowBounds || {};
  mainWindow = new BrowserWindow({
    width: b.width || 1400,
    height: b.height || 900,
    x: Number.isFinite(b.x) ? b.x : undefined,
    y: Number.isFinite(b.y) ? b.y : undefined,
    title: PRODUCT,
    show: false,
    backgroundColor: '#ffffff',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });
  if (b.maximized) mainWindow.maximize();
  mainWindow.once('ready-to-show', () => mainWindow.show());

  const remember = () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const nb = mainWindow.getNormalBounds();
    settings.windowBounds = { ...nb, maximized: mainWindow.isMaximized() };
    saveSettingsSoon();
  };
  mainWindow.on('resize', remember);
  mainWindow.on('move', remember);
  mainWindow.on('close', () => { remember(); saveSettingsNow(); });
  mainWindow.on('closed', () => { mainWindow = null; });

  // 外部リンクは既定ブラウザで開く
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('file:')) { e.preventDefault(); if (/^https?:/i.test(url)) shell.openExternal(url); }
  });

  mainWindow.loadFile(path.join(ROOT_DIR, 'index.html'));
}

// ---------------------------------------------------------------------------
// メニュー
// ---------------------------------------------------------------------------
function sendMenu(id) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('menu', id);
}

function showAbout() {
  dialog.showMessageBox(mainWindow, {
    type: 'info',
    title: 'バージョン情報',
    message: `${PRODUCT} ${app.getVersion()}`,
    detail: `Electron ${process.versions.electron}\nChrome ${process.versions.chrome}\nNode ${process.versions.node}\n\nhttps://github.com/sarumogu2013-glitch/MapDetector`,
    buttons: ['OK']
  });
}

function handleMenu(id) {
  const wc = mainWindow && !mainWindow.isDestroyed() ? mainWindow.webContents : null;
  switch (id) {
    case 'app.quit': app.quit(); break;
    case 'help.about': showAbout(); break;
    case 'help.checkUpdate': checkForUpdates(true); break;
    case 'view.devtools': if (wc) wc.toggleDevTools(); break;
    case 'view.reload': if (wc) wc.reload(); break;
    case 'view.fullscreen': if (mainWindow) mainWindow.setFullScreen(!mainWindow.isFullScreen()); break;
    default: sendMenu(id);
  }
}

// 修飾キーなしの単キー (P, Escape など) はテキスト入力を奪うためネイティブ登録しない。F1–F24 は可。
function isSafeAccel(accel) {
  if (!accel) return false;
  if (accel.includes('+')) return true;
  return /^F([1-9]|1\d|2[0-4])$/.test(accel);
}

function buildMenu() {
  require(path.join(ROOT_DIR, 'js', 'menu-def.js'));
  const def = (globalThis.MD && globalThis.MD.MenuDef) || [];
  const template = def.map((top) => ({
    label: top.label,
    submenu: (top.items || []).map((it) => {
      if (it.type === 'separator') return { type: 'separator' };
      const item = { label: it.label, click: () => handleMenu(it.id) };
      if (isSafeAccel(it.accel)) item.accelerator = it.accel;
      else if (it.accel) item.label = `${it.label}  (${it.accel === 'Escape' ? 'Esc' : it.accel})`;
      return item;
    })
  }));
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---------------------------------------------------------------------------
// 自動更新 (electron-updater, GitHub Releases)
// ---------------------------------------------------------------------------
let autoUpdater = null;
let manualCheck = false;
let updateDialogShown = false;
let updateTimer = null;

function sendUpdateStatus(status) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('update:status', status);
}

function setupUpdater() {
  if (!app.isPackaged) return;
  try {
    ({ autoUpdater } = require('electron-updater'));
  } catch (e) {
    console.error('electron-updater unavailable:', e);
    return;
  }
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('checking-for-update', () => sendUpdateStatus({ state: 'checking' }));
  autoUpdater.on('update-available', (info) => {
    sendUpdateStatus({ state: 'available', version: info && info.version });
    if (manualCheck) {
      manualCheck = false;
      dialog.showMessageBox(mainWindow, {
        type: 'info', title: '更新', buttons: ['OK'],
        message: `新しいバージョン ${info.version} が見つかりました。`,
        detail: 'バックグラウンドでダウンロードしています。完了後に再起動を確認します。'
      });
    }
  });
  autoUpdater.on('update-not-available', (info) => {
    sendUpdateStatus({ state: 'none', version: info && info.version });
    if (manualCheck) {
      manualCheck = false;
      dialog.showMessageBox(mainWindow, {
        type: 'info', title: '更新', buttons: ['OK'],
        message: `最新バージョンです (${app.getVersion()})。`
      });
    }
  });
  autoUpdater.on('download-progress', (p) => {
    sendUpdateStatus({ state: 'downloading', percent: Math.round((p && p.percent) || 0) });
  });
  autoUpdater.on('update-downloaded', async (info) => {
    sendUpdateStatus({ state: 'downloaded', version: info && info.version });
    if (updateDialogShown) return;
    updateDialogShown = true;
    const r = await dialog.showMessageBox(mainWindow, {
      type: 'question',
      title: '更新の準備完了',
      message: `バージョン ${info.version} の更新をダウンロードしました。`,
      detail: '今すぐ再起動して更新しますか? (「後で」を選ぶと終了時に更新されます)',
      buttons: ['再起動して更新', '後で'],
      defaultId: 0,
      cancelId: 1
    });
    if (r.response === 0) {
      saveSettingsNow();
      setImmediate(() => autoUpdater.quitAndInstall());
    } else {
      updateDialogShown = false;
    }
  });
  autoUpdater.on('error', (err) => {
    const message = (err && (err.message || String(err))) || 'unknown error';
    sendUpdateStatus({ state: 'error', message });
    if (manualCheck) {
      manualCheck = false;
      dialog.showMessageBox(mainWindow, {
        type: 'error', title: '更新エラー', buttons: ['OK'],
        message: '更新の確認に失敗しました。', detail: message
      });
    }
  });

  setTimeout(() => checkForUpdates(false), 3000);
  updateTimer = setInterval(() => checkForUpdates(false), 6 * 60 * 60 * 1000);
}

async function checkForUpdates(manual) {
  if (!app.isPackaged || !autoUpdater) {
    if (manual) {
      await dialog.showMessageBox(mainWindow, {
        type: 'info', title: '更新', buttons: ['OK'],
        message: '自動更新はインストール版でのみ動作します。',
        detail: `現在のバージョン: ${app.getVersion()} (開発実行中)`
      });
    }
    return { ok: false, reason: 'not-packaged' };
  }
  manualCheck = !!manual;
  try {
    const r = await autoUpdater.checkForUpdates();
    return { ok: true, version: r && r.updateInfo ? r.updateInfo.version : null };
  } catch (e) {
    // 'error' イベントでも通知されるため、ここでは結果を返すのみ
    return { ok: false, reason: (e && e.message) || String(e) };
  }
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------
const OPEN_FILTERS = {
  drawing: [
    { name: '図面 (DXF/GeoJSON/画像)', extensions: ['dxf', 'geojson', 'json', 'png', 'jpg', 'jpeg'] },
    { name: 'DXF', extensions: ['dxf'] },
    { name: 'GeoJSON', extensions: ['geojson', 'json'] },
    { name: '画像', extensions: ['png', 'jpg', 'jpeg'] },
    { name: 'すべてのファイル', extensions: ['*'] }
  ],
  sima: [
    { name: 'SIMA', extensions: ['sim', 'txt'] },
    { name: 'すべてのファイル', extensions: ['*'] }
  ],
  any: [{ name: 'すべてのファイル', extensions: ['*'] }]
};

function senderWindow(e) {
  return BrowserWindow.fromWebContents(e.sender) || mainWindow;
}

function registerIpc() {
  ipcMain.handle('tiles:open', async (e) => {
    const r = await dialog.showOpenDialog(senderWindow(e), {
      title: 'タイルフォルダを選択',
      defaultPath: settings.lastTileFolder || undefined,
      properties: ['openDirectory']
    });
    if (r.canceled || !r.filePaths.length) return null;
    const res = await detectTiles(r.filePaths[0]);
    if (!res) {
      dialog.showMessageBox(senderWindow(e), {
        type: 'warning', title: 'タイルフォルダ', buttons: ['OK'],
        message: 'タイル (z/x/y.png 等) が見つかりませんでした。', detail: r.filePaths[0]
      });
    }
    return res;
  });

  ipcMain.handle('tiles:openPath', async (_e, dirPath) => {
    if (typeof dirPath !== 'string' || !dirPath) return null;
    return detectTiles(dirPath);
  });

  ipcMain.handle('file:open', async (e, kind) => {
    const filters = OPEN_FILTERS[kind] || OPEN_FILTERS.any;
    const key = `lastDir.${OPEN_FILTERS[kind] ? kind : 'any'}`;
    const r = await dialog.showOpenDialog(senderWindow(e), {
      title: 'ファイルを開く',
      defaultPath: settings[key] || undefined,
      properties: ['openFile'],
      filters
    });
    if (r.canceled || !r.filePaths.length) return null;
    const p = r.filePaths[0];
    const buf = await fsp.readFile(p);
    settings[key] = path.dirname(p);
    saveSettingsSoon();
    return { path: p, name: path.basename(p), data: new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength) };
  });

  ipcMain.handle('file:save', async (e, opts) => {
    opts = opts || {};
    const defaultName = opts.defaultName || 'output.txt';
    const dir = settings['lastDir.save'];
    const r = await dialog.showSaveDialog(senderWindow(e), {
      title: '保存',
      defaultPath: dir ? path.join(dir, defaultName) : defaultName,
      filters: Array.isArray(opts.filters) && opts.filters.length ? opts.filters : undefined
    });
    if (r.canceled || !r.filePath) return null;
    const content = opts.content;
    let buf;
    if (typeof content === 'string') {
      const enc = String(opts.encoding || 'utf8').toLowerCase().replace('-', '_');
      if (enc === 'shift_jis' || enc === 'sjis' || enc === 'cp932') {
        buf = require('iconv-lite').encode(content, 'cp932');
      } else {
        const wantBom = opts.bom !== undefined ? !!opts.bom : /\.csv$/i.test(r.filePath);
        buf = Buffer.from((wantBom ? '﻿' : '') + content, 'utf8');
      }
    } else if (content instanceof ArrayBuffer) {
      buf = Buffer.from(content);
    } else if (ArrayBuffer.isView(content)) {
      buf = Buffer.from(content.buffer, content.byteOffset, content.byteLength);
    } else {
      buf = Buffer.alloc(0);
    }
    await fsp.writeFile(r.filePath, buf);
    settings['lastDir.save'] = path.dirname(r.filePath);
    saveSettingsSoon();
    return r.filePath;
  });

  ipcMain.on('app:version', (e) => { e.returnValue = app.getVersion(); });

  ipcMain.handle('update:check', () => checkForUpdates(true));

  ipcMain.handle('settings:get', (_e, key) => {
    if (typeof key !== 'string') return undefined;
    return settings[key];
  });
  ipcMain.handle('settings:set', (_e, key, value) => {
    if (typeof key !== 'string') return false;
    if (value === undefined) delete settings[key];
    else settings[key] = value;
    saveSettingsSoon();
    return true;
  });
}

// ---------------------------------------------------------------------------
// 起動
// ---------------------------------------------------------------------------
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  if (process.platform === 'win32') app.setAppUserModelId('io.github.sarumogu2013-glitch.mapdetector');

  app.whenReady().then(() => {
    loadSettings();
    protocol.handle('mdtile', handleTile);
    registerIpc();
    buildMenu();
    createWindow();
    setupUpdater();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('before-quit', () => {
    clearInterval(updateTimer);
    saveSettingsNow();
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
