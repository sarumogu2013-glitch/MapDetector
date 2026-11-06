// MapDetector メインアプリ (レンダラー)
(function () {
  'use strict';
  var MD = window.MD, L = window.L, N = window.mdNative || null;
  var $ = function (id) { return document.getElementById(id); };
  if (N) document.body.classList.add('electron');

  // ---------------- 状態 ----------------
  var S = {
    zone: 9,
    tile: null,          // {opened, layer, name}
    base: null,
    overlays: [],        // {id, name, kind, shapes, layer, textLayer, visible, snap, geo?, img?}
    route: { list: [], cur: -1, ips: [], al: null, stations: [], bones: [], layer: null, proj: null },
    points: [], ptLayer: null,
    picking: false, snapOn: true,
    snapModes: { end: true, mid: true, inter: true, center: true, node: true, near: true },
    snap: new MD.Snap.Index(25),
    hover: null, nextId: 1
  };
  var VERSION = (N && N.version) || MD.VERSION || '0.0.0';

  // ---------------- 地図 ----------------
  var renderer = L.canvas({ padding: 0.5, tolerance: 4 });
  var map = L.map('map', {
    center: [35.681, 139.767], zoom: 12, maxZoom: 24, minZoom: 0,
    zoomSnap: 0.25, zoomDelta: 0.5, wheelPxPerZoomLevel: 90, wheelDebounceTime: 20,
    preferCanvas: true, renderer: renderer, attributionControl: true, boxZoom: true,
    // 回転 (leaflet-rotate): 方位ボタンのドラッグ / Shift+ホイール / 右ドラッグ / 2本指
    rotate: true, bearing: 0, rotateControl: { closeOnZeroBearing: false, position: 'topleft' }, shiftKeyRotate: true, touchRotate: true
  });
  map.attributionControl.setPrefix('MapDetector ' + VERSION);
  L.control.scale({ imperial: false, maxWidth: 160 }).addTo(map);
  S.ptLayer = L.layerGroup().addTo(map);

  // ---- 回転: 右ボタン (または Ctrl+左ボタン) ドラッグで画面中心まわりに回転、ステータスバーで数値入力
  function getBearing() { return map.getBearing ? map.getBearing() : 0; }
  function setBearing(deg) { deg = ((deg % 360) + 360) % 360; map.setBearing(deg); }
  (function () {
    var el = map.getContainer(), rot = null;
    function ang(ev) { var r = el.getBoundingClientRect(); return Math.atan2(ev.clientY - (r.top + r.height / 2), ev.clientX - (r.left + r.width / 2)) * 180 / Math.PI; }
    el.addEventListener('contextmenu', function (ev) { if (rot && rot.moved) ev.preventDefault(); });
    el.addEventListener('mousedown', function (ev) {
      if (!(ev.button === 2 || (ev.button === 0 && ev.ctrlKey))) return;
      rot = { a0: ang(ev), b0: getBearing(), moved: false };
      if (ev.button === 0) { ev.preventDefault(); ev.stopPropagation(); map.dragging.disable(); }
    }, true);
    document.addEventListener('mousemove', function (ev) {
      if (!rot) return;
      var d = ang(ev) - rot.a0; if (Math.abs(d) > 1) rot.moved = true;
      if (rot.moved) setBearing(rot.b0 + d);
    });
    document.addEventListener('mouseup', function () { if (rot) { map.dragging.enable(); setTimeout(function () { rot = null; }, 0); } });
  })();
  map.on('rotate', function () { var b = getBearing(); var inp = document.getElementById('numBearing'); if (inp && document.activeElement !== inp) inp.value = (Math.round(b * 10) / 10).toString(); if (!rotRaf) rotRaf = requestAnimationFrame(function () { rotRaf = 0; updateRouteLabels(); }); });
  map.on('rotate', function () { markDirty(); });
  var rotRaf = 0;
  var snapMarker = L.marker([0, 0], { interactive: false, keyboard: false, icon: L.divIcon({ className: '', iconSize: null }) });
  var centerMarker = L.marker([0, 0], { interactive: false, keyboard: false, icon: L.divIcon({ className: 'md-snap center', iconSize: null }) });

  var BASES = {
    pale: ['https://cyberjapandata.gsi.go.jp/xyz/pale/{z}/{x}/{y}.png', 18],
    std: ['https://cyberjapandata.gsi.go.jp/xyz/std/{z}/{x}/{y}.png', 18],
    photo: ['https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/{z}/{x}/{y}.jpg', 18]
  };
  function setBase(key) {
    if (S.base) { S.base.remove(); S.base = null; }
    $('selBase').value = key || '';
    if (!key || !BASES[key]) return;
    S.base = L.tileLayer(BASES[key][0], { maxNativeZoom: BASES[key][1], maxZoom: 24, zIndex: 0,
      attribution: '<a href="https://maps.gsi.go.jp/development/ichiran.html">地理院タイル</a>' }).addTo(map);
    S.base.bringToBack();
  }

  // ---------------- 座標変換 ----------------
  function toP(ll) { return MD.JPRCS.toPlane(ll.lat, ll.lng, S.zone); }
  function toLL(p) { var r = MD.JPRCS.toLatLng(p.e, p.n, S.zone); return L.latLng(r.lat, r.lng); }
  function f3(v) { return (Math.round(v * 1000) / 1000).toFixed(3); }
  var ROMAN = ['', 'I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI', 'XII', 'XIII', 'XIV', 'XV', 'XVI', 'XVII', 'XVIII', 'XIX'];
  (function () {
    var sel = $('selZone');
    for (var i = 1; i <= 19; i++) { var o = document.createElement('option'); o.value = i; o.textContent = ROMAN[i] + '系 (' + i + ')'; sel.appendChild(o); }
    sel.value = S.zone;
    sel.onchange = function () { setZone(+sel.value); };
  })();
  function setZone(z) {
    if (z === S.zone) return;
    S.zone = z; $('selZone').value = z;
    S.overlays.forEach(rebuildOverlay);
    rebuildRoute();
    refreshPoints();
    toast('座標系を ' + ROMAN[z] + '系 に変更');
  }

  // ---------------- UI 補助 ----------------
  var toastTimer;
  function toast(msg, ms) {
    var t = $('toast'); t.textContent = msg; t.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(function () { t.hidden = true; }, ms || 3000);
  }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function isTyping() { var a = document.activeElement; return a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.tagName === 'SELECT' || a.isContentEditable); }

  // ---------------- タイル ----------------
  function setTiles(opened, name, opt) {
    if (S.tile) S.tile.layer.remove();
    var info = opened.info || opened.det;
    var tms = !!info.tms;
    $('chkTms').checked = tms;
    var layer = MD.Tiles.createLayer(opened, tms);
    layer.setOpacity(+$('rngTileOpacity').value);
    layer.addTo(map);
    S.tile = { opened: opened, layer: layer, name: name };
    markDirty();
    var lv = info.levels;
    $('tileInfo').textContent = name + '\nズーム ' + lv[0] + '–' + lv[lv.length - 1] + ' / ' + (info.ext || '') + (info.count ? ' / ' + info.count + '枚' : '') + (tms ? ' / TMS' : '');
    if (!(opt && opt.noFit)) fitTiles(true);
  }
  function fitTiles(autoZone) {
    if (!S.tile) return;
    var info = S.tile.opened.info || S.tile.opened.det;
    var b = MD.Tiles.boundsOf(info, $('chkTms').checked);
    if (!b) return;
    map.fitBounds(b, { animate: false });
    if (autoZone) { var c = b.getCenter(); var z = MD.JPRCS.guessZone(c.lat, c.lng); if (z && z !== S.zone && !S.overlays.length && !S.route.ips.length) setZone(z); }
  }
  $('chkTms').onchange = function () { if (S.tile) { var o = S.tile; setTilesKeepTms(o); } };
  function setTilesKeepTms(o) {
    o.layer.remove();
    o.layer = MD.Tiles.createLayer(o.opened, $('chkTms').checked);
    o.layer.setOpacity(+$('rngTileOpacity').value).addTo(map);
    fitTiles(false);
  }
  $('rngTileOpacity').oninput = function () { if (S.tile) S.tile.layer.setOpacity(+this.value); };
  $('selBase').onchange = function () { setBase(this.value); markDirty(); };

  async function openTiles() {
    try {
      if (N) {
        var info = await N.openTileFolder(); if (!info) return;
        setTiles({ kind: 'electron', info: info }, info.root);
        N.setSetting && N.setSetting('lastTileFolder', info.root);
      } else if (window.showDirectoryPicker) {
        var dir = await window.showDirectoryPicker({ id: 'tiles', mode: 'read' });
        await openTileHandle(dir);
      } else { $('inpTiles').click(); }
    } catch (e) { if (e && e.name !== 'AbortError') toast('タイルを開けません: ' + e.message, 5000); }
  }
  async function openTileHandle(dir) {
    toast('タイル構造を解析中…', 10000);
    var det = await MD.Tiles.detectFromHandle(dir);
    setTiles({ kind: 'handle', det: det }, dir.name);
    toast('タイルを読み込みました');
  }
  $('btnOpenTiles').onclick = openTiles;
  $('btnOpenTilesFallback').onclick = function () { $('inpTiles').click(); };
  $('inpTiles').onchange = function () {
    try {
      var files = this.files; if (!files.length) return;
      var det = MD.Tiles.detectFromFileList(files);
      var name = (files[0].webkitRelativePath || '').split('/')[0] || 'tiles';
      setTiles({ kind: 'files', det: det }, name);
    } catch (e) { toast(e.message, 5000); }
    this.value = '';
  };

  // ---------------- 図形 → Leaflet ----------------
  function arcPts(c, r, a0, a1, seg) {
    var da = a1 - a0; while (da <= 0) da += Math.PI * 2;
    var n = Math.max(8, Math.ceil((seg || 72) * da / (Math.PI * 2))), out = [];
    for (var i = 0; i <= n; i++) { var a = a0 + da * i / n; out.push({ e: c.e + r * Math.cos(a), n: c.n + r * Math.sin(a) }); }
    return out;
  }
  function shapesToLayers(shapes, style, rend, k, bearing) {
    style = style || {}; rend = rend || renderer; k = k || 1; bearing = bearing || 0;
    var byColor = {}, group = L.featureGroup(), texts = [];
    function add(color, pts) { (byColor[color] = byColor[color] || []).push(pts.map(toLL)); }
    shapes.forEach(function (s) {
      var col = style.color || s.color || '#0f172a';
      if (s.type === 'polyline') { var p = s.pts; if (s.closed && p.length > 2) p = p.concat([p[0]]); if (p.length > 1) add(col, p); }
      else if (s.type === 'circle') add(col, arcPts(s.c, s.r, 0, Math.PI * 2));
      else if (s.type === 'arc') add(col, arcPts(s.c, s.r, s.a0, s.a1));
      else if (s.type === 'point') L.circleMarker(toLL(s.p), { radius: 3 * k, color: col, weight: 1 * k, fillOpacity: 0.8, renderer: rend, interactive: false }).addTo(group);
      else if (s.type === 'text' && s.text) texts.push(s);
    });
    Object.keys(byColor).forEach(function (col) {
      L.polyline(byColor[col], { color: col, weight: (style.weight || 1.2) * k, opacity: style.opacity || 0.95, renderer: rend, interactive: false, smoothFactor: 0.5 }).addTo(group);
    });
    var textLayer = null;
    if (texts.length) {
      textLayer = L.layerGroup();
      texts.slice(0, 5000).forEach(function (t) {
        var rot = -(t.rot || 0) * 180 / Math.PI + bearing;
        L.marker(toLL(t.p), { interactive: false, keyboard: false, icon: L.divIcon({ className: '', iconSize: null,
          html: '<div class="md-text" style="transform: translate(0,-100%) rotate(' + rot + 'deg); transform-origin: 0 100%; color:' + esc(t.color || '#111') + (k !== 1 ? ';font-size:' + (11 * k).toFixed(1) + 'px' : '') + '">' + esc(t.text) + '</div>' }) }).addTo(textLayer);
      });
    }
    return { layer: group, textLayer: textLayer };
  }
  function updateTextVisibility() {
    var z = map.getZoom();
    S.overlays.forEach(function (o) {
      if (!o.textLayer) return;
      var show = o.visible && z >= 17;
      if (show && !map.hasLayer(o.textLayer)) o.textLayer.addTo(map);
      if (!show && map.hasLayer(o.textLayer)) o.textLayer.remove();
    });
    updateRouteLabels();
  }
  map.on('zoomend', updateTextVisibility);

  // ---------------- オーバーレイ ----------------
  function geojsonToShapes(gj) {
    var out = [];
    function line(coords, closed) { out.push({ type: 'polyline', pts: coords.map(function (c) { return toP({ lat: c[1], lng: c[0] }); }), closed: closed, layer: 'geojson' }); }
    function geom(g) {
      if (!g) return;
      switch (g.type) {
        case 'Point': out.push({ type: 'point', p: toP({ lat: g.coordinates[1], lng: g.coordinates[0] }), layer: 'geojson' }); break;
        case 'MultiPoint': g.coordinates.forEach(function (c) { geom({ type: 'Point', coordinates: c }); }); break;
        case 'LineString': line(g.coordinates, false); break;
        case 'MultiLineString': g.coordinates.forEach(function (c) { line(c, false); }); break;
        case 'Polygon': g.coordinates.forEach(function (c) { line(c, true); }); break;
        case 'MultiPolygon': g.coordinates.forEach(function (p) { p.forEach(function (c) { line(c, true); }); }); break;
        case 'GeometryCollection': g.geometries.forEach(geom); break;
      }
    }
    (gj.type === 'FeatureCollection' ? gj.features : gj.type === 'Feature' ? [gj] : [{ geometry: gj }]).forEach(function (f) { geom(f.geometry); });
    return out;
  }
  function rebuildOverlay(o) {
    if (o.kind === 'image') return;
    if (o.layer) o.layer.remove();
    if (o.textLayer) o.textLayer.remove();
    if (o.kind === 'geojson') {
      o.shapes = geojsonToShapes(o.geo);
      o.layer = L.geoJSON(o.geo, { style: { color: o.color, weight: 1.5 }, pointToLayer: function (f, ll) { return L.circleMarker(ll, { radius: 3, renderer: renderer }); }, interactive: false });
    } else {
      var r = shapesToLayers(o.shapes, o.color ? { color: o.color } : null);
      o.layer = r.layer; o.textLayer = r.textLayer;
    }
    if (o.visible) o.layer.addTo(map);
    S.snap.setGroup(o.id, o.shapes);
    S.snap.setGroupEnabled && S.snap.setGroupEnabled(o.id, o.visible && o.snap);
    updateTextVisibility();
  }
  function addOverlay(o, rs) {
    o.id = 'ov' + (S.nextId++); o.visible = true; o.snap = o.kind !== 'image';
    if (rs) { if (rs.label) o.name = rs.label; if (rs.visible != null) o.visible = rs.visible; if (rs.snap != null) o.snap = rs.snap; if (rs.color) o.color = rs.color; }
    if (o.kind === 'image') o.layer.on('change', markDirty);
    markDirty();
    S.overlays.push(o);
    if (o.kind === 'image') { if (o.visible) o.layer.addTo(map); } else rebuildOverlay(o);
    renderLayerList();
  }
  function removeOverlay(o) {
    if (o.layer) o.layer.remove(); if (o.textLayer) o.textLayer.remove();
    S.snap.removeGroup(o.id);
    S.overlays.splice(S.overlays.indexOf(o), 1);
    if (o.url) URL.revokeObjectURL(o.url);
    renderLayerList(); markDirty();
  }
  function renderLayerList() {
    var ul = $('layerList'); ul.innerHTML = '';
    S.overlays.forEach(function (o) {
      var li = document.createElement('li');
      li.innerHTML = '<input type="checkbox" class="vis" title="表示"' + (o.visible ? ' checked' : '') + '>' +
        '<span class="name" title="' + esc(o.name) + '">' + esc(o.name) + '</span>' +
        (o.kind === 'image' ? '<input type="range" class="op" min="0" max="1" step="0.05" value="' + o.layer.options.opacity + '" title="不透明度"><label title="位置合わせハンドル"><input type="checkbox" class="ed" checked>調整</label>'
          : '<label title="スナップ対象"><input type="checkbox" class="sn"' + (o.snap ? ' checked' : '') + '>snap</label>' + (o.kind === 'sima' ? '<button class="edit" title="座標点を表で編集">編集</button>' : '') + '<button class="fit" title="全体表示">⤢</button>') +
        '<button class="x" title="削除">×</button>';
      li.querySelector('.vis').onchange = function () {
        o.visible = this.checked; markDirty();
        if (o.visible) o.layer.addTo(map); else o.layer.remove();
        if (S.snap.setGroupEnabled && o.kind !== 'image') S.snap.setGroupEnabled(o.id, o.visible && o.snap);
        updateTextVisibility();
      };
      var sn = li.querySelector('.sn'); if (sn) sn.onchange = function () { o.snap = this.checked; markDirty(); S.snap.setGroupEnabled && S.snap.setGroupEnabled(o.id, o.visible && o.snap); };
      var op = li.querySelector('.op'); if (op) op.oninput = function () { o.layer.setOpacity(+this.value); markDirty(); };
      var ed = li.querySelector('.ed'); if (ed) { ed.checked = o.layer._editable !== false; ed.onchange = function () { o.layer.setEditable(this.checked); markDirty(); }; }
      var fit = li.querySelector('.fit'); if (fit) fit.onclick = function () { try { map.fitBounds(o.layer.getBounds(), { maxZoom: 20 }); } catch (e) { /* empty */ } };
      var edb = li.querySelector('.edit'); if (edb) edb.onclick = function () { openSimaEditor(o); };
      li.querySelector('.x').onclick = function () { if (DOCK.target === o) closeDock(); removeOverlay(o); };
      ul.appendChild(li);
    });
  }

  // ファイル読込 (Electron/ブラウザ共通)
  async function pickFile(kind, inputId) {
    if (N) return N.openFile(kind);
    return new Promise(function (resolve) {
      var inp = $(inputId);
      inp.onchange = async function () { var f = inp.files[0]; inp.value = ''; if (!f) return resolve(null); resolve({ name: f.name, data: await f.arrayBuffer() }); };
      inp.click();
    });
  }
  async function openDrawing() { var f = await pickFile('drawing', 'inpDrawing'); if (f) loadDrawing(f.name, f.data); }
  async function openSima() { var f = await pickFile('sima', 'inpSima'); if (f) loadSima(f.name, f.data); }
  $('btnOpenDrawing').onclick = openDrawing;
  $('btnOpenSima').onclick = openSima;

  // opt.restore: プロジェクト復元時 (保存された状態を適用し、表示範囲の移動やメッセージを抑止)
  function loadDrawing(name, data, opt) {
    opt = opt || {};
    var rs = opt.restore || null;
    var ext = (name.split('.').pop() || '').toLowerCase();
    var src = { name: name, data: data };
    try {
      if (ext === 'dxf') {
        var dxfOpts = rs && rs.dxfOpts ? rs.dxfOpts : { swapXY: $('chkDxfSwap').checked, scale: +$('selDxfScale').value };
        var text = MD.DXF.decode(data);
        var res = MD.DXF.parse(text, dxfOpts);
        if (!res.shapes.length) throw new Error('図形がありません');
        addOverlay({ name: name, kind: 'dxf', shapes: res.shapes, src: src, dxfOpts: dxfOpts }, rs);
        var o = S.overlays[S.overlays.length - 1];
        if (rs) return;
        if (res.bounds) {
          var b = L.latLngBounds(toLL({ e: res.bounds.minE, n: res.bounds.minN }), toLL({ e: res.bounds.maxE, n: res.bounds.maxN }));
          if (!map.getBounds().intersects(b) || !S.tile) map.fitBounds(b, { maxZoom: 20 });
        }
        toast(name + ': ' + res.shapes.length + ' 図形' + (res.warnings && res.warnings.length ? ' (警告 ' + res.warnings.length + ')' : ''));
        void o;
      } else if (ext === 'geojson' || ext === 'json') {
        var gj = JSON.parse(new TextDecoder('utf-8').decode(data));
        addOverlay({ name: name, kind: 'geojson', geo: gj, color: '#7c3aed', src: src }, rs);
        if (rs) return;
        try { map.fitBounds(S.overlays[S.overlays.length - 1].layer.getBounds(), { maxZoom: 19 }); } catch (e) { /* empty */ }
      } else if (/^(png|jpe?g|gif|webp|bmp)$/.test(ext)) {
        var url = URL.createObjectURL(new Blob([data]));
        if (rs && rs.image) {
          var lay = new MD.AffineImage(url, rs.image.corners.map(function (c) { return L.latLng(c[0], c[1]); }), { opacity: rs.image.opacity, editable: rs.image.editable });
          addOverlay({ name: name, kind: 'image', layer: lay, url: url, shapes: [], src: src }, rs);
          return;
        }
        var img = new Image();
        img.onload = function () {
          // 現在表示範囲の 70% に縦横比を保って配置
          var sz = map.getSize(), w = img.naturalWidth, h = img.naturalHeight;
          var sc = Math.min(sz.x * 0.7 / w, sz.y * 0.7 / h), cx = sz.x / 2, cy = sz.y / 2;
          var tl = map.containerPointToLatLng([cx - w * sc / 2, cy - h * sc / 2]);
          var tr = map.containerPointToLatLng([cx + w * sc / 2, cy - h * sc / 2]);
          var bl = map.containerPointToLatLng([cx - w * sc / 2, cy + h * sc / 2]);
          var layer = new MD.AffineImage(url, [tl, tr, bl], { opacity: 0.6 });
          addOverlay({ name: name, kind: 'image', layer: layer, url: url, shapes: [], src: src });
          toast('赤い丸(左上/右上/左下)と中央の✥をドラッグして位置合わせ', 6000);
        };
        img.src = url;
      } else if (ext === 'sim' || ext === 'xml') { loadSima(name, data, opt); }
      else throw new Error('未対応の形式: ' + ext);
    } catch (e) { toast(name + ' を読めません: ' + e.message, 6000); console.error(e); }
  }

  // ---------------- 線形 (SIMA / IP) ----------------
  /** SIMA 座標点 (表で編集可能な行) + 画地/線 → 表示・スナップ用図形 */
  function simaShapes(o) {
    var out = [];
    o.points.forEach(function (p) {
      var x = +p.x, y = +p.y; if (!isFinite(x) || !isFinite(y) || p.x === '' || p.y === '') return;
      out.push({ type: 'point', p: { e: y, n: x }, name: p.name, layer: 'sima', color: '#0369a1' });
      if (p.name) out.push({ type: 'text', p: { e: y, n: x }, text: String(p.name), h: 1, rot: 0, layer: 'sima', color: '#0369a1' });
    });
    return out.concat(o.extraShapes || []);
  }
  function loadSima(name, data, opt) {
    opt = opt || {};
    var rs = opt.restore || null;
    try {
      var text = MD.SIMA.decode(data);
      var isXml = MD.SIMAXML && MD.SIMAXML.isSimaXml(text);
      var res = isXml ? MD.SIMAXML.parse(text) : MD.SIMA.parse(text);
      if (!rs && res.zone && res.zone !== S.zone) setZone(res.zone);
      var routes = (res.routes || []).filter(function (r) { return r.ips && r.ips.length >= 2; });
      if (rs) routes = [];   // 路線はプロジェクトに保存された内容 (IP表の編集を含む) を使う
      if (routes.length) {
        routes.forEach(function (r) { r.label = name + ' : ' + (r.name || ('路線' + (r.no || ''))); });
        S.route.list = S.route.list.concat(routes);
        renderRouteSelect();
        selectRoute(S.route.list.length - routes.length);
        fitRoute();
      }
      var extra = [];
      var ptRows = rs && rs.points ? rs.points : (res.points || []).map(function (p) { return { no: p.no, name: p.name, x: p.n, y: p.e, z: p.z || 0 }; });
      var shapes = extra;
      (res.parcels || []).forEach(function (pc) {
        if (pc.pts && pc.pts.length >= 3) shapes.push({ type: 'polyline', pts: pc.pts.map(function (q) { return { e: q.e, n: q.n }; }), closed: true, layer: '画地', color: '#b45309', name: pc.name });
      });
      (res.lines || []).forEach(function (ln) { shapes.push({ type: 'polyline', pts: ln.pts.map(function (q) { return { e: q.e, n: q.n }; }), closed: false, layer: '開放型画地', color: '#9333ea', name: ln.name }); });
      if (ptRows.length || extra.length) {
        var cnt = [ptRows.length + '点', (res.parcels || []).length ? res.parcels.length + '画地' : '', (res.lines || []).length ? res.lines.length + '線' : ''].filter(Boolean).join(' ');
        var so = { name: name + ' (' + cnt + ')', kind: 'sima', points: ptRows, extraShapes: extra, src: { name: name, data: data } };
        so.shapes = simaShapes(so);
        if (rs && rs.points) so.pointsEdited = true;
        addOverlay(so, rs);
        if (rs) return;
        if (!routes.length) { try { map.fitBounds(S.overlays[S.overlays.length - 1].layer.getBounds(), { maxZoom: 19 }); } catch (e) { /* 点のみ */ } }
      }
      if (rs) return;
      var w = (res.warnings || []).concat.apply(res.warnings || [], routes.map(function (r) { return r.warnings || []; }));
      toast(name + (isXml ? ' [JPGIS XML' + (res.zone ? ' ' + ROMAN[res.zone] + '系' : '') + ']' : '') + ': 路線 ' + routes.length + ' / 座標 ' + (res.points || []).length + '点' + (w.length ? '\n警告: ' + w.slice(0, 3).join(' / ') : ''), 6000);
    } catch (e) { toast('SIMAを読めません: ' + e.message, 6000); console.error(e); }
  }
  function renderRouteSelect() {
    var sel = $('selRoute'); sel.innerHTML = '';
    S.route.list.forEach(function (r, i) { var o = document.createElement('option'); o.value = i; o.textContent = r.label || r.name || ('路線' + (i + 1)); sel.appendChild(o); });
    sel.value = S.route.cur;
  }
  $('selRoute').onchange = function () { selectRoute(+this.value); };
  function selectRoute(i) {
    S.route.cur = i; $('selRoute').value = i;
    var r = S.route.list[i];
    S.route.ips = r ? r.ips.map(function (p) { return { name: p.name || '', e: +p.e, n: +p.n, R: +p.R || 0, A1: +p.A1 || 0, A2: +p.A2 || 0 }; }) : [];
    // SIMA にある追加距離・測点間隔・幅員を設定 (追加距離がある線形は測点を追加距離で表記)
    if (r && r.startChainage != null) { $('numStart').value = r.startChainage; $('selStaFmt').value = 'ch'; }
    if (r && r.pitch) $('numPitch').value = r.pitch;
    if (r && r.widths) { if (r.widths.left != null) $('numLeft').value = r.widths.left; if (r.widths.right != null) $('numRight').value = r.widths.right; }
    renderIpTable(); rebuildRoute();
  }
  function renderIpTable() {
    var tb = $('tblIp').tBodies[0]; tb.innerHTML = '';
    S.route.ips.forEach(function (p, i) {
      var tr = document.createElement('tr');
      tr.innerHTML = '<td class="name"><input data-k="name" value="' + esc(p.name) + '"></td>' +
        ['n', 'e', 'R', 'A1', 'A2'].map(function (k) { return '<td><input data-k="' + k + '" value="' + (k === 'n' || k === 'e' ? f3(p[k]) : (p[k] || '')) + '"></td>'; }).join('') +
        '<td><button class="x" title="削除">×</button></td>';
      tr.querySelectorAll('input').forEach(function (inp) { inp.onchange = function () { var k = inp.dataset.k; p[k] = k === 'name' ? inp.value : (+inp.value || 0); }; });
      tr.querySelector('.x').onclick = function () { S.route.ips.splice(i, 1); renderIpTable(); rebuildRoute(); };
      tb.appendChild(tr);
    });
  }
  $('btnAddIp').onclick = function () {
    var last = S.route.ips[S.route.ips.length - 1], c = toP(map.getCenter());
    S.route.ips.push({ name: 'IP' + S.route.ips.length, e: last ? last.e + 50 : c.e, n: last ? last.n : c.n, R: 0, A1: 0, A2: 0 });
    renderIpTable();
  };
  $('btnApplyIp').onclick = function () { rebuildRoute(); };
  ['numPitch', 'numSub', 'numStart', 'numLeft', 'numRight', 'chkKey', 'chkEdges', 'chkLabels', 'chkIpLine', 'numLabelZoom', 'selStaFmt'].forEach(function (id) {
    $(id).addEventListener('change', rebuildRoute);
  });
  function routeFromPoints() {
    if (S.points.length < 2) { toast('取得点が2点以上必要です (始点=BP, 終点=EP)'); return; }
    var ips = S.points.map(function (p, i, a) { return { name: i === 0 ? 'BP' : i === a.length - 1 ? 'EP' : 'IP' + i, e: p.e, n: p.n, R: 0, A1: 0, A2: 0 }; });
    S.route.list.push({ label: '取得点から作成 ' + (S.route.list.length + 1), ips: ips });
    renderRouteSelect(); selectRoute(S.route.list.length - 1);
    $('tblIp').closest('details').open = true;
    toast('IP表で曲線半径 R / クロソイド A を入力して「反映」');
  }
  $('btnNewRoute').onclick = routeFromPoints;

  function fmtCh(ch) { var r = Math.round(ch * 100) / 100; return Math.abs(r - Math.round(r)) < 1e-9 ? String(Math.round(r)) : r.toFixed(2); }
  function staLabel(ch, pitch) {
    if ($('selStaFmt').value === 'ch') return fmtCh(ch);
    var k = Math.floor((ch + 1e-6) / pitch), rem = ch - k * pitch;
    return 'No.' + k + (rem > 0.005 ? '+' + rem.toFixed(2) : '');
  }
  function rebuildRoute() {
    var R = S.route;
    markDirty();
    if (DOCK.kind === 'ip' && !DOCK.updating && DOCK.grid) DOCK.grid.setRows(ipRows());
    if (R.layer) { R.layer.remove(); R.layer = null; }
    if (R.labelLayer) { R.labelLayer.remove(); R.labelLayer = null; }
    R.bones = [];
    S.snap.removeGroup('route');
    R.al = null; R.proj = null; R.stations = []; R.bones = [];
    if (R.ips.length < 2) { $('alignInfo').textContent = ''; return; }
    var pitch = Math.max(0.1, +$('numPitch').value || 20);
    var al;
    try { al = MD.Alignment.build(R.ips, {}); } catch (e) { $('alignInfo').textContent = '線形計算エラー: ' + e.message; return; }
    var st = MD.Alignment.stations(al, { pitch: pitch, sub: +$('numSub').value || 0, startChainage: +$('numStart').value || 0, includeKeyPoints: $('chkKey').checked, endInclude: true });
    if ($('selStaFmt').value === 'ch') st.forEach(function (x) {
      x.label = (x.kind === 'key' ? x.label.split(' ')[0] + ' ' : '') + fmtCh(x.chainage);
    });
    var bones = MD.Alignment.fishbone(al, st, { left: +$('numLeft').value || 0, right: +$('numRight').value || 0 });
    var srcRoute = S.route.list[S.route.cur];
    if (srcRoute && srcRoute.customStations) {
      // 表で編集した測点 (追加距離・測点ごとの幅員) で横断線を作る
      var cs = stationGeom(al, srcRoute.customStations).filter(function (x) { return x.ok; });
      st = cs.map(function (x) { return x.station; });
      bones = cs.map(function (x) { return x.bone; });
    }
    R.al = al; R.stations = st; R.bones = bones; R.pitch = pitch;

    var shapes = [], D = { ips: $('chkIpLine').checked ? R.ips.slice() : null, cl: null, ol: null, or: null, mainB: [], keyB: [], subB: [] };
    R.ips.forEach(function (p) { shapes.push({ type: 'point', p: { e: p.e, n: p.n }, name: p.name, layer: 'IP' }); });
    // 中心線: 要素ごとに正確な形状でスナップ登録
    al.elements.forEach(function (el) {
      if (el.type === 'line') {
        var p1 = MD.Alignment.pointAt(al, el.s0 + el.len);
        shapes.push({ type: 'polyline', pts: [el.p0, { e: p1.e, n: p1.n }], closed: false, layer: 'CL' });
      } else if (el.type === 'arc' && Math.abs(el.k0) > 1e-12) {
        var rr = 1 / el.k0, c = { e: el.p0.e - Math.sin(el.h0) * rr, n: el.p0.n + Math.cos(el.h0) * rr };
        var a0 = Math.atan2(el.p0.n - c.n, el.p0.e - c.e), a1 = a0 + el.len * el.k0;
        shapes.push({ type: 'arc', c: c, r: Math.abs(rr), a0: el.k0 > 0 ? a0 : a1, a1: el.k0 > 0 ? a1 : a0, layer: 'CL' });
      } else {
        var pts = [], n = Math.max(4, Math.ceil(el.len / 1));
        for (var i = 0; i <= n; i++) { var q = MD.Alignment.pointAt(al, el.s0 + el.len * i / n); pts.push({ e: q.e, n: q.n }); }
        shapes.push({ type: 'polyline', pts: pts, closed: false, noVertexSnap: true, layer: 'CL' });
      }
    });
    D.cl = MD.Alignment.sample(al, 1);
    if ($('chkEdges').checked) {
      var wl = +$('numLeft').value || 0, wr = +$('numRight').value || 0;
      if (wl > 0) { var ol = D.ol = MD.Alignment.offset(al, wl, 1); shapes.push({ type: 'polyline', pts: ol, closed: false, noVertexSnap: true, layer: 'EDGE' }); }
      if (wr > 0) { var or = D.or = MD.Alignment.offset(al, -wr, 1); shapes.push({ type: 'polyline', pts: or, closed: false, noVertexSnap: true, layer: 'EDGE' }); }
    }
    bones.forEach(function (b) {
      (b.station.kind === 'key' ? D.keyB : b.station.kind === 'sub' ? D.subB : D.mainB).push([b.l, b.r]);
      shapes.push({ type: 'polyline', pts: [b.l, b.c, b.r], closed: false, layer: 'BONE' });
    });
    al.keyPoints.forEach(function (k) { var q = MD.Alignment.pointAt(al, k.s); shapes.push({ type: 'point', p: { e: q.e, n: q.n }, name: k.name, layer: 'KEY' }); });
    R.draw = D;
    R.layer = drawRoute(D, renderer).addTo(map);
    S.snap.setGroup('route', shapes);

    updateRouteLabels();

    // 取得点の測点/離れ 計算用
    var sArr = [], pArr = [], step = 1, n2 = Math.ceil(al.length / step);
    for (var j = 0; j <= n2; j++) { var s = Math.min(al.length, j * step), q2 = MD.Alignment.pointAt(al, s); sArr.push(s); pArr.push(q2); }
    R.proj = { s: sArr, p: pArr, start: +$('numStart').value || 0 };

    var w = (al.warnings || []).slice(), src = S.route.list[S.route.cur], chk = '';
    // SIMA の中心線測点・幅杭座標と照合
    if (src && src.check && src.check.length) {
      var st0 = +$('numStart').value || 0, mx = 0, worst = '', n = 0;
      src.check.forEach(function (c) {
        if (!c.sideKnown) return;
        var q = MD.Alignment.pointAt(al, c.chainage - st0);
        var d = Math.hypot(q.e - Math.sin(q.h) * c.off - c.e, q.n + Math.cos(q.h) * c.off - c.n);
        n++; if (d > mx) { mx = d; worst = c.name; }
      });
      if (n) chk = '\n照合: SIMA の測点・幅杭 ' + n + '点 最大差 ' + (mx * 1000).toFixed(1) + ' mm' + (mx > 0.01 ? ' (' + worst + ') ⚠ 不一致' : ' ✓');
    }
    if (DOCK.kind === 'stations' && !DOCK.updating && DOCK.grid) DOCK.grid.setRows(stationRows());
    $('alignInfo').textContent = '延長 ' + al.length.toFixed(3) + ' m / 測点 ' + st.length + (srcRoute && srcRoute.customStations ? ' (表で編集中)' : '') + ' / 主要点 ' + al.keyPoints.length + chk + (w.length ? '\n⚠ ' + w.join('\n⚠ ') : '');
    refreshPoints();
  }
  /** 線形の描画 (メイン画面・印刷で共用)。D: rebuildRoute が作る描画データ (平面座標) */
  function drawRoute(D, rend, k) {
    k = k || 1;   // 線幅の倍率 (印刷用)
    var g = L.featureGroup(), o = { renderer: rend, interactive: false };
    function pl(pts, opt) { return L.polyline(pts.map(toLL), L.extend({}, o, opt)).addTo(g); }
    function multi(arr, opt) { if (arr.length) L.polyline(arr.map(function (ln) { return ln.map(toLL); }), L.extend({}, o, opt)).addTo(g); }
    if (D.ips) {
      pl(D.ips, { color: '#64748b', weight: 1 * k, dashArray: (6 * k) + ' ' + (4 * k) });
      D.ips.forEach(function (p) { L.circleMarker(toLL(p), L.extend({}, o, { radius: 3.5 * k, color: '#475569', weight: 1 * k, fillColor: '#fff', fillOpacity: 1 })).addTo(g); });
    }
    if (D.cl) pl(D.cl, { color: '#dc2626', weight: 2 * k });
    if (D.ol) pl(D.ol, { color: '#2563eb', weight: 1.2 * k });
    if (D.or) pl(D.or, { color: '#2563eb', weight: 1.2 * k });
    multi(D.subB, { color: '#16a34a', weight: 0.8 * k, opacity: 0.7, dashArray: (3 * k) + ' ' + (3 * k) });
    multi(D.mainB, { color: '#16a34a', weight: 1.4 * k });
    multi(D.keyB, { color: '#dc2626', weight: 1.4 * k });
    return g;
  }
  /** 測点ラベル: 横断線方向に回転、表示縮尺に応じて間引き (主要点は重ならない範囲で表示) */
  function routeLabelLayer(mpp, bearing, scaleK) {
    var R = S.route, k = scaleK || 1;
    var px = R.pitch / mpp;
    var every = Math.max(1, Math.ceil(16 * k / Math.max(px, 0.01)));
    var nice = [1, 2, 5, 10, 25, 50, 100, 250, 500, 1000]; every = nice.find(function (v) { return v >= every; }) || every;
    var lab = L.layerGroup(), keyPx = -1e9;
    R.bones.forEach(function (b) {
      var st = b.station, key = st.kind === 'key';
      if (st.kind === 'sub') return;
      if (!key) { var kk = Math.round((st.chainage) / R.pitch); if (kk % every) return; }
      else { var sp = b.station.s / mpp; if (sp - keyPx < 12 * k) return; keyPx = sp; }
      var raw = -(b.h + Math.PI / 2) * 180 / Math.PI + bearing;
      raw = ((raw % 360) + 360) % 360;
      var flip = raw > 90 && raw < 270, ang = flip ? raw - 180 : raw;
      L.marker(toLL(b.l), { interactive: false, keyboard: false, icon: L.divIcon({ className: '', iconSize: null,
        html: '<div class="md-sta-rot" style="transform: rotate(' + ang.toFixed(1) + 'deg)"><div class="md-sta-label' + (key ? ' md-key-label' : '') + (flip ? ' flip' : '') + '"' + (k !== 1 ? ' style="font-size:' + (11 * k).toFixed(1) + 'px"' : '') + '>' + esc(st.label) + '</div></div>' }) }).addTo(lab);
    });
    return lab;
  }
  // 測点ラベル (横断線方向に回転)。ズームに応じて間引き (主要点は常に表示)
  function updateRouteLabels() {
    var R = S.route;
    if (R.labelLayer) { R.labelLayer.remove(); R.labelLayer = null; }
    if (!R.bones.length || !$('chkLabels').checked || map.getZoom() < (+$('numLabelZoom').value || 0)) return;
    R.labelLayer = routeLabelLayer(metersPerPixel(toLL(R.bones[0].c).lat), getBearing()).addTo(map);
  }
  function fitRoute() { if (S.route.layer) map.fitBounds(S.route.layer.getBounds(), { padding: [30, 30], maxZoom: 19 }); }

  /** 平面座標 → {s, off} (off: 左+ / 右-) */
  function projectToRoute(p) {
    var P = S.route.proj; if (!P) return null;
    var best = null;
    for (var i = 0; i < P.p.length - 1; i++) {
      var a = P.p[i], b = P.p[i + 1], dx = b.e - a.e, dy = b.n - a.n, L2 = dx * dx + dy * dy;
      var t = L2 ? ((p.e - a.e) * dx + (p.n - a.n) * dy) / L2 : 0; t = Math.max(0, Math.min(1, t));
      var qe = a.e + dx * t, qn = a.n + dy * t, d2 = (p.e - qe) * (p.e - qe) + (p.n - qn) * (p.n - qn);
      if (!best || d2 < best.d2) best = { d2: d2, s: P.s[i] + (P.s[i + 1] - P.s[i]) * t, side: dx * (p.n - a.n) - dy * (p.e - a.e) };
    }
    if (!best) return null;
    var q = MD.Alignment.pointAt(S.route.al, best.s);
    var off = Math.hypot(p.e - q.e, p.n - q.n) * (best.side >= 0 ? 1 : -1);
    return { s: best.s, chainage: best.s + P.start, off: off };
  }

  // ---------------- 座標取得 + スナップ ----------------
  function setPicking(on) {
    S.picking = on; $('btnPick').classList.toggle('on', on); $('map').classList.toggle('picking', on);
    if (!on) { snapMarker.remove(); centerMarker.remove(); S.hover = null; $('stSnap').textContent = ''; }
  }
  $('btnPick').onclick = function () { setPicking(!S.picking); };
  $('chkSnap').onchange = function () { S.snapOn = this.checked; };
  document.querySelectorAll('[data-snap]').forEach(function (c) { c.onchange = function () { S.snapModes[c.dataset.snap] = c.checked; }; });
  var KIND_JA = { end: '端点', mid: '中点', inter: '交点', center: '中心', node: '点', near: '線上', raw: '任意' };

  function metersPerPixel(lat) { return 40075016.686 * Math.cos(lat * Math.PI / 180) / (256 * Math.pow(2, map.getZoom())); }
  function computeSnap(ll, alt) {
    var p = toP(ll);
    if (S.snapOn && !alt) {
      var tol = (+$('numSnapPx').value || 12) * metersPerPixel(ll.lat);
      var all = S.snap.queryAll(p, tol, S.snapModes), r = all.candidates[0];
      if (r) return { p: r.p, kind: r.kind, shape: r.shape, centerHint: all.centerHint };
      if (all.centerHint) return { p: p, kind: 'raw', centerHint: all.centerHint };
    }
    return { p: p, kind: 'raw' };
  }
  var pending = null, rafId = 0;
  map.on('mousemove', function (e) {
    pending = e; if (rafId) return;
    rafId = requestAnimationFrame(function () {
      rafId = 0; var ev = pending; if (!ev) return;
      var alt = ev.originalEvent && ev.originalEvent.altKey;
      var ll = ev.latlng, p = toP(ll);
      var txt = 'X ' + f3(p.n) + '  Y ' + f3(p.e) + '   (' + ll.lat.toFixed(8) + ', ' + ll.lng.toFixed(8) + ')';
      var pr = S.route.proj ? projectToRoute(p) : null;
      if (pr) txt += '   ' + staLabel(pr.chainage, S.route.pitch) + ' ' + (pr.off >= 0 ? 'L' : 'R') + Math.abs(pr.off).toFixed(3);
      $('stCursor').textContent = txt;
      if (!S.picking) return;
      var h = S.hover = computeSnap(ll, alt);
      var sl = toLL(h.p);
      var nm = h.shape && h.shape.name ? ' ' + h.shape.name : '';
      snapMarker.setLatLng(sl).setIcon(L.divIcon({ className: '', iconSize: null,
        html: '<div class="md-snap ' + h.kind + '"></div>' + (h.kind !== 'raw' ? '<div class="md-snap-label">' + KIND_JA[h.kind] + esc(nm) + '</div>' : '') }));
      if (!map.hasLayer(snapMarker)) snapMarker.addTo(map);
      if (h.centerHint && S.snapModes.center) { centerMarker.setLatLng(toLL(h.centerHint)); if (!map.hasLayer(centerMarker)) centerMarker.addTo(map); }
      else centerMarker.remove();
      $('stSnap').textContent = h.kind !== 'raw' ? 'スナップ: ' + KIND_JA[h.kind] + nm : '';
    });
  });
  map.on('mouseout', function () { snapMarker.remove(); centerMarker.remove(); });
  map.on('click', function (e) {
    if (!S.picking) return;
    var alt = e.originalEvent && e.originalEvent.altKey;
    var h = computeSnap(e.latlng, alt);
    addPoint(h.p, h.kind, h.shape && h.shape.name);
  });
  map.on('zoomend', function () { $('stZoom').textContent = 'Z ' + map.getZoom().toFixed(2); });
  $('stZoom').textContent = 'Z ' + map.getZoom().toFixed(2);
  $('numBearing').onchange = function () { setBearing(+this.value || 0); markDirty(); };
  $('btnNorth').onclick = function () { setBearing(0); markDirty(); };

  function addPoint(p, kind, snapName) {
    var no = S.points.length ? S.points[S.points.length - 1].no + 1 : 1;
    S.points.push({ no: no, name: 'P' + no, e: p.e, n: p.n, z: 0, kind: kind || 'raw', ref: snapName || '' });
    refreshPoints();
  }
  function refreshPoints() {
    markDirty();
    if (DOCK.kind === 'points' && !DOCK.updating && DOCK.grid) DOCK.grid.setRows(ptRowsOf());
    S.ptLayer.clearLayers();
    var tb = $('tblPts').tBodies[0]; tb.innerHTML = '';
    S.points.forEach(function (pt, idx) {
      var ll = toLL(pt);
      pt.lat = ll.lat; pt.lng = ll.lng;
      var pr = S.route.proj ? projectToRoute(pt) : null;
      pt.sta = pr ? staLabel(pr.chainage, S.route.pitch) : ''; pt.chainage = pr ? pr.chainage : null; pt.off = pr ? pr.off : null;
      L.circleMarker(ll, { radius: 3.5, color: '#dc2626', weight: 2, fillColor: '#fff', fillOpacity: 1, renderer: renderer, interactive: false }).addTo(S.ptLayer);
      L.marker(ll, { interactive: false, keyboard: false, icon: L.divIcon({ className: '', iconSize: null, html: '<div class="md-pt">' + esc(pt.name) + '</div>' }) }).addTo(S.ptLayer);
      var tr = document.createElement('tr');
      tr.innerHTML = '<td>' + pt.no + '</td><td class="name"><input value="' + esc(pt.name) + '"></td><td>' + f3(pt.n) + '</td><td>' + f3(pt.e) + '</td><td>' + KIND_JA[pt.kind] + '</td><td>' +
        (pr ? esc(pt.sta) + ' ' + (pr.off >= 0 ? 'L' : 'R') + Math.abs(pr.off).toFixed(2) : '') + '</td><td><button class="x" title="削除">×</button></td>';
      tr.querySelector('input').onchange = function () { pt.name = this.value; refreshPoints(); };
      tr.querySelector('.x').onclick = function () { S.points.splice(idx, 1); refreshPoints(); };
      tr.onclick = function (ev) { if (ev.target.tagName !== 'INPUT' && ev.target.tagName !== 'BUTTON') map.panTo(ll); };
      tb.appendChild(tr);
    });
    var w = tb.closest('.tblwrap'); w.scrollTop = w.scrollHeight;
  }

  // ---------------- 出力 ----------------
  function csvOfPoints() {
    var rows = [['No', '点名', 'X', 'Y', '緯度', '経度', 'スナップ', '参照', '測点', '追加距離', '離れ(左+)', '座標系']];
    S.points.forEach(function (p) {
      rows.push([p.no, p.name, f3(p.n), f3(p.e), p.lat.toFixed(9), p.lng.toFixed(9), KIND_JA[p.kind], p.ref || '', p.sta || '',
        p.chainage != null ? p.chainage.toFixed(3) : '', p.off != null ? p.off.toFixed(3) : '', S.zone]);
    });
    return rows.map(function (r) { return r.map(function (v) { v = String(v); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; }).join(','); }).join('\r\n') + '\r\n';
  }
  async function saveText(defaultName, content, encoding, filters) {
    if (N) { var p = await N.saveFile({ defaultName: defaultName, content: content, encoding: encoding, filters: filters }); if (p) toast('保存しました: ' + p); return; }
    var blob = new Blob([encoding === 'utf8' && /\.csv$/i.test(defaultName) ? '﻿' : '', content], { type: 'text/plain' });
    var a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = defaultName; a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 5000);
    if (encoding === 'shift_jis') toast('ブラウザ版はUTF-8で保存します (Shift_JISはデスクトップ版)');
  }
  function exportCsv() { if (!S.points.length) return toast('取得点がありません'); saveText('points.csv', csvOfPoints(), 'utf8', [{ name: 'CSV', extensions: ['csv'] }]); }
  function exportSima() {
    if (!S.points.length) return toast('取得点がありません');
    saveText('points.sim', MD.SIMA.exportPoints(S.points.map(function (p) { return { no: p.no, name: p.name, e: p.e, n: p.n, z: p.z || 0 }; }), 'MapDetector'), 'shift_jis', [{ name: 'SIMA', extensions: ['sim'] }]);
  }
  function exportStations() {
    var B = S.route.bones; if (!B.length) return toast('線形がありません');
    var rows = [['測点', '種別', '追加距離', '中心X', '中心Y', '左端X', '左端Y', '右端X', '右端Y', '方向角(度,北から右回り)']];
    B.forEach(function (b) {
      var az = (90 - b.h * 180 / Math.PI + 360) % 360;
      rows.push([b.station.label, b.station.kind, b.station.chainage.toFixed(3), f3(b.c.n), f3(b.c.e), f3(b.l.n), f3(b.l.e), f3(b.r.n), f3(b.r.e), az.toFixed(6)]);
    });
    saveText('stations.csv', rows.map(function (r) { return r.join(','); }).join('\r\n') + '\r\n', 'utf8', [{ name: 'CSV', extensions: ['csv'] }]);
  }
  async function copyPoints() {
    var t = S.points.map(function (p) { return [p.name, f3(p.n), f3(p.e)].join('\t'); }).join('\n');
    try { await navigator.clipboard.writeText(t); toast(S.points.length + '点をコピー (点名, X, Y)'); } catch (e) { toast('コピー失敗: ' + e.message); }
  }
  $('btnCsv').onclick = exportCsv; $('btnSimaOut').onclick = exportSima; $('btnCopy').onclick = copyPoints;
  $('btnClear').onclick = function () { if (S.points.length && confirm('取得点をすべて削除しますか?')) { S.points = []; refreshPoints(); } };

  // ---------------- 表の編集ドック (表計算風グリッド) ----------------
  var DOCK = { grid: null, kind: null, target: null, updating: false };
  var hlMarker = L.marker([0, 0], { interactive: false, keyboard: false, icon: L.divIcon({ className: 'md-hl', iconSize: null }) });
  function numOr(v, d) { var x = typeof v === 'number' ? v : MD.Grid.parseNumber(String(v == null ? '' : v)); return isFinite(x) && x !== null ? x : d; }
  function openDock(cfg) {
    closeDock(true);
    $('dock').hidden = false; $('dockTitle').textContent = cfg.title;
    var bt = $('dockButtons'); bt.innerHTML = '';
    (cfg.buttons || []).forEach(function (b) { var x = document.createElement('button'); x.textContent = b.label; x.onclick = b.fn; bt.appendChild(x); });
    map.invalidateSize();
    DOCK.kind = cfg.kind; DOCK.target = cfg.target || null;
    DOCK.grid = new MD.Grid($('dockGrid'), {
      columns: cfg.columns, rows: cfg.rows, newRow: cfg.newRow,
      height: Math.max(80, $('dockGrid').clientHeight),
      onChange: function (rows) { DOCK.updating = true; try { cfg.onChange(rows); } finally { DOCK.updating = false; } markDirty(); },
      onSelect: function (i) { var p = cfg.locate && cfg.locate(DOCK.grid.getRows()[i]); if (p) { var ll = toLL(p); hlMarker.setLatLng(ll).addTo(map); if (!map.getBounds().pad(-0.1).contains(ll)) map.panTo(ll); } else hlMarker.remove(); }
    });
    DOCK.grid.focus();
  }
  function closeDock(keepHidden) {
    if (DOCK.grid) { DOCK.grid.destroy(); DOCK.grid = null; }
    DOCK.kind = null; DOCK.target = null; hlMarker.remove();
    $('dockGrid').innerHTML = '';
    if (!keepHidden) { $('dock').hidden = true; map.invalidateSize(); }
  }
  $('dockClose').onclick = function () { closeDock(); };
  $('dockAddRow').onclick = function () { if (DOCK.grid) DOCK.grid.insertRow(); };
  $('dockDelRow').onclick = function () { if (DOCK.grid) DOCK.grid.deleteSelectedRows(); };
  new ResizeObserver(function () { if (!$('dock').hidden) map.invalidateSize(); }).observe($('dock'));
  var COLS_XYZ = [
    { key: 'no', label: '点番号', type: 'text', width: 70 }, { key: 'name', label: '点名', type: 'text', width: 150 },
    { key: 'x', label: 'X (北)', type: 'number', width: 120, decimals: 3 }, { key: 'y', label: 'Y (東)', type: 'number', width: 120, decimals: 3 },
    { key: 'z', label: '標高', type: 'number', width: 80, decimals: 3 }];
  function locXY(r) { if (!r) return null; var x = numOr(r.x, NaN), y = numOr(r.y, NaN); return isFinite(x) && isFinite(y) ? { e: y, n: x } : null; }

  function openSimaEditor(o) {
    openDock({
      kind: 'sima', target: o, title: 'SIMA 座標点の編集 — ' + o.name, columns: COLS_XYZ, rows: o.points,
      newRow: function (i) { return { no: '', name: '', x: '', y: '', z: 0 }; },
      locate: locXY,
      onChange: function (rows) { o.points = rows; o.pointsEdited = true; o.shapes = simaShapes(o); rebuildOverlay(o); },
      buttons: [{ label: 'SIMA出力', fn: function () {
        var pts = o.points.filter(function (r) { return locXY(r); }).map(function (r, i) { return { no: r.no || i + 1, name: r.name, n: numOr(r.x, 0), e: numOr(r.y, 0), z: numOr(r.z, 0) }; });
        saveText(o.src.name.replace(/\.[^.]+$/, '') + '_編集.sim', MD.SIMA.exportPoints(pts, o.src.name), 'shift_jis', [{ name: 'SIMA', extensions: ['sim'] }]);
      } }]
    });
  }
  function openIpEditor() {
    if (!S.route.ips.length) S.route.ips = [];
    openDock({
      kind: 'ip', title: 'IP表の編集 (線形: ' + ($('selRoute').selectedOptions[0] ? $('selRoute').selectedOptions[0].textContent : '新規') + ')',
      columns: [{ key: 'name', label: '点名', type: 'text', width: 120 }, { key: 'x', label: 'X (北)', type: 'number', width: 120, decimals: 3 }, { key: 'y', label: 'Y (東)', type: 'number', width: 120, decimals: 3 },
        { key: 'R', label: 'R', type: 'number', width: 80, decimals: 3 }, { key: 'A1', label: 'A1', type: 'number', width: 80, decimals: 3 }, { key: 'A2', label: 'A2', type: 'number', width: 80, decimals: 3 }],
      rows: ipRows(),
      newRow: function () { return { name: '', x: '', y: '', R: 0, A1: 0, A2: 0 }; },
      locate: locXY,
      onChange: function (rows) {
        S.route.ips = rows.filter(function (r) { return locXY(r); }).map(function (r) { return { name: r.name || '', n: numOr(r.x, 0), e: numOr(r.y, 0), R: numOr(r.R, 0), A1: numOr(r.A1, 0), A2: numOr(r.A2, 0) }; });
        if (S.route.cur < 0 && S.route.ips.length >= 2) { S.route.list.push({ label: '表から作成', ips: S.route.ips }); renderRouteSelect(); S.route.cur = S.route.list.length - 1; $('selRoute').value = S.route.cur; }
        renderIpTable(); rebuildRoute();
      }
    });
  }
  function ipRows() { return S.route.ips.map(function (p) { return { name: p.name, x: p.n, y: p.e, R: p.R || 0, A1: p.A1 || 0, A2: p.A2 || 0 }; }); }
  function openPointsEditor() {
    openDock({
      kind: 'points', title: '取得点の編集', columns: COLS_XYZ, rows: ptRowsOf(),
      newRow: function () { return { no: '', name: '', x: '', y: '', z: 0 }; },
      locate: locXY,
      onChange: function (rows) {
        S.points = rows.filter(function (r) { return locXY(r); }).map(function (r, i) {
          var old = r._ref || {};
          return { no: +r.no || i + 1, name: r.name || ('P' + (i + 1)), n: numOr(r.x, 0), e: numOr(r.y, 0), z: numOr(r.z, 0), kind: old.kind || 'raw', ref: old.ref || '' };
        });
        refreshPoints();
      }
    });
  }
  function ptRowsOf() { return S.points.map(function (p) { return { no: p.no, name: p.name, x: p.n, y: p.e, z: p.z || 0, _ref: { kind: p.kind, ref: p.ref } }; }); }
  // ---- 測点 (横断線の位置) の表編集: 追加距離・幅員を入力 → 座標は自動計算
  function defW(side) { return +$(side === 'l' ? 'numLeft' : 'numRight').value || 0; }
  function blankOr(v) { if (v === '' || v == null) return null; var x = numOr(v, NaN); return isFinite(x) ? x : null; }
  /** 測点行 [{name, ch, wl, wr, kind}] → 線形上の位置と横断線 */
  function stationGeom(al, rows) {
    var start = +$('numStart').value || 0;
    return rows.map(function (r) {
      var ch = blankOr(r.ch), res = { row: r, ok: false };
      if (ch == null) return res;
      var s = ch - start;
      if (s < -0.005 || s > al.length + 0.005) { res.out = true; return res; }   // 丸め (小数3桁) の誤差は許容
      s = Math.max(0, Math.min(al.length, s));
      var q = MD.Alignment.pointAt(al, s), nx = -Math.sin(q.h), ny = Math.cos(q.h);
      var wl = defW('l'), wr = defW('r');   // 幅員は全測点で一律
      var station = { s: s, chainage: ch, label: r.name || staLabel(ch, S.route.pitch || 20), kind: r.kind || 'main' };
      res.ok = true; res.station = station;
      res.bone = { station: station, h: q.h, c: { e: q.e, n: q.n }, l: { e: q.e + nx * wl, n: q.n + ny * wl }, r: { e: q.e - nx * wr, n: q.n - ny * wr } };
      return res;
    });
  }
  function stationRows() {
    var R = S.route, src = S.route.list[S.route.cur];
    if (!R.al) return [];
    var rows = src && src.customStations ? src.customStations : R.bones.map(function (b) {
      return { name: b.station.label, ch: Math.round(b.station.chainage * 1000) / 1000, wl: '', wr: '', kind: b.station.kind };
    });
    return stationGeom(R.al, rows).map(function (g) {
      var r = g.row, b = g.bone;
      return { name: r.name, ch: r.ch, wl: r.wl == null ? '' : r.wl, wr: r.wr == null ? '' : r.wr, kind: r.kind || 'main',
        cx: b ? b.c.n : '', cy: b ? b.c.e : '', lx: b ? b.l.n : '', ly: b ? b.l.e : '', rx: b ? b.r.n : '', ry: b ? b.r.e : '',
        note: g.out ? '範囲外' : (r.ch === '' || r.ch == null ? '' : (b ? (r.kind === 'key' ? '主要点' : '') : '数値不正')) };
    });
  }
  // 名前が自動の測点名 (No.k+x / 追加距離 / 「BC 69682.60」等) なら追加距離の変更に追従させる
  function autoName(name, ch) {
    var lab = staLabel(ch, S.route.pitch || 20);
    if (!name) return lab;
    if (/^(No\.\d+(\+[\d.]+)?|\d+(\.\d+)?)$/.test(name)) return lab;
    var m = /^(\S+) (No\.\S+|\d+(\.\d+)?)$/.exec(name);
    return m ? m[1] + ' ' + lab : name;
  }
  function openStationEditor() {
    var src = S.route.list[S.route.cur];
    if (!src || !S.route.al) { toast('先に線形 (SIMA または IP表) を用意してください'); return; }
    var numCol = function (key, label, w, ro) { return { key: key, label: label, type: 'number', width: w, decimals: 3, readOnly: !!ro }; };
    openDock({
      kind: 'stations', title: '測点の編集 (追加距離 → 座標を自動計算・幅員は一律)',
      columns: [{ key: 'name', label: '測点名', type: 'text', width: 140 }, numCol('ch', '追加距離', 110),
        numCol('cx', '中心 X', 110, true), numCol('cy', '中心 Y', 110, true), numCol('lx', '左端 X', 110, true), numCol('ly', '左端 Y', 110, true),
        numCol('rx', '右端 X', 110, true), numCol('ry', '右端 Y', 110, true), { key: 'note', label: '備考', type: 'text', width: 70, readOnly: true }],
      rows: stationRows(),
      newRow: function () { return { name: '', ch: '', wl: '', wr: '', kind: 'main' }; },
      locate: function (r) { var g = r && S.route.al ? stationGeom(S.route.al, [r])[0] : null; return g && g.bone ? g.bone.c : null; },
      onChange: function (rows) {
        var prev = src.customStations || null;
        src.customStations = rows.map(function (r, i) {
          var ch = blankOr(r.ch), name = r.name || '';
          var old = prev && prev[i];
          if (ch != null && (!old || old.ch !== r.ch || !name)) name = autoName(name, ch);
          return { name: name, ch: r.ch === '' || r.ch == null ? '' : (ch != null ? ch : r.ch), wl: r.wl === '' || r.wl == null ? '' : r.wl, wr: r.wr === '' || r.wr == null ? '' : r.wr, kind: r.kind || 'main' };
        });
        rebuildRoute();
        DOCK.grid.updateRows(stationRows());
      },
      buttons: [
        { label: '追加距離順に並べ替え', fn: function () {
          if (!src.customStations) src.customStations = stationRows().map(function (r) { return { name: r.name, ch: r.ch, wl: r.wl, wr: r.wr, kind: r.kind }; });
          src.customStations.sort(function (a, b) { var x = blankOr(a.ch), y = blankOr(b.ch); return (x == null ? 1e15 : x) - (y == null ? 1e15 : y); });
          DOCK.updating = true; rebuildRoute(); DOCK.updating = false; DOCK.grid.setRows(stationRows());
        } },
        { label: '自動生成に戻す', fn: function () {
          if (src.customStations && !confirm('表で編集した測点を破棄して、測点間隔からの自動生成に戻しますか?')) return;
          src.customStations = null; DOCK.updating = true; rebuildRoute(); DOCK.updating = false; DOCK.grid.setRows(stationRows());
        } },
        { label: 'CSV出力', fn: exportStations }
      ]
    });
  }
  $('btnStaGrid').onclick = openStationEditor;
  $('btnIpGrid').onclick = function (e) { e.preventDefault(); openIpEditor(); };
  $('btnPtsGrid').onclick = openPointsEditor;

  // ---------------- プロジェクト (名前を付けて保存 / 開く) ----------------
  // 画面の状態 + 読み込んだ SIMA・図面ファイル本体を 1 つの .mdp (JSON) に保存する。タイルはフォルダの場所だけ記録。
  var PROJ = { path: null, name: null, handle: null, dirty: false };
  var UI_IDS = ['numPitch', 'numSub', 'numStart', 'selStaFmt', 'numLabelZoom', 'numLeft', 'numRight', 'chkKey', 'chkEdges', 'chkLabels', 'chkIpLine', 'numSnapPx', 'chkDxfSwap', 'selDxfScale'];
  function updateTitle() {
    var t = 'MapDetector ' + VERSION + ' — ' + (PROJ.name || '無題') + (PROJ.dirty ? ' *' : '');
    if (document.title !== t) document.title = t;
  }
  function markDirty() {
    if (S.restoring || PROJ.dirty) return;
    PROJ.dirty = true; updateTitle();
    if (N && N.setDirty) N.setDirty(true);
  }
  function setClean() {
    PROJ.dirty = false; updateTitle();
    if (N && N.setDirty) N.setDirty(false);
  }
  function abToB64(ab) {
    var u = new Uint8Array(ab), out = '', CH = 0x8000;
    for (var i = 0; i < u.length; i += CH) out += String.fromCharCode.apply(null, u.subarray(i, i + CH));
    return btoa(out);
  }
  function b64ToAb(b64) { var bin = atob(b64), u = new Uint8Array(bin.length); for (var i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u.buffer; }
  function uiValue(id) { var el = $(id); return el.type === 'checkbox' ? el.checked : el.value; }

  function serializeProject() {
    var c = map.getCenter();
    var tileInfo = S.tile ? (S.tile.opened.info || S.tile.opened.det) : null;
    var ui = {}; UI_IDS.forEach(function (id) { ui[id] = uiValue(id); });
    return {
      app: 'MapDetector', format: 1, version: VERSION, savedAt: new Date().toISOString(),
      view: { center: [c.lat, c.lng], zoom: map.getZoom(), bearing: getBearing() },
      zone: S.zone, base: $('selBase').value, panelHidden: $('panel').classList.contains('hidden'),
      tile: S.tile ? { name: S.tile.name, path: S.tile.opened.kind === 'electron' ? tileInfo.root : null, tms: $('chkTms').checked, opacity: +$('rngTileOpacity').value } : null,
      overlays: S.overlays.filter(function (o) { return o.src; }).map(function (o) {
        var r = { kind: o.kind, label: o.name, visible: o.visible, snap: o.snap, color: o.color || null, file: { name: o.src.name, data: abToB64(o.src.data) } };
        if (o.dxfOpts) r.dxfOpts = o.dxfOpts;
        if (o.points && o.pointsEdited) r.points = o.points;   // 表で編集した座標点 (未編集なら埋め込みファイルから再生成)
        if (o.kind === 'image') r.image = { corners: o.layer.getCorners().map(function (ll) { return [ll.lat, ll.lng]; }), opacity: o.layer.options.opacity, editable: o.layer._editable !== false };
        return r;
      }),
      routes: { list: S.route.list.map(function (r) { var x = {}; Object.keys(r).forEach(function (k) { x[k] = r[k]; }); return x; }), cur: S.route.cur, ips: S.route.ips },
      ui: ui,
      snap: { on: S.snapOn, modes: S.snapModes },
      points: S.points.map(function (p) { return { no: p.no, name: p.name, e: p.e, n: p.n, z: p.z || 0, kind: p.kind, ref: p.ref || '' }; })
    };
  }

  function clearAll() {
    closeDock();
    S.restoring = true;
    try {
      S.overlays.slice().forEach(removeOverlay);
      if (S.tile) { S.tile.layer.remove(); S.tile = null; $('tileInfo').textContent = '未読込 — フォルダをドラッグ&ドロップでも開けます'; }
      S.route.list = []; S.route.cur = -1; S.route.ips = [];
      renderRouteSelect(); renderIpTable(); rebuildRoute();
      S.points = []; refreshPoints();
      setPicking(false);
    } finally { S.restoring = false; }
  }

  async function applyProject(pj) {
    if (!pj || pj.app !== 'MapDetector') throw new Error('MapDetector のプロジェクトファイルではありません');
    S.restoring = true;
    var warn = [];
    try {
      clearAll(); S.restoring = true;
      $('selZone').value = S.zone = pj.zone || 9;
      setBase(pj.base || '');
      $('panel').classList.toggle('hidden', !!pj.panelHidden);
      Object.keys(pj.ui || {}).forEach(function (id) { var el = $(id); if (!el) return; if (el.type === 'checkbox') el.checked = !!pj.ui[id]; else el.value = pj.ui[id]; });
      if (pj.snap) {
        S.snapOn = pj.snap.on !== false; $('chkSnap').checked = S.snapOn;
        Object.keys(pj.snap.modes || {}).forEach(function (k) { S.snapModes[k] = !!pj.snap.modes[k]; var cb = document.querySelector('[data-snap="' + k + '"]'); if (cb) cb.checked = S.snapModes[k]; });
      }
      // タイル (デスクトップ版のみ場所から再オープン)
      if (pj.tile) {
        $('rngTileOpacity').value = pj.tile.opacity != null ? pj.tile.opacity : 1;
        var info = null;
        if (pj.tile.path && N && N.openTilePath) { try { info = await N.openTilePath(pj.tile.path); } catch (e) { info = null; } }
        if (info) {
          info.tms = !!pj.tile.tms;
          setTiles({ kind: 'electron', info: info }, info.root, { noFit: true });
        } else warn.push('タイルフォルダ「' + (pj.tile.path || pj.tile.name) + '」を開けませんでした (タイルは別途開いてください)');
      }
      // 図面・SIMA (埋め込みファイルから再読込)
      (pj.overlays || []).forEach(function (ov) {
        var data = b64ToAb(ov.file.data);
        if (ov.kind === 'sima') loadSima(ov.file.name, data, { restore: ov });
        else loadDrawing(ov.file.name, data, { restore: ov });
      });
      renderLayerList();
      // 路線
      S.route.list = (pj.routes && pj.routes.list) || [];
      renderRouteSelect();
      if (pj.routes && pj.routes.cur >= 0 && S.route.list[pj.routes.cur]) {
        S.route.cur = pj.routes.cur; $('selRoute').value = S.route.cur;
        S.route.ips = (pj.routes.ips || []).map(function (p) { return { name: p.name || '', e: +p.e, n: +p.n, R: +p.R || 0, A1: +p.A1 || 0, A2: +p.A2 || 0 }; });
      }
      renderIpTable(); rebuildRoute();
      // 取得点
      S.points = (pj.points || []).map(function (p) { return { no: p.no, name: p.name, e: p.e, n: p.n, z: p.z || 0, kind: p.kind || 'raw', ref: p.ref || '' }; });
      refreshPoints();
      if (pj.view) { map.setView(pj.view.center, pj.view.zoom, { animate: false }); setBearing(pj.view.bearing || 0); }
      map.invalidateSize();
    } finally { S.restoring = false; }
    return warn;
  }

  async function openProjectData(name, path, data) {
    var pj = JSON.parse(new TextDecoder('utf-8').decode(data));
    var warn = await applyProject(pj);
    PROJ.path = path || null; PROJ.name = name; PROJ.handle = null;
    setClean();
    if (N && N.setSetting && path) N.setSetting('lastProject', path);
    toast('プロジェクトを開きました: ' + name + (warn.length ? '\n' + warn.join('\n') : ''), warn.length ? 7000 : 3000);
  }
  async function confirmDiscard() {
    return !PROJ.dirty || confirm('保存されていない変更があります。破棄してよろしいですか?');
  }
  async function openProject() {
    if (!(await confirmDiscard())) return;
    try {
      if (N) { var f = await N.openFile('project'); if (f) await openProjectData(f.name, f.path, f.data); return; }
      var r = await new Promise(function (resolve) {
        var inp = $('inpProject');
        inp.onchange = async function () { var file = inp.files[0]; inp.value = ''; resolve(file ? { name: file.name, data: await file.arrayBuffer() } : null); };
        inp.click();
      });
      if (r) await openProjectData(r.name, null, r.data);
    } catch (e) { toast('プロジェクトを開けません: ' + e.message, 6000); console.error(e); }
  }
  async function saveProject(asNew) {
    try {
      var json = JSON.stringify(serializeProject());
      var defName = (PROJ.name || '無題') .replace(/\.mdp$/i, '') + '.mdp';
      if (N) {
        var path = (!asNew && PROJ.path) ? await N.writeFile({ path: PROJ.path, content: json, encoding: 'utf8' })
          : await N.saveFile({ defaultName: defName, defaultPath: PROJ.path || undefined, content: json, encoding: 'utf8', bom: false, filters: [{ name: 'MapDetector プロジェクト', extensions: ['mdp'] }] });
        if (!path) return false;
        PROJ.path = path; PROJ.name = path.split(/[\\/]/).pop();
        if (N.setSetting) N.setSetting('lastProject', path);
      } else if (window.showSaveFilePicker) {
        var h = (!asNew && PROJ.handle) || await window.showSaveFilePicker({ suggestedName: defName, types: [{ description: 'MapDetector プロジェクト', accept: { 'application/json': ['.mdp'] } }] });
        var w = await h.createWritable(); await w.write(json); await w.close();
        PROJ.handle = h; PROJ.name = h.name;
      } else {
        var a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([json], { type: 'application/json' })); a.download = defName; a.click();
        setTimeout(function () { URL.revokeObjectURL(a.href); }, 5000);
        PROJ.name = defName;
      }
      setClean();
      toast('保存しました: ' + PROJ.name);
      return true;
    } catch (e) { if (e && e.name === 'AbortError') return false; toast('保存できません: ' + e.message, 6000); console.error(e); return false; }
  }
  async function newProject() {
    if (!(await confirmDiscard())) return;
    clearAll();
    PROJ.path = null; PROJ.name = null; PROJ.handle = null;
    if (N && N.setSetting) { N.setSetting('lastProject', undefined); N.setSetting('lastTileFolder', undefined); }
    setClean();
  }
  window.addEventListener('beforeunload', function (e) { if (!N && PROJ.dirty) { e.preventDefault(); e.returnValue = ''; } });

  // ---------------- 印刷 (用紙 → 枠を配置 → レイヤー → ズーム → 回転 → 方位図/縮尺バー自動 → 印刷) ----------------
  var PAPERS = { A4: [297, 210], A3: [420, 297], A2: [594, 420], A1: [841, 594], A0: [1189, 841] };
  var PR = { open: false, frame: null, center: null, drag: null };
  function prOpt() {
    var sz = PAPERS[$('prPaper').value], land = $('prOrient').value === 'land';
    var W = land ? sz[0] : sz[1], H = land ? sz[1] : sz[0], m = +$('prMargin').value || 0, foot = 9;
    var dpi = +$('prDpi').value || 150, zsel = +$('prZoom').value;
    var scSel = $('prScale').value, fixed = null;
    if (scSel === 'custom') fixed = +$('prScaleCustom').value || null; else if (scSel !== 'map') fixed = +scSel;
    // 座標基準: 印刷地図は平面直角座標の投影で描く。pxPerM = 座標 1 m あたりの印刷ピクセル数
    var g = prGrid(PR.center || map.getCenter());
    var pxPerM = fixed ? dpi / (0.0254 * fixed) : g.d0 * Math.pow(2, zsel);   // 地図の縮尺: 選んだタイルズームと同じ細かさ
    // 回転: 北上 = 座標北 (X軸) が真上。表示角のまま = メイン画面と同じ見え方 (子午線収差を補正)
    var B = $('prRotNorth').checked ? 0 : -mainUpAzimuth(PR.center || map.getCenter());
    var mapW = W - 2 * m, mapH = H - 2 * m - foot;   // mm (地図部分)
    return { fixedScale: fixed, paper: $('prPaper').value, W: W, H: H, m: m, foot: foot, dpi: dpi, zsel: zsel, pxPerM: pxPerM, z: Math.log2(pxPerM),
      scale: dpi / 0.0254 / pxPerM, bearing: B, d0: g.d0, mapW: mapW, mapH: mapH,
      pxW: Math.round(mapW / 25.4 * dpi), pxH: Math.round(mapH / 25.4 * dpi) };
  }
  /** メイン地図 (Web メルカトル) で、平面直角座標 1 m のズーム0 ピクセル長 (d0) と座標北の画面角 (回転0のとき, 時計回り度) */
  function prGrid(c) {
    var P = toP(c), pc = map.project(c, 0);
    var pe = map.project(toLL({ e: P.e + 1, n: P.n }), 0), pn = map.project(toLL({ e: P.e, n: P.n + 1 }), 0);
    var vN = pn.subtract(pc);
    return { d0: (pe.distanceTo(pc) + pn.distanceTo(pc)) / 2, gridDeg: Math.atan2(vN.x, -vN.y) * 180 / Math.PI };
  }
  /** メイン画面で、指定地点における画面上方向の座標方位角 (度) — 表示角のまま印刷する回転量 */
  function mainUpAzimuth(c) {
    var cp = map.latLngToContainerPoint(c), a = toP(map.containerPointToLatLng(cp.add([0, 50]))), b = toP(map.containerPointToLatLng(cp.subtract([0, 50])));
    return Math.atan2(b.e - a.e, b.n - a.n) * 180 / Math.PI;
  }
  function prPlaneMpp(o) { return 1 / o.pxPerM; }
  function prScale(o) { return o.scale; }
  /** 平面直角座標を投影とする Leaflet CRS (1 m = 2^zoom px、y は北が上) */
  function planeCRS() {
    return L.extend({}, L.CRS, {
      projection: {
        project: function (ll) { var p = MD.JPRCS.toPlane(ll.lat, ll.lng, S.zone); return L.point(p.e, p.n); },
        unproject: function (pt) { var r = MD.JPRCS.toLatLng(pt.x, pt.y, S.zone); return L.latLng(r.lat, r.lng); },
        bounds: L.bounds([-1e7, -1e7], [1e7, 1e7])
      },
      transformation: L.transformation(1, 0, -1, 0),
      scale: function (z) { return Math.pow(2, z); },
      zoom: function (sc) { return Math.log(sc) / Math.LN2; },
      distance: function (a, b) { return this.projection.project(a).distanceTo(this.projection.project(b)); },
      infinite: true
    });
  }
  /** 画面上方向の座標方位角 (度) = -bearing。用紙枠の 4 隅 (左上・右上・右下・左下) を平面直角座標で厳密に計算 */
  function prCornersPlane(o, c) {
    var P = toP(c), up = -o.bearing * Math.PI / 180, rt = up + Math.PI / 2;
    var U = { e: Math.sin(up), n: Math.cos(up) }, R = { e: Math.sin(rt), n: Math.cos(rt) };
    var hw = o.pxW / 2 / o.pxPerM, hh = o.pxH / 2 / o.pxPerM;
    return [[-1, 1], [1, 1], [1, -1], [-1, -1]].map(function (s) {
      return { e: P.e + R.e * hw * s[0] + U.e * hh * s[1], n: P.n + R.n * hw * s[0] + U.n * hh * s[1] };
    });
  }
  function prCorners(o, c) { return prCornersPlane(o, c).map(toLL); }
  function prUpdate() {
    if (!PR.open) return;
    var o = prOpt(), c = PR.center || map.getCenter();
    PR.center = c;
    var cs = prCorners(o, c);
    if (!PR.frame) {
      PR.frame = L.polygon(cs, { color: '#ea580c', weight: 2, dashArray: '8 4', fillColor: '#fb923c', fillOpacity: 0.08, interactive: true, bubblingMouseEvents: false, className: 'md-print-frame' }).addTo(map);
      PR.frame.on('mousedown', function (e) {
        L.DomEvent.stop(e); map.dragging.disable();
        PR.drag = { start: e.latlng, c0: PR.center };
      });
    } else PR.frame.setLatLngs(cs);
    var den = o.scale, gw = o.pxW / o.pxPerM, gh = o.pxH / o.pxPerM;
    $('prZoom').disabled = !!o.fixedScale; $('prScaleCustom').hidden = $('prScale').value !== 'custom';
    $('prInfo').textContent = '縮尺 1:' + (o.fixedScale ? Math.round(den) : Math.round(den)).toLocaleString() + ' (座標基準)' + ' / 範囲 ' + gw.toFixed(0) + ' m × ' + gh.toFixed(0) + ' m / 回転 ' + o.bearing.toFixed(1) + '°' +
      ' / 画像 ' + o.pxW + '×' + o.pxH + ' px';
  }
  map.on('mousemove', function (e) {
    if (!PR.drag) return;
    var d = PR.drag, a = map.project(d.start, 20), b = map.project(e.latlng, 20), c0 = map.project(d.c0, 20);
    PR.center = map.unproject(c0.add(b.subtract(a)), 20); prUpdate();
  });
  document.addEventListener('mouseup', function () { if (PR.drag) { PR.drag = null; map.dragging.enable(); } });
  map.on('rotate', function () { if (PR.open && !$('prRotNorth').checked) prUpdate(); });

  function prLayerDefs() {
    var defs = [];
    // ラスタ (タイル・背景) は印刷時に平面直角座標へワープして描く
    if (S.base) defs.push({ id: 'base', label: '背景地図 (' + $('selBase').selectedOptions[0].textContent + ')', on: true, raster: function () {
      var b = BASES[$('selBase').value];
      return { minZ: 2, maxZ: b[1], opacity: 1, getUrl: function (z, x, y) { return Promise.resolve(b[0].replace('{z}', z).replace('{x}', x).replace('{y}', y)); }, release: function () {} }; } });
    if (S.tile) defs.push({ id: 'tile', label: 'タイル (' + S.tile.name + ')', on: true, raster: function () {
      var src = MD.Tiles.makeSource(S.tile.opened, $('chkTms').checked), lv = src.levels;
      src.minZ = lv[0]; src.maxZ = lv[lv.length - 1]; src.opacity = +$('rngTileOpacity').value; return src; } });
    S.overlays.forEach(function (o) {
      defs.push({ id: o.id, label: o.name, on: o.visible, build: function (pm, rend, k, bearing) {
        if (o.kind === 'image') return new MD.AffineImage(o.url, o.layer.getCorners(), { opacity: o.layer.options.opacity, editable: false });
        if (o.kind === 'geojson') return L.geoJSON(o.geo, { style: { color: o.color, weight: 1.5 * k }, pointToLayer: function (f, ll) { return L.circleMarker(ll, { radius: 3 * k, renderer: rend }); }, interactive: false, renderer: rend });
        var r = shapesToLayers(o.shapes, o.color ? { color: o.color } : null, rend, k, bearing);
        var g = L.featureGroup([r.layer]); if (r.textLayer && $('prTexts').checked) g.addLayer(r.textLayer); return g;
      } });
    });
    if (S.route.draw) {
      defs.push({ id: 'route', label: '線形 (中心線・幅員線・横断線)', on: true, build: function (pm, rend, k) { return drawRoute(S.route.draw, rend, k); } });
      defs.push({ id: 'routeLabels', label: '測点名', on: $('chkLabels').checked, build: function (pm, rend, k, bearing, mpp) { return routeLabelLayer(mpp, bearing, k); } });
    }
    if (S.points.length) defs.push({ id: 'points', label: '取得点 (' + S.points.length + '点)', on: true, build: function (pm, rend, k) {
      var g = L.featureGroup();
      S.points.forEach(function (p) {
        var ll = toLL(p);
        L.circleMarker(ll, { radius: 3.5 * k, color: '#dc2626', weight: 2 * k, fillColor: '#fff', fillOpacity: 1, renderer: rend, interactive: false }).addTo(g);
        L.marker(ll, { interactive: false, icon: L.divIcon({ className: '', iconSize: null, html: '<div class="md-pt" style="font-size:' + (10 * k).toFixed(1) + 'px;line-height:' + (16 * k).toFixed(1) + 'px;border-radius:' + (9 * k) + 'px">' + esc(p.name) + '</div>' }) }).addTo(g);
      });
      return g;
    } });
    return defs;
  }
  function openPrint() {
    PR.open = true; $('printPanel').hidden = false;
    // ズームレベル候補: タイルのネイティブ範囲 (既定は最大)。タイルがなければ現在のズーム付近
    var sel = $('prZoom'), lv = S.tile ? (S.tile.opened.info || S.tile.opened.det).levels : null;
    var zmin = lv ? lv[0] : Math.max(0, Math.floor(map.getZoom()) - 4), zmax = lv ? lv[lv.length - 1] : Math.min(20, Math.ceil(map.getZoom()) + 2);
    var prev = sel.value; sel.innerHTML = '';
    for (var z = zmax; z >= zmin; z--) { var op = document.createElement('option'); op.value = z; op.textContent = z + (z === zmax ? ' (最大)' : ''); sel.appendChild(op); }
    sel.value = prev && +prev >= zmin && +prev <= zmax ? prev : zmax;
    $('prRotKeep').nextSibling.textContent = ' 表示角のまま (' + getBearing().toFixed(1) + '°)';
    var ul = $('prLayers'); ul.innerHTML = '';
    PR.defs = prLayerDefs();
    PR.defs.forEach(function (d) {
      var li = document.createElement('label'); li.className = 'pr-layer';
      li.innerHTML = '<input type="checkbox"' + (d.on ? ' checked' : '') + '> ' + esc(d.label);
      li.firstChild.onchange = function () { d.on = this.checked; };
      ul.appendChild(li);
    });
    if (!PR.center) PR.center = map.getCenter();
    prUpdate();
    // 枠が画面に収まるよう表示
    try { map.fitBounds(PR.frame.getBounds(), { padding: [40, 40], animate: false }); } catch (e) { /* empty */ }
  }
  function closePrint() {
    PR.open = false; $('printPanel').hidden = true;
    if (PR.frame) { PR.frame.remove(); PR.frame = null; }
  }
  ['prPaper', 'prOrient', 'prDpi', 'prMargin', 'prZoom', 'prRotKeep', 'prRotNorth', 'prScale', 'prScaleCustom'].forEach(function (id) { $(id).addEventListener('change', function () {
    prUpdate();
    // 枠がはみ出したら全体が見えるように表示を合わせる
    try { var fb = PR.frame.getBounds(); if (!map.getBounds().contains(fb)) map.fitBounds(fb, { padding: [40, 40], animate: false }); } catch (e) { /* empty */ }
  }); });
  $('prCenter').onclick = function () { PR.center = map.getCenter(); prUpdate(); };
  $('prClose').onclick = closePrint;
  $('prGo').onclick = function () { doPrint(); };

  function niceLen(x) { var p = Math.pow(10, Math.floor(Math.log10(x))), f = x / p; return (f >= 5 ? 5 : f >= 2.5 ? 2.5 : f >= 2 ? 2 : 1) * p; }
  /**
   * Web メルカトルのタイルを平面直角座標の印刷地図へ描く。タイル 1 枚ごとに 3 隅から一次変換を求めて drawImage
   * (タイル範囲ではメルカトル→平面直角の変換はほぼ一次なので誤差は無視できる)。
   */
  async function warpRaster(pm, ctx, src, o, c) {
    var zt = Math.round(Math.log2(o.pxPerM / o.d0));
    zt = Math.max(src.minZ, Math.min(src.maxZ, zt));
    var cs = prCorners(o, c), la = cs.map(function (q) { return q.lat; }), ln = cs.map(function (q) { return q.lng; });
    function tx(lng, z) { return Math.floor((lng + 180) / 360 * Math.pow(2, z)); }
    function ty(lat, z) { var r = lat * Math.PI / 180; return Math.floor((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * Math.pow(2, z)); }
    var x0, x1, y0, y1;
    for (;;) {
      x0 = tx(Math.min.apply(null, ln), zt); x1 = tx(Math.max.apply(null, ln), zt);
      y0 = ty(Math.max.apply(null, la), zt); y1 = ty(Math.min.apply(null, la), zt);
      if ((x1 - x0 + 1) * (y1 - y0 + 1) <= 4000 || zt <= src.minZ) break;
      zt--;   // 枚数が多すぎる場合は粗いズームで
    }
    var jobs = [];
    for (var x = x0; x <= x1; x++) for (var y = y0; y <= y1; y++) jobs.push([x, y]);
    ctx.save(); ctx.globalAlpha = src.opacity == null ? 1 : src.opacity; ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
    var T = MD.Tiles, done = 0;
    async function one(j) {
      var url = await src.getUrl(zt, j[0], j[1]);
      if (!url) return;
      var img = new Image(); img.crossOrigin = null; img.decoding = 'async';
      var ok = await new Promise(function (res) { img.onload = function () { res(true); }; img.onerror = function () { res(false); }; img.src = url; });
      if (!ok || !img.naturalWidth) return;
      var p0 = pm.latLngToContainerPoint([T.tile2lat(j[1], zt), T.tile2lng(j[0], zt)]);
      var p1 = pm.latLngToContainerPoint([T.tile2lat(j[1], zt), T.tile2lng(j[0] + 1, zt)]);
      var p2 = pm.latLngToContainerPoint([T.tile2lat(j[1] + 1, zt), T.tile2lng(j[0], zt)]);
      var w = img.naturalWidth, h = img.naturalHeight;
      ctx.setTransform((p1.x - p0.x) / w, (p1.y - p0.y) / w, (p2.x - p0.x) / h, (p2.y - p0.y) / h, p0.x, p0.y);
      ctx.drawImage(img, -0.3, -0.3, w + 0.6, h + 0.6);   // 継ぎ目が出ないよう僅かに重ねる
    }
    var q = jobs.slice(), workers = [];
    for (var i = 0; i < 12; i++) workers.push((async function () { while (q.length) { await one(q.shift()); done++; } })());
    await Promise.all(workers);
    ctx.restore();
  }
  async function doPrint() {
    var o = prOpt(), c = PR.center, k = o.dpi / 96;
    var sheet = $('printSheet'); sheet.innerHTML = '';
    // 用紙サイズ (@page)
    var st = $('printPageStyle'); st.textContent = '@page { size: ' + o.W + 'mm ' + o.H + 'mm; margin: 0; }';
    sheet.style.width = o.W + 'mm'; sheet.style.height = o.H + 'mm';
    var inner = document.createElement('div'); inner.className = 'ps-inner';
    inner.style.cssText = 'left:' + o.m + 'mm;top:' + o.m + 'mm;width:' + (o.W - 2 * o.m) + 'mm;height:' + (o.H - 2 * o.m) + 'mm';
    sheet.appendChild(inner);
    var box = document.createElement('div'); box.className = 'ps-mapbox'; box.style.cssText = 'width:' + o.mapW + 'mm;height:' + o.mapH + 'mm'; inner.appendChild(box);
    var mdiv = document.createElement('div'); mdiv.className = 'ps-map';
    mdiv.style.cssText = 'width:' + o.pxW + 'px;height:' + o.pxH + 'px;transform:scale(' + (96 / o.dpi) + ');transform-origin:0 0';
    box.appendChild(mdiv);
    $('printStage').hidden = false;
    toast('印刷用の地図を準備中…', 60000);
    var prend = L.canvas({ padding: 0.1 });
    var pm = L.map(mdiv, { zoomControl: false, attributionControl: false, zoomAnimation: false, fadeAnimation: false, markerZoomAnimation: false, inertia: false,
      dragging: false, scrollWheelZoom: false, doubleClickZoom: false, boxZoom: false, keyboard: false, touchZoom: false,
      zoomSnap: 0, maxZoom: 30, minZoom: -10, preferCanvas: true, renderer: prend, crs: planeCRS(), rotate: true, bearing: o.bearing, rotateControl: false, shiftKeyRotate: false, touchRotate: false });
    pm.setView(c, o.z, { animate: false });
    if (pm.setBearing) pm.setBearing(o.bearing);
    var mpp = prPlaneMpp(o, c);
    var waits = [];
    // ラスタはキャンバスに描いて地図の最背面へ (背景 → タイルの順)
    var cv = document.createElement('canvas'); cv.width = o.pxW; cv.height = o.pxH; cv.className = 'ps-raster';
    mdiv.insertBefore(cv, mdiv.firstChild);
    var ctx = cv.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, o.pxW, o.pxH);
    for (var di = 0; di < PR.defs.length; di++) {
      var dd = PR.defs[di];
      if (dd.on && dd.raster) { var srcR = dd.raster(); try { await warpRaster(pm, ctx, srcR, o, c); } finally { srcR.release(); } }
    }
    PR.defs.forEach(function (d) {
      if (!d.on || d.raster) return;
      var lay = d.build(pm, prend, k, o.bearing, mpp);
      PR.lastMap = pm;
      if (!lay) return;
      if (lay instanceof L.GridLayer) waits.push(new Promise(function (res) {
        // 範囲内にタイルが無いと load が来ないので、読み込みが始まらなければすぐ進む
        var started = false;
        lay.on('loading', function () { started = true; });
        lay.once('load', res);
        setTimeout(function () { if (!started || !Object.keys(lay._tiles || {}).length) res(); }, 800);
        setTimeout(res, 45000);
      }));
      lay.addTo(pm);
    });
    await Promise.all(waits);
    await new Promise(function (r) { setTimeout(r, 300); });
    // 方位図: 印刷地図上で北の向きを実測して回転
    var Pc = toP(c), p0 = pm.latLngToContainerPoint(c), p1 = pm.latLngToContainerPoint(toLL({ e: Pc.e, n: Pc.n + 10 }));   // 座標北
    var northDeg = Math.atan2(p1.x - p0.x, -(p1.y - p0.y)) * 180 / Math.PI;
    var deco = '';
    if ($('prDeco').checked) {
      deco += '<div class="ps-north"><svg viewBox="0 0 40 60" width="12mm" height="18mm"><g transform="rotate(' + northDeg.toFixed(2) + ' 20 26)"><polygon points="20,2 32,44 20,36 8,44" fill="#111"/><polygon points="20,2 8,44 20,36" fill="#fff" stroke="#111" stroke-width="1.2"/></g><text x="20" y="58" text-anchor="middle" font-size="13" font-family="sans-serif" font-weight="700">N</text></svg><div class="ps-north-cap">座標北</div></div>';
      var den = prScale(o, c), target = 60 / 1000 * den, L1 = niceLen(target), mmLen = L1 / den * 1000;
      var segs = ''; for (var i = 0; i < 4; i++) segs += '<div class="ps-seg' + (i % 2 ? ' w' : '') + '" style="width:' + (mmLen / 4) + 'mm"></div>';
      var unit = function (v) { return v >= 1000 ? (v / 1000) + ' km' : v + ' m'; };
      deco += '<div class="ps-scale"><div class="ps-bar">' + segs + '</div><div class="ps-ticks" style="width:' + mmLen + 'mm"><span>0</span><span>' + unit(L1 / 2) + '</span><span>' + unit(L1) + '</span></div><div class="ps-den">縮尺 1:' + Math.round(den).toLocaleString() + '</div></div>';
    }
    var decoDiv = document.createElement('div'); decoDiv.className = 'ps-deco'; decoDiv.innerHTML = deco; box.appendChild(decoDiv);
    var foot = document.createElement('div'); foot.className = 'ps-foot'; foot.style.height = o.foot + 'mm';
    var now = new Date();
    foot.innerHTML = '<span class="ps-title">' + esc($('prTitle').value || PROJ.name || '') + '</span><span>' + 'JGD2011 平面直角座標 ' + ROMAN[S.zone] + '系' + '</span><span>縮尺 1:' + Math.round(prScale(o, c)).toLocaleString() + ' (' + o.paper + '・座標基準)</span><span>' + now.getFullYear() + '/' + (now.getMonth() + 1) + '/' + now.getDate() + '</span><span>MapDetector ' + VERSION + '</span>';
    inner.appendChild(foot);
    $('toast').hidden = true;
    var cleanup = function () { window.removeEventListener('afterprint', cleanup); try { pm.remove(); } catch (e) { /* empty */ } sheet.innerHTML = ''; $('printStage').hidden = true; st.textContent = ''; };
    window.addEventListener('afterprint', cleanup);
    document.body.classList.add('printing');
    setTimeout(function () { window.print(); document.body.classList.remove('printing'); if (!PR.keepStage) setTimeout(cleanup, 500); }, 50);
  }

  // ---------------- メニュー ----------------
  var ACTIONS = {
    'file.print': function () { if (PR.open) closePrint(); else openPrint(); },
    'file.new': newProject, 'file.openProject': openProject,
    'file.save': function () { saveProject(false); }, 'file.saveAs': function () { saveProject(true); },
    'file.saveThenClose': async function () { if (await saveProject(false) && N && N.closeWindow) N.closeWindow(); },
    'file.openTiles': openTiles, 'file.openDrawing': openDrawing, 'file.openSima': openSima,
    'file.exportCsv': exportCsv, 'file.exportSima': exportSima, 'file.exportStations': exportStations,
    'edit.undoPoint': function () { if (DOCK.grid && DOCK.grid.hasFocus()) { DOCK.grid.undo(); return; } if (isTyping()) { document.execCommand('undo'); return; } S.points.pop(); refreshPoints(); },
    'edit.clearPoints': function () { $('btnClear').click(); },
    'edit.copyPoints': copyPoints,
    'view.fit': function () { fitTiles(false); }, 'view.fitAlignment': fitRoute,
    'view.togglePanel': function () { $('panel').classList.toggle('hidden'); map.invalidateSize(); },
    'view.toggleBase': function () { setBase(S.base ? '' : 'pale'); },
    'view.reload': function () { location.reload(); },
    'view.fullscreen': function () { if (document.fullscreenElement) document.exitFullscreen(); else document.documentElement.requestFullscreen(); },
    'view.devtools': function () { toast('ブラウザの開発者ツール (F12) を使用してください'); },
    'tool.pick': function () { setPicking(!S.picking); }, 'tool.pan': function () { setPicking(false); },
    'tool.snapToggle': function () { S.snapOn = !S.snapOn; $('chkSnap').checked = S.snapOn; toast('スナップ ' + (S.snapOn ? 'ON' : 'OFF')); },
    'tool.alignmentFromPoints': routeFromPoints,
    'help.checkUpdate': function () { if (N) N.checkForUpdates(); else toast('自動更新はデスクトップ版 (インストーラ版) で利用できます'); },
    'help.about': function () { $('aboutVersion').textContent = 'バージョン ' + VERSION; $('aboutEdition').textContent = N ? 'デスクトップ版' : 'ブラウザ版'; $('dlgAbout').showModal(); },
    'app.quit': function () { window.close(); }
  };
  function runAction(id) { var f = ACTIONS[id]; if (f) f(); else console.warn('unknown menu id', id); }

  function buildHtmlMenu() {
    var nav = $('menubar'); nav.hidden = false;
    MD.MenuDef.forEach(function (m) {
      var d = document.createElement('div'); d.className = 'm';
      var b = document.createElement('button'); b.textContent = m.label; d.appendChild(b);
      var dd = document.createElement('div'); dd.className = 'dd';
      m.items.forEach(function (it) {
        if (it.type === 'separator') { dd.appendChild(document.createElement('hr')); return; }
        var x = document.createElement('button');
        x.innerHTML = '<span>' + esc(it.label) + '</span><span class="acc">' + esc((it.accel || '').replace('CmdOrCtrl', 'Ctrl')) + '</span>';
        x.onclick = function () { closeAll(); runAction(it.id); };
        dd.appendChild(x);
      });
      d.appendChild(dd);
      b.onclick = function (ev) { ev.stopPropagation(); var o = d.classList.contains('open'); closeAll(); if (!o) d.classList.add('open'); };
      b.onmouseenter = function () { if (nav.querySelector('.m.open') && !d.classList.contains('open')) { closeAll(); d.classList.add('open'); } };
      nav.appendChild(d);
    });
    function closeAll() { nav.querySelectorAll('.m.open').forEach(function (x) { x.classList.remove('open'); }); }
    document.addEventListener('click', closeAll);
  }
  // キーボード: ブラウザ版はメニュー定義のショートカットを全て処理。Electron版は単キー(P/Escape)のみ (他はネイティブメニュー)
  function accelMatch(accel, e) {
    var parts = accel.split('+'), key = parts.pop();
    var ctrl = parts.indexOf('CmdOrCtrl') >= 0 || parts.indexOf('Ctrl') >= 0, shift = parts.indexOf('Shift') >= 0, alt = parts.indexOf('Alt') >= 0;
    if (ctrl !== (e.ctrlKey || e.metaKey) || shift !== e.shiftKey || alt !== e.altKey) return false;
    return e.key.toLowerCase() === key.toLowerCase() || e.code === 'Key' + key.toUpperCase() || e.code === 'Digit' + key;
  }
  document.addEventListener('keydown', function (e) {
    var single = !e.ctrlKey && !e.metaKey && !e.altKey;
    if (single && isTyping()) return;
    for (var i = 0; i < MD.MenuDef.length; i++) {
      var items = MD.MenuDef[i].items;
      for (var j = 0; j < items.length; j++) {
        var it = items[j]; if (!it.accel || !it.id) continue;
        var isSingle = !/\+/.test(it.accel) && !/^F\d+$/.test(it.accel);
        if (N && !isSingle) continue;
        if (it.id === 'app.quit' || it.id === 'view.reload') continue;
        if (accelMatch(it.accel, e)) { e.preventDefault(); runAction(it.id); return; }
      }
    }
  });
  if (N) {
    N.onMenu(runAction);
    N.onUpdateStatus && N.onUpdateStatus(function (st) {
      var m = { checking: '更新を確認中…', available: '新しいバージョン ' + (st.version || '') + ' をダウンロード中', none: '', downloading: '更新ダウンロード ' + Math.round(st.percent || 0) + '%', downloaded: '更新 ' + (st.version || '') + ' 準備完了 (再起動で適用)', error: '' };
      $('stUpdate').textContent = m[st.state] || '';
    });
  } else buildHtmlMenu();
  $('stVersion').textContent = 'v' + VERSION;
  updateTitle();

  // ---------------- ドラッグ&ドロップ ----------------
  document.addEventListener('dragover', function (e) { e.preventDefault(); document.body.classList.add('dropping'); });
  document.addEventListener('dragleave', function (e) { if (!e.relatedTarget) document.body.classList.remove('dropping'); });
  document.addEventListener('drop', async function (e) {
    e.preventDefault(); document.body.classList.remove('dropping');
    var items = Array.from(e.dataTransfer.items || []), files = Array.from(e.dataTransfer.files || []);
    // ディレクトリ判定
    for (var i = 0; i < items.length; i++) {
      var ent = items[i].webkitGetAsEntry && items[i].webkitGetAsEntry();
      if (ent && ent.isDirectory) {
        try {
          if (N && N.getPathForFile) { var info = await N.openTilePath(N.getPathForFile(files[i])); if (info) { setTiles({ kind: 'electron', info: info }, info.root); N.setSetting && N.setSetting('lastTileFolder', info.root); } }
          else if (items[i].getAsFileSystemHandle) { var h = await items[i].getAsFileSystemHandle(); await openTileHandle(h); }
        } catch (err) { toast('フォルダを開けません: ' + err.message, 5000); }
        return;
      }
    }
    for (var j = 0; j < files.length; j++) { var f = files[j]; loadDrawing(f.name, await f.arrayBuffer()); }
  });

  // 起動時: 前回のプロジェクト (なければ前回のタイルフォルダ) を開く (デスクトップ版)
  (async function () {
    if (!N || !N.getSetting) return;
    try {
      var lp = await N.getSetting('lastProject');
      if (lp && N.readFile) { var f = await N.readFile(lp); if (f) { await openProjectData(f.name, f.path, f.data); return; } }
      var last = await N.getSetting('lastTileFolder');
      if (last) { var info = await N.openTilePath(last); if (info) setTiles({ kind: 'electron', info: info }, info.root); }
      setClean();
    } catch (e) { /* 前回フォルダなし */ }
  })();

  // デバッグ/テスト用
  window.MDApp = { PR: PR, openPrint: openPrint, doPrint: doPrint, prOpt: prOpt, DOCK: DOCK, serializeProject: serializeProject, applyProject: applyProject, saveProject: saveProject, PROJ: PROJ, S: S, map: map, loadDrawing: loadDrawing, loadSima: loadSima, addPoint: addPoint, setZone: setZone, setTiles: setTiles, computeSnap: computeSnap, rebuildRoute: rebuildRoute };
})();
