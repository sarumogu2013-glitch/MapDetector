// MD.Snap — CAD-like object snapping over vector shapes (plane coords {e,n}, metres).
// Uniform-grid spatial index per group; primitives: polyline segments (incl. closing
// segment), arcs, circles, points, plus circle/arc centers.
(function (root) {
  'use strict';
  root.MD = root.MD || {};

  var TAU = Math.PI * 2;
  var EPS = 1e-9;

  // ---------------------------------------------------------------- geometry
  function mod(a, m) { a = a % m; return a < 0 ? a + m : a; }

  // Sweep of a CCW arc a0→a1 in (0, 2π]; a0 == a1 (mod 2π) is treated as a full circle.
  function arcSweep(a0, a1) {
    var s = mod(a1 - a0, TAU);
    return s < 1e-12 ? TAU : s;
  }

  function angleInArc(a, a0, a1, eps) {
    if (eps === undefined) eps = 1e-9;
    var sw = arcSweep(a0, a1);
    if (sw >= TAU) return true;
    var d = mod(a - a0, TAU);
    return d <= sw + eps || d >= TAU - eps;
  }

  function nearestOnSeg(p, a, b) {
    var de = b.e - a.e, dn = b.n - a.n;
    var L2 = de * de + dn * dn;
    var t = L2 > 0 ? ((p.e - a.e) * de + (p.n - a.n) * dn) / L2 : 0;
    if (t < 0) t = 0; else if (t > 1) t = 1;
    var q = { e: a.e + de * t, n: a.n + dn * t };
    return { p: q, t: t, d: Math.hypot(p.e - q.e, p.n - q.n) };
  }

  // Nearest point on an arc (CCW a0→a1). Omit a0/a1 (or pass null) for a full circle.
  function nearestOnArc(p, c, r, a0, a1) {
    var full = a0 == null || a1 == null || arcSweep(a0, a1) >= TAU;
    var de = p.e - c.e, dn = p.n - c.n;
    var dc = Math.hypot(de, dn);
    var ang = dc > 0 ? Math.atan2(dn, de) : (full ? 0 : a0 + arcSweep(a0, a1) / 2);
    if (full || angleInArc(ang, a0, a1, 0)) {
      var q = { e: c.e + r * Math.cos(ang), n: c.n + r * Math.sin(ang) };
      return { p: q, a: ang, d: Math.abs(dc - r) };
    }
    var p0 = { e: c.e + r * Math.cos(a0), n: c.n + r * Math.sin(a0) };
    var p1 = { e: c.e + r * Math.cos(a1), n: c.n + r * Math.sin(a1) };
    var d0 = Math.hypot(p.e - p0.e, p.n - p0.n), d1 = Math.hypot(p.e - p1.e, p.n - p1.n);
    return d0 <= d1 ? { p: p0, a: a0, d: d0 } : { p: p1, a: a1, d: d1 };
  }

  // Proper/touching intersection of segments ab and cd → {e,n} or null (parallel → null).
  function segSeg(a, b, c, d) {
    var r_e = b.e - a.e, r_n = b.n - a.n, s_e = d.e - c.e, s_n = d.n - c.n;
    var den = r_e * s_n - r_n * s_e;
    var scale = Math.hypot(r_e, r_n) * Math.hypot(s_e, s_n);
    if (scale === 0 || Math.abs(den) <= 1e-12 * scale) return null;
    var qe = c.e - a.e, qn = c.n - a.n;
    var t = (qe * s_n - qn * s_e) / den;
    var u = (qe * r_n - qn * r_e) / den;
    var et = 1e-9;
    if (t < -et || t > 1 + et || u < -et || u > 1 + et) return null;
    return { e: a.e + r_e * t, n: a.n + r_n * t };
  }

  // Intersections of segment ab with circle (c, r) → [{e,n}] (0..2 points, on the segment).
  function segCircle(a, b, c, r) {
    var de = b.e - a.e, dn = b.n - a.n;
    var fe = a.e - c.e, fn = a.n - c.n;
    var A = de * de + dn * dn;
    if (A === 0) return [];
    var B = 2 * (fe * de + fn * dn);
    var C = fe * fe + fn * fn - r * r;
    var disc = B * B - 4 * A * C;
    var out = [];
    if (disc < 0) {
      // tangent within rounding: accept if the closest approach is on the circle
      var tt = -B / (2 * A);
      if (disc > -1e-9 * B * B && tt >= 0 && tt <= 1) out.push({ e: a.e + de * tt, n: a.n + dn * tt });
      return out;
    }
    var sq = Math.sqrt(disc);
    var ts = sq === 0 ? [-B / (2 * A)] : [(-B - sq) / (2 * A), (-B + sq) / (2 * A)];
    for (var i = 0; i < ts.length; i++) {
      var t = ts[i];
      if (t >= -1e-9 && t <= 1 + 1e-9) out.push({ e: a.e + de * t, n: a.n + dn * t });
    }
    return out;
  }

  // Intersections of two circles → [{e,n}] (0..2 points; coincident circles → []).
  function circleCircle(c1, r1, c2, r2) {
    var de = c2.e - c1.e, dn = c2.n - c1.n;
    var d = Math.hypot(de, dn);
    if (d === 0) return [];
    var tolr = 1e-9 * Math.max(r1, r2, d);
    if (d > r1 + r2 + tolr || d < Math.abs(r1 - r2) - tolr) return [];
    var a = (r1 * r1 - r2 * r2 + d * d) / (2 * d);
    var h2 = r1 * r1 - a * a;
    var h = h2 > 0 ? Math.sqrt(h2) : 0;
    var me = c1.e + a * de / d, mn = c1.n + a * dn / d;
    if (h === 0) return [{ e: me, n: mn }];
    var oe = -dn * h / d, on = de * h / d;
    return [{ e: me + oe, n: mn + on }, { e: me - oe, n: mn - on }];
  }

  var geom = {
    TAU: TAU,
    mod: mod,
    arcSweep: arcSweep,
    angleInArc: angleInArc,
    nearestOnSeg: nearestOnSeg,
    nearestOnArc: nearestOnArc,
    segSeg: segSeg,
    segCircle: segCircle,
    circleCircle: circleCircle
  };

  // ---------------------------------------------------------------- index
  // primitive types
  var F_START = 1, F_END = 2, F_MID = 4;
  var SEG = 0, ARC = 1, CIRC = 2, PT = 3, CEN = 4, VTX = 5;
  var STRIDE = 5;           // floats per primitive
  var BIG_CELLS = 4096;     // primitives covering more cells go to an always-checked list
  var OFF = 1 << 20;        // cell index offset (keys stay positive)
  var ROW = 1 << 21;

  function Group(id, shapes, cellSize) {
    this.id = id;
    this.enabled = true;
    this.shapes = shapes;
    this.cs = cellSize;
    var typ = [], f = [], sh = [], si = [], fl = [];
    var flag = 7;
    function add(t, a, b, c, d, e, shapeIdx, segIdx) {
      typ.push(t); f.push(a, b, c, d, e); sh.push(shapeIdx); si.push(segIdx); fl.push(flag);
      return typ.length - 1;
    }
    for (var k = 0; k < shapes.length; k++) {
      var s = shapes[k];
      if (!s) continue;
      if (s.type === 'polyline' && s.pts && s.pts.length) {
        var pts = s.pts, n = pts.length;
        if (n === 1) { add(VTX, pts[0].e, pts[0].n, 0, 0, 0, k, 0); continue; }
        var nseg = s.closed && n > 2 ? n : n - 1;
        var nvs = !!s.noVertexSnap;
        for (var i = 0; i < nseg; i++) {
          var a = pts[i], b = pts[(i + 1) % n];
          // flags: bit0 start vertex is 'end', bit1 end vertex is 'end', bit2 'mid' allowed.
          // noVertexSnap (tessellated curves): only first/last vertex are 'end', no 'mid'.
          flag = nvs ? ((i === 0 ? F_START : 0) | (i === nseg - 1 && !s.closed ? F_END : 0)) : 7;
          if (a.e === b.e && a.n === b.n) {
            if (!nvs || i === 0 || (i === nseg - 1 && !s.closed)) add(VTX, a.e, a.n, 0, 0, 0, k, i);
            continue;
          }
          add(SEG, a.e, a.n, b.e, b.n, 0, k, i);
        }
        flag = 7;
      } else if (s.type === 'circle' && s.c && s.r > 0) {
        var ci = add(CIRC, s.c.e, s.c.n, s.r, 0, 0, k, 0);
        add(CEN, s.c.e, s.c.n, 0, 0, 0, k, ci);
      } else if (s.type === 'arc' && s.c && s.r > 0) {
        var ai = add(ARC, s.c.e, s.c.n, s.r, s.a0, s.a1, k, 0);
        add(CEN, s.c.e, s.c.n, 0, 0, 0, k, ai);
      } else if (s.type === 'point' && s.p) {
        add(PT, s.p.e, s.p.n, 0, 0, 0, k, 0);
      }
    }
    this.typ = Uint8Array.from(typ);
    this.f = Float64Array.from(f);
    this.sh = Int32Array.from(sh);
    this.si = Int32Array.from(si);
    this.fl = Uint8Array.from(fl);
    this.count = typ.length;
    this.stamp = new Uint32Array(this.count);
    this.qstamp = 0;
    this.cells = new Map();
    this.big = [];
    this._build();
  }

  Group.prototype._put = function (ix, iy, id) {
    var key = (ix + OFF) * ROW + (iy + OFF);
    var arr = this.cells.get(key);
    if (arr) arr.push(id); else this.cells.set(key, [id]);
  };

  Group.prototype._build = function () {
    var cs = this.cs, f = this.f, typ = this.typ;
    for (var id = 0; id < this.count; id++) {
      var o = id * STRIDE, t = typ[id];
      if (t === PT || t === CEN || t === VTX) {
        this._put(Math.floor(f[o] / cs), Math.floor(f[o + 1] / cs), id);
      } else if (t === SEG) {
        this._putSeg(f[o], f[o + 1], f[o + 2], f[o + 3], id);
      } else {
        this._putRing(f[o], f[o + 1], f[o + 2], id, t === ARC ? f[o + 3] : null, t === ARC ? f[o + 4] : null);
      }
    }
  };

  Group.prototype._putSeg = function (e0, n0, e1, n1, id) {
    var cs = this.cs;
    var ix0 = Math.floor(Math.min(e0, e1) / cs), ix1 = Math.floor(Math.max(e0, e1) / cs);
    var iy0 = Math.floor(Math.min(n0, n1) / cs), iy1 = Math.floor(Math.max(n0, n1) / cs);
    var ix, iy;
    if ((ix1 - ix0 + 1) * (iy1 - iy0 + 1) <= 4) {
      for (iy = iy0; iy <= iy1; iy++) for (ix = ix0; ix <= ix1; ix++) this._put(ix, iy, id);
      return;
    }
    // walk rows (n strips); within a row, the e-range of the segment
    var dn = n1 - n0, de = e1 - e0;
    var nlo = Math.min(n0, n1), nhi = Math.max(n0, n1);
    var pad = cs * 1e-9;
    for (iy = iy0; iy <= iy1; iy++) {
      var ya = Math.max(nlo, iy * cs), yb = Math.min(nhi, (iy + 1) * cs);
      var ea, eb;
      if (dn === 0) { ea = e0; eb = e1; }
      else {
        ea = e0 + de * (ya - n0) / dn;
        eb = e0 + de * (yb - n0) / dn;
      }
      var lo = Math.floor((Math.min(ea, eb) - pad) / cs), hi = Math.floor((Math.max(ea, eb) + pad) / cs);
      if (lo < ix0) lo = ix0; if (hi > ix1) hi = ix1;
      for (ix = lo; ix <= hi; ix++) this._put(ix, iy, id);
    }
  };

  Group.prototype._putRing = function (ce, cn, r, id, a0, a1) {
    var cs = this.cs;
    var minE = ce - r, maxE = ce + r, minN = cn - r, maxN = cn + r;
    if (a0 != null && arcSweep(a0, a1) < TAU) {
      // tight bbox of the arc
      var p0e = ce + r * Math.cos(a0), p0n = cn + r * Math.sin(a0);
      var p1e = ce + r * Math.cos(a1), p1n = cn + r * Math.sin(a1);
      minE = Math.min(p0e, p1e); maxE = Math.max(p0e, p1e);
      minN = Math.min(p0n, p1n); maxN = Math.max(p0n, p1n);
      if (angleInArc(0, a0, a1, 0)) maxE = ce + r;
      if (angleInArc(Math.PI / 2, a0, a1, 0)) maxN = cn + r;
      if (angleInArc(Math.PI, a0, a1, 0)) minE = ce - r;
      if (angleInArc(-Math.PI / 2, a0, a1, 0)) minN = cn - r;
    }
    var ix0 = Math.floor(minE / cs), ix1 = Math.floor(maxE / cs);
    var iy0 = Math.floor(minN / cs), iy1 = Math.floor(maxN / cs);
    if ((ix1 - ix0 + 1) * (iy1 - iy0 + 1) > BIG_CELLS) { this.big.push(id); return; }
    var pad = cs * 1e-9;
    for (var iy = iy0; iy <= iy1; iy++) {
      var y0 = iy * cs - pad, y1 = (iy + 1) * cs + pad;
      for (var ix = ix0; ix <= ix1; ix++) {
        var x0 = ix * cs - pad, x1 = (ix + 1) * cs + pad;
        // min / max distance from center to cell rectangle
        var dx = ce < x0 ? x0 - ce : (ce > x1 ? ce - x1 : 0);
        var dy = cn < y0 ? y0 - cn : (cn > y1 ? cn - y1 : 0);
        var dmin = Math.hypot(dx, dy);
        var Dx = Math.max(Math.abs(ce - x0), Math.abs(ce - x1));
        var Dy = Math.max(Math.abs(cn - y0), Math.abs(cn - y1));
        var dmax = Math.hypot(Dx, Dy);
        if (dmin <= r && dmax >= r) this._put(ix, iy, id);
      }
    }
  };

  // Collect primitive ids whose cells overlap the box [p±tol].
  Group.prototype._gather = function (p, tol, out) {
    var cs = this.cs, stamp = this.stamp, cells = this.cells;
    var s = ++this.qstamp;
    if (s >= 0xffffffff) { stamp.fill(0); this.qstamp = s = 1; }
    var ix0 = Math.floor((p.e - tol) / cs), ix1 = Math.floor((p.e + tol) / cs);
    var iy0 = Math.floor((p.n - tol) / cs), iy1 = Math.floor((p.n + tol) / cs);
    for (var ix = ix0; ix <= ix1; ix++) {
      var base = (ix + OFF) * ROW + OFF;
      for (var iy = iy0; iy <= iy1; iy++) {
        var arr = cells.get(base + iy);
        if (!arr) continue;
        for (var j = 0; j < arr.length; j++) {
          var id = arr[j];
          if (stamp[id] !== s) { stamp[id] = s; out.push(id); }
        }
      }
    }
    for (var b = 0; b < this.big.length; b++) {
      var bid = this.big[b];
      if (stamp[bid] !== s) { stamp[bid] = s; out.push(bid); }
    }
  };

  var CLASS = { node: 1, end: 1, center: 1, inter: 1, mid: 2, near: 3 };
  var MAX_INTER_PRIMS = 48;

  function Index(cellSize) {
    this.cellSize = cellSize > 0 ? cellSize : 50;
    this.groups = new Map();
  }

  Index.prototype.setGroup = function (id, shapes) {
    var prev = this.groups.get(id);
    var g = new Group(id, shapes || [], this.cellSize);
    if (prev) g.enabled = prev.enabled;
    this.groups.set(id, g);
  };
  Index.prototype.removeGroup = function (id) { this.groups.delete(id); };
  Index.prototype.clear = function () { this.groups.clear(); };
  Index.prototype.hasGroup = function (id) { return this.groups.has(id); };
  Index.prototype.setGroupEnabled = function (id, on) {
    var g = this.groups.get(id);
    if (g) g.enabled = !!on;
  };
  Index.prototype.isGroupEnabled = function (id) {
    var g = this.groups.get(id);
    return !!(g && g.enabled);
  };
  Index.prototype.stats = function () {
    var prims = 0, cells = 0, big = 0;
    this.groups.forEach(function (g) { prims += g.count; cells += g.cells.size; big += g.big.length; });
    return { groups: this.groups.size, primitives: prims, cells: cells, big: big };
  };

  function allModes(m) {
    if (!m) return { end: true, mid: true, near: true, inter: true, center: true, node: true };
    return m;
  }

  // All candidates within tol, sorted by (class, distance). Each:
  // {p, kind, shape, d, cls, group, shape2?}. Also returns centerHint via out.centerHint.
  Index.prototype._candidates = function (p, tol, modes, out) {
    modes = allModes(modes);
    var res = [];
    var tol2 = tol * tol;
    var nearPrims = []; // {g, id, d, q}
    var hint = null, hintD = Infinity;
    var ids = [];
    function push(pt, kind, g, shapeIdx, extra) {
      var d = Math.hypot(pt.e - p.e, pt.n - p.n);
      if (d > tol) return;
      var c = { p: { e: pt.e, n: pt.n }, kind: kind, shape: g.shapes[shapeIdx], d: d, cls: CLASS[kind], group: g.id };
      if (extra) c.shape2 = extra;
      res.push(c);
    }
    this.groups.forEach(function (g) {
      if (!g.enabled || g.count === 0) return;
      ids.length = 0;
      g._gather(p, tol, ids);
      var f = g.f, typ = g.typ;
      for (var j = 0; j < ids.length; j++) {
        var id = ids[j], o = id * STRIDE, t = typ[id], k = g.sh[id];
        if (t === PT) {
          if (modes.node) push({ e: f[o], n: f[o + 1] }, 'node', g, k);
        } else if (t === VTX) {
          if (modes.end) push({ e: f[o], n: f[o + 1] }, 'end', g, k);
        } else if (t === CEN) {
          if (modes.center) push({ e: f[o], n: f[o + 1] }, 'center', g, k);
        } else if (t === SEG) {
          var a = { e: f[o], n: f[o + 1] }, b = { e: f[o + 2], n: f[o + 3] };
          var ns = nearestOnSeg(p, a, b);
          if (ns.d > tol) continue;
          var fls = g.fl[id];
          if (modes.end) {
            if (fls & F_START) push(a, 'end', g, k);
            if (fls & F_END) push(b, 'end', g, k);
          }
          if (modes.mid && (fls & F_MID)) push({ e: (a.e + b.e) / 2, n: (a.n + b.n) / 2 }, 'mid', g, k);
          if (modes.near) push(ns.p, 'near', g, k);
          nearPrims.push({ g: g, id: id, d: ns.d });
        } else { // ARC / CIRC
          var c = { e: f[o], n: f[o + 1] }, r = f[o + 2];
          var isArc = t === ARC, a0 = f[o + 3], a1 = f[o + 4];
          var na = isArc ? nearestOnArc(p, c, r, a0, a1) : nearestOnArc(p, c, r);
          if (na.d > tol) continue;
          if (isArc) {
            if (modes.end) {
              push({ e: c.e + r * Math.cos(a0), n: c.n + r * Math.sin(a0) }, 'end', g, k);
              push({ e: c.e + r * Math.cos(a1), n: c.n + r * Math.sin(a1) }, 'end', g, k);
            }
            if (modes.mid) {
              var am = a0 + arcSweep(a0, a1) / 2;
              push({ e: c.e + r * Math.cos(am), n: c.n + r * Math.sin(am) }, 'mid', g, k);
            }
          }
          if (modes.near) push(na.p, 'near', g, k);
          if (na.d < hintD) { hintD = na.d; hint = { e: c.e, n: c.n }; }
          nearPrims.push({ g: g, id: id, d: na.d });
        }
      }
    });

    if (modes.inter && nearPrims.length > 1) {
      if (nearPrims.length > MAX_INTER_PRIMS) {
        nearPrims.sort(function (x, y) { return x.d - y.d; });
        nearPrims.length = MAX_INTER_PRIMS;
      }
      for (var i = 0; i < nearPrims.length; i++) {
        for (var j2 = i + 1; j2 < nearPrims.length; j2++) {
          var pts = intersectPrims(nearPrims[i], nearPrims[j2]);
          for (var q = 0; q < pts.length; q++) {
            var A = nearPrims[i], B = nearPrims[j2];
            var dd = (pts[q].e - p.e) * (pts[q].e - p.e) + (pts[q].n - p.n) * (pts[q].n - p.n);
            if (dd > tol2) continue;
            push(pts[q], 'inter', A.g, A.g.sh[A.id], B.g.shapes[B.g.sh[B.id]]);
          }
        }
      }
    }

    res.sort(function (x, y) { return x.cls - y.cls || x.d - y.d || kindOrder(x.kind) - kindOrder(y.kind); });
    if (out) out.centerHint = modes.center ? hint : null;
    return res;
  };

  // tie-break inside a class at equal distance: node > end > center > inter
  function kindOrder(k) {
    return k === 'node' ? 0 : k === 'end' ? 1 : k === 'center' ? 2 : k === 'inter' ? 3 : 4;
  }

  function primGeom(g, id) {
    var o = id * STRIDE, f = g.f, t = g.typ[id];
    if (t === SEG) return { t: SEG, a: { e: f[o], n: f[o + 1] }, b: { e: f[o + 2], n: f[o + 3] } };
    return { t: t, c: { e: f[o], n: f[o + 1] }, r: f[o + 2], a0: f[o + 3], a1: f[o + 4] };
  }

  function onArcFilter(pts, G) {
    if (G.t !== ARC) return pts;
    return pts.filter(function (q) {
      return angleInArc(Math.atan2(q.n - G.c.n, q.e - G.c.e), G.a0, G.a1, 1e-9);
    });
  }

  function samePt(a, b) {
    return Math.abs(a.e - b.e) <= 1e-9 * (1 + Math.abs(a.e)) && Math.abs(a.n - b.n) <= 1e-9 * (1 + Math.abs(a.n));
  }

  function intersectPrims(A, B) {
    var GA = primGeom(A.g, A.id), GB = primGeom(B.g, B.id);
    var pts;
    if (GA.t === SEG && GB.t === SEG) {
      var x = segSeg(GA.a, GA.b, GB.a, GB.b);
      if (!x) return [];
      // shared vertex of the same polyline (adjacent / closing segments) is not an intersection
      if (A.g === B.g && A.g.sh[A.id] === B.g.sh[B.id]) {
        var sharedA = samePt(x, GA.a) || samePt(x, GA.b);
        var sharedB = samePt(x, GB.a) || samePt(x, GB.b);
        if (sharedA && sharedB) return [];
        // snap to the exact vertex when numerically at it
      }
      return [x];
    }
    if (GA.t === SEG) return onArcFilter(segCircle(GA.a, GA.b, GB.c, GB.r), GB);
    if (GB.t === SEG) return onArcFilter(segCircle(GB.a, GB.b, GA.c, GA.r), GA);
    pts = circleCircle(GA.c, GA.r, GB.c, GB.r);
    return onArcFilter(onArcFilter(pts, GA), GB);
  }

  Index.prototype.query = function (p, tol, modes) {
    var o = {};
    var list = this._candidates(p, tol, modes, o);
    if (!list.length) return null;
    var c = list[0];
    var r = { p: c.p, kind: c.kind, shape: c.shape, d: c.d, group: c.group };
    if (c.shape2) r.shape2 = c.shape2;
    if (o.centerHint) r.centerHint = o.centerHint;
    return r;
  };

  // All candidates (sorted best-first) plus centerHint — for cycling snaps / debugging.
  Index.prototype.queryAll = function (p, tol, modes) {
    var o = {};
    var list = this._candidates(p, tol, modes, o);
    return { candidates: list, centerHint: o.centerHint || null };
  };

  root.MD.Snap = { Index: Index, geom: geom };
})(typeof window !== 'undefined' ? window : globalThis);
