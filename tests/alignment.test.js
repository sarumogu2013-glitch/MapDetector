'use strict';
const test = require('node:test');
const assert = require('node:assert');
require('../js/alignment.js');
const AL = globalThis.MD.Alignment;

const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg || ''} expected ${b}, got ${a} (diff ${a - b})`);
const dist = (p, q) => Math.hypot(p.e - q.e, p.n - q.n);
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const kp = (al, name, ip) => al.keyPoints.find((k) => k.name === name && (ip == null || k.ipIndex === ip));

// distance from point p to the infinite line through a with direction (unit) d
const lineDist = (p, a, d) => Math.abs((p.e - a.e) * d.n - (p.n - a.n) * d.e);

function checkContinuity(al) {
  for (let i = 1; i < al.elements.length; i++) {
    const a = al.elements[i - 1], b = al.elements[i];
    const end = AL.evalElement(a, a.len);
    near(b.s0, a.s0 + a.len, 1e-9, 's0 chain');
    assert.ok(dist(end, b.p0) < 1e-6, `position jump ${dist(end, b.p0)} at element ${i}`);
    near(wrap(end.h - b.h0), 0, 1e-9, `heading jump at element ${i}`);
    if (a.type === 'clothoid' || b.type === 'clothoid') near(a.k1, b.k0, 1e-12, `curvature jump at element ${i}`);
  }
  const last = al.elements[al.elements.length - 1];
  near(last.s0 + last.len, al.length, 1e-9, 'total length');
}

test('straight only', () => {
  const al = AL.build([{ e: 0, n: 0 }, { e: 30, n: 40 }]);
  assert.strictEqual(al.elements.length, 1);
  assert.strictEqual(al.elements[0].type, 'line');
  near(al.length, 50, 1e-12);
  const p = AL.pointAt(al, 25);
  near(p.e, 15, 1e-12); near(p.n, 20, 1e-12); near(p.h, Math.atan2(4, 3), 1e-12);
  const pc = AL.pointAt(al, 999);
  near(pc.e, 30, 1e-12);
  assert.deepStrictEqual(al.keyPoints.map((k) => k.name), ['BP', 'EP']);
  assert.deepStrictEqual(al.warnings, []);
});

test('angle point (no R) keeps straight lines and marks IP', () => {
  const al = AL.build([{ e: 0, n: 0 }, { e: 100, n: 0 }, { e: 100, n: 100 }]);
  near(al.length, 200, 1e-9);
  assert.ok(kp(al, 'IP', 1));
  near(kp(al, 'IP', 1).s, 100, 1e-9);
});

test('single circular curve', () => {
  const R = 200, I = 60 * Math.PI / 180;
  const ips = [{ e: 0, n: 0 }, { e: 300, n: 0, R }, { e: 300 + 400 * Math.cos(I), n: 400 * Math.sin(I) }];
  const al = AL.build(ips);
  assert.deepStrictEqual(al.warnings, []);
  assert.deepStrictEqual(al.elements.map((e) => e.type), ['line', 'arc', 'line']);
  const T = R * Math.tan(I / 2), CL = R * I;
  near(al.curves[0].T1, T, 1e-9, 'T1');
  near(al.curves[0].T2, T, 1e-9, 'T2');
  near(al.elements[1].len, CL, 1e-9, 'CL');
  near(al.elements[1].k0, 1 / R, 1e-15, 'left turn k>0');
  near(al.length, (300 - T) + CL + (400 - T), 1e-9, 'length');
  const bc = kp(al, 'BC', 1), ec = kp(al, 'EC', 1), sp = kp(al, 'SP', 1);
  near(bc.s, 300 - T, 1e-9);
  near(ec.s, 300 - T + CL, 1e-9);
  near(sp.s, 300 - T + CL / 2, 1e-9);
  const pBC = AL.pointAt(al, bc.s);
  near(pBC.e, 300 - T, 1e-9); near(pBC.n, 0, 1e-9);
  const pEC = AL.pointAt(al, ec.s);
  near(pEC.e, 300 + T * Math.cos(I), 1e-6); near(pEC.n, T * Math.sin(I), 1e-6);
  near(pEC.h, I, 1e-12);
  // SP distance from IP = R(sec(I/2) - 1) (external secant)
  near(dist(AL.pointAt(al, sp.s), ips[1]), R * (1 / Math.cos(I / 2) - 1), 1e-6, 'SL');
  checkContinuity(al);
});

test('right-turn curve has negative curvature', () => {
  const al = AL.build([{ e: 0, n: 0 }, { e: 200, n: 0, R: 100 }, { e: 300, n: -100 }]);
  const arc = al.elements.find((e) => e.type === 'arc');
  assert.ok(arc.k0 < 0);
  near(arc.len, 100 * Math.PI / 4, 1e-9);
  checkContinuity(al);
});

test('symmetric clothoid vs textbook formulas', () => {
  const R = 300, A = 150, I = 50 * Math.PI / 180;
  const L = A * A / R;              // 75
  const tau = L / (2 * R);
  // textbook series (単位クロソイド): X, Y of KE point
  const X = L * (1 - tau ** 2 / 10 + tau ** 4 / 216 - tau ** 6 / 9360 + tau ** 8 / 685440);
  const Y = L * (tau / 3 - tau ** 3 / 42 + tau ** 5 / 1320 - tau ** 7 / 75600 + tau ** 9 / 6894720);
  const dR = Y - R * (1 - Math.cos(tau));
  const Xm = X - R * Math.sin(tau);
  const TL = Xm + (R + dR) * Math.tan(I / 2);
  const CLtot = 2 * L + R * (I - 2 * tau);
  const ips = [{ e: 0, n: 0 }, { e: 500, n: 0, R, A1: A, A2: A }, { e: 500 + 500 * Math.cos(I), n: 500 * Math.sin(I) }];
  const al = AL.build(ips);
  assert.deepStrictEqual(al.warnings, []);
  assert.deepStrictEqual(al.elements.map((e) => e.type), ['line', 'clothoid', 'arc', 'clothoid', 'line']);
  near(al.curves[0].T1, TL, 1e-6, 'TL1');
  near(al.curves[0].T2, TL, 1e-6, 'TL2');
  const ka1 = kp(al, 'KA1', 1), ke1 = kp(al, 'KE1', 1), ke2 = kp(al, 'KE2', 1), ka2 = kp(al, 'KA2', 1);
  near(ka1.s, 500 - TL, 1e-6);
  near(ke1.s - ka1.s, L, 1e-9);
  near(ka2.s - ka1.s, CLtot, 1e-9);
  near(ka2.s - ke2.s, L, 1e-9);
  // KE1 local coordinates relative to KA1 = (X, Y)
  const pKA1 = AL.pointAt(al, ka1.s), pKE1 = AL.pointAt(al, ke1.s);
  near(pKE1.e - pKA1.e, X, 1e-6, 'X');
  near(pKE1.n - pKA1.n, Y, 1e-6, 'Y');
  near(pKE1.h, tau, 1e-12, 'tau');
  // KA2 on outgoing tangent at distance TL from IP
  const pKA2 = AL.pointAt(al, ka2.s);
  near(pKA2.e, 500 + TL * Math.cos(I), 1e-6); near(pKA2.n, TL * Math.sin(I), 1e-6);
  // SP: symmetric -> on bisector; distance from IP = (R+dR)/cos(I/2) - R
  near(dist(AL.pointAt(al, kp(al, 'SP', 1).s), ips[1]), (R + dR) / Math.cos(I / 2) - R, 1e-6, 'SP');
  checkContinuity(al);
});

test('clothoid integration accuracy vs Fresnel-type series at large tau', () => {
  // clothoid with tau = 1 rad: compare to series with many terms
  const R = 50, L = 100, tau = L / (2 * R);
  const el = { type: 'clothoid', s0: 0, len: L, p0: { e: 0, n: 0 }, h0: 0, k0: 0, k1: 1 / R };
  // series: x = L Σ (-1)^k tau^{2k} / ((4k+1)(2k)!), y = L Σ (-1)^k tau^{2k+1} / ((4k+3)(2k+1)!)
  let x = 0, y = 0, fact = 1;
  for (let k = 0; k < 20; k++) {
    if (k > 0) fact *= (2 * k - 1) * (2 * k);
    x += (-1) ** k * tau ** (2 * k) / ((4 * k + 1) * fact);
    y += (-1) ** k * tau ** (2 * k + 1) / ((4 * k + 3) * fact * (2 * k + 1));
  }
  const p = AL.evalElement(el, L);
  near(p.e, L * x, 1e-9); near(p.n, L * y, 1e-9); near(p.h, tau, 1e-15);
});

test('asymmetric clothoids: continuity and EC on outgoing tangent', () => {
  const ips = [
    { e: 0, n: 0 },
    { e: 400, n: 50, R: 250, A1: 120, A2: 180 },
    { e: 700, n: 400, R: 180, A1: 90 },          // exit without clothoid
    { e: 1100, n: 450, R: 300, A2: 100 },        // entry without clothoid
    { e: 1500, n: 300 }
  ];
  const al = AL.build(ips);
  assert.deepStrictEqual(al.warnings, []);
  checkContinuity(al);
  for (let i = 1; i <= 3; i++) {
    const ip = ips[i], prev = ips[i - 1], next = ips[i + 1];
    const dIn = { e: (ip.e - prev.e) / dist(ip, prev), n: (ip.n - prev.n) / dist(ip, prev) };
    const dOut = { e: (next.e - ip.e) / dist(next, ip), n: (next.n - ip.n) / dist(next, ip) };
    const ks = al.keyPoints.filter((k) => k.ipIndex === i).sort((a, b) => a.s - b.s);
    const first = AL.pointAt(al, ks[0].s), last = AL.pointAt(al, ks[ks.length - 1].s);
    assert.ok(lineDist(first, ip, dIn) < 1e-6, `curve ${i} start on incoming tangent`);
    assert.ok(lineDist(last, ip, dOut) < 1e-6, `curve ${i} end on outgoing tangent (${lineDist(last, ip, dOut)})`);
    near(wrap(last.h - Math.atan2(dOut.n, dOut.e)), 0, 1e-9, 'end heading');
    near(dist(first, ip), al.curves[i - 1].T1, 1e-6);
    near(dist(last, ip), al.curves[i - 1].T2, 1e-6);
  }
  // names per curve
  const names = (i) => al.keyPoints.filter((k) => k.ipIndex === i).map((k) => k.name);
  assert.deepStrictEqual(names(1), ['KA1', 'KE1', 'SP', 'KE2', 'KA2']);
  assert.deepStrictEqual(names(2), ['KA1', 'KE1', 'SP', 'EC']);
  assert.deepStrictEqual(names(3), ['BC', 'SP', 'KE2', 'KA2']);
  // asymmetric: T1 != T2 for curve 1 and longer clothoid side has longer tangent
  assert.ok(al.curves[0].T2 > al.curves[0].T1);
  // sampled points: no gap larger than step on curves (lines are sampled at ends only)
  const pts = AL.sample(al, 2);
  near(dist(pts[0], ips[0]), 0, 1e-9); near(dist(pts[pts.length - 1], ips[4]), 0, 1e-6);
});

test('clothoids that do not fit fall back to simple curve with warning', () => {
  const ips = [{ e: 0, n: 0 }, { e: 300, n: 0, R: 100, A1: 150, A2: 150 }, { e: 600, n: 50 }];
  const al = AL.build(ips);
  assert.ok(al.warnings.length >= 1);
  assert.deepStrictEqual(al.elements.map((e) => e.type), ['line', 'arc', 'line']);
  checkContinuity(al);
});

test('overlapping curves are shrunk with warning and remain continuous', () => {
  const ips = [{ e: 0, n: 0 }, { e: 100, n: 0, R: 500 }, { e: 150, n: 80, R: 500 }, { e: 300, n: 80 }];
  const al = AL.build(ips);
  assert.ok(al.warnings.some((w) => /重複/.test(w)), al.warnings.join('\n'));
  checkContinuity(al);
  const c1 = al.curves[0], c2 = al.curves[1];
  assert.ok(c1.T2 + c2.T1 <= Math.hypot(50, 80) + 1e-6);
  assert.ok(c1.T1 <= 100 + 1e-6 && c2.T2 <= 150 + 1e-6);
  // end at EP
  const end = AL.pointAt(al, al.length);
  near(end.e, 300, 1e-6); near(end.n, 80, 1e-6);
});

test('chainage labels', () => {
  assert.strictEqual(AL.chainageLabel(0, 20), 'No.0');
  assert.strictEqual(AL.chainageLabel(60, 20), 'No.3');
  assert.strictEqual(AL.chainageLabel(70, 20), 'No.3+10.00');
  assert.strictEqual(AL.chainageLabel(103.214, 20), 'No.5+3.21');
  assert.strictEqual(AL.chainageLabel(119.999, 20), 'No.6');
});

test('stations: main, sub, key labels and startChainage', () => {
  const R = 200, I = 60 * Math.PI / 180;
  const ips = [{ e: 0, n: 0 }, { e: 300, n: 0, R }, { e: 300 + 400 * Math.cos(I), n: 400 * Math.sin(I) }];
  const al = AL.build(ips);
  const st = AL.stations(al, { pitch: 20 });
  for (let i = 1; i < st.length; i++) assert.ok(st[i].s >= st[i - 1].s);
  const mains = st.filter((x) => x.kind === 'main');
  assert.strictEqual(mains[0].label, 'No.0');
  assert.strictEqual(mains[3].label, 'No.3');
  near(mains[3].s, 60, 1e-9);
  assert.strictEqual(mains.length, Math.floor(al.length / 20) + 1);
  const bc = st.find((x) => x.keyName === 'BC');
  const T = R * Math.tan(I / 2);
  assert.strictEqual(bc.label, 'BC1 ' + AL.chainageLabel(300 - T, 20));
  assert.match(bc.label, /^BC1 No\.\d+\+\d+\.\d\d$/);
  assert.ok(st.find((x) => x.keyName === 'EP'));
  assert.strictEqual(st[0].keyName === 'BP' || st[0].label === 'No.0', true);

  // startChainage 105 -> first main station is No.6 at s=15
  const st2 = AL.stations(al, { pitch: 20, sub: 10, startChainage: 105 });
  const m2 = st2.filter((x) => x.kind === 'main');
  assert.strictEqual(m2[0].label, 'No.6');
  near(m2[0].s, 15, 1e-9);
  near(m2[0].chainage, 120, 1e-9);
  const s2 = st2.filter((x) => x.kind === 'sub');
  assert.strictEqual(s2[0].label, 'No.5+10.00');
  near(s2[0].s, 5, 1e-9);
  assert.strictEqual(st2.find((x) => x.keyName === 'BP').label, 'BP No.5+5.00');

  const st3 = AL.stations(al, { pitch: 20, includeKeyPoints: false, endInclude: false });
  assert.ok(st3.every((x) => x.kind === 'main'));
  const st4 = AL.stations(al, { pitch: 20, includeKeyPoints: false });
  assert.deepStrictEqual(st4.filter((x) => x.kind === 'key').map((x) => x.keyName), ['EP']);
});

test('fishbone perpendicular with widths', () => {
  const ips = [{ e: 0, n: 0 }, { e: 400, n: 50, R: 250, A1: 120, A2: 180 }, { e: 700, n: 400 }];
  const al = AL.build(ips);
  const st = AL.stations(al, { pitch: 20 });
  const fb = AL.fishbone(al, st, { left: 7, right: 4.5 });
  assert.strictEqual(fb.length, st.length);
  assert.match(st.find((x) => x.keyName === 'KA1').label, /^KA1-1 No\.\d+\+\d+\.\d\d$/);
  assert.match(st.find((x) => x.keyName === 'SP').label, /^SP1 No\./);
  for (const f of fb) {
    near(dist(f.c, f.l), 7, 1e-9);
    near(dist(f.c, f.r), 4.5, 1e-9);
    const t = { e: Math.cos(f.h), n: Math.sin(f.h) };
    near((f.l.e - f.c.e) * t.e + (f.l.n - f.c.n) * t.n, 0, 1e-9, 'perp l');
    near((f.r.e - f.c.e) * t.e + (f.r.n - f.c.n) * t.n, 0, 1e-9, 'perp r');
    // left side is to the left: cross(t, l-c) > 0
    assert.ok(t.e * (f.l.n - f.c.n) - t.n * (f.l.e - f.c.e) > 0);
    // tangent matches numerical derivative of the centerline
    const p1 = AL.pointAt(al, Math.max(0, f.station.s - 0.01)), p2 = AL.pointAt(al, Math.min(al.length, f.station.s + 0.01));
    near(wrap(Math.atan2(p2.n - p1.n, p2.e - p1.e) - f.h), 0, 1e-4);
  }
});

test('sample and offset', () => {
  const ips = [{ e: 0, n: 0 }, { e: 200, n: 0, R: 100 }, { e: 200, n: 200 }];
  const al = AL.build(ips);
  const pts = AL.sample(al, 1);
  near(pts[0].e, 0, 1e-12);
  near(pts[pts.length - 1].n, 200, 1e-9);
  for (let i = 1; i < pts.length; i++) assert.ok(dist(pts[i], pts[i - 1]) > 1e-7);
  // element boundaries included
  for (const el of al.elements) assert.ok(pts.some((p) => dist(p, el.p0) < 1e-9));
  // arc points within step 1
  const off = AL.offset(al, 3, 1);
  // offset of arc portion lies on radius R-3 (left turn, left offset towards center)
  const arc = al.elements.find((e) => e.type === 'arc');
  const c = { e: arc.p0.e - Math.sin(arc.h0) / arc.k0, n: arc.p0.n + Math.cos(arc.h0) / arc.k0 };
  const pa = AL.sample(al, 1).findIndex((p) => dist(p, arc.p0) < 1e-9);
  near(dist(off[pa + 5], c), 97, 1e-6);
  const offR = AL.offset(al, -3, 1);
  near(dist(offR[pa + 5], c), 103, 1e-6);
});
