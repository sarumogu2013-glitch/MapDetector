/*
 * MD.DXF — minimal ASCII DXF reader (R12 .. R2018).
 *
 * parse(text, {swapXY=false, scale=1, offsetE=0, offsetN=0})
 *   default : e = x*scale + offsetE, n = y*scale + offsetN
 *   swapXY  : e = y*scale + offsetE, n = x*scale + offsetN
 * All geometry is pushed through one 2D affine transform (block insert ∘ OCS ∘ output),
 * so mirrored transforms (swapXY, negative scale, extrusion 0,0,-1) keep arcs CCW.
 *
 * Polylines with bulges are split into true 'arc' shapes plus straight 'polyline'
 * runs (closed:false). ELLIPSE / SPLINE (and arcs under non-uniform scaling)
 * are approximated as polylines with noVertexSnap:true.
 */
(function (root) {
  'use strict';
  root.MD = root.MD || {};

  var TAU = Math.PI * 2;
  var DEG = Math.PI / 180;

  // ------------------------------------------------------------ ACI palette
  var ACI = (function () {
    var t = new Array(256);
    t[0] = '#000000';
    var base = ['#ff0000', '#ffff00', '#00ff00', '#00ffff', '#0000ff', '#ff00ff', '#000000', '#808080', '#c0c0c0'];
    for (var i = 1; i <= 9; i++) t[i] = base[i - 1];
    var vals = [255, 165, 127, 76, 38];
    function hex(v) { v = Math.max(0, Math.min(255, Math.round(v))); return (v < 16 ? '0' : '') + v.toString(16); }
    for (var c = 10; c <= 249; c++) {
      var h = Math.floor((c - 10) / 10) * 15;
      var sub = (c - 10) % 10;
      var V = vals[sub >> 1];
      var S = (sub & 1) ? 0.5 : 1;
      var hh = h / 60, sec = Math.floor(hh) % 6, f = hh - Math.floor(hh);
      var p = V * (1 - S), q = V * (1 - S * f), tt = V * (1 - S * (1 - f));
      var rgb = [[V, tt, p], [q, V, p], [p, V, tt], [p, q, V], [tt, p, V], [V, p, q]][sec];
      t[c] = '#' + hex(rgb[0]) + hex(rgb[1]) + hex(rgb[2]);
    }
    var grays = [51, 80, 105, 130, 190, 255];
    for (var g = 0; g < 6; g++) t[250 + g] = '#' + hex(grays[g]) + hex(grays[g]) + hex(grays[g]);
    return t;
  })();

  function aciToHex(i) {
    i = Math.abs(i | 0);
    if (i === 7) return '#000000';
    return ACI[i] || '#000000';
  }

  function trueColorHex(v) {
    v = v & 0xffffff;
    var s = v.toString(16);
    while (s.length < 6) s = '0' + s;
    return '#' + s;
  }

  // ------------------------------------------------------------ decode
  function toBytes(buf) {
    if (buf instanceof Uint8Array) return buf;
    if (ArrayBuffer.isView(buf)) return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    return new Uint8Array(buf);
  }

  var CODEPAGES = {
    ANSI_932: 'shift_jis', ANSI_936: 'gbk', ANSI_949: 'euc-kr', ANSI_950: 'big5',
    ANSI_1250: 'windows-1250', ANSI_1251: 'windows-1251', ANSI_1252: 'windows-1252',
    ANSI_1253: 'windows-1253', ANSI_1254: 'windows-1254', ANSI_1255: 'windows-1255',
    ANSI_1256: 'windows-1256', ANSI_1257: 'windows-1257', ANSI_874: 'windows-874'
  };

  function tryUtf8(bytes) {
    try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch (e) { return null; }
  }

  function decode(arrayBuffer) {
    var bytes = toBytes(arrayBuffer);
    var head = new TextDecoder('latin1').decode(bytes.subarray(0, Math.min(bytes.length, 65536)));
    var cpM = /\$DWGCODEPAGE\s*\r?\n\s*3\s*\r?\n\s*(\S+)/i.exec(head);
    var verM = /\$ACADVER\s*\r?\n\s*1\s*\r?\n\s*AC(\d{4})/i.exec(head);
    var cp = cpM ? cpM[1].toUpperCase() : null;
    var ver = verM ? parseInt(verM[1], 10) : 0;
    var text = null;
    if (ver >= 1021) {
      // R2007+ DXF is always UTF-8
      text = tryUtf8(bytes);
    }
    if (text == null && cp && CODEPAGES[cp]) {
      try { text = new TextDecoder(CODEPAGES[cp]).decode(bytes); } catch (e) { text = null; }
    }
    if (text == null) text = tryUtf8(bytes);
    if (text == null) text = new TextDecoder('shift_jis').decode(bytes);
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    return text;
  }

  // ------------------------------------------------------------ text cleanup
  function decodeUnicodeEscapes(s) {
    return s.replace(/\\U\+([0-9A-Fa-f]{4})/g, function (_, h) { return String.fromCharCode(parseInt(h, 16)); })
      .replace(/\\M\+[0-9A-Fa-f]([0-9A-Fa-f]{4})/g, function (_, h) {
        // MIF (multibyte) escape: best effort for Shift_JIS
        try {
          var code = parseInt(h, 16);
          return new TextDecoder('shift_jis').decode(new Uint8Array([code >> 8, code & 255]));
        } catch (e) { return '?'; }
      });
  }

  function cleanText(s) {
    s = decodeUnicodeEscapes(s);
    return s.replace(/%%(\d{3}|[cdpouCDPOU%])/g, function (_, c) {
      if (/^\d{3}$/.test(c)) return String.fromCharCode(parseInt(c, 10));
      switch (c.toLowerCase()) {
        case 'c': return '⌀';
        case 'd': return '°';
        case 'p': return '±';
        case '%': return '%';
        default: return '';
      }
    });
  }

  function cleanMText(s) {
    s = decodeUnicodeEscapes(s);
    var out = '';
    for (var i = 0; i < s.length; i++) {
      var ch = s[i];
      if (ch === '\\') {
        var n = s[i + 1];
        if (n === undefined) break;
        if (n === 'P') { out += '\n'; i++; continue; }
        if (n === 'N') { out += '\n'; i++; continue; }
        if (n === 'X') { out += '\n'; i++; continue; }
        if (n === '~') { out += ' '; i++; continue; }
        if (n === '\\' || n === '{' || n === '}') { out += n; i++; continue; }
        if ('LlOoKk'.indexOf(n) >= 0) { i++; continue; }
        if (n === 'S') {
          var end = s.indexOf(';', i + 2);
          if (end < 0) end = s.length;
          out += s.slice(i + 2, end).replace(/[\^#]/g, '/');
          i = end;
          continue;
        }
        if ('ACFfHQTWpc'.indexOf(n) >= 0) {
          var e2 = s.indexOf(';', i + 2);
          i = e2 < 0 ? s.length : e2;
          continue;
        }
        // unknown escape: keep char
        out += n;
        i++;
        continue;
      }
      if (ch === '{' || ch === '}') continue;
      out += ch;
    }
    return cleanText(out);
  }

  // ------------------------------------------------------------ affine
  // m = [a, b, c, d, tx, ty] : x' = a x + c y + tx ; y' = b x + d y + ty
  function mul(m1, m2) { // m1 ∘ m2
    return [
      m1[0] * m2[0] + m1[2] * m2[1],
      m1[1] * m2[0] + m1[3] * m2[1],
      m1[0] * m2[2] + m1[2] * m2[3],
      m1[1] * m2[2] + m1[3] * m2[3],
      m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
      m1[1] * m2[4] + m1[3] * m2[5] + m1[5]
    ];
  }
  function apply(m, x, y) { return { e: m[0] * x + m[2] * y + m[4], n: m[1] * x + m[3] * y + m[5] }; }
  function det(m) { return m[0] * m[3] - m[1] * m[2]; }
  function translate(x, y) { return [1, 0, 0, 1, x, y]; }
  function rotate(a) { var c = Math.cos(a), s = Math.sin(a); return [c, s, -s, c, 0, 0]; }
  function scaleM(sx, sy) { return [sx, 0, 0, sy, 0, 0]; }
  // is the transform a similarity (uniform scale, optionally mirrored)?
  function isConformal(m) {
    var c1 = Math.hypot(m[0], m[1]), c2 = Math.hypot(m[2], m[3]);
    if (!(c1 > 0) || !(c2 > 0)) return false;
    var dot = m[0] * m[2] + m[1] * m[3];
    return Math.abs(c1 - c2) <= 1e-9 * Math.max(c1, c2) && Math.abs(dot) <= 1e-9 * c1 * c2;
  }

  // ------------------------------------------------------------ tokenizer
  function readPairs(text) {
    var lines = text.split(/\r\n|\r|\n/);
    var pairs = [];
    for (var i = 0; i + 1 < lines.length; i += 2) {
      var codeStr = lines[i].trim();
      if (codeStr === '' && i === lines.length - 1) break;
      var code = parseInt(codeStr, 10);
      if (!isFinite(code)) {
        // resync: skip one line
        i -= 1;
        continue;
      }
      var v = lines[i + 1];
      // keep leading spaces of text values, trim others
      if (code === 1 || code === 3) v = v.replace(/\s+$/, '');
      else v = v.trim();
      pairs.push([code, v]);
    }
    return pairs;
  }

  // group pairs into entities: {type, g:[[code,val],...]}
  function groupEntities(pairs, start, stopTypes) {
    var list = [];
    var i = start;
    while (i < pairs.length) {
      var p = pairs[i];
      if (p[0] !== 0) { i++; continue; }
      var type = p[1].toUpperCase();
      if (stopTypes.indexOf(type) >= 0) break;
      var g = [];
      i++;
      while (i < pairs.length && pairs[i][0] !== 0) { g.push(pairs[i]); i++; }
      list.push({ type: type, g: g });
    }
    return { list: list, next: i };
  }

  function getv(g, code, def) {
    for (var i = 0; i < g.length; i++) if (g[i][0] === code) return g[i][1];
    return def;
  }
  function getf(g, code, def) {
    var v = getv(g, code, undefined);
    if (v === undefined) return def;
    var f = parseFloat(v);
    return isFinite(f) ? f : def;
  }
  function geti(g, code, def) {
    var v = getv(g, code, undefined);
    if (v === undefined) return def;
    var f = parseInt(v, 10);
    return isFinite(f) ? f : def;
  }

  // nest POLYLINE→VERTEX..SEQEND and INSERT→ATTRIB..SEQEND
  function nestEntities(list) {
    var out = [];
    for (var i = 0; i < list.length; i++) {
      var en = list[i];
      if (en.type === 'POLYLINE') {
        en.vertices = [];
        while (i + 1 < list.length && list[i + 1].type === 'VERTEX') { en.vertices.push(list[++i]); }
        if (i + 1 < list.length && list[i + 1].type === 'SEQEND') i++;
      } else if (en.type === 'INSERT') {
        en.attribs = [];
        if (geti(en.g, 66, 0) === 1) {
          while (i + 1 < list.length && list[i + 1].type === 'ATTRIB') en.attribs.push(list[++i]);
          if (i + 1 < list.length && list[i + 1].type === 'SEQEND') i++;
        }
      } else if (en.type === 'VERTEX' || en.type === 'SEQEND' || en.type === 'ATTRIB') {
        continue; // stray
      }
      out.push(en);
    }
    return out;
  }

  // ------------------------------------------------------------ parse
  function parse(text, opts) {
    opts = opts || {};
    var sc = opts.scale == null ? 1 : +opts.scale;
    var oE = +opts.offsetE || 0, oN = +opts.offsetN || 0;
    var F = opts.swapXY ? [0, sc, sc, 0, oE, oN] : [sc, 0, 0, sc, oE, oN];

    var res = { shapes: [], layers: [], bounds: null, warnings: [] };
    if (typeof text !== 'string') text = String(text || '');
    if (/^AutoCAD Binary DXF/.test(text)) {
      res.warnings.push('バイナリDXFには対応していません');
      return res;
    }
    var pairs = readPairs(text);

    var layerMap = {};
    var blocks = {};
    var entities = [];
    var unsupported = {};
    var skippedPaper = 0;

    // ---- sections
    var i = 0;
    while (i < pairs.length) {
      if (pairs[i][0] === 0 && pairs[i][1] === 'SECTION' && pairs[i + 1] && pairs[i + 1][0] === 2) {
        var name = pairs[i + 1][1].toUpperCase();
        i += 2;
        if (name === 'TABLES') {
          while (i < pairs.length && !(pairs[i][0] === 0 && pairs[i][1] === 'ENDSEC')) {
            if (pairs[i][0] === 0 && pairs[i][1] === 'LAYER') {
              var g = [];
              i++;
              while (i < pairs.length && pairs[i][0] !== 0) { g.push(pairs[i]); i++; }
              var ln = getv(g, 2, null);
              if (ln != null) {
                var aci = geti(g, 62, 7);
                var tc = getv(g, 420, undefined);
                var col = tc !== undefined ? trueColorHex(parseInt(tc, 10)) : aciToHex(aci);
                var L = { name: ln, color: col };
                if (aci < 0) L.off = true;
                if (geti(g, 70, 0) & 1) L.frozen = true;
                if (!layerMap[ln]) res.layers.push(L);
                layerMap[ln] = L;
              }
              continue;
            }
            i++;
          }
        } else if (name === 'BLOCKS') {
          while (i < pairs.length && !(pairs[i][0] === 0 && pairs[i][1] === 'ENDSEC')) {
            if (pairs[i][0] === 0 && pairs[i][1] === 'BLOCK') {
              var bg = [];
              i++;
              while (i < pairs.length && pairs[i][0] !== 0) { bg.push(pairs[i]); i++; }
              var r = groupEntities(pairs, i, ['ENDBLK', 'ENDSEC']);
              i = r.next;
              var bn = getv(bg, 2, getv(bg, 3, ''));
              blocks[bn.toUpperCase()] = {
                name: bn,
                bx: getf(bg, 10, 0), by: getf(bg, 20, 0),
                flags: geti(bg, 70, 0),
                entities: nestEntities(r.list)
              };
              if (i < pairs.length && pairs[i][1] === 'ENDBLK') {
                i++;
                while (i < pairs.length && pairs[i][0] !== 0) i++;
              }
              continue;
            }
            i++;
          }
        } else if (name === 'ENTITIES') {
          var re = groupEntities(pairs, i, ['ENDSEC']);
          entities = nestEntities(re.list);
          i = re.next;
        } else {
          while (i < pairs.length && !(pairs[i][0] === 0 && pairs[i][1] === 'ENDSEC')) i++;
        }
        continue;
      }
      i++;
    }

    function layerOf(name) {
      if (!layerMap[name]) {
        var L = { name: name, color: '#000000' };
        layerMap[name] = L;
        res.layers.push(L);
      }
      return layerMap[name];
    }

    // ---- bounds
    var B = { minE: Infinity, minN: Infinity, maxE: -Infinity, maxN: -Infinity };
    function bx(p) {
      if (!isFinite(p.e) || !isFinite(p.n)) return;
      if (p.e < B.minE) B.minE = p.e;
      if (p.e > B.maxE) B.maxE = p.e;
      if (p.n < B.minN) B.minN = p.n;
      if (p.n > B.maxN) B.maxN = p.n;
    }
    function inSweep(a, a0, a1) {
      var s = ((a1 - a0) % TAU + TAU) % TAU;
      var d = ((a - a0) % TAU + TAU) % TAU;
      return d <= s + 1e-12;
    }

    function push(shape) {
      res.shapes.push(shape);
      if (shape.type === 'polyline') shape.pts.forEach(bx);
      else if (shape.type === 'circle') { bx({ e: shape.c.e - shape.r, n: shape.c.n - shape.r }); bx({ e: shape.c.e + shape.r, n: shape.c.n + shape.r }); }
      else if (shape.type === 'arc') {
        var c = shape.c, r = shape.r;
        bx({ e: c.e + r * Math.cos(shape.a0), n: c.n + r * Math.sin(shape.a0) });
        bx({ e: c.e + r * Math.cos(shape.a1), n: c.n + r * Math.sin(shape.a1) });
        for (var q = 0; q < 4; q++) {
          var a = q * Math.PI / 2;
          if (inSweep(a, shape.a0, shape.a1)) bx({ e: c.e + r * Math.cos(a), n: c.n + r * Math.sin(a) });
        }
      } else if (shape.type === 'point' || shape.type === 'text') bx(shape.p);
    }

    // ---- geometry emitters (local coords, transform m)
    function emitPolyline(m, xy, closed, sty, extra) {
      if (xy.length < 2) {
        if (xy.length === 1) push(Object.assign({ type: 'point', p: apply(m, xy[0][0], xy[0][1]) }, sty));
        return;
      }
      var s = Object.assign({ type: 'polyline', pts: xy.map(function (p) { return apply(m, p[0], p[1]); }), closed: !!closed }, sty);
      if (extra) Object.assign(s, extra);
      push(s);
    }

    function arcPoints(cx, cy, r, a0, sweep) {
      var n = Math.max(2, Math.ceil(Math.abs(sweep) / (5 * DEG)));
      var pts = [];
      for (var k = 0; k <= n; k++) {
        var a = a0 + sweep * k / n;
        pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
      }
      return pts;
    }

    // arc in local coords: CCW from a0 to a1 (radians)
    function emitArc(m, cx, cy, r, a0, a1, sty) {
      var sweep = ((a1 - a0) % TAU + TAU) % TAU;
      if (sweep < 1e-12) sweep = TAU;
      if (!isConformal(m)) {
        emitPolyline(m, arcPoints(cx, cy, r, a0, sweep), false, sty, { noVertexSnap: true });
        return;
      }
      var c = apply(m, cx, cy);
      var ps = apply(m, cx + r * Math.cos(a0), cy + r * Math.sin(a0));
      var pe = apply(m, cx + r * Math.cos(a0 + sweep), cy + r * Math.sin(a0 + sweep));
      var rr = r * Math.sqrt(Math.abs(det(m)));
      var as = Math.atan2(ps.n - c.n, ps.e - c.e);
      var ae = Math.atan2(pe.n - c.n, pe.e - c.e);
      var A0, A1;
      if (det(m) > 0) { A0 = as; A1 = ae; } else { A0 = ae; A1 = as; }
      // keep a1 > a0 numerically (CCW sweep preserved)
      A0 = ((A0 % TAU) + TAU) % TAU;
      A1 = A0 + sweep;
      if (sweep >= TAU - 1e-12) { push(Object.assign({ type: 'circle', c: c, r: rr }, sty)); return; }
      push(Object.assign({ type: 'arc', c: c, r: rr, a0: A0, a1: A1 }, sty));
    }

    function emitCircle(m, cx, cy, r, sty) {
      if (!isConformal(m)) {
        var pts = arcPoints(cx, cy, r, 0, TAU);
        pts.pop();
        emitPolyline(m, pts, true, sty, { noVertexSnap: true });
        return;
      }
      push(Object.assign({ type: 'circle', c: apply(m, cx, cy), r: r * Math.sqrt(Math.abs(det(m))) }, sty));
    }

    // vertices [{x,y,b}] → polylines / arcs
    function emitBulgePolyline(m, verts, closed, sty) {
      // drop duplicated closing vertex
      if (closed && verts.length > 2) {
        var f0 = verts[0], l0 = verts[verts.length - 1];
        if (Math.abs(f0.x - l0.x) < 1e-12 && Math.abs(f0.y - l0.y) < 1e-12) verts = verts.slice(0, -1);
      }
      var nseg = closed ? verts.length : verts.length - 1;
      var hasBulge = false;
      for (var k = 0; k < nseg; k++) if (verts[k].b && Math.abs(verts[k].b) > 1e-12) { hasBulge = true; break; }
      if (!hasBulge) {
        emitPolyline(m, verts.map(function (v) { return [v.x, v.y]; }), closed && verts.length > 2, sty);
        return;
      }
      var run = null;
      function flush() {
        if (run && run.length >= 2) emitPolyline(m, run, false, sty);
        run = null;
      }
      for (var s = 0; s < nseg; s++) {
        var p1 = verts[s], p2 = verts[(s + 1) % verts.length];
        var b = p1.b || 0;
        if (Math.abs(b) <= 1e-12) {
          if (!run) run = [[p1.x, p1.y]];
          run.push([p2.x, p2.y]);
          continue;
        }
        flush();
        var dx = p2.x - p1.x, dy = p2.y - p1.y;
        var chord = Math.hypot(dx, dy);
        if (chord < 1e-12) continue;
        var theta = 4 * Math.atan(b);
        var r = chord / (2 * Math.abs(Math.sin(theta / 2)));
        var h = (chord / 2) / Math.tan(theta / 2);
        var cx = (p1.x + p2.x) / 2 - dy / chord * h;
        var cy = (p1.y + p2.y) / 2 + dx / chord * h;
        var as = Math.atan2(p1.y - cy, p1.x - cx);
        var ae = Math.atan2(p2.y - cy, p2.x - cx);
        if (theta > 0) emitArc(m, cx, cy, r, as, ae, sty);
        else emitArc(m, cx, cy, r, ae, as, sty);
      }
      flush();
    }

    // OCS (extrusion) handling: only (0,0,±1) supported exactly
    function ocs(g, m) {
      var nz = getf(g, 230, 1);
      var nx = getf(g, 210, 0), ny = getf(g, 220, 0);
      if (nz < 0 && Math.abs(nx) < 1e-9 && Math.abs(ny) < 1e-9) return mul(m, [-1, 0, 0, 1, 0, 0]);
      if (Math.abs(nx) > 1e-6 || Math.abs(ny) > 1e-6) unsupported['3D押出方向'] = (unsupported['3D押出方向'] || 0) + 1;
      return m;
    }

    // ---- B-spline evaluation (de Boor, rational)
    function splinePoints(g) {
      var deg = geti(g, 71, 3);
      var knots = [], ctrl = [], fit = [], weights = [];
      var last = null;
      g.forEach(function (p) {
        var c = p[0], v = parseFloat(p[1]);
        if (c === 40) knots.push(v);
        else if (c === 41) weights.push(v);
        else if (c === 10) { last = [v, 0]; ctrl.push(last); }
        else if (c === 20 && last) last[1] = v;
        else if (c === 11) { last = [v, 0]; fit.push(last); }
        else if (c === 21 && last) last[1] = v;
      });
      // fix: '20' after '11' belongs to fit; handled since last points to fit
      var n = ctrl.length;
      if (n >= deg + 1 && knots.length === n + deg + 1) {
        var w = weights.length === n ? weights : ctrl.map(function () { return 1; });
        var t0 = knots[deg], t1 = knots[n];
        var samples = Math.max(16, n * 8);
        var out = [];
        for (var s = 0; s <= samples; s++) {
          var t = t0 + (t1 - t0) * s / samples;
          var k = deg;
          while (k < n - 1 && t >= knots[k + 1]) k++;
          var d = [];
          for (var j = 0; j <= deg; j++) {
            var cp = ctrl[k - deg + j], ww = w[k - deg + j];
            d.push([cp[0] * ww, cp[1] * ww, ww]);
          }
          for (var r = 1; r <= deg; r++) {
            for (var jj = deg; jj >= r; jj--) {
              var ii = k - deg + jj;
              var den = knots[ii + deg + 1 - r] - knots[ii];
              var a = den === 0 ? 0 : (t - knots[ii]) / den;
              d[jj] = [
                (1 - a) * d[jj - 1][0] + a * d[jj][0],
                (1 - a) * d[jj - 1][1] + a * d[jj][1],
                (1 - a) * d[jj - 1][2] + a * d[jj][2]
              ];
            }
          }
          var q = d[deg];
          out.push([q[0] / q[2], q[1] / q[2]]);
        }
        return out;
      }
      if (fit.length >= 2) return fit;
      if (n >= 2) return ctrl;
      return [];
    }

    // ---- entity → shapes
    function entityStyle(en, ctx) {
      var g = en.g;
      var lname = getv(g, 8, '0');
      if (lname === '0' && ctx.layer) lname = ctx.layer;
      var L = layerOf(lname);
      var color;
      var tc = getv(g, 420, undefined);
      var ci = geti(g, 62, 256);
      if (tc !== undefined) color = trueColorHex(parseInt(tc, 10));
      else if (ci === 0) color = ctx.color || L.color;          // BYBLOCK
      else if (ci === 256 || ci < 0 || ci > 256) color = L.color; // BYLAYER
      else color = aciToHex(ci);
      return { layer: lname, color: color };
    }

    function handle(en, m, ctx, depth) {
      var g = en.g;
      if (geti(g, 60, 0) === 1) return;
      if (depth === 0 && geti(g, 67, 0) === 1) { skippedPaper++; return; }
      var sty = entityStyle(en, ctx);
      var t, mm;
      switch (en.type) {
        case 'LINE':
          emitPolyline(m, [[getf(g, 10, 0), getf(g, 20, 0)], [getf(g, 11, 0), getf(g, 21, 0)]], false, sty);
          break;
        case 'LWPOLYLINE': {
          mm = ocs(g, m);
          var verts = [], cur = null;
          g.forEach(function (p) {
            if (p[0] === 10) { cur = { x: parseFloat(p[1]), y: 0, b: 0 }; verts.push(cur); }
            else if (p[0] === 20 && cur) cur.y = parseFloat(p[1]);
            else if (p[0] === 42 && cur) cur.b = parseFloat(p[1]) || 0;
          });
          emitBulgePolyline(mm, verts, (geti(g, 70, 0) & 1) === 1, sty);
          break;
        }
        case 'POLYLINE': {
          var fl = geti(g, 70, 0);
          if (fl & (16 | 64)) { unsupported['POLYLINE(メッシュ)'] = (unsupported['POLYLINE(メッシュ)'] || 0) + 1; break; }
          var is3d = (fl & 8) !== 0;
          mm = is3d ? m : ocs(g, m);
          var vs = [];
          (en.vertices || []).forEach(function (v) {
            var vf = geti(v.g, 70, 0);
            if (vf & 16) return; // spline frame control point
            if (vf & 128 && !(vf & 64)) return; // polyface face record
            vs.push({ x: getf(v.g, 10, 0), y: getf(v.g, 20, 0), b: is3d ? 0 : getf(v.g, 42, 0) });
          });
          emitBulgePolyline(mm, vs, (fl & 1) === 1, sty);
          break;
        }
        case 'CIRCLE':
          mm = ocs(g, m);
          emitCircle(mm, getf(g, 10, 0), getf(g, 20, 0), getf(g, 40, 0), sty);
          break;
        case 'ARC':
          mm = ocs(g, m);
          emitArc(mm, getf(g, 10, 0), getf(g, 20, 0), getf(g, 40, 0), getf(g, 50, 0) * DEG, getf(g, 51, 360) * DEG, sty);
          break;
        case 'POINT':
          push(Object.assign({ type: 'point', p: apply(m, getf(g, 10, 0), getf(g, 20, 0)) }, sty));
          break;
        case 'TEXT':
        case 'ATTRIB':
        case 'ATTDEF': {
          if (en.type === 'ATTDEF') break; // definitions are not drawn
          if (en.type === 'ATTRIB' && (geti(g, 70, 0) & 1)) break;
          mm = ocs(g, m);
          var h72 = geti(g, 72, 0), v73 = geti(g, en.type === 'TEXT' ? 73 : 74, 0);
          var useAlign = (h72 !== 0 || v73 !== 0) && getv(g, 11, undefined) !== undefined;
          var tx = useAlign ? getf(g, 11, 0) : getf(g, 10, 0);
          var ty = useAlign ? getf(g, 21, 0) : getf(g, 20, 0);
          emitText(mm, tx, ty, cleanText(getv(g, 1, '')), getf(g, 40, 1), getf(g, 50, 0) * DEG, sty);
          break;
        }
        case 'MTEXT': {
          var str = '';
          g.forEach(function (p) { if (p[0] === 3) str += p[1]; });
          str += getv(g, 1, '');
          var rot = getf(g, 50, 0) * DEG;
          var xd = getv(g, 11, undefined);
          // MTEXT 11/21 direction is in WCS
          if (xd !== undefined) rot = Math.atan2(getf(g, 21, 0), getf(g, 11, 1));
          emitText(xd !== undefined ? m : ocs(g, m), getf(g, 10, 0), getf(g, 20, 0), cleanMText(str), getf(g, 40, 1), rot, sty);
          break;
        }
        case 'ELLIPSE': {
          var cx = getf(g, 10, 0), cy = getf(g, 20, 0);
          var mx = getf(g, 11, 1), my = getf(g, 21, 0);
          var ratio = getf(g, 40, 1);
          var p0 = getf(g, 41, 0), p1 = getf(g, 42, TAU);
          var neg = getf(g, 230, 1) < 0;
          var nx = neg ? my : -my, ny = neg ? -mx : mx; // minor dir = N × major
          var sw = p1 - p0;
          while (sw <= 0) sw += TAU;
          if (sw > TAU) sw = TAU;
          var full = Math.abs(sw - TAU) < 1e-9;
          var nn = Math.max(16, Math.ceil(sw / (5 * DEG)));
          var pts = [];
          for (var k = 0; k <= nn; k++) {
            if (full && k === nn) break;
            t = p0 + sw * k / nn;
            pts.push([cx + mx * Math.cos(t) + ratio * nx * Math.sin(t), cy + my * Math.cos(t) + ratio * ny * Math.sin(t)]);
          }
          emitPolyline(m, pts, full, sty, { noVertexSnap: true });
          break;
        }
        case 'SPLINE': {
          var sp = splinePoints(g);
          var closedS = (geti(g, 70, 0) & 1) === 1;
          if (closedS && sp.length > 2) {
            var a = sp[0], z = sp[sp.length - 1];
            if (Math.hypot(a[0] - z[0], a[1] - z[1]) < 1e-9) sp = sp.slice(0, -1);
          }
          emitPolyline(m, sp, closedS && sp.length > 2, sty, { noVertexSnap: true });
          break;
        }
        case 'SOLID':
        case 'TRACE':
        case '3DFACE': {
          mm = en.type === '3DFACE' ? m : ocs(g, m);
          var q = [[getf(g, 10, 0), getf(g, 20, 0)], [getf(g, 11, 0), getf(g, 21, 0)], [getf(g, 12, 0), getf(g, 22, 0)], [getf(g, 13, getf(g, 12, 0)), getf(g, 23, getf(g, 22, 0))]];
          if (en.type !== '3DFACE') q = [q[0], q[1], q[3], q[2]];
          if (q[2][0] === q[3][0] && q[2][1] === q[3][1]) q.pop();
          emitPolyline(mm, q, true, sty);
          break;
        }
        case 'INSERT':
        case 'DIMENSION': {
          var bname = getv(g, 2, '');
          var blk = blocks[bname.toUpperCase()];
          if (!blk) {
            if (en.type === 'INSERT') res.warnings.push('ブロック "' + bname + '" が見つかりません');
            break;
          }
          if (depth >= 8) { res.warnings.push('ブロック "' + bname + '" のネストが深すぎます'); break; }
          var childCtx = { layer: sty.layer, color: sty.color };
          if (en.type === 'DIMENSION') {
            // dimension block geometry is already in WCS
            blk.entities.forEach(function (c) { handle(c, m, childCtx, depth + 1); });
            break;
          }
          mm = ocs(g, m);
          var ix = getf(g, 10, 0), iy = getf(g, 20, 0);
          var sx = getf(g, 41, 1), sy = getf(g, 42, 1);
          var ro = getf(g, 50, 0) * DEG;
          var cols = Math.max(1, geti(g, 70, 1)), rows = Math.max(1, geti(g, 71, 1));
          var cs = getf(g, 44, 0), rs = getf(g, 45, 0);
          if (cols * rows > 10000) { cols = 1; rows = 1; res.warnings.push('MINSERT の配列が大きすぎるため1個のみ表示します'); }
          for (var rI = 0; rI < rows; rI++) {
            for (var cI = 0; cI < cols; cI++) {
              // M = T(ins) R(rot) T(array offset) S(sx,sy) T(-base)
              var bm = mul(translate(ix, iy), mul(rotate(ro), mul(translate(cI * cs, rI * rs), mul(scaleM(sx, sy), translate(-blk.bx, -blk.by)))));
              var total = mul(mm, bm);
              blk.entities.forEach(function (c) { handle(c, total, childCtx, depth + 1); });
            }
          }
          // attributes are in the insert's (parent) coordinate system
          (en.attribs || []).forEach(function (a) { handle(a, m, ctx, depth); });
          break;
        }
        case 'HATCH':
        case 'VIEWPORT':
        case 'IMAGE':
        case 'WIPEOUT':
        case 'REGION':
        case '3DSOLID':
        case 'BODY':
        case 'LEADER':
        case 'MLEADER':
        case 'MULTILEADER':
        case 'TOLERANCE':
        case 'MLINE':
        case 'RAY':
        case 'XLINE':
        case 'OLE2FRAME':
        default:
          unsupported[en.type] = (unsupported[en.type] || 0) + 1;
      }
    }

    function emitText(m, x, y, str, h, rot, sty) {
      var p = apply(m, x, y);
      var dv = apply([m[0], m[1], m[2], m[3], 0, 0], Math.cos(rot), Math.sin(rot));
      var s = Math.sqrt(Math.abs(det(m)));
      push(Object.assign({ type: 'text', p: p, text: str, h: h * s, rot: Math.atan2(dv.n, dv.e) }, sty));
    }

    entities.forEach(function (en) { handle(en, F, { layer: null, color: null }, 0); });

    Object.keys(unsupported).forEach(function (k) {
      res.warnings.push('未対応の要素 ' + k + ' × ' + unsupported[k] + ' を無視しました');
    });
    if (skippedPaper) res.warnings.push('ペーパー空間の要素 ' + skippedPaper + ' 個を無視しました');
    if (isFinite(B.minE)) res.bounds = B;
    return res;
  }

  root.MD.DXF = {
    decode: decode,
    parse: parse,
    aciToHex: aciToHex,
    _cleanMText: cleanMText
  };
})(typeof window !== 'undefined' ? window : globalThis);
