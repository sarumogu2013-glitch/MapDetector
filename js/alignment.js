// 道路線形 (IP 法): 直線 + 円曲線 + クロソイド緩和曲線 (非対称 A1/A2 可)
// 測点・横断線 (魚の骨)・中心線サンプリング・オフセット線
(function (root) {
  root.MD = root.MD || {};

  var EPS = 1e-9;

  // 10 点 Gauss–Legendre
  var GL_X = [-0.9739065285171717, -0.8650633666889845, -0.6794095682990244, -0.4333953941292472,
    -0.1488743389816312, 0.1488743389816312, 0.4333953941292472, 0.6794095682990244,
    0.8650633666889845, 0.9739065285171717];
  var GL_W = [0.0666713443086881, 0.1494513491505806, 0.2190863625159820, 0.2692667193099963,
    0.2955242247147529, 0.2955242247147529, 0.2692667193099963, 0.2190863625159820,
    0.1494513491505806, 0.0666713443086881];

  function headingAt(el, t) {
    if (el.len <= 0) return el.h0;
    return el.h0 + el.k0 * t + (el.k1 - el.k0) * t * t / (2 * el.len);
  }

  // 要素始点から距離 t の点 {e, n, h}
  function evalElement(el, t) {
    if (t < 0) t = 0;
    if (t > el.len) t = el.len;
    var h0 = el.h0, p0 = el.p0;
    if (el.type === 'line' || (Math.abs(el.k0) < 1e-15 && Math.abs(el.k1) < 1e-15)) {
      return { e: p0.e + t * Math.cos(h0), n: p0.n + t * Math.sin(h0), h: h0 };
    }
    if (el.type === 'arc' || Math.abs(el.k1 - el.k0) < 1e-15) {
      var k = el.k0, h = h0 + k * t;
      return { e: p0.e + (Math.sin(h) - Math.sin(h0)) / k, n: p0.n - (Math.cos(h) - Math.cos(h0)) / k, h: h };
    }
    // クロソイド: 曲率が線形 → 方向角は 2 次。分割 Gauss–Legendre で積分
    var hEnd = headingAt(el, t);
    var dk = Math.max(Math.abs(el.k0), Math.abs(el.k0 + (el.k1 - el.k0) * t / el.len));
    var panels = Math.max(1, Math.ceil(dk * t / 0.2));
    var w = t / panels, se = 0, sn = 0;
    for (var p = 0; p < panels; p++) {
      var a = p * w, half = w / 2, mid = a + half;
      for (var i = 0; i < 10; i++) {
        var u = mid + half * GL_X[i];
        var hh = headingAt(el, u);
        se += GL_W[i] * half * Math.cos(hh);
        sn += GL_W[i] * half * Math.sin(hh);
      }
    }
    return { e: p0.e + se, n: p0.n + sn, h: hEnd };
  }

  function sub(a, b) { return { e: a.e - b.e, n: a.n - b.n }; }
  function cross(a, b) { return a.e * b.n - a.n * b.e; }
  function dot(a, b) { return a.e * b.e + a.n * b.n; }
  function norm(a) { return Math.hypot(a.e, a.n); }
  function unit(a) { var l = norm(a); return { e: a.e / l, n: a.n / l }; }

  // 1 つの IP の曲線を、始点 (0,0)・入射方向角 thIn で構成
  // 戻り値: {els:[...], end:{e,n}}  (要素は p0 が原点相対)
  function buildCurveLocal(thIn, sign, R, L1, L2, arcAng) {
    var els = [], p = { e: 0, n: 0 }, h = thIn, k = sign / R;
    function push(type, len, k0, k1) {
      if (len <= EPS) return;
      var el = { type: type, len: len, p0: p, h0: h, k0: k0, k1: k1 };
      els.push(el);
      var q = evalElement(el, len);
      p = { e: q.e, n: q.n }; h = q.h;
    }
    push('clothoid', L1, 0, k);
    push('arc', R * arcAng, k, k);
    push('clothoid', L2, k, 0);
    return { els: els, end: p };
  }

  // 曲線諸元 (R, A1, A2, 縮尺 f) から接線長などを計算
  function designCurve(c, warnings, label) {
    var R = c.R * c.scale, A1 = c.A1 * c.scale, A2 = c.A2 * c.scale;
    var L1 = A1 * A1 / R, L2 = A2 * A2 / R;
    var absI = Math.abs(c.I);
    var arcAng = absI - L1 / (2 * R) - L2 / (2 * R);
    if (arcAng < 0) {
      if (!c.warnedFit) {
        warnings.push(label + ': クロソイドが入りません (円弧角 < 0) — 緩和曲線を省略して単円で計算します');
        c.warnedFit = true;
      }
      c.A1 = 0; c.A2 = 0; A1 = 0; A2 = 0; L1 = 0; L2 = 0; arcAng = absI;
    }
    var loc = buildCurveLocal(c.thIn, c.sign, R, L1, L2, arcAng);
    var E = loc.end;
    var cr = cross(c.dIn, c.dOut);
    c.T1 = cross(E, c.dOut) / cr;
    c.T2 = cross(c.dIn, E) / cr;
    c.loc = loc; c.Ruse = R; c.L1 = L1; c.L2 = L2; c.arcAng = arcAng;
    c.A1use = A1; c.A2use = A2;
  }

  function build(ips, opts) {
    opts = opts || {};
    var warnings = [];
    var elements = [], keyPoints = [];
    ips = (ips || []).filter(function (p) { return p && isFinite(p.e) && isFinite(p.n); });
    // 重複点除去
    var pts = [];
    for (var i = 0; i < ips.length; i++) {
      if (pts.length && norm(sub(ips[i], pts[pts.length - 1].p)) < 1e-6) {
        warnings.push('IP' + i + ': 前の点と同一座標のため無視しました');
        continue;
      }
      pts.push({ p: ips[i], idx: i });
    }
    if (pts.length < 2) {
      if (ips.length) warnings.push('IP が 2 点未満です');
      return { elements: [], length: 0, keyPoints: pts.length ? [{ s: 0, name: 'BP', ipIndex: 0 }] : [], warnings: warnings };
    }
    var N = pts.length;
    var segLen = [], segDir = [];
    for (i = 0; i < N - 1; i++) {
      var d = sub(pts[i + 1].p, pts[i].p);
      segLen.push(norm(d)); segDir.push(unit(d));
    }

    // 各中間 IP の曲線
    var curves = [];
    for (i = 1; i < N - 1; i++) {
      var ip = pts[i].p;
      var dIn = segDir[i - 1], dOut = segDir[i];
      var I = Math.atan2(cross(dIn, dOut), dot(dIn, dOut));
      var R = Math.abs(Number(ip.R) || 0);
      var c = {
        i: pts[i].idx, ip: ip, dIn: dIn, dOut: dOut, I: I, sign: I >= 0 ? 1 : -1,
        thIn: Math.atan2(dIn.n, dIn.e), name: ip.name,
        R: R, A1: Math.abs(Number(ip.A1) || 0), A2: Math.abs(Number(ip.A2) || 0), scale: 1,
        T1: 0, T2: 0, isCurve: false
      };
      if (R > 0 && Math.abs(I) > 1e-10) {
        if (Math.abs(I) > Math.PI - 1e-6) {
          warnings.push('IP' + c.i + ': 交角が 180° に近いため曲線を設置できません');
        } else {
          c.isCurve = true;
          designCurve(c, warnings, 'IP' + c.i);
        }
      }
      curves[i] = c;
    }

    // 曲線の重なりチェック → 該当曲線を相似縮小 (R, A を同率で縮小すると接線長も同率で縮小)
    for (var iter = 0; iter < 50; iter++) {
      var changed = false;
      for (i = 0; i < N - 1; i++) {
        var cA = curves[i], cB = curves[i + 1];
        var tA = cA && cA.isCurve ? cA.T2 : 0;
        var tB = cB && cB.isCurve ? cB.T1 : 0;
        if (tA + tB > segLen[i] * (1 + 1e-12) + 1e-9) {
          var f = segLen[i] / (tA + tB) * (1 - 1e-12);
          [cA, cB].forEach(function (cc) {
            if (cc && cc.isCurve && (cc === cA ? tA : tB) > 0) {
              if (!cc.warnedOverlap) {
                warnings.push('IP' + cc.i + ': 接線長が IP 間距離を超えます (前後の曲線と重複) — R/A を縮小して計算します');
                cc.warnedOverlap = true;
              }
              cc.scale *= f;
              designCurve(cc, warnings, 'IP' + cc.i);
            }
          });
          changed = true;
        }
      }
      if (!changed) break;
    }
    curves.forEach(function (cc) {
      if (cc && cc.isCurve && cc.scale < 1 - 1e-9) {
        warnings.push('IP' + cc.i + ': 縮小後 R=' + cc.Ruse.toFixed(3) +
          (cc.A1use ? ' A1=' + cc.A1use.toFixed(3) : '') + (cc.A2use ? ' A2=' + cc.A2use.toFixed(3) : ''));
      }
    });

    // 要素列の組み立て
    var s = 0, cur = { e: pts[0].p.e, n: pts[0].p.n };
    keyPoints.push({ s: 0, name: 'BP', ipIndex: 0 });
    function addLine(to, h) {
      var len = norm(sub(to, cur));
      if (len > EPS) {
        elements.push({ type: 'line', s0: s, len: len, p0: cur, h0: h, k0: 0, k1: 0 });
        s += len;
      }
      cur = { e: to.e, n: to.n };
    }
    for (i = 1; i < N - 1; i++) {
      c = curves[i];
      ip = c.ip;
      if (!c.isCurve) {
        addLine(ip, Math.atan2(segDir[i - 1].n, segDir[i - 1].e));
        if (Math.abs(c.I) > 1e-10) keyPoints.push({ s: s, name: 'IP', ipIndex: c.i });
        continue;
      }
      var start = { e: ip.e - c.T1 * c.dIn.e, n: ip.n - c.T1 * c.dIn.n };
      addLine(start, c.thIn);
      var sCurve0 = s;
      var ki = c.i;
      if (c.L1 > EPS) keyPoints.push({ s: s, name: 'KA1', ipIndex: ki });
      var arcS0 = null, arcS1 = null;
      for (var j = 0; j < c.loc.els.length; j++) {
        var le = c.loc.els[j];
        var el = {
          type: le.type, s0: s, len: le.len,
          p0: { e: start.e + le.p0.e, n: start.n + le.p0.n },
          h0: le.h0, k0: le.k0, k1: le.k1, ipIndex: ki
        };
        if (el.type === 'arc') { arcS0 = s; arcS1 = s + el.len; }
        elements.push(el);
        s += el.len;
      }
      var sCurve1 = s;
      if (arcS0 === null) { arcS0 = arcS1 = sCurve0 + c.L1; }
      keyPoints.push({ s: arcS0, name: c.L1 > EPS ? 'KE1' : 'BC', ipIndex: ki });
      keyPoints.push({ s: (arcS1 > arcS0 + EPS) ? (arcS0 + arcS1) / 2 : (sCurve0 + sCurve1) / 2, name: 'SP', ipIndex: ki });
      keyPoints.push({ s: arcS1, name: c.L2 > EPS ? 'KE2' : 'EC', ipIndex: ki });
      if (c.L2 > EPS) keyPoints.push({ s: sCurve1, name: 'KA2', ipIndex: ki });
      // 曲線終点は出口接線上の理論位置にスナップ (数値誤差の蓄積防止)
      cur = { e: ip.e + c.T2 * c.dOut.e, n: ip.n + c.T2 * c.dOut.n };
    }
    addLine(pts[N - 1].p, Math.atan2(segDir[N - 2].n, segDir[N - 2].e));
    keyPoints.push({ s: s, name: 'EP', ipIndex: pts[N - 1].idx });
    keyPoints.sort(function (a, b) { return a.s - b.s; });

    return {
      elements: elements, length: s, keyPoints: keyPoints, warnings: warnings,
      curves: curves.filter(Boolean).map(function (cc) {
        return {
          ipIndex: cc.i, name: cc.name, I: cc.I, isCurve: cc.isCurve,
          R: cc.isCurve ? cc.Ruse : 0, A1: cc.isCurve ? cc.A1use : 0, A2: cc.isCurve ? cc.A2use : 0,
          L1: cc.isCurve ? cc.L1 : 0, L2: cc.isCurve ? cc.L2 : 0, T1: cc.T1, T2: cc.T2
        };
      })
    };
  }

  function findElement(al, s) {
    var els = al.elements, lo = 0, hi = els.length - 1;
    while (lo < hi) {
      var mid = (lo + hi + 1) >> 1;
      if (els[mid].s0 <= s) lo = mid; else hi = mid - 1;
    }
    return els[lo];
  }

  function pointAt(al, s) {
    if (!al || !al.elements || !al.elements.length) return null;
    if (!(s >= 0)) s = 0;
    if (s > al.length) s = al.length;
    var el = findElement(al, s);
    return evalElement(el, s - el.s0);
  }

  function chainageLabel(ch, pitch) {
    var r = Math.round(ch * 100) / 100;
    var k = Math.floor((r + 1e-7) / pitch);
    var rem = Math.round((r - k * pitch) * 100) / 100;
    if (rem >= pitch - 1e-9) { k += 1; rem = 0; }
    if (rem < 0.005) return 'No.' + k;
    return 'No.' + k + '+' + rem.toFixed(2);
  }

  function stations(al, o) {
    o = o || {};
    var pitch = o.pitch > 0 ? Number(o.pitch) : 20;
    var subP = o.sub > 0 ? Number(o.sub) : 0;
    var c0 = Number(o.startChainage) || 0;
    var incKey = o.includeKeyPoints !== false;
    var endInc = o.endInclude !== false;
    var L = al.length, out = [];
    var tol = 1e-6;
    // 主測点
    var k0 = Math.ceil((c0 - tol) / pitch);
    for (var k = k0; ; k++) {
      var s = k * pitch - c0;
      if (s > L + tol) break;
      if (s < -tol) continue;
      if (s > L) s = L;
      if (s < 0) s = 0;
      if (!endInc && s > L - tol) break;
      out.push({ s: s, chainage: c0 + s, label: 'No.' + k, kind: 'main' });
    }
    // プラス杭
    if (subP > 0 && subP < pitch) {
      var j0 = Math.ceil((c0 - tol) / subP);
      for (var jj = j0; ; jj++) {
        var ch = jj * subP, ss = ch - c0;
        if (ss > L + tol) break;
        if (ss < -tol) continue;
        var q = ch / pitch;
        if (Math.abs(q - Math.round(q)) * pitch < tol) continue; // 主測点と重複
        if (!endInc && ss > L - tol) break;
        ss = Math.min(Math.max(ss, 0), L);
        out.push({ s: ss, chainage: c0 + ss, label: chainageLabel(c0 + ss, pitch), kind: 'sub' });
      }
    }
    // 主要点
    (al.keyPoints || []).forEach(function (kp) {
      var isEnd = kp.name === 'EP';
      if (isEnd && !endInc) return;
      if (!incKey && !isEnd) return;
      var nm = (kp.name === 'BP' || kp.name === 'EP') ? kp.name
        : kp.name + (/\d$/.test(kp.name) ? '-' : '') + kp.ipIndex;   // BC1, KA1-1 (KA1 of IP1)
      out.push({ s: kp.s, chainage: c0 + kp.s, label: nm + ' ' + chainageLabel(c0 + kp.s, pitch), kind: 'key', keyName: kp.name, ipIndex: kp.ipIndex });
    });
    var order = { main: 0, sub: 1, key: 2 };
    out.sort(function (a, b) { return (a.s - b.s) || (order[a.kind] - order[b.kind]); });
    return out;
  }

  function fishbone(al, sts, o) {
    o = o || {};
    var left = o.left != null ? Number(o.left) : 10;
    var right = o.right != null ? Number(o.right) : 10;
    return (sts || []).map(function (st) {
      var p = pointAt(al, st.s);
      var nx = -Math.sin(p.h), ny = Math.cos(p.h);
      return {
        station: st,
        c: { e: p.e, n: p.n },
        l: { e: p.e + nx * left, n: p.n + ny * left },
        r: { e: p.e - nx * right, n: p.n - ny * right },
        h: p.h
      };
    });
  }

  // 中心線サンプル (方向角付き)。要素境界を含む。同一点・同方向の重複は除去
  function sampleH(al, step) {
    step = step > 0 ? step : 1;
    var out = [];
    (al.elements || []).forEach(function (el) {
      var nseg = el.type === 'line' ? 1 : Math.max(1, Math.ceil(el.len / step));
      for (var i = 0; i <= nseg; i++) {
        var q = evalElement(el, el.len * i / nseg);
        var last = out[out.length - 1];
        if (i === 0 && last && Math.hypot(last.e - q.e, last.n - q.n) < 1e-6) {
          var dh = Math.abs(Math.atan2(Math.sin(q.h - last.h), Math.cos(q.h - last.h)));
          if (dh < 1e-9) continue;
        }
        out.push(q);
      }
    });
    return out;
  }

  function sample(al, step) {
    var out = [];
    sampleH(al, step).forEach(function (p) {
      var last = out[out.length - 1];
      if (last && Math.hypot(last.e - p.e, last.n - p.n) < 1e-6) return;
      out.push({ e: p.e, n: p.n });
    });
    return out;
  }
  function offset(al, d, step) {
    d = Number(d) || 0;
    return sampleH(al, step).map(function (p) {
      return { e: p.e - Math.sin(p.h) * d, n: p.n + Math.cos(p.h) * d };
    });
  }

  root.MD.Alignment = {
    build: build,
    pointAt: pointAt,
    stations: stations,
    fishbone: fishbone,
    sample: sample,
    offset: offset,
    evalElement: evalElement,
    chainageLabel: chainageLabel
  };
})(typeof window !== 'undefined' ? window : globalThis);
