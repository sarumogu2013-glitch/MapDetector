// MapDetector — preload: レンダラーへ window.mdNative を公開する (contextIsolation 有効)
'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

function toArrayBuffer(u8) {
  if (!u8) return u8;
  if (u8 instanceof ArrayBuffer) return u8;
  return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
}

function subscribe(channel, cb) {
  if (typeof cb !== 'function') return () => {};
  const listener = (_e, payload) => cb(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

let version = '';
try { version = ipcRenderer.sendSync('app:version'); } catch (_) { /* ignore */ }

contextBridge.exposeInMainWorld('mdNative', {
  isElectron: true,
  version,
  env: (() => { try { return ipcRenderer.sendSync('app:env'); } catch (e) { return {}; } })(),

  // タイルフォルダ: {root, token, levels, ext, tms, sampleBounds, levelsInfo} | null
  // タイルURL: `mdtile://${token}/{z}/{x}/{y}`
  openTileFolder: () => ipcRenderer.invoke('tiles:open'),
  openTilePath: (p) => ipcRenderer.invoke('tiles:openPath', p),

  // kind: 'drawing' | 'sima' | 'project' | 'any' → {path, name, data: ArrayBuffer} | null
  openFile: async (kind) => {
    const r = await ipcRenderer.invoke('file:open', kind);
    if (!r) return null;
    return { path: r.path, name: r.name, data: toArrayBuffer(r.data) };
  },

  // ダイアログなしで読み込み → {path, name, data: ArrayBuffer} | null (存在しない場合)
  readFile: async (p) => {
    const r = await ipcRenderer.invoke('file:read', p);
    if (!r) return null;
    return { path: r.path, name: r.name, data: toArrayBuffer(r.data) };
  },

  // opts: {defaultName?, defaultPath?, title?, content: string|ArrayBuffer|Uint8Array,
  //        encoding: 'utf8'|'shift_jis', filters?, bom?} → path | null (キャンセル)
  saveFile: (opts) => ipcRenderer.invoke('file:save', opts),

  // ダイアログなしで書き込み。opts: {path, content, encoding?, bom?} → path。失敗時は reject。
  writeFile: (opts) => ipcRenderer.invoke('file:write', opts),
  chooseDirectory: (opts) => ipcRenderer.invoke('dir:choose', opts),
  writeBinary: (base, rel, data) => ipcRenderer.invoke('file:writeBinary', base, rel, data),

  // 未保存変更の有無をメインへ通知 (ウィンドウを閉じる際の確認に使用)
  setDirty: (dirty) => ipcRenderer.send('app:setDirty', !!dirty),
  // 未保存確認を経由せずにウィンドウを閉じる (file.saveThenClose で保存完了後に呼ぶ)
  closeWindow: () => ipcRenderer.send('app:close'),

  // https:// のURLのみ既定ブラウザで開く → Promise<boolean>
  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),

  checkForUpdates: () => ipcRenderer.invoke('update:check'),

  // 戻り値は購読解除関数
  onMenu: (cb) => subscribe('menu', cb),
  onUpdateStatus: (cb) => subscribe('update:status', cb),

  getSetting: (k) => ipcRenderer.invoke('settings:get', k),
  setSetting: (k, v) => ipcRenderer.invoke('settings:set', k, v),

  // ドラッグ&ドロップされた File オブジェクトの絶対パス
  getPathForFile: (file) => {
    try { return webUtils.getPathForFile(file) || ''; } catch (_) { return ''; }
  }
});
