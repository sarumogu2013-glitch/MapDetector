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
    preferCanvas: true, renderer: renderer, attributionControl: true, boxZoom: true
  });
  map.attributionControl.setPrefix('MapDetector ' + VERSION);
  L.control.scale({ imperial: false, maxWidth: 160 }).addTo(map);
  S.ptLayer = L.layerGroup().addTo(map);
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
  function setTiles(opened, name) {
    if (S.tile) S.tile.layer.remove();
    var info = opened.info || opened.det;
    var tms = !!info.tms;
    $('chkTms').checked = tms;
    var layer = MD.Tiles.createLayer(opened, tms);
    layer.setOpacity(+$('rngTileOpacity').value);
    layer.addTo(map);
    S.tile = { opened: opened, layer: layer, name: name };
    var lv = info.levels;
    $('tileInfo').textContent = name + '\nズーム ' + lv[0] + '–' + lv[lv.length - 1] + ' / ' + (info.ext || '') + (info.count ? ' / ' + info.count + '枚' : '') + (tms ? ' / TMS' : '');
    fitTiles(true);
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
  $('selBase').onchange = function () { setBase(this.value); };

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
  function shapesToLayers(shapes, style) {
    style = style || {};
    var byColor = {}, group = L.featureGroup(), texts = [];
    function add(color, pts) { (byColor[color] = byColor[color] || []).push(pts.map(toLL)); }
    shapes.forEach(function (s) {
      var col = style.color || s.color || '#0f172a';
      if (s.type === 'polyline') { var p = s.pts; if (s.closed && p.length > 2) p = p.concat([p[0]]); if (p.length > 1) add(col, p); }
      else if (s.type === 'circle') add(col, arcPts(s.c, s.r, 0, Math.PI * 2));
      else if (s.type === 'arc') add(col, arcPts(s.c, s.r, s.a0, s.a1));
      else if (s.type === 'point') L.circleMarker(toLL(s.p), { radius: 3, color: col, weight: 1, fillOpacity: 0.8, renderer: renderer, interactive: false }).addTo(group);
      else if (s.type === 'text' && s.text) texts.push(s);
    });
    Object.keys(byColor).forEach(function (col) {
      L.polyline(byColor[col], { color: col, weight: style.weight || 1.2, opacity: style.opacity || 0.95, renderer: renderer, interactive: false, smoothFactor: 0.5 }).addTo(group);
    });
    var textLayer = null;
    if (texts.length) {
      textLayer = L.layerGroup();
      texts.slice(0, 5000).forEach(function (t) {
        var rot = -(t.rot || 0) * 180 / Math.PI;
        L.marker(toLL(t.p), { interactive: false, keyboard: false, icon: L.divIcon({ className: '', iconSize: null,
          html: '<div class="md-text" style="transform: translate(0,-100%) rotate(' + rot + 'deg); transform-origin: 0 100%; color:' + esc(t.color || '#111') + '">' + esc(t.text) + '</div>' }) }).addTo(textLayer);
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
  function addOverlay(o) {
    o.id = 'ov' + (S.nextId++); o.visible = true; o.snap = o.kind !== 'image';
    S.overlays.push(o);
    if (o.kind === 'image') o.layer.addTo(map); else rebuildOverlay(o);
    renderLayerList();
  }
  function removeOverlay(o) {
    if (o.layer) o.layer.remove(); if (o.textLayer) o.textLayer.remove();
    S.snap.removeGroup(o.id);
    S.overlays.splice(S.overlays.indexOf(o), 1);
    if (o.url) URL.revokeObjectURL(o.url);
    renderLayerList();
  }
  function renderLayerList() {
    var ul = $('layerList'); ul.innerHTML = '';
    S.overlays.forEach(function (o) {
      var li = document.createElement('li');
      li.innerHTML = '<input type="checkbox" class="vis" title="表示"' + (o.visible ? ' checked' : '') + '>' +
        '<span class="name" title="' + esc(o.name) + '">' + esc(o.name) + '</span>' +
        (o.kind === 'image' ? '<input type="range" class="op" min="0" max="1" step="0.05" value="' + o.layer.options.opacity + '" title="不透明度"><label title="位置合わせハンドル"><input type="checkbox" class="ed" checked>調整</label>'
          : '<label title="スナップ対象"><input type="checkbox" class="sn"' + (o.snap ? ' checked' : '') + '>snap</label><button class="fit" title="全体表示">⤢</button>') +
        '<button class="x" title="削除">×</button>';
      li.querySelector('.vis').onchange = function () {
        o.visible = this.checked;
        if (o.visible) o.layer.addTo(map); else o.layer.remove();
        if (S.snap.setGroupEnabled && o.kind !== 'image') S.snap.setGroupEnabled(o.id, o.visible && o.snap);
        updateTextVisibility();
      };
      var sn = li.querySelector('.sn'); if (sn) sn.onchange = function () { o.snap = this.checked; S.snap.setGroupEnabled && S.snap.setGroupEnabled(o.id, o.visible && o.snap); };
      var op = li.querySelector('.op'); if (op) op.oninput = function () { o.layer.setOpacity(+this.value); };
      var ed = li.querySelector('.ed'); if (ed) ed.onchange = function () { o.layer.setEditable(this.checked); };
      var fit = li.querySelector('.fit'); if (fit) fit.onclick = function () { try { map.fitBounds(o.layer.getBounds(), { maxZoom: 20 }); } catch (e) { /* empty */ } };
      li.querySelector('.x').onclick = function () { removeOverlay(o); };
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

  function loadDrawing(name, data) {
    var ext = (name.split('.').pop() || '').toLowerCase();
    try {
      if (ext === 'dxf') {
        var text = MD.DXF.decode(data);
        var res = MD.DXF.parse(text, { swapXY: $('chkDxfSwap').checked, scale: +$('selDxfScale').value });
        if (!res.shapes.length) throw new Error('図形がありません');
        addOverlay({ name: name, kind: 'dxf', shapes: res.shapes });
        var o = S.overlays[S.overlays.length - 1];
        if (res.bounds) {
          var b = L.latLngBounds(toLL({ e: res.bounds.minE, n: res.bounds.minN }), toLL({ e: res.bounds.maxE, n: res.bounds.maxN }));
          if (!map.getBounds().intersects(b) || !S.tile) map.fitBounds(b, { maxZoom: 20 });
        }
        toast(name + ': ' + res.shapes.length + ' 図形' + (res.warnings && res.warnings.length ? ' (警告 ' + res.warnings.length + ')' : ''));
        void o;
      } else if (ext === 'geojson' || ext === 'json') {
        var gj = JSON.parse(new TextDecoder('utf-8').decode(data));
        addOverlay({ name: name, kind: 'geojson', geo: gj, color: '#7c3aed' });
        try { map.fitBounds(S.overlays[S.overlays.length - 1].layer.getBounds(), { maxZoom: 19 }); } catch (e) { /* empty */ }
      } else if (/^(png|jpe?g|gif|webp|bmp)$/.test(ext)) {
        var url = URL.createObjectURL(new Blob([data]));
        var img = new Image();
        img.onload = function () {
          // 現在表示範囲の 70% に縦横比を保って配置
          var sz = map.getSize(), w = img.naturalWidth, h = img.naturalHeight;
          var sc = Math.min(sz.x * 0.7 / w, sz.y * 0.7 / h), cx = sz.x / 2, cy = sz.y / 2;
          var tl = map.containerPointToLatLng([cx - w * sc / 2, cy - h * sc / 2]);
          var tr = map.containerPointToLatLng([cx + w * sc / 2, cy - h * sc / 2]);
          var bl = map.containerPointToLatLng([cx - w * sc / 2, cy + h * sc / 2]);
          var layer = new MD.AffineImage(url, [tl, tr, bl], { opacity: 0.6 });
          addOverlay({ name: name, kind: 'image', layer: layer, url: url, shapes: [] });
          toast('赤い丸(左上/右上/左下)と中央の✥をドラッグして位置合わせ', 6000);
        };
        img.src = url;
      } else if (ext === 'sim' || ext === 'xml') { loadSima(name, data); }
      else throw new Error('未対応の形式: ' + ext);
    } catch (e) { toast(name + ' を読めません: ' + e.message, 6000); console.error(e); }
  }

  // ---------------- 線形 (SIMA / IP) ----------------
  function loadSima(name, data) {
    try {
      var text = MD.SIMA.decode(data);
      var isXml = MD.SIMAXML && MD.SIMAXML.isSimaXml(text);
      var res = isXml ? MD.SIMAXML.parse(text) : MD.SIMA.parse(text);
      if (res.zone && res.zone !== S.zone) setZone(res.zone);
      var routes = (res.routes || []).filter(function (r) { return r.ips && r.ips.length >= 2; });
      if (routes.length) {
        routes.forEach(function (r) { r.label = name + ' : ' + (r.name || ('路線' + (r.no || ''))); });
        S.route.list = S.route.list.concat(routes);
        renderRouteSelect();
        selectRoute(S.route.list.length - routes.length);
        fitRoute();
      }
      var shapes = [];
      (res.points || []).forEach(function (p) {
        shapes.push({ type: 'point', p: { e: p.e, n: p.n }, name: p.name, layer: 'sima', color: '#0369a1' });
        if (p.name) shapes.push({ type: 'text', p: { e: p.e, n: p.n }, text: p.name, h: 1, rot: 0, layer: 'sima', color: '#0369a1' });
      });
      (res.parcels || []).forEach(function (pc) {
        if (pc.pts && pc.pts.length >= 3) shapes.push({ type: 'polyline', pts: pc.pts.map(function (q) { return { e: q.e, n: q.n }; }), closed: true, layer: '画地', color: '#b45309', name: pc.name });
      });
      (res.lines || []).forEach(function (ln) { shapes.push({ type: 'polyline', pts: ln.pts.map(function (q) { return { e: q.e, n: q.n }; }), closed: false, layer: '開放型画地', color: '#9333ea', name: ln.name }); });
      if (shapes.length) {
        var cnt = [(res.points || []).length + '点', (res.parcels || []).length ? res.parcels.length + '画地' : '', (res.lines || []).length ? res.lines.length + '線' : ''].filter(Boolean).join(' ');
        addOverlay({ name: name + ' (' + cnt + ')', kind: 'sima', shapes: shapes });
        if (!routes.length) { try { map.fitBounds(S.overlays[S.overlays.length - 1].layer.getBounds(), { maxZoom: 19 }); } catch (e) { /* 点のみ */ } }
      }
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
    R.al = al; R.stations = st; R.bones = bones; R.pitch = pitch;

    var g = L.featureGroup(), shapes = [];
    function pl(pts, opt) { return L.polyline(pts.map(toLL), L.extend({ renderer: renderer, interactive: false }, opt)).addTo(g); }
    if ($('chkIpLine').checked) {
      pl(R.ips, { color: '#64748b', weight: 1, dashArray: '6 4' });
      R.ips.forEach(function (p) { L.circleMarker(toLL(p), { radius: 3.5, color: '#475569', weight: 1, fillColor: '#fff', fillOpacity: 1, renderer: renderer, interactive: false }).addTo(g); });
    }
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
    var cl = MD.Alignment.sample(al, 1);
    pl(cl, { color: '#dc2626', weight: 2 });
    if ($('chkEdges').checked) {
      var wl = +$('numLeft').value || 0, wr = +$('numRight').value || 0;
      if (wl > 0) { var ol = MD.Alignment.offset(al, wl, 1); pl(ol, { color: '#2563eb', weight: 1.2 }); shapes.push({ type: 'polyline', pts: ol, closed: false, noVertexSnap: true, layer: 'EDGE' }); }
      if (wr > 0) { var or = MD.Alignment.offset(al, -wr, 1); pl(or, { color: '#2563eb', weight: 1.2 }); shapes.push({ type: 'polyline', pts: or, closed: false, noVertexSnap: true, layer: 'EDGE' }); }
    }
    var mainB = [], keyB = [], subB = [];
    bones.forEach(function (b) {
      var line = [toLL(b.l), toLL(b.r)];
      (b.station.kind === 'key' ? keyB : b.station.kind === 'sub' ? subB : mainB).push(line);
      shapes.push({ type: 'polyline', pts: [b.l, b.c, b.r], closed: false, layer: 'BONE' });
    });
    if (subB.length) L.polyline(subB, { color: '#16a34a', weight: 0.8, opacity: 0.7, dashArray: '3 3', renderer: renderer, interactive: false }).addTo(g);
    if (mainB.length) L.polyline(mainB, { color: '#16a34a', weight: 1.4, renderer: renderer, interactive: false }).addTo(g);
    if (keyB.length) L.polyline(keyB, { color: '#dc2626', weight: 1.4, renderer: renderer, interactive: false }).addTo(g);
    al.keyPoints.forEach(function (k) { var q = MD.Alignment.pointAt(al, k.s); shapes.push({ type: 'point', p: { e: q.e, n: q.n }, name: k.name, layer: 'KEY' }); });
    g.addTo(map);
    R.layer = g;
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
    $('alignInfo').textContent = '延長 ' + al.length.toFixed(3) + ' m / 測点 ' + st.length + ' / 主要点 ' + al.keyPoints.length + chk + (w.length ? '\n⚠ ' + w.join('\n⚠ ') : '');
    refreshPoints();
  }
  // 測点ラベル (横断線方向に回転)。ズームに応じて間引き (主要点は常に表示)
  function updateRouteLabels() {
    var R = S.route;
    if (R.labelLayer) { R.labelLayer.remove(); R.labelLayer = null; }
    if (!R.bones.length || !$('chkLabels').checked || map.getZoom() < (+$('numLabelZoom').value || 0)) return;
    var c0 = toLL(R.bones[0].c), px = R.pitch / metersPerPixel(c0.lat);
    var every = Math.max(1, Math.ceil(16 / Math.max(px, 0.01)));
    var nice = [1, 2, 5, 10, 25, 50, 100, 250, 500, 1000]; every = nice.find(function (v) { return v >= every; }) || every;
    var lab = L.layerGroup(), keyPx = -1e9;
    R.bones.forEach(function (b) {
      var st = b.station, key = st.kind === 'key';
      if (st.kind === 'sub') return;
      if (!key) { var k = Math.round((st.chainage) / R.pitch); if (k % every) return; }
      else { var sp = b.station.s / metersPerPixel(c0.lat); if (sp - keyPx < 12) return; keyPx = sp; }
      var raw = -(b.h + Math.PI / 2) * 180 / Math.PI;    // 横断線(左向き)の画面角
      raw = ((raw % 360) + 360) % 360;
      var flip = raw > 90 && raw < 270, ang = flip ? raw - 180 : raw;
      L.marker(toLL(b.l), { interactive: false, keyboard: false, icon: L.divIcon({ className: '', iconSize: null,
        html: '<div class="md-sta-rot" style="transform: rotate(' + ang.toFixed(1) + 'deg)"><div class="md-sta-label' + (key ? ' md-key-label' : '') + (flip ? ' flip' : '') + '">' + esc(st.label) + '</div></div>' }) }).addTo(lab);
    });
    R.labelLayer = lab.addTo(map);
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

  function addPoint(p, kind, snapName) {
    var no = S.points.length ? S.points[S.points.length - 1].no + 1 : 1;
    S.points.push({ no: no, name: 'P' + no, e: p.e, n: p.n, z: 0, kind: kind || 'raw', ref: snapName || '' });
    refreshPoints();
  }
  function refreshPoints() {
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

  // ---------------- メニュー ----------------
  var ACTIONS = {
    'file.openTiles': openTiles, 'file.openDrawing': openDrawing, 'file.openSima': openSima,
    'file.exportCsv': exportCsv, 'file.exportSima': exportSima, 'file.exportStations': exportStations,
    'edit.undoPoint': function () { if (isTyping()) { document.execCommand('undo'); return; } S.points.pop(); refreshPoints(); },
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
    'help.about': function () { $('aboutText').textContent = 'バージョン ' + VERSION + (N ? ' (デスクトップ版)' : ' (ブラウザ版)'); $('dlgAbout').showModal(); },
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
  document.title = 'MapDetector ' + VERSION;

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

  // 起動時: 前回のタイルフォルダを開く (デスクトップ版)
  (async function () {
    if (!N || !N.getSetting) return;
    try {
      var last = await N.getSetting('lastTileFolder');
      if (last) { var info = await N.openTilePath(last); if (info) setTiles({ kind: 'electron', info: info }, info.root); }
    } catch (e) { /* 前回フォルダなし */ }
  })();

  // デバッグ/テスト用
  window.MDApp = { S: S, map: map, loadDrawing: loadDrawing, loadSima: loadSima, addPoint: addPoint, setZone: setZone, setTiles: setTiles, computeSnap: computeSnap, rebuildRoute: rebuildRoute };
})();
