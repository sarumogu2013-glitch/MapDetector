// ローカルタイル (z/x/y.png 等) のソースとLeafletレイヤー。
// - Electron: main プロセスの mdtile:// プロトコルで直接配信 (最速)
// - ブラウザ: File System Access API (遅延読込) または <input webkitdirectory> (全ファイル索引)
(function (root) {
  root.MD = root.MD || {};
  var L = root.L;
  var EXT_RE = /\.(png|jpe?g|webp|gif)$/i;
  var TRANSPARENT = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

  function isNum(s) { return /^\d+$/.test(s); }

  // タイル番号 → 緯度経度 (XYZ)
  function tile2lng(x, z) { return x / Math.pow(2, z) * 360 - 180; }
  function tile2lat(y, z) { var n = Math.PI - 2 * Math.PI * y / Math.pow(2, z); return 180 / Math.PI * Math.atan(Math.sinh(n)); }

  /** info: {levels, tms, sampleBounds:{z,xmin,xmax,ymin,ymax}} → L.LatLngBounds (XYZ/TMS 補正込み) */
  function boundsOf(info, tms) {
    var b = info.sampleBounds; if (!b) return null;
    var z = b.z, ymin = b.ymin, ymax = b.ymax;
    if (tms) { var m = Math.pow(2, z) - 1; ymin = m - b.ymax; ymax = m - b.ymin; }
    return L.latLngBounds([tile2lat(ymax + 1, z), tile2lng(b.xmin, z)], [tile2lat(ymin, z), tile2lng(b.xmax + 1, z)]);
  }

  // ---------- ブラウザ: ディレクトリハンドル (遅延) ----------
  async function listDir(dir) {
    var out = [];
    for await (var entry of dir.values()) out.push(entry);
    return out;
  }
  async function detectFromHandle(rootDir) {
    var dir = rootDir, depth = 0, tms = false;
    while (true) {
      var entries = await listDir(dir);
      if (entries.some(function (e) { return e.kind === 'file' && /^tilemapresource\.xml$/i.test(e.name); })) tms = true;
      var nums = entries.filter(function (e) { return e.kind === 'directory' && isNum(e.name); });
      if (nums.length) {
        var levels = nums.map(function (e) { return +e.name; }).sort(function (a, b) { return a - b; });
        var zdir = nums.find(function (e) { return +e.name === levels[0]; });
        var xs = (await listDir(zdir)).filter(function (e) { return e.kind === 'directory' && isNum(e.name); });
        var xmin = Infinity, xmax = -Infinity, ymin = Infinity, ymax = -Infinity, ext = null;
        for (var i = 0; i < xs.length; i++) {
          var x = +xs[i].name; xmin = Math.min(xmin, x); xmax = Math.max(xmax, x);
          var ys = await listDir(xs[i]);
          for (var j = 0; j < ys.length; j++) {
            var m = ys[j].kind === 'file' && /^(\d+)\.(\w+)$/.exec(ys[j].name);
            if (!m || !EXT_RE.test(ys[j].name)) continue;
            ext = ext || m[2]; ymin = Math.min(ymin, +m[1]); ymax = Math.max(ymax, +m[1]);
          }
        }
        return { dir: dir, levels: levels, ext: ext || 'png', tms: tms,
          sampleBounds: isFinite(xmin) && isFinite(ymin) ? { z: levels[0], xmin: xmin, xmax: xmax, ymin: ymin, ymax: ymax } : null };
      }
      var dirs = entries.filter(function (e) { return e.kind === 'directory'; });
      if (dirs.length !== 1 || ++depth > 3) throw new Error('タイル構造 (z/x/y.png) が見つかりません');
      dir = dirs[0];
    }
  }
  function HandleSource(det) {
    this.det = det; this.cache = new Map();
    this.exts = [det.ext].concat(['png', 'jpg', 'jpeg', 'webp'].filter(function (e) { return e !== det.ext; }));
  }
  HandleSource.prototype._sub = function (parentKey, parent, name) {
    var key = parentKey + '/' + name, p = this.cache.get(key);
    if (!p) { p = parent.then(function (d) { return d ? d.getDirectoryHandle(name).catch(function () { return null; }) : null; }); this.cache.set(key, p); }
    return p;
  };
  HandleSource.prototype.getBlob = async function (z, x, y) {
    var zd = this._sub('', Promise.resolve(this.det.dir), String(z));
    var xd = await this._sub('/' + z, zd, String(x));
    if (!xd) return null;
    for (var i = 0; i < this.exts.length; i++) {
      try { var fh = await xd.getFileHandle(y + '.' + this.exts[i]); return await fh.getFile(); } catch (e) { /* 次の拡張子 */ }
    }
    return null;
  };

  // ---------- ブラウザ: FileList (webkitdirectory) ----------
  function detectFromFileList(files) {
    var map = new Map(), levels = new Set(), tms = false, ext = null;
    var re = /(?:^|\/)(\d+)\/(\d+)\/(\d+)\.(png|jpe?g|webp|gif)$/i;
    for (var i = 0; i < files.length; i++) {
      var f = files[i], p = f.webkitRelativePath || f.name;
      if (/tilemapresource\.xml$/i.test(p)) { tms = true; continue; }
      var m = re.exec(p); if (!m) continue;
      var k = m[1] + '/' + m[2] + '/' + m[3];
      if (!map.has(k)) map.set(k, f);
      levels.add(+m[1]); ext = ext || m[4];
    }
    if (!map.size) throw new Error('タイル (z/x/y.png) が見つかりません');
    var lv = Array.from(levels).sort(function (a, b) { return a - b; });
    var z0 = lv[0], xmin = Infinity, xmax = -Infinity, ymin = Infinity, ymax = -Infinity;
    map.forEach(function (_f, k) {
      var a = k.split('/'); if (+a[0] !== z0) return;
      xmin = Math.min(xmin, +a[1]); xmax = Math.max(xmax, +a[1]); ymin = Math.min(ymin, +a[2]); ymax = Math.max(ymax, +a[2]);
    });
    return { map: map, levels: lv, ext: ext, tms: tms, count: map.size, sampleBounds: { z: z0, xmin: xmin, xmax: xmax, ymin: ymin, ymax: ymax } };
  }
  function FileListSource(det) { this.det = det; }
  FileListSource.prototype.getBlob = function (z, x, y) { return Promise.resolve(this.det.map.get(z + '/' + x + '/' + y) || null); };

  // ---------- Leaflet レイヤー ----------
  // Blob を返す非同期ソース用。ObjectURL はタイル破棄時に解放。
  var BlobTileLayer = L.GridLayer.extend({
    options: { tms: false },
    initialize: function (source, options) { this._source = source; L.GridLayer.prototype.initialize.call(this, options); },
    createTile: function (coords, done) {
      var img = document.createElement('img'), self = this;
      img.alt = ''; img.setAttribute('role', 'presentation'); img.decoding = 'async';
      var z = coords.z, y = coords.y;
      if (this.options.tms) y = Math.pow(2, z) - 1 - y;
      this._source.getBlob(z, coords.x, y).then(function (blob) {
        if (!blob) { img.src = TRANSPARENT; done(null, img); return; }
        var url = URL.createObjectURL(blob); img._mdUrl = url;
        img.onload = function () { done(null, img); };
        img.onerror = function () { done(null, img); };
        img.src = url;
      }, function (e) { img.src = TRANSPARENT; done(e, img); });
      void self; return img;
    },
    _removeTile: function (key) {
      var t = this._tiles[key];
      if (t && t.el && t.el._mdUrl) URL.revokeObjectURL(t.el._mdUrl);
      L.GridLayer.prototype._removeTile.call(this, key);
    }
  });

  var COMMON = { maxZoom: 24, keepBuffer: 4, updateWhenZooming: false, updateWhenIdle: false, className: 'md-local-tiles' };

  /**
   * opened: {kind:'electron', info} | {kind:'handle', det} | {kind:'files', det}
   * 戻り値 L.Layer
   */
  function createLayer(opened, tms) {
    var info = opened.info || opened.det;
    var lv = info.levels;
    var opts = L.extend({}, COMMON, { minNativeZoom: lv[0], maxNativeZoom: lv[lv.length - 1], tms: !!tms,
      minZoom: Math.max(0, lv[0] - 6), bounds: boundsOf(info, tms) || undefined });
    if (opened.kind === 'electron') {
      return L.tileLayer('mdtile://' + info.token + '/{z}/{x}/{y}', L.extend(opts, { errorTileUrl: TRANSPARENT, crossOrigin: false }));
    }
    var src = opened.kind === 'handle' ? new HandleSource(info) : new FileListSource(info);
    return new BlobTileLayer(src, opts);
  }

  /**
   * 開いたタイルから 1 枚ずつ画像 URL を取り出す (印刷時に平面直角座標へワープ描画するため)。
   * getUrl(z, x, y) は XYZ の番号で受け、TMS なら内部で反転。戻り値 Promise<string|null>。release() で ObjectURL を解放。
   */
  function makeSource(opened, tms) {
    var info = opened.info || opened.det, urls = [];
    var flip = function (z, y) { return tms ? Math.pow(2, z) - 1 - y : y; };
    if (opened.kind === 'electron') {
      return { levels: info.levels, getUrl: function (z, x, y) { return Promise.resolve('mdtile://' + info.token + '/' + z + '/' + x + '/' + flip(z, y)); }, release: function () {} };
    }
    var src = opened.kind === 'handle' ? new HandleSource(info) : new FileListSource(info);
    return {
      levels: info.levels,
      getUrl: function (z, x, y) { return src.getBlob(z, x, flip(z, y)).then(function (b) { if (!b) return null; var u = URL.createObjectURL(b); urls.push(u); return u; }); },
      release: function () { urls.forEach(function (u) { URL.revokeObjectURL(u); }); urls = []; }
    };
  }

  root.MD.Tiles = { makeSource: makeSource,
    detectFromHandle: detectFromHandle, detectFromFileList: detectFromFileList,
    createLayer: createLayer, boundsOf: boundsOf, tile2lat: tile2lat, tile2lng: tile2lng
  };
})(typeof window !== 'undefined' ? window : globalThis);
