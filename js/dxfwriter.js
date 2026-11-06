/*
 * MD.DXFWriter — minimal ASCII DXF R12 (AC1009) writer.
 *
 * write(layers, opts) → string (CRLF line endings)
 *   layers : [{name, color:'#rrggbb' | ACI number, aci?, shapes:[Shape...]}]
 *   opts   : {swapXY=false, scale=1, z=0, encoding='shift_jis'|'utf8'|'ascii'}
 *     default : x = e*scale, y = n*scale      (MD.DXF.parse(text) restores e/n)
 *     swapXY  : x = n*scale, y = e*scale      (MD.DXF.parse(text, {swapXY:true}) restores e/n)
 *   encoding:
 *     'shift_jis' (default): $DWGCODEPAGE ANSI_932; the returned JS string must be
 *                            encoded to cp932 bytes by the caller (e.g. iconv-lite).
 *     'utf8'               : no $DWGCODEPAGE; caller writes UTF-8 bytes.
 *     'ascii'              : $DWGCODEPAGE ANSI_1252; every non-ASCII char → \U+XXXX.
 *
 * Entities: polyline → LINE (2-pt open) or POLYLINE/VERTEX/SEQEND (70 bit 1 = closed),
 * circle → CIRCLE, arc → ARC (degrees, CCW; mirrored correctly under swapXY),
 * point → POINT, text → TEXT (40 height, 50 rotation deg).
 * Entity colour is BYLAYER unless the shape's own color maps to a different ACI.
 */
(function (root) {
  'use strict';
  root.MD = root.MD || {};

  var TAU = Math.PI * 2;
  var RAD2DEG = 180 / Math.PI;

  // ------------------------------------------------------------ ACI palette (same as MD.DXF reader)
  var ACI_RGB = (function () {
    var t = new Array(256);
    var base = [[255, 0, 0], [255, 255, 0], [0, 255, 0], [0, 255, 255], [0, 0, 255], [255, 0, 255], [0, 0, 0], [128, 128, 128], [192, 192, 192]];
    t[0] = [0, 0, 0];
    for (var i = 1; i <= 9; i++) t[i] = base[i - 1];
    var vals = [255, 165, 127, 76, 38];
    function cl(v) { return Math.max(0, Math.min(255, Math.round(v))); }
    for (var c = 10; c <= 249; c++) {
      var h = Math.floor((c - 10) / 10) * 15;
      var sub = (c - 10) % 10;
      var V = vals[sub >> 1];
      var S = (sub & 1) ? 0.5 : 1;
      var hh = h / 60, sec = Math.floor(hh) % 6, f = hh - Math.floor(hh);
      var p = V * (1 - S), q = V * (1 - S * f), tt = V * (1 - S * (1 - f));
      var rgb = [[V, tt, p], [q, V, p], [p, V, tt], [p, q, V], [tt, p, V], [V, p, q]][sec];
      t[c] = [cl(rgb[0]), cl(rgb[1]), cl(rgb[2])];
    }
    var grays = [51, 80, 105, 130, 190, 255];
    for (var g = 0; g < 6; g++) t[250 + g] = [grays[g], grays[g], grays[g]];
    return t;
  })();

  function parseHex(s) {
    var m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(s).trim());
    if (!m) return null;
    var h = m[1];
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    var v = parseInt(h, 16);
    return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
  }

  // '#rrggbb' | ACI number → ACI 1..255 (null if not given/unparseable)
  function toAci(color) {
    if (color == null || color === '') return null;
    if (typeof color === 'number') {
      var n = Math.abs(Math.round(color));
      return n >= 1 && n <= 255 ? n : null;
    }
    var rgb = parseHex(color);
    if (!rgb) return null;
    // white and black both map to ACI 7 (white-on-dark / black-on-light)
    if ((rgb[0] === 255 && rgb[1] === 255 && rgb[2] === 255) || (rgb[0] === 0 && rgb[1] === 0 && rgb[2] === 0)) return 7;
    var best = 7, bd = Infinity;
    for (var i = 1; i <= 255; i++) {
      var c = ACI_RGB[i];
      var dr = rgb[0] - c[0], dg = rgb[1] - c[1], db = rgb[2] - c[2];
      var d = 2 * dr * dr + 4 * dg * dg + 3 * db * db; // simple perceptual weighting
      if (d < bd) { bd = d; best = i; }
    }
    return best;
  }

  // ------------------------------------------------------------ text escaping
  function escapeAscii(s) {
    var out = '';
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) { out += '?'; i++; continue; } // non-BMP
      if (c < 0x80) out += s[i];
      else { var h = c.toString(16).toUpperCase(); while (h.length < 4) h = '0' + h; out += '\\U+' + h; }
    }
    return out;
  }

  function cleanString(s, encoding) {
    s = String(s == null ? '' : s).replace(/\r\n|\r|\n|\t/g, ' ').replace(/[\x00-\x1f\x7f]/g, '');
    if (encoding === 'ascii') return escapeAscii(s);
    return s.replace(/[\ud800-\udbff][\udc00-\udfff]/g, '?'); // non-BMP not representable in R12
  }

  function textValue(s, encoding) {
    s = cleanString(s, encoding);
    if (/%%/.test(s)) s = s.replace(/%/g, '%%%'); // keep literal "%%" (reader/AutoCAD: %%% → %)
    return s;
  }

  function layerName(s, encoding) {
    s = cleanString(s, 'utf8').replace(/[<>\/\\":;?*|=,`]/g, '_').trim();
    if (encoding === 'ascii') s = escapeAscii(s);
    return s || '0';
  }

  // ------------------------------------------------------------ number formatting
  function num(v) {
    v = +v;
    if (!isFinite(v) || Math.abs(v) < 1e-12) return '0.0';
    var s = v.toFixed(10);
    if (s.indexOf('.') >= 0) s = s.replace(/0+$/, '').replace(/\.$/, '.0');
    return s;
  }

  function normAng(a) { return ((a % TAU) + TAU) % TAU; }
  function deg(a) {
    var d = normAng(a) * RAD2DEG;
    if (d >= 360 - 1e-10) d = 0;
    return num(d);
  }

  // ------------------------------------------------------------ writer
  function write(layers, opts) {
    opts = opts || {};
    layers = layers || [];
    var sc = opts.scale == null ? 1 : +opts.scale;
    if (!isFinite(sc) || sc === 0) sc = 1;
    var z = +opts.z || 0;
    var encoding = opts.encoding || 'shift_jis';
    if (encoding === 'utf-8') encoding = 'utf8';
    if (encoding === 'sjis' || encoding === 'cp932') encoding = 'shift_jis';
    var swap = !!opts.swapXY;
    // (e, n) → (x, y);  M = [a, b, c, d] : x = a e + c n, y = b e + d n
    var M = swap ? [0, sc, sc, 0] : [sc, 0, 0, sc];
    var detM = M[0] * M[3] - M[1] * M[2];
    var rs = Math.sqrt(Math.abs(detM));
    function X(p) { return { x: M[0] * p.e + M[2] * p.n, y: M[1] * p.e + M[3] * p.n }; }
    function vecAng(a) {
      var c = Math.cos(a), s = Math.sin(a);
      return Math.atan2(M[1] * c + M[3] * s, M[0] * c + M[2] * s);
    }

    var out = [];
    function g(code, value) {
      var c = String(code);
      while (c.length < 3) c = ' ' + c;
      out.push(c, String(value));
    }

    // extents (DXF coords)
    var B = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
    function bx(q) {
      if (!isFinite(q.x) || !isFinite(q.y)) return;
      if (q.x < B.minX) B.minX = q.x;
      if (q.x > B.maxX) B.maxX = q.x;
      if (q.y < B.minY) B.minY = q.y;
      if (q.y > B.maxY) B.maxY = q.y;
    }
    function inSweep(a, a0, sweep) { return normAng(a - a0) <= sweep + 1e-12; }

    // ---- build entities first (also collects extents)
    var ent = [];
    function e(code, value) {
      var c = String(code);
      while (c.length < 3) c = ' ' + c;
      ent.push(c, String(value));
    }
    var usedLayers = [];
    var seen = {};

    layers.forEach(function (L) {
      var name = layerName(L.name, encoding);
      var laci = toAci(L.aci != null ? L.aci : L.color);
      if (laci == null) laci = 7;
      if (!seen[name]) { seen[name] = { name: name, aci: laci }; usedLayers.push(seen[name]); }
      var lay = seen[name];
      (L.shapes || []).forEach(function (s) {
        if (!s || !s.type) return;
        var saci = toAci(s.aci != null ? s.aci : s.color);
        function head(type) {
          e(0, type);
          e(8, name);
          if (saci != null && saci !== lay.aci) e(62, saci);
        }
        function pt(q, cx, cy, cz) { e(cx || 10, num(q.x)); e(cy || 20, num(q.y)); e(cz || 30, num(z)); }
        switch (s.type) {
          case 'polyline': {
            var pts = (s.pts || []).filter(function (p) { return p && isFinite(p.e) && isFinite(p.n); }).map(X);
            if (!pts.length) return;
            pts.forEach(bx);
            if (pts.length === 1) { head('POINT'); pt(pts[0]); return; }
            var closed = !!s.closed && pts.length > 2;
            if (pts.length === 2 && !closed) {
              head('LINE'); pt(pts[0]); pt(pts[1], 11, 21, 31);
              return;
            }
            head('POLYLINE');
            e(66, 1);
            e(10, '0.0'); e(20, '0.0'); e(30, num(z));
            e(70, closed ? 1 : 0);
            pts.forEach(function (q) {
              e(0, 'VERTEX'); e(8, name);
              if (saci != null && saci !== lay.aci) e(62, saci);
              pt(q); e(70, 0);
            });
            e(0, 'SEQEND'); e(8, name);
            return;
          }
          case 'circle': {
            if (!s.c || !(s.r > 0)) return;
            var c = X(s.c), r = s.r * rs;
            bx({ x: c.x - r, y: c.y - r }); bx({ x: c.x + r, y: c.y + r });
            head('CIRCLE'); pt(c); e(40, num(r));
            return;
          }
          case 'arc': {
            if (!s.c || !(s.r > 0)) return;
            var cc = X(s.c), rr = s.r * rs;
            var sweep = normAng(s.a1 - s.a0);
            if (sweep < 1e-12) sweep = TAU;
            if (sweep >= TAU - 1e-12) {
              bx({ x: cc.x - rr, y: cc.y - rr }); bx({ x: cc.x + rr, y: cc.y + rr });
              head('CIRCLE'); pt(cc); e(40, num(rr));
              return;
            }
            var as = vecAng(s.a0), ae = vecAng(s.a0 + sweep);
            var A0 = detM > 0 ? as : ae; // mirrored → CCW sweep runs from mapped end to mapped start
            A0 = normAng(A0);
            var A1 = A0 + sweep;
            bx({ x: cc.x + rr * Math.cos(A0), y: cc.y + rr * Math.sin(A0) });
            bx({ x: cc.x + rr * Math.cos(A1), y: cc.y + rr * Math.sin(A1) });
            for (var k = 0; k < 4; k++) {
              var qa = k * Math.PI / 2;
              if (inSweep(qa, A0, sweep)) bx({ x: cc.x + rr * Math.cos(qa), y: cc.y + rr * Math.sin(qa) });
            }
            head('ARC'); pt(cc); e(40, num(rr)); e(50, deg(A0)); e(51, deg(A1));
            return;
          }
          case 'point': {
            if (!s.p) return;
            var pp = X(s.p);
            bx(pp);
            head('POINT'); pt(pp);
            return;
          }
          case 'text': {
            if (!s.p) return;
            var tp = X(s.p);
            bx(tp);
            var h = (s.h > 0 ? s.h : 1) * rs;
            head('TEXT'); pt(tp); e(40, num(h));
            e(1, textValue(s.text, encoding));
            var rot = vecAng(s.rot || 0);
            if (Math.abs(normAng(rot)) > 1e-12) e(50, deg(rot));
            e(7, 'STANDARD');
            return;
          }
          default:
            return;
        }
      });
    });

    if (!seen['0']) usedLayers.unshift({ name: '0', aci: 7 });
    if (!isFinite(B.minX)) B = { minX: 0, minY: 0, maxX: 0, maxY: 0 };

    // ---- HEADER
    g(0, 'SECTION'); g(2, 'HEADER');
    g(9, '$ACADVER'); g(1, 'AC1009');
    if (encoding === 'shift_jis') { g(9, '$DWGCODEPAGE'); g(3, 'ANSI_932'); }
    else if (encoding === 'ascii') { g(9, '$DWGCODEPAGE'); g(3, 'ANSI_1252'); }
    g(9, '$INSBASE'); g(10, '0.0'); g(20, '0.0'); g(30, '0.0');
    g(9, '$EXTMIN'); g(10, num(B.minX)); g(20, num(B.minY)); g(30, num(z));
    g(9, '$EXTMAX'); g(10, num(B.maxX)); g(20, num(B.maxY)); g(30, num(z));
    g(9, '$INSUNITS'); g(70, 6);
    g(0, 'ENDSEC');

    // ---- TABLES
    g(0, 'SECTION'); g(2, 'TABLES');
    g(0, 'TABLE'); g(2, 'LTYPE'); g(70, 1);
    g(0, 'LTYPE'); g(2, 'CONTINUOUS'); g(70, 0); g(3, 'Solid line'); g(72, 65); g(73, 0); g(40, '0.0');
    g(0, 'ENDTAB');
    g(0, 'TABLE'); g(2, 'LAYER'); g(70, usedLayers.length);
    usedLayers.forEach(function (L) {
      g(0, 'LAYER'); g(2, L.name); g(70, 0); g(62, L.aci); g(6, 'CONTINUOUS');
    });
    g(0, 'ENDTAB');
    g(0, 'TABLE'); g(2, 'STYLE'); g(70, 1);
    g(0, 'STYLE'); g(2, 'STANDARD'); g(70, 0); g(40, '0.0'); g(41, '1.0'); g(50, '0.0'); g(71, 0);
    g(42, '2.5'); g(3, opts.font || 'txt'); g(4, opts.bigFont || '');
    g(0, 'ENDTAB');
    g(0, 'ENDSEC');

    // ---- ENTITIES
    g(0, 'SECTION'); g(2, 'ENTITIES');
    for (var i = 0; i < ent.length; i++) out.push(ent[i]);
    g(0, 'ENDSEC');
    g(0, 'EOF');

    return out.join('\r\n') + '\r\n';
  }

  root.MD.DXFWriter = {
    write: write,
    toAci: toAci,
    escapeAscii: escapeAscii
  };
})(typeof window !== 'undefined' ? window : globalThis);
