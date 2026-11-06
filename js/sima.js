/*
 * MD.SIMA — SIMA (JSIMA 共通フォーマット) reader / point exporter.
 *
 * Supported records
 *   G00  header (title)               Z00  data section label
 *   A00 / A01 / A99   coordinates     A01,点番号,点名,X,Y,標高,   (X = northing → n, Y = easting → e)
 *   D00 / B01 / D99   画地 (parcel)    B01,点番号,点名  (references A01 points)
 *   F00 .. F99        路線 (route)     F00,路線番号,路線名,...
 *       F01..F04      route attribute / element records (vendor dependent)
 *       C00 .. C99    要素区間, C01 = 円曲線半径 R, C02 = クロソイドパラメータ A
 *
 * Route records differ between CAD vendors, so the route parser is tolerant:
 * inside an F00..F99 block every record that references an A01 point (by
 * 点番号+点名, by 点名 alone, or by an inline name+X+Y) becomes the next IP.
 * C01/C02 values found in a C00..C99 block are attached to the IP referenced
 * inside that block, or else the IP referenced just before it (or after it,
 * if the block precedes all IPs except BP). The first C02 before the C01 is
 * A1, the one after is A2.
 * Without any route block, a route is built from points named BP / IP.n / EP.
 */
(function (root) {
  'use strict';
  root.MD = root.MD || {};

  // ---------------------------------------------------------------- decode
  function toBytes(buf) {
    if (buf instanceof Uint8Array) return buf;
    if (ArrayBuffer.isView(buf)) return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    return new Uint8Array(buf);
  }

  function decode(arrayBuffer) {
    var bytes = toBytes(arrayBuffer);
    var text;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch (e) {
      text = new TextDecoder('shift_jis').decode(bytes);
    }
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    return text;
  }

  // ---------------------------------------------------------------- helpers
  function splitLine(line) {
    var f = line.split(',').map(function (s) { return s.trim(); });
    // trailing comma → drop the empty last field
    while (f.length > 1 && f[f.length - 1] === '') f.pop();
    return f;
  }

  function isNum(s) {
    return typeof s === 'string' && /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(s);
  }

  function num(s) {
    return isNum(s) ? parseFloat(s) : NaN;
  }

  function normName(s) {
    // normalise full-width ASCII + case for name matching
    return String(s || '')
      .replace(/[！-～]/g, function (c) { return String.fromCharCode(c.charCodeAt(0) - 0xfee0); })
      .replace(/　/g, ' ')
      .trim()
      .toUpperCase();
  }

  // BP / IP.n / EP style names → {kind, idx}
  var IP_RE = /^IP\s*[.\-_ ]?\s*(\d+)$/;
  function routeNameKind(name) {
    var n = normName(name);
    if (n === 'BP' || n === 'B.P' || n === 'B.P.') return { kind: 'BP', idx: -Infinity };
    if (n === 'EP' || n === 'E.P' || n === 'E.P.') return { kind: 'EP', idx: Infinity };
    var m = IP_RE.exec(n);
    if (m) return { kind: 'IP', idx: parseInt(m[1], 10) };
    return null;
  }

  // ---------------------------------------------------------------- parse
  function parse(text) {
    var out = { title: '', points: [], routes: [], parcels: [], warnings: [] };
    if (typeof text !== 'string') text = String(text || '');
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    var lines = text.split(/\r\n|\r|\n/);

    var recs = [];
    for (var li = 0; li < lines.length; li++) {
      var line = lines[li];
      if (!line.trim()) continue;
      var f = splitLine(line);
      var code = normName(f[0]);
      if (!/^[A-Z]\d\d$/.test(code)) {
        out.warnings.push('行 ' + (li + 1) + ': 不明なレコード "' + line.slice(0, 40) + '"');
        continue;
      }
      recs.push({ code: code, f: f.slice(1), line: li + 1 });
    }

    // ---- pass 1: header + points
    var byNo = {}, byName = {};
    recs.forEach(function (r) {
      if (r.code === 'G00' && !out.title) {
        // G00,版番号,現場名,...  (some writers omit the version)
        var cands = r.f.filter(function (s) { return s !== ''; });
        if (cands.length >= 2 && /^\d{1,2}$/.test(cands[0])) out.title = cands[1];
        else if (cands.length) out.title = cands[0];
      } else if (r.code === 'A01') {
        var x = num(r.f[2]), y = num(r.f[3]);
        if (!isFinite(x) || !isFinite(y)) {
          out.warnings.push('行 ' + r.line + ': A01 の座標が不正です');
          return;
        }
        var z = num(r.f[4]);
        var p = {
          no: r.f[0] || String(out.points.length + 1),
          name: r.f[1] || '',
          e: y, n: x,
          z: isFinite(z) ? z : 0
        };
        out.points.push(p);
        if (byNo[p.no] && byNo[p.no] !== p) out.warnings.push('点番号 ' + p.no + ' が重複しています');
        byNo[p.no] = p;
        if (p.name) {
          var k = normName(p.name);
          if (!byName[k]) byName[k] = p;
        }
      }
    });
    // numeric point numbers: also index without leading zeros
    out.points.forEach(function (p) {
      if (/^\d+$/.test(p.no)) {
        var k = String(parseInt(p.no, 10));
        if (!byNo[k]) byNo[k] = p;
      }
    });

    function findNo(s) {
      if (!s) return null;
      if (byNo[s]) return byNo[s];
      if (/^\d+$/.test(s)) return byNo[String(parseInt(s, 10))] || null;
      return null;
    }
    function findName(s) {
      if (!s || isNum(s)) return null;
      return byName[normName(s)] || null;
    }

    /*
     * Find a point reference in a record's fields.
     * Returns {name, e, n, pt} or null.
     */
    function findRef(f, allowNoOnly) {
      var a = f[0], b = f[1];
      // 点番号,点名
      if (b && !isNum(b)) {
        var pn = findName(b);
        if (pn) return { name: pn.name, e: pn.e, n: pn.n, pt: pn };
        var pno = findNo(a);
        if (pno && (!pno.name || normName(pno.name) === normName(b))) return { name: pno.name || b, e: pno.e, n: pno.n, pt: pno };
        // inline coordinates: 点番号?,点名,X,Y
        if (isNum(f[2]) && isNum(f[3])) return { name: b, e: num(f[3]), n: num(f[2]), pt: null, inline: true };
        if (routeNameKind(b)) return { name: b, missing: true };
      }
      // 点名 only (first field)
      if (a && !isNum(a)) {
        var pa = findName(a);
        if (pa) return { name: pa.name, e: pa.e, n: pa.n, pt: pa };
        if (isNum(f[1]) && isNum(f[2]) && routeNameKind(a)) return { name: a, e: num(f[2]), n: num(f[1]), pt: null, inline: true };
        if (routeNameKind(a)) return { name: a, missing: true };
      }
      // 点番号 only (no name field, or empty name)
      if (allowNoOnly && a && /^\d+$/.test(a) && (b === undefined || b === '')) {
        var pnum = findNo(a);
        if (pnum) return { name: pnum.name || pnum.no, e: pnum.e, n: pnum.n, pt: pnum };
      }
      // any other field that is exactly a point name (e.g. "F02,xx,IP.3")
      for (var i = 2; i < f.length; i++) {
        if (f[i] && !isNum(f[i]) && routeNameKind(f[i])) {
          var pf = findName(f[i]);
          if (pf) return { name: pf.name, e: pf.e, n: pf.n, pt: pf };
        }
      }
      return null;
    }

    function numericsExcluding(f, ref) {
      var vals = [];
      var skip = 0;
      if (ref) {
        // drop the referencing fields
        if (ref.pt && normName(f[1]) === normName(ref.pt.name)) skip = 2;
        else if (ref.pt && normName(f[0]) === normName(ref.pt.name)) skip = 1;
        else if (ref.pt && (f[1] === undefined || f[1] === '')) skip = 2;
        else if (ref.inline) skip = 4;
      }
      for (var i = skip; i < f.length; i++) if (isNum(f[i])) vals.push(num(f[i]));
      return vals;
    }

    // ---- pass 2: parcels + routes
    var curParcel = null, curRoute = null, curC = null;

    function finishRoute() {
      if (!curRoute) return;
      var r = curRoute.route;
      // attach C blocks
      curRoute.cblocks.forEach(function (cb) {
        var target = cb.ipIndex;
        if (target == null) {
          if (cb.prevIndex != null && cb.prevIndex > 0) target = cb.prevIndex;
          else if (cb.prevIndex === 0 && r.ips.length > 1) target = 1;
          else if (cb.prevIndex == null && r.ips.length > 1) target = 1;
        }
        if (target == null || !r.ips[target]) {
          r.warnings.push('行 ' + cb.line + ': 要素区間 (C00) の対象IPが特定できません');
          return;
        }
        if (cb.ipIndex == null && cb.prevIndex === 0) r.warnings.push('行 ' + cb.line + ': 要素区間がBPの直後にあるため次のIPに割り当てました');
        if (target === 0 || target === r.ips.length - 1) {
          r.warnings.push('行 ' + cb.line + ': 要素区間が始点/終点 (' + r.ips[target].name + ') に付いています (無視されます)');
        }
        var ip = r.ips[target];
        if (cb.R != null) {
          if (ip.R && ip.R !== cb.R) r.warnings.push(ip.name + ': 半径が複数あります (' + ip.R + ', ' + cb.R + ')');
          ip.R = cb.R;
        }
        if (cb.A1 != null) ip.A1 = cb.A1;
        if (cb.A2 != null) ip.A2 = cb.A2;
      });
      if (r.ips.length < 2) r.warnings.push('路線 "' + r.name + '": IPが2点未満です');
      // symmetric clothoid if only one side given? keep as is, but warn
      r.ips.forEach(function (ip, i) {
        if (i === 0 || i === r.ips.length - 1) return;
        if ((ip.A1 && !ip.A2) || (!ip.A1 && ip.A2)) r.warnings.push(ip.name + ': クロソイドが片側のみです (A1=' + ip.A1 + ', A2=' + ip.A2 + ')');
        if ((ip.A1 || ip.A2) && !ip.R) r.warnings.push(ip.name + ': クロソイドがありますが半径がありません');
      });
      out.routes.push(r);
      curRoute = null;
      curC = null;
    }

    function addIP(ref, line) {
      var r = curRoute.route;
      if (ref.missing) {
        r.warnings.push('行 ' + line + ': 点 "' + ref.name + '" が座標データにありません');
        return null;
      }
      var last = r.ips[r.ips.length - 1];
      if (last && last._pt && ref.pt && last._pt === ref.pt) return r.ips.length - 1;
      if (last && !ref.pt && last.name === ref.name && last.e === ref.e && last.n === ref.n) return r.ips.length - 1;
      var ip = { name: ref.name, e: ref.e, n: ref.n, R: 0, A1: 0, A2: 0 };
      Object.defineProperty(ip, '_pt', { value: ref.pt, enumerable: false });
      r.ips.push(ip);
      return r.ips.length - 1;
    }

    recs.forEach(function (rec) {
      var c = rec.code, f = rec.f;
      // ----- parcels
      if (c === 'D00') {
        curParcel = { no: f[0] || String(out.parcels.length + 1), name: f[1] || '', pts: [] };
        return;
      }
      if (c === 'D99') {
        if (curParcel) out.parcels.push(curParcel);
        curParcel = null;
        return;
      }
      if (c === 'B01' && curParcel && !curRoute) {
        var p = findNo(f[0]) || findName(f[1]);
        if (p && f[1] && p.name && normName(p.name) !== normName(f[1]) && findName(f[1])) p = findName(f[1]);
        if (p) curParcel.pts.push({ e: p.e, n: p.n, name: p.name });
        else out.warnings.push('行 ' + rec.line + ': 画地の点 ' + f.join(',') + ' が見つかりません');
        return;
      }
      // ----- routes
      if (c === 'F00') {
        finishRoute();
        curRoute = {
          route: { no: f[0] || String(out.routes.length + 1), name: f[1] || f[0] || ('路線' + (out.routes.length + 1)), ips: [], warnings: [] },
          cblocks: []
        };
        return;
      }
      if (!curRoute) {
        if (/^[CF]\d\d$/.test(c)) out.warnings.push('行 ' + rec.line + ': 路線ブロック外の ' + c + ' レコードを無視しました');
        return;
      }
      if (c === 'F99') { if (curC) { curRoute.cblocks.push(curC); curC = null; } finishRoute(); return; }
      if (c === 'C00') {
        if (curC) curRoute.cblocks.push(curC);
        curC = { line: rec.line, ipIndex: null, prevIndex: curRoute.route.ips.length ? curRoute.route.ips.length - 1 : null, R: null, A1: null, A2: null };
        var ref0 = findRef(f, false);
        if (ref0 && !ref0.missing) curC.ipIndex = addIP(ref0, rec.line);
        return;
      }
      if (c === 'C99') {
        if (curC) curRoute.cblocks.push(curC);
        curC = null;
        return;
      }
      if (c === 'C01' || c === 'C02') {
        var implicit = false;
        if (!curC) {
          // C01/C02 without C00: treat as its own block
          implicit = true;
          curC = { line: rec.line, ipIndex: null, prevIndex: curRoute.route.ips.length ? curRoute.route.ips.length - 1 : null, R: null, A1: null, A2: null };
        }
        var ref = findRef(f, false);
        if (ref && !ref.missing && curC.ipIndex == null) curC.ipIndex = addIP(ref, rec.line);
        var vals = numericsExcluding(f, ref && !ref.missing ? ref : null).filter(function (v) { return v > 0; });
        if (!vals.length) {
          curRoute.route.warnings.push('行 ' + rec.line + ': ' + c + ' に数値がありません');
        } else if (c === 'C01') {
          curC.R = vals[0];
        } else {
          if (vals.length >= 2) { curC.A1 = vals[0]; curC.A2 = vals[1]; }
          else if (curC.R == null && curC.A1 == null) curC.A1 = vals[0];
          else if (curC.R == null) curC.A2 = vals[0]; // two C02 before any C01
          else curC.A2 = vals[0];
        }
        if (implicit && c === 'C01') { /* keep open: following C02 belong to it */ }
        return;
      }
      if (/^C\d\d$/.test(c)) {
        // other element records (直線 etc.) may still reference a point
        var refc = findRef(f, false);
        if (refc && !refc.missing && curC && curC.ipIndex == null) curC.ipIndex = addIP(refc, rec.line);
        return;
      }
      // F01..F98, B01 or anything else inside the route block
      var refF = findRef(f, c === 'B01' || /^F0[1-4]$/.test(c));
      if (refF) {
        // a new point reference closes an implicit C block
        if (curC && curC.ipIndex != null) {
          // keep explicit blocks open until C99; implicit ones are closed here
        }
        var idx = addIP(refF, rec.line);
        if (idx != null && curC && curC.ipIndex == null && curC.R == null && curC.A1 == null) {
          // empty C block opened before its IP → belongs to this IP
          curC.ipIndex = idx;
        }
      }
    });
    if (curC && curRoute) { curRoute.cblocks.push(curC); curC = null; }
    if (curRoute) {
      curRoute.route.warnings.push('路線 "' + curRoute.route.name + '": F99 がありません');
      finishRoute();
    }
    if (curParcel) {
      out.warnings.push('画地 "' + curParcel.name + '": D99 がありません');
      out.parcels.push(curParcel);
    }

    // ---- fallback: route from BP / IP.n / EP point names
    if (!out.routes.length) {
      var named = [];
      out.points.forEach(function (p, i) {
        var k = routeNameKind(p.name);
        if (k) named.push({ p: p, k: k, i: i });
      });
      var hasBP = named.some(function (x) { return x.k.kind === 'BP'; });
      var hasEP = named.some(function (x) { return x.k.kind === 'EP'; });
      var nIP = named.filter(function (x) { return x.k.kind === 'IP'; }).length;
      if ((hasBP && hasEP) || (nIP >= 2 && (hasBP || hasEP || nIP >= 2))) {
        named.sort(function (a, b) { return (a.k.idx - b.k.idx) || (a.i - b.i); });
        // drop duplicates of the same name
        var seen = {};
        var ips = [];
        named.forEach(function (x) {
          var key = x.k.kind + ':' + x.k.idx;
          if (seen[key]) return;
          seen[key] = true;
          ips.push({ name: x.p.name, e: x.p.e, n: x.p.n, R: 0, A1: 0, A2: 0 });
        });
        var w = ['路線データ (F00) がないため点名 (BP/IP/EP) から路線を作成しました。曲線半径は不明 (0) です'];
        if (!hasBP) w.push('BP がありません');
        if (!hasEP) w.push('EP がありません');
        out.routes.push({ no: '1', name: out.title || '路線', ips: ips, warnings: w });
      }
    }
    return out;
  }

  // ---------------------------------------------------------------- export
  function fmt(v) {
    return (typeof v === 'number' && isFinite(v)) ? v.toFixed(3) : '0.000';
  }

  function exportPoints(points, title) {
    var L = [];
    L.push('G00,01,' + String(title || 'MapDetector').replace(/[,\r\n]/g, ' ') + ',');
    L.push('Z00,座標ﾃﾞｰﾀ,');
    L.push('A00,');
    (points || []).forEach(function (p, i) {
      var no = (p.no != null && p.no !== '') ? String(p.no) : String(i + 1);
      var name = String(p.name == null ? '' : p.name).replace(/[,\r\n]/g, ' ');
      L.push('A01,' + no + ',' + name + ',' + fmt(p.n) + ',' + fmt(p.e) + ',' + fmt(p.z == null ? 0 : p.z) + ',');
    });
    L.push('A99,');
    return L.join('\r\n') + '\r\n';
  }

  root.MD.SIMA = {
    decode: decode,
    parse: parse,
    exportPoints: exportPoints,
    _routeNameKind: routeNameKind
  };
})(typeof window !== 'undefined' ? window : globalThis);
