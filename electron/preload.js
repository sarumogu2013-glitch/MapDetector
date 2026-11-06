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

  // タイルフォルダ: {root, token, levels, ext, tms, sampleBounds, levelsInfo} | null
  // タイルURL: `mdtile://${token}/{z}/{x}/{y}`
  openTileFolder: () => ipcRenderer.invoke('tiles:open'),
  openTilePath: (p) => ipcRenderer.invoke('tiles:openPath', p),

  // kind: 'drawing' | 'sima' | 'any' → {path, name, data: ArrayBuffer} | null
  openFile: async (kind) => {
    const r = await ipcRenderer.invoke('file:open', kind);
    if (!r) return null;
    return { path: r.path, name: r.name, data: toArrayBuffer(r.data) };
  },

  // opts: {defaultName, content: string|ArrayBuffer|Uint8Array, encoding: 'utf8'|'shift_jis', filters?, bom?} → path | null
  saveFile: (opts) => ipcRenderer.invoke('file:save', opts),

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
