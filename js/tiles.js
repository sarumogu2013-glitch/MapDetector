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

  // ---------- ピラミッド表示: 無いズームを補う ----------
  // ・元より粗いズーム (最小ズーム未満・途中の抜け): 1 段細かいズームの 4 枚をメモリ上で合成・縮小して作る (再帰・キャッシュ)
  // ・元より細かい抜け: 一番近い粗いズームの画像を拡大 (最大ズーム超は Leaflet の maxNativeZoom で拡大)
  // ・データ範囲外は即座に空
  var PyramidTileLayer = L.GridLayer.extend({
    initialize: function (fetchUrl, info, tms, options) {
      L.GridLayer.prototype.initialize.call(this, options);
      this._fetch = fetchUrl; this._lv = info.levels.slice().sort(function (a, b) { return a - b; }); this._set = new Set(this._lv);
      this._cache = new Map(); this._inflight = new Map();
      var b = info.sampleBounds;
      if (b) {   // データ範囲 (XYZ のタイル番号で、最小ズーム z0 基準)
        var m = Math.pow(2, b.z) - 1;
        this._bx = { z: b.z, x0: b.xmin, x1: b.xmax, y0: tms ? m - b.ymax : b.ymin, y1: tms ? m - b.ymin : b.ymax };
      }
      this._tms = !!tms;
    },
    _inData: function (z, x, y) {
      var b = this._bx; if (!b) return true;
      if (z >= b.z) { var s = z - b.z; return (x >> s) >= b.x0 && (x >> s) <= b.x1 && (y >> s) >= b.y0 && (y >> s) <= b.y1; }
      var k = b.z - z; return (x << k) <= b.x1 && (((x + 1) << k) - 1) >= b.x0 && (y << k) <= b.y1 && (((y + 1) << k) - 1) >= b.y0;
    },
    _remember: function (key, v) {
      this._cache.set(key, v);
      if (this._cache.size > 700) this._cache.delete(this._cache.keys().next().value);   // 古いものから捨てる (約 700 枚)
    },
    _native: function (z, x, y) {
      var self = this, fy = this._tms ? Math.pow(2, z) - 1 - y : y;
      return Promise.resolve(this._fetch(z, x, fy)).then(function (u) {
        if (!u) return null;
        var src = u.url || u, cors = self.options.parentFallback;   // Web タイルは CORS 付きで読む (非対応の配信元は付けずに再試行)
        function load(withCors) {
          return new Promise(function (res) {
            var img = new Image(); img.decoding = 'async'; if (withCors) img.crossOrigin = 'anonymous';
            img.onload = function () { res(img); };
            img.onerror = function () { res(null); };
            img.src = src;
          });
        }
        return load(cors).then(function (im) { return im || !cors ? im : load(false); }).then(function (im) { if (u.revoke) u.revoke(); return im; });
      });
    },
    /** (z, x, y) の画像 (Image または Canvas、無ければ null) */
    _get: function (z, x, y) {
      var key = z + '/' + x + '/' + y, self = this;
      if (this._cache.has(key)) { var v = this._cache.get(key); this._cache.delete(key); this._cache.set(key, v); return Promise.resolve(v); }
      if (this._inflight.has(key)) return this._inflight.get(key);
      if (!this._inData(z, x, y)) return Promise.resolve(null);
      var lv = this._lv, finer = null, coarser = null;
      for (var i = 0; i < lv.length; i++) { if (lv[i] > z && finer == null) finer = lv[i]; if (lv[i] < z) coarser = lv[i]; }
      var p;
      if (this._set.has(z)) {
        p = this._native(z, x, y);
        // Web タイル: その場所にタイルが無ければ (404 等)、1 つ粗いズームの画像を拡大して埋める
        if (this.options.parentFallback && z > lv[0]) p = p.then(function (im) {
          if (im) return im;
          return self._get(z - 1, x >> 1, y >> 1).then(function (pa) {
            if (!pa) return null;
            var w = (pa.naturalWidth || pa.width) / 2, cv = document.createElement('canvas'); cv.width = cv.height = 256;
            cv.getContext('2d').drawImage(pa, (x & 1) * w, (y & 1) * w, w, w, 0, 0, 256, 256);
            return cv;
          });
        });
      }
      else if (finer != null && (coarser == null || finer - z <= 3)) {
        // 1 段細かいズームの 4 枚を合成して縮小 (その 4 枚も必要なら同じ方法で作る)
        p = Promise.all([[0, 0], [1, 0], [0, 1], [1, 1]].map(function (d) { return self._get(z + 1, 2 * x + d[0], 2 * y + d[1]); })).then(function (ch) {
          if (!ch.some(Boolean)) return null;
          var cv = document.createElement('canvas'); cv.width = cv.height = 256;
          var ctx = cv.getContext('2d'); ctx.imageSmoothingQuality = 'high';
          ch.forEach(function (im, k) { if (im) ctx.drawImage(im, (k % 2) * 128, (k >> 1) * 128, 128, 128); });
          return cv;
        });
      } else if (coarser != null) {
        // 粗いズームの画像の一部を拡大
        var d = z - coarser, n = Math.pow(2, d), px = x >> d, py = y >> d;
        p = this._get(coarser, px, py).then(function (im) {
          if (!im) return null;
          var w = (im.naturalWidth || im.width) / n, cv = document.createElement('canvas'); cv.width = cv.height = 256;
          cv.getContext('2d').drawImage(im, (x - px * n) * w, (y - py * n) * w, w, w, 0, 0, 256, 256);
          return cv;
        });
      } else p = Promise.resolve(null);
      p = p.then(function (v) { self._inflight.delete(key); if (v) self._remember(key, v); return v; }, function () { self._inflight.delete(key); return null; });
      this._inflight.set(key, p);
      return p;
    },
    createTile: function (coords, done) {
      var cv = document.createElement('canvas'); cv.width = cv.height = 256;
      this._get(coords.z, coords.x, coords.y).then(function (im) { if (im) cv.getContext('2d').drawImage(im, 0, 0, 256, 256); done(null, cv); }, function (e) { done(e, cv); });
      return cv;
    }
  });

  var COMMON = { maxZoom: 32, keepBuffer: 4, updateWhenZooming: false, updateWhenIdle: false, className: 'md-local-tiles' };

  /**
   * opened: {kind:'electron', info} | {kind:'handle', det} | {kind:'files', det}
   * 戻り値 L.Layer
   */
  function createLayer(opened, tms, extra) {
    var info = opened.info || opened.det;
    var lv = info.levels;
    var opts = L.extend({}, COMMON, { minNativeZoom: lv[0], maxNativeZoom: lv[lv.length - 1], tms: !!tms,
      minZoom: Math.max(0, lv[0] - 6), bounds: boundsOf(info, tms) || undefined }, extra || {});
    var layer;
    if (opened.kind === 'web') {
      // Web タイル: 指定ズーム範囲で取得し、無い場所は粗いズームを拡大して補う (最大ズーム超は拡大表示)
      layer = new PyramidTileLayer(function (z, x, y) { return webUrl(info, z, x, y); }, { levels: lv }, false,
        L.extend(opts, { minNativeZoom: undefined, minZoom: Math.max(0, lv[0] - 2), bounds: undefined, attribution: info.attribution || '', parentFallback: true }));
    } else if (!(extra && extra.minNativeZoom != null)) {
      // ローカルタイル: 無いズームを補うピラミッド表示 (最小ズーム未満は合成・縮小、最大ズーム超は拡大)
      var fetchUrl;
      if (opened.kind === 'electron') fetchUrl = function (z, x, y) { return 'mdtile://' + info.token + '/' + z + '/' + x + '/' + y; };
      else {
        var bsrc = opened.kind === 'handle' ? new HandleSource(info) : new FileListSource(info);
        fetchUrl = function (z, x, y) { return bsrc.getBlob(z, x, y).then(function (blob) { if (!blob) return null; var u = URL.createObjectURL(blob); return { url: u, revoke: function () { URL.revokeObjectURL(u); } }; }); };
      }
      layer = new PyramidTileLayer(fetchUrl, info, tms, L.extend(opts, { minNativeZoom: undefined }));
    } else if (opened.kind === 'electron') {
      layer = L.tileLayer('mdtile://' + info.token + '/{z}/{x}/{y}', L.extend(opts, { errorTileUrl: TRANSPARENT, crossOrigin: false }));
    } else {
      var src = opened.kind === 'handle' ? new HandleSource(info) : new FileListSource(info);
      layer = new BlobTileLayer(src, opts);
    }
    if (opts.preloadTiles) {
      // 全体図用: 表示範囲の周囲 N タイル分まで先読み (縮小した瞬間にも何か見えるように)。データ範囲外は読まない
      var n = opts.preloadTiles;
      layer._getTiledPixelBounds = function (center) {
        var b = L.GridLayer.prototype._getTiledPixelBounds.call(this, center);
        var px = this.getTileSize().x * this._map.getZoomScale(this._map.getZoom(), this._tileZoom) * n;
        return new L.Bounds(b.min.subtract([px, px]), b.max.add([px, px]));
      };
    }
    return layer;
  }

  /**
   * 開いたタイルから 1 枚ずつ画像 URL を取り出す (印刷時に平面直角座標へワープ描画するため)。
   * getUrl(z, x, y) は XYZ の番号で受け、TMS なら内部で反転。戻り値 Promise<string|null>。release() で ObjectURL を解放。
   */
  function makeSource(opened, tms) {
    var info = opened.info || opened.det, urls = [];
    var flip = function (z, y) { return tms ? Math.pow(2, z) - 1 - y : y; };
    if (opened.kind === 'web') {
      return { levels: info.levels, web: true, getUrl: function (z, x, y) { return Promise.resolve(webUrl(info, z, x, flip(z, y))); }, release: function () {} };
    }
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

  /** Web タイルの URL: {z}{x}{y}{s}{-y} に対応 */
  function webUrl(info, z, x, y) {
    var sd = info.subdomains || 'abc';
    return info.url.replace('{z}', z).replace('{x}', x).replace('{-y}', Math.pow(2, z) - 1 - y).replace('{y}', y).replace('{s}', sd[Math.abs(x + y) % sd.length]);
  }
  /**
   * Web タイルの提供ズーム範囲を自動判定: 指定地点のタイルを z0〜zmax まで並行に取りに行き、読めたズームの最小〜最大を返す。
   * 戻り値 Promise<{ minZ, maxZ, ok: [z...] } | null>
   */
  function probeWebZoom(info, lat, lng, zmax, timeoutMs) {
    zmax = zmax == null ? 22 : zmax;
    var tries = [];
    for (var z = 0; z <= zmax; z++) (function (z) {
      var n = Math.pow(2, z), x = Math.floor((lng + 180) / 360 * n), r = lat * Math.PI / 180;
      var y = Math.floor((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * n);
      if (info.tms) y = n - 1 - y;
      tries.push(new Promise(function (res) {
        var img = new Image(), done = false, fin = function (v) { if (!done) { done = true; res(v ? z : null); } };
        img.onload = function () { fin(img.naturalWidth > 0); }; img.onerror = function () { fin(false); };
        setTimeout(function () { fin(false); }, timeoutMs || 6000);
        img.src = webUrl(info, z, x, y);
      }));
    })(z);
    return Promise.all(tries).then(function (r) {
      var ok = r.filter(function (v) { return v != null; });
      return ok.length ? { minZ: ok[0], maxZ: ok[ok.length - 1], ok: ok } : null;
    });
  }
  /** Web タイルの「開いたタイル」情報を作る */
  function webOpened(o) {
    var lv = []; for (var z = o.minZ; z <= o.maxZ; z++) lv.push(z);
    return { kind: 'web', info: { url: o.url, levels: lv, tms: !!o.tms, ext: 'web', subdomains: o.subdomains, attribution: o.attribution || '' } };
  }

  root.MD.Tiles = { makeSource: makeSource, webOpened: webOpened, webUrl: webUrl, probeWebZoom: probeWebZoom,
    detectFromHandle: detectFromHandle, detectFromFileList: detectFromFileList,
    createLayer: createLayer, boundsOf: boundsOf, tile2lat: tile2lat, tile2lng: tile2lng
  };
})(typeof window !== 'undefined' ? window : globalThis);
