'use strict';
const test = require('node:test');
const assert = require('node:assert');
require('../js/snap.js');
const { Index, geom } = globalThis.MD.Snap;

const P = (e, n) => ({ e, n });
const close = (a, b, eps = 1e-6) =>
  assert.ok(Math.abs(a.e - b.e) <= eps && Math.abs(a.n - b.n) <= eps, `${JSON.stringify(a)} != ${JSON.stringify(b)}`);
const pl = (pts, closed = false) => ({ type: 'polyline', pts: pts.map(([e, n]) => P(e, n)), closed, layer: '0', color: '#ffffff' });
const ONLY = (k) => ({ end: false, mid: false, near: false, inter: false, center: false, node: false, [k]: true });

// ---------------------------------------------------------------- geom
test('geom.segSeg', () => {
  close(geom.segSeg(P(0, 0), P(10, 10), P(0, 10), P(10, 0)), P(5, 5));
  assert.strictEqual(geom.segSeg(P(0, 0), P(10, 0), P(0, 1), P(10, 1)), null); // parallel
  assert.strictEqual(geom.segSeg(P(0, 0), P(1, 1), P(3, 0), P(4, -1)), null); // lines cross outside
  close(geom.segSeg(P(0, 0), P(10, 0), P(5, 0), P(5, 5)), P(5, 0)); // T touch
});

test('geom.segCircle / circleCircle', () => {
  const pts = geom.segCircle(P(-10, 0), P(10, 0), P(0, 0), 5);
  assert.strictEqual(pts.length, 2);
  close(pts[0], P(-5, 0)); close(pts[1], P(5, 0));
  assert.strictEqual(geom.segCircle(P(-10, 0), P(0, 0), P(0, 0), 5).length, 1);
  assert.strictEqual(geom.segCircle(P(-10, 9), P(10, 9), P(0, 0), 5).length, 0);
  const cc = geom.circleCircle(P(0, 0), 5, P(8, 0), 5);
  assert.strictEqual(cc.length, 2);
  close(cc.find((q) => q.n > 0), P(4, 3));
  assert.strictEqual(geom.circleCircle(P(0, 0), 1, P(5, 0), 1).length, 0);
  assert.strictEqual(geom.circleCircle(P(0, 0), 5, P(0, 0), 5).length, 0);
  assert.strictEqual(geom.circleCircle(P(0, 0), 5, P(10, 0), 5).length, 1); // tangent
});

test('geom.angleInArc incl. wraparound', () => {
  const D = Math.PI / 180;
  assert.ok(geom.angleInArc(45 * D, 0, 90 * D));
  assert.ok(!geom.angleInArc(135 * D, 0, 90 * D));
  // arc from 300° to 60° CCW passes through 0°
  assert.ok(geom.angleInArc(0, 300 * D, 60 * D));
  assert.ok(geom.angleInArc(-30 * D, 300 * D, 60 * D));
  assert.ok(geom.angleInArc(30 * D + 2 * Math.PI, 300 * D, 60 * D));
  assert.ok(!geom.angleInArc(180 * D, 300 * D, 60 * D));
  // negative input angles
  assert.ok(geom.angleInArc(-Math.PI / 2, -Math.PI, 0));
  assert.ok(!geom.angleInArc(Math.PI / 2, -Math.PI, 0));
  // a0 == a1 → full circle
  assert.ok(geom.angleInArc(2, 1, 1));
});

test('geom.nearestOnSeg / nearestOnArc', () => {
  const r = geom.nearestOnSeg(P(5, 3), P(0, 0), P(10, 0));
  close(r.p, P(5, 0)); assert.ok(Math.abs(r.d - 3) < 1e-12); assert.ok(Math.abs(r.t - 0.5) < 1e-12);
  close(geom.nearestOnSeg(P(-5, 3), P(0, 0), P(10, 0)).p, P(0, 0));
  const D = Math.PI / 180;
  close(geom.nearestOnArc(P(0, 20), P(0, 0), 10, 0, Math.PI).p, P(0, 10));
  // outside the arc span → nearest endpoint
  close(geom.nearestOnArc(P(1, -20), P(0, 0), 10, 0, Math.PI).p, P(10, 0));
  // wrap arc 300°..60°: point at 0° is on it
  close(geom.nearestOnArc(P(20, 0), P(0, 0), 10, 300 * D, 60 * D).p, P(10, 0));
  // full circle
  close(geom.nearestOnArc(P(0, -3), P(0, 0), 10).p, P(0, -10));
});

// ---------------------------------------------------------------- kinds
test('node: point shapes', () => {
  const ix = new Index(50);
  const pt = { type: 'point', p: P(100, 200), layer: 'p', color: '#ff0000', name: 'A' };
  ix.setGroup('g', [pt]);
  const r = ix.query(P(101, 201), 3);
  assert.strictEqual(r.kind, 'node'); assert.strictEqual(r.shape, pt); close(r.p, P(100, 200));
  assert.strictEqual(ix.query(P(110, 200), 3), null);
  assert.strictEqual(ix.query(P(101, 201), 3, ONLY('end')), null);
});

test('end: every polyline vertex; mid; near', () => {
  const ix = new Index(50);
  const s = pl([[0, 0], [100, 0], [100, 100]]);
  ix.setGroup('g', [s]);
  let r = ix.query(P(99, 1), 5);
  assert.strictEqual(r.kind, 'end'); close(r.p, P(100, 0)); assert.strictEqual(r.shape, s);
  r = ix.query(P(51, 2), 5);
  assert.strictEqual(r.kind, 'mid'); close(r.p, P(50, 0));
  r = ix.query(P(30, 2), 5);
  assert.strictEqual(r.kind, 'near'); close(r.p, P(30, 0));
  r = ix.query(P(102, 70), 5);
  assert.strictEqual(r.kind, 'near'); close(r.p, P(100, 70));
  assert.strictEqual(ix.query(P(30, 8), 5), null);
});

test('closed polyline indexes closing segment', () => {
  const ix = new Index(50);
  ix.setGroup('g', [pl([[0, 0], [100, 0], [100, 100], [0, 100]], true)]);
  const r = ix.query(P(1, 30), 3);
  assert.strictEqual(r.kind, 'near'); close(r.p, P(0, 30));
  assert.strictEqual(ix.query(P(1, 50), 3).kind, 'mid');
  // open version has no closing segment
  ix.setGroup('g', [pl([[0, 0], [100, 0], [100, 100], [0, 100]], false)]);
  assert.strictEqual(ix.query(P(1, 30), 3), null);
});

test('center: offered near the center; centerHint near the perimeter', () => {
  const ix = new Index(50);
  const c = { type: 'circle', c: P(500, 500), r: 40, layer: '0', color: '#fff' };
  ix.setGroup('g', [c]);
  let r = ix.query(P(501, 499), 3);
  assert.strictEqual(r.kind, 'center'); close(r.p, P(500, 500)); assert.strictEqual(r.shape, c);
  r = ix.query(P(541, 500), 3);
  assert.strictEqual(r.kind, 'near'); close(r.p, P(540, 500));
  close(r.centerHint, P(500, 500));
  // with center mode disabled, no hint
  r = ix.query(P(541, 500), 3, { near: true });
  assert.strictEqual(r.centerHint, undefined);
  // only center mode: near the perimeter returns nothing but queryAll reports the hint
  assert.strictEqual(ix.query(P(541, 500), 3, ONLY('center')), null);
  close(ix.queryAll(P(541, 500), 3, ONLY('center')).centerHint, P(500, 500));
});

test('arc: ends, mid, near, center; wraparound arc', () => {
  const D = Math.PI / 180;
  const ix = new Index(20);
  const a = { type: 'arc', c: P(0, 0), r: 100, a0: 300 * D, a1: 60 * D, layer: '0', color: '#fff' };
  ix.setGroup('g', [a]);
  let r = ix.query(P(101, 1), 4);
  assert.strictEqual(r.kind, 'mid'); close(r.p, P(100, 0)); // mid at 0°
  const e0 = P(100 * Math.cos(300 * D), 100 * Math.sin(300 * D));
  r = ix.query(P(e0.e + 1, e0.n), 4);
  assert.strictEqual(r.kind, 'end'); close(r.p, e0);
  r = ix.query(P(102 * Math.cos(20 * D), 102 * Math.sin(20 * D)), 4);
  assert.strictEqual(r.kind, 'near'); close(r.p, P(100 * Math.cos(20 * D), 100 * Math.sin(20 * D)));
  close(r.centerHint, P(0, 0));
  // on the missing part of the circle: nothing
  assert.strictEqual(ix.query(P(-100, 0), 4), null);
  assert.strictEqual(ix.query(P(0, 101), 4), null);
  assert.strictEqual(ix.query(P(1, 1), 4).kind, 'center');
});

test('arc with negative / >2π angles', () => {
  const ix = new Index(20);
  // CCW from -π/2 to +π/2 = right half
  ix.setGroup('g', [{ type: 'arc', c: P(0, 0), r: 50, a0: -Math.PI / 2, a1: Math.PI / 2 + 4 * Math.PI }]);
  assert.strictEqual(ix.query(P(51, 0), 2).kind, 'mid');
  assert.strictEqual(ix.query(P(-51, 0), 2), null);
  const r = ix.query(P(30, 41), 2);
  assert.strictEqual(r.kind, 'near');
});

test('inter: segment–segment', () => {
  const ix = new Index(50);
  const s1 = pl([[0, 0], [100, 100]]), s2 = pl([[0, 100], [100, 0]]);
  ix.setGroup('g', [s1, s2]);
  const r = ix.query(P(52, 50), 4);
  assert.strictEqual(r.kind, 'inter'); close(r.p, P(50, 50));
  assert.ok(r.shape === s1 || r.shape === s1); assert.ok(r.shape2 === s2 || r.shape === s2);
});

test('inter across groups', () => {
  const ix = new Index(50);
  ix.setGroup('a', [pl([[0, 0], [100, 100]])]);
  ix.setGroup('b', [pl([[0, 100], [100, 0]])]);
  const r = ix.query(P(52, 50), 4);
  assert.strictEqual(r.kind, 'inter'); close(r.p, P(50, 50));
});

test('inter: segment–circle, segment–arc, arc–arc, circle–circle', () => {
  const ix = new Index(30);
  ix.setGroup('g', [
    { type: 'circle', c: P(0, 0), r: 50 },
    pl([[-100, 10], [100, 10]]),
  ]);
  const x = Math.sqrt(50 * 50 - 100);
  let r = ix.query(P(x + 1, 11), 4);
  assert.strictEqual(r.kind, 'inter'); close(r.p, P(x, 10));

  // segment–arc: upper half arc only intersects y=10 on the upper half
  ix.setGroup('g', [
    { type: 'arc', c: P(0, 0), r: 50, a0: 0, a1: Math.PI },
    pl([[-100, -10], [100, -10]]),
    pl([[-100, 10], [100, 10]]),
  ]);
  r = ix.query(P(x + 1, 11), 4);
  assert.strictEqual(r.kind, 'inter');
  r = ix.query(P(x + 1, -11), 4);
  assert.notStrictEqual(r && r.kind, 'inter');

  // arc–arc (wrap-around arcs)
  const D = Math.PI / 180;
  ix.setGroup('g', [
    { type: 'arc', c: P(0, 0), r: 5, a0: 300 * D, a1: 60 * D },
    { type: 'arc', c: P(8, 0), r: 5, a0: 90 * D, a1: 270 * D },
  ]);
  r = ix.query(P(4.5, 3.2), 1);
  assert.strictEqual(r.kind, 'inter'); close(r.p, P(4, 3));
  r = ix.query(P(4.5, -3.2), 1);
  assert.strictEqual(r.kind, 'inter'); close(r.p, P(4, -3));

  // circle–circle
  ix.setGroup('g', [{ type: 'circle', c: P(0, 0), r: 5 }, { type: 'circle', c: P(8, 0), r: 5 }]);
  r = ix.query(P(4.2, 2.8), 1);
  assert.strictEqual(r.kind, 'inter'); close(r.p, P(4, 3));
});

test('no inter at shared vertices of the same polyline (incl. closing)', () => {
  const ix = new Index(50);
  ix.setGroup('g', [pl([[0, 0], [100, 0], [100, 100], [0, 100]], true)]);
  for (const v of [P(100, 0), P(0, 0), P(0, 100)]) {
    const all = ix.queryAll(P(v.e + 0.5, v.n + 0.5), 3).candidates;
    assert.ok(!all.some((c) => c.kind === 'inter'), 'unexpected inter at ' + JSON.stringify(v));
    assert.strictEqual(all[0].kind, 'end');
  }
  // but a self-crossing polyline does produce an inter
  ix.setGroup('g', [pl([[0, 0], [100, 100], [100, 0], [0, 100]])]);
  const r = ix.query(P(51, 50), 3);
  assert.strictEqual(r.kind, 'inter'); close(r.p, P(50, 50));
});

test('priorities: class 1 beats mid beats near; ties by distance', () => {
  const ix = new Index(50);
  // segment midpoint at (50,0); a point node at (53,0)
  ix.setGroup('g', [pl([[0, 0], [100, 0]]), { type: 'point', p: P(54, 0) }]);
  let r = ix.query(P(50.5, 0), 5); // closer to mid but node wins
  assert.strictEqual(r.kind, 'node');
  r = ix.query(P(50.5, 0), 5, { mid: true, near: true });
  assert.strictEqual(r.kind, 'mid');
  r = ix.query(P(46, 0.5), 5, { near: true, mid: true });
  assert.strictEqual(r.kind, 'mid'); // mid beats near even though near is closer
  // class-1 tie by distance: end vs node
  ix.setGroup('g', [pl([[0, 0], [100, 0]]), { type: 'point', p: P(3, 0) }]);
  assert.strictEqual(ix.query(P(1, 0), 5).kind, 'end');
  assert.strictEqual(ix.query(P(2.5, 0), 5).kind, 'node');
  // inter vs end: nearest wins
  ix.setGroup('g', [pl([[0, 0], [100, 100]]), pl([[0, 100], [100, 0]]), pl([[53, 0], [53, 50.5]])]);
  r = ix.query(P(51, 50.2), 5);
  assert.strictEqual(r.kind, 'inter');
  r = ix.query(P(52.8, 50.5), 5);
  assert.strictEqual(r.kind, 'end');
});

test('groups: replace, remove, disable, clear', () => {
  const ix = new Index(50);
  ix.setGroup('a', [{ type: 'point', p: P(0, 0) }]);
  ix.setGroup('b', [{ type: 'point', p: P(10, 0) }]);
  assert.strictEqual(ix.query(P(0.5, 0), 2).kind, 'node');
  ix.setGroupEnabled('a', false);
  assert.strictEqual(ix.query(P(0.5, 0), 2), null);
  assert.ok(!ix.isGroupEnabled('a'));
  ix.setGroup('a', [{ type: 'point', p: P(1, 0) }]); // replacement keeps disabled state
  assert.strictEqual(ix.query(P(1, 0), 2), null);
  ix.setGroupEnabled('a', true);
  close(ix.query(P(0.5, 0), 2).p, P(1, 0));
  ix.removeGroup('a');
  assert.strictEqual(ix.query(P(0.5, 0), 2), null);
  assert.strictEqual(ix.query(P(10, 0), 2).kind, 'node');
  ix.clear();
  assert.strictEqual(ix.query(P(10, 0), 2), null);
});

test('long segments / big circles across many cells, negative coords', () => {
  const ix = new Index(10);
  ix.setGroup('g', [
    pl([[-5000, -3000], [7000, 4100]]),
    { type: 'circle', c: P(-20000, 30000), r: 5000 },
  ]);
  // point on the long diagonal
  const t = 0.37, q = P(-5000 + 12000 * t, -3000 + 7100 * t);
  const r = ix.query(P(q.e + 0.3, q.n - 0.3), 1, { near: true });
  assert.strictEqual(r.kind, 'near');
  assert.ok(r.d < 1);
  const rc = ix.query(P(-20000 + 5000 * Math.cos(1), 30000 + 5000 * Math.sin(1)), 0.5, { near: true });
  assert.strictEqual(rc.kind, 'near');
});

test('modes default to all and missing modes are off', () => {
  const ix = new Index(50);
  ix.setGroup('g', [pl([[0, 0], [100, 0]])]);
  assert.strictEqual(ix.query(P(30, 1), 3).kind, 'near');
  assert.strictEqual(ix.query(P(30, 1), 3, { end: true }), null);
});

test('huge polyline is indexed per segment', () => {
  const pts = [];
  for (let i = 0; i < 5000; i++) pts.push([i * 2, Math.sin(i / 50) * 100]);
  const ix = new Index(25);
  ix.setGroup('g', [pl(pts)]);
  const r = ix.query(P(2001, Math.sin(1000 / 50) * 100), 3, { end: true });
  assert.strictEqual(r.kind, 'end');
  assert.ok(ix.stats().primitives === 4999);
});

test('performance: 100k random segments, 1000 queries', () => {
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const shapes = [];
  for (let i = 0; i < 100000; i++) {
    const e = rnd() * 20000, n = rnd() * 20000, a = rnd() * Math.PI * 2, L = 5 + rnd() * 50;
    shapes.push(pl([[e, n], [e + L * Math.cos(a), n + L * Math.sin(a)]]));
  }
  const ix = new Index(50);
  const t0 = process.hrtime.bigint();
  ix.setGroup('big', shapes);
  const tBuild = Number(process.hrtime.bigint() - t0) / 1e6;
  const t1 = process.hrtime.bigint();
  let hits = 0;
  for (let i = 0; i < 1000; i++) {
    if (ix.query(P(rnd() * 20000, rnd() * 20000), 5)) hits++;
  }
  const tq = Number(process.hrtime.bigint() - t1) / 1e6;
  console.log(`build ${tBuild.toFixed(0)} ms, 1000 queries ${tq.toFixed(1)} ms, hits ${hits}`);
  assert.ok(tq < 1000, `queries took ${tq} ms`);
  assert.ok(hits > 0);
});

test('noVertexSnap polylines: only first/last vertex are end, no mid, no self inter', () => {
  const ix = new Index(50);
  const pts = [];
  for (let i = 0; i <= 20; i++) pts.push([i * 10, (i * 10) ** 2 / 400]); // tessellated parabola
  const curve = Object.assign(pl(pts), { noVertexSnap: true });
  ix.setGroup('g', [curve]);
  // interior vertex (100, 25): no end, no inter, falls back to near
  let all = ix.queryAll(P(100.5, 25.5), 3).candidates;
  assert.ok(all.length > 0);
  assert.ok(all.every((c) => c.kind === 'near'), JSON.stringify(all.map((c) => c.kind)));
  // segment midpoint (105, ~27.5) not offered
  assert.strictEqual(ix.query(P(105, 27.6), 3, { mid: true }), null);
  // first / last vertex are ends
  let r = ix.query(P(0.5, 0.5), 3);
  assert.strictEqual(r.kind, 'end'); close(r.p, P(0, 0));
  r = ix.query(P(199.5, 100.5), 3);
  assert.strictEqual(r.kind, 'end'); close(r.p, P(200, 100));
  // inter with another shape still works
  ix.setGroup('h', [pl([[50, -10], [50, 50]])]);
  r = ix.query(P(50.4, 6.6), 3);
  assert.strictEqual(r.kind, 'inter'); close(r.p, P(50, 6.25));
  // closed noVertexSnap: no ends except vertex 0
  ix.setGroup('h', []);
  ix.setGroup('g', [Object.assign(pl([[0, 0], [100, 0], [100, 100], [0, 100]], true), { noVertexSnap: true })]);
  assert.strictEqual(ix.query(P(100.5, 0.5), 3).kind, 'near');
  assert.strictEqual(ix.query(P(0.5, 0.5), 3).kind, 'end');
});

test('point shape is returned with its name', () => {
  const ix = new Index(50);
  const pt = { type: 'point', p: P(5, 5), name: 'BM1' };
  ix.setGroup('g', [pt]);
  const r = ix.query(P(5, 5), 1);
  assert.strictEqual(r.shape, pt); assert.strictEqual(r.shape.name, 'BM1');
});
