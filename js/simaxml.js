// SIMA (JPGIS版) XML 読み込み — jsima102.xsd (JSIMA 2012) 準拠
//   GenbaJoho/CoordinateSystem → 平面直角座標系の系番号
//   Sokuten (Number, Name, Altitude, RefPoint→GM_Point)        → points
//   Kakuchi (Number, Name, RefSurface→GM_Surface)              → parcels (閉じた多角形)
//   KaihouKakuchi (Number, Name, RefCurve→GM_Curve)            → lines (開放型画地)
//   Kijyunten / Suijyunten (RefSokuten→Sokuten)                → points (種別付き)
// 座標は DirectPosition.coordinate "X Y [Z]" (X=北 → n, Y=東 → e)。
// XML 版には路線(線形)要素がないため、点名 BP/IP/EP から線形を組み立てる (MD.SIMA の規則を流用)。
(function (root) {
  root.MD = root.MD || {};

  // ---- 最小 XML パーサ (要素/属性/テキストのみ。DOM 不要で Node テストでも動く) ----
  function decodeEnt(s) {
    return s.replace(/&(#x[0-9a-f]+|#\d+|lt|gt|amp|quot|apos);/gi, function (m, g) {
      if (g[0] === '#') return String.fromCodePoint(g[1] === 'x' || g[1] === 'X' ? parseInt(g.slice(2), 16) : parseInt(g.slice(1), 10));
      return { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" }[g.toLowerCase()];
    });
  }
  function local(n) { var i = n.indexOf(':'); return i >= 0 ? n.slice(i + 1) : n; }
  function parseXml(text) {
    var rootNode = { name: '#root', attrs: {}, children: [], text: '' }, stack = [rootNode], i = 0, n = text.length;
    while (i < n) {
      var lt = text.indexOf('<', i);
      if (lt < 0) lt = n;
      if (lt > i) stack[stack.length - 1].text += decodeEnt(text.slice(i, lt));
      if (lt >= n) break;
      if (text.startsWith('<!--', lt)) { i = text.indexOf('-->', lt); i = i < 0 ? n : i + 3; continue; }
      if (text.startsWith('<![CDATA[', lt)) { var ce = text.indexOf(']]>', lt); stack[stack.length - 1].text += text.slice(lt + 9, ce < 0 ? n : ce); i = ce < 0 ? n : ce + 3; continue; }
      if (text[lt + 1] === '?' || text[lt + 1] === '!') { i = text.indexOf('>', lt); i = i < 0 ? n : i + 1; continue; }
      var gt = lt, q = null;
      while (++gt < n) { var c = text[gt]; if (q) { if (c === q) q = null; } else if (c === '"' || c === "'") q = c; else if (c === '>') break; }
      var tag = text.slice(lt + 1, gt); i = gt + 1;
      if (tag[0] === '/') { if (stack.length > 1) stack.pop(); continue; }
      var self = /\/\s*$/.test(tag); if (self) tag = tag.replace(/\/\s*$/, '');
      var m = /^([^\s]+)/.exec(tag), node = { name: local(m[1]), attrs: {}, children: [], text: '' };
      var re = /([^\s=]+)\s*=\s*("([^"]*)"|'([^']*)')/g, a;
      while ((a = re.exec(tag))) node.attrs[local(a[1])] = decodeEnt(a[3] != null ? a[3] : a[4]);
      stack[stack.length - 1].children.push(node);
      if (!self) stack.push(node);
    }
    return rootNode;
  }
  function walk(node, fn) { fn(node); node.children.forEach(function (c) { walk(c, fn); }); }
  function child(node, name) { for (var i = 0; i < node.children.length; i++) if (node.children[i].name === name) return node.children[i]; return null; }
  function childText(node, name) { var c = child(node, name); return c ? c.text.trim() : ''; }

  function parse(text) {
    var doc = parseXml(text), ids = {}, warnings = [];
    walk(doc, function (nd) { if (nd.attrs.id) ids[nd.attrs.id] = nd; });
    function deref(nd) { var seen = 0; while (nd && nd.attrs.idref && ids[nd.attrs.idref] && seen++ < 10) nd = ids[nd.attrs.idref]; return nd; }
    function coord(t) {
      var v = t.trim().split(/[\s,]+/).map(Number);
      return v.length >= 2 && isFinite(v[0]) && isFinite(v[1]) ? { n: v[0], e: v[1], z: v.length > 2 && isFinite(v[2]) ? v[2] : 0 } : null;
    }
    function pointOf(nd) {   // GM_Point (参照/インライン) → 座標
      nd = deref(nd); var out = null;
      if (!nd) return null;
      walk(nd, function (x) {
        if (out) return;
        if (x.name === 'DirectPosition.coordinate' || x.name === 'coordinate' || x.name === 'pos') out = coord(x.text);
        else if (x !== nd && x.attrs.idref && ids[x.attrs.idref]) out = pointOf(ids[x.attrs.idref]);
      });
      return out;
    }
    // 曲線/面 → 座標列 (曲線参照を展開し、向きが逆なら反転して連結)
    function pathOf(nd, depth) {
      nd = deref(nd); var pts = [];
      if (!nd || depth > 8) return pts;
      function push(p) { var l = pts[pts.length - 1]; if (p && !(l && Math.abs(l.e - p.e) < 1e-6 && Math.abs(l.n - p.n) < 1e-6)) pts.push(p); }
      function rec(x) {
        if (x.name === 'DirectPosition.coordinate' || x.name === 'coordinate' || x.name === 'pos') { push(coord(x.text)); return; }
        if (x.attrs.idref && ids[x.attrs.idref]) {
          var t = ids[x.attrs.idref];
          if (/Point$/.test(t.name) || t.name === 'Sokuten') { push(pointOf(t)); return; }
          var sub = pathOf(t, depth + 1);
          if (sub.length && pts.length) {
            var l = pts[pts.length - 1], a = sub[0], b = sub[sub.length - 1];
            var da = Math.hypot(a.e - l.e, a.n - l.n), db = Math.hypot(b.e - l.e, b.n - l.n);
            if (db < da || (x.attrs.orientation === '-' && db <= da)) sub.reverse();
          }
          sub.forEach(push); return;
        }
        x.children.forEach(rec);
      }
      nd.children.forEach(rec);
      return pts;
    }
    var out = { format: 'sima-jpgis', title: '', zone: null, points: [], parcels: [], lines: [], routes: [], warnings: warnings };
    var genba = null;
    walk(doc, function (nd) { if (!genba && nd.name === 'GenbaJoho') genba = nd; });
    if (genba) {
      out.title = childText(genba, 'Name');
      var z = parseInt(childText(genba, 'CoordinateSystem'), 10); if (z >= 1 && z <= 19) out.zone = z;
    }
    var seenSokuten = new Set();
    function addSokuten(nd, kind) {
      nd = deref(nd); if (!nd || seenSokuten.has(nd)) return; seenSokuten.add(nd);
      var ref = child(nd, 'RefPoint'), p = ref ? pointOf(ref) : null;
      var no = childText(nd, 'Number'), name = childText(nd, 'Name');
      if (!p) { warnings.push('測点 ' + (name || no) + ' の座標がありません'); return; }
      var alt = parseFloat(childText(nd, 'Altitude'));
      out.points.push({ no: no, name: name || no, e: p.e, n: p.n, z: isFinite(alt) ? alt : p.z, kind: kind || '' });
    }
    walk(doc, function (nd) {
      if (nd.name === 'Kijyunten' || nd.name === 'Suijyunten') {
        var rs = child(nd, 'RefSokuten');
        if (rs) { var s = rs.attrs.idref ? ids[rs.attrs.idref] : child(rs, 'Sokuten'); if (s) addSokuten(s, nd.name === 'Kijyunten' ? '基準点' : '水準点'); }
      }
    });
    walk(doc, function (nd) { if (nd.name === 'Sokuten' && child(nd, 'RefPoint')) addSokuten(nd, ''); });
    walk(doc, function (nd) {
      if (nd.name === 'Kakuchi' && child(nd, 'RefSurface')) {
        var pts = pathOf(child(nd, 'RefSurface'), 0);
        if (pts.length > 1) { var a = pts[0], b = pts[pts.length - 1]; if (Math.hypot(a.e - b.e, a.n - b.n) < 1e-6) pts.pop(); }
        if (pts.length >= 3) out.parcels.push({ no: childText(nd, 'Number'), name: childText(nd, 'Name'), pts: pts });
        else warnings.push('画地 ' + childText(nd, 'Name') + ' の形状を取得できません');
      } else if (nd.name === 'KaihouKakuchi' && child(nd, 'RefCurve')) {
        var lp = pathOf(child(nd, 'RefCurve'), 0);
        if (lp.length >= 2) out.lines.push({ no: childText(nd, 'Number'), name: childText(nd, 'Name'), pts: lp });
        else warnings.push('開放型画地 ' + childText(nd, 'Name') + ' の形状を取得できません');
      }
    });
    // 線形: 点名 BP/IP/EP から (CSV SIMA の規則を流用)
    if (root.MD.SIMA && out.points.length) {
      var csv = out.points.map(function (p, i) { return ['A01', p.no || (i + 1), String(p.name).replace(/,/g, ' '), p.n, p.e, p.z || 0, ''].join(','); });
      var r = root.MD.SIMA.parse(['G00,01,' + out.title + ','].concat(['A00,'], csv, ['A99,']).join('\r\n'));
      out.routes = r.routes || [];
    }
    if (!out.points.length && !out.parcels.length && !out.lines.length) warnings.push('SIMA(JPGIS) の測点・画地が見つかりません');
    return out;
  }

  function isSimaXml(text) { return /^\s*(﻿)?<\?xml/.test(text) && /<([\w-]+:)?(GI|Sokuten|Kakuchi)\b/.test(text); }

  root.MD.SIMAXML = { parse: parse, isSimaXml: isSimaXml, _parseXml: parseXml };
})(typeof window !== 'undefined' ? window : globalThis);
