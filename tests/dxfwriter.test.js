'use strict';
const test = require('node:test');
const assert = require('node:assert');
require('../js/dxf.js');
require('../js/dxfwriter.js');
const DXF = globalThis.MD.DXF;
const W = globalThis.MD.DXFWriter;

const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} != ${b}`);
const normA = a => ((a % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
const nearAng = (a, b) => { const d = Math.abs(normA(a) - normA(b)); assert.ok(d < 1e-6 || Math.abs(d - 2 * Math.PI) < 1e-6, `${a} != ${b}`); };
const sweep = s => normA(s.a1 - s.a0);
const nearPt = (p, q) => { near(p.e, q.e); near(p.n, q.n); };

// typical 平面直角 magnitudes
const E0 = -6543.210987, N0 = -35678.123456;
const SHAPES = [
  { type: 'polyline', pts: [{ e: E0, n: N0 }, { e: E0 + 10.5, n: N0 + 0.25 }, { e: E0 + 20, n: N0 - 3.125 }], closed: false },
  { type: 'polyline', pts: [{ e: E0, n: N0 }, { e: E0 + 5, n: N0 }, { e: E0 + 5, n: N0 + 5 }, { e: E0, n: N0 + 5 }], closed: true },
  { type: 'polyline', pts: [{ e: E0 + 1, n: N0 + 2 }, { e: E0 + 3, n: N0 + 4 }], closed: false },
  { type: 'circle', c: { e: E0 + 50, n: N0 + 50 }, r: 2.5 },
  { type: 'arc', c: { e: E0 + 100, n: N0 }, r: 10, a0: 0.3, a1: 1.9 },
  { type: 'arc', c: { e: E0 + 120, n: N0 }, r: 4, a0: 5.5, a1: 0.7 },          // wraps through 0
  { type: 'arc', c: { e: E0 + 140, n: N0 }, r: 3, a0: -0.5, a1: 0.5 },          // negative start
  { type: 'point', p: { e: E0 - 7, n: N0 - 8 } },
  { type: 'text', p: { e: E0 + 1, n: N0 + 1 }, text: '東京駅 No.1', h: 2.5, rot: Math.PI / 6 },
  { type: 'text', p: { e: E0 + 2, n: N0 + 2 }, text: 'BP 100%% 50%', h: 1, rot: -Math.PI / 2 }
];
const LAYERS = [
  { name: 'MEASURE', color: '#ff0000', shapes: SHAPES.slice(0, 8) },
  { name: '文字', color: '#00ff00', shapes: SHAPES.slice(8) }
];

function checkRoundTrip(r) {
  assert.deepStrictEqual(r.warnings, []);
  const sh = r.shapes;
  assert.strictEqual(sh.length, SHAPES.length);
  sh.forEach((s, i) => {
    const o = SHAPES[i];
    assert.strictEqual(s.type, o.type, `shape ${i}`);
    switch (o.type) {
      case 'polyline':
        assert.strictEqual(s.pts.length, o.pts.length);
        s.pts.forEach((p, k) => nearPt(p, o.pts[k]));
        assert.strictEqual(s.closed, o.closed);
        break;
      case 'circle': nearPt(s.c, o.c); near(s.r, o.r); break;
      case 'arc':
        nearPt(s.c, o.c); near(s.r, o.r);
        nearAng(s.a0, o.a0); nearAng(s.a1, o.a1); near(sweep(s), sweep(o));
        break;
      case 'point': nearPt(s.p, o.p); break;
      case 'text':
        nearPt(s.p, o.p); near(s.h, o.h); nearAng(s.rot, o.rot);
        assert.strictEqual(s.text, o.text);
        break;
    }
  });
}

test('format: CRLF only, starts with SECTION, R12 header, EOF', () => {
  const t = W.write(LAYERS);
  assert.ok(t.startsWith('  0\r\nSECTION\r\n  2\r\nHEADER'));
  assert.ok(!/[^\r]\n/.test(t), 'LF-only line ending found');
  assert.ok(!/\r(?!\n)/.test(t), 'CR-only line ending found');
  assert.ok(/\$ACADVER\r\n  1\r\nAC1009/.test(t));
  assert.ok(/\$DWGCODEPAGE\r\n  3\r\nANSI_932/.test(t));
  assert.ok(/\$INSUNITS\r\n 70\r\n6\r\n/.test(t));
  assert.ok(/  0\r\nLTYPE\r\n  2\r\nCONTINUOUS/.test(t));
  assert.ok(/  0\r\nSTYLE\r\n  2\r\nSTANDARD/.test(t));
  assert.ok(/  0\r\nPOLYLINE\r\n/.test(t) && /  0\r\nSEQEND\r\n/.test(t) && /  0\r\nLINE\r\n/.test(t));
  assert.ok(t.endsWith('  0\r\nEOF\r\n'));
  assert.ok(t.includes('東京駅')); // shift_jis mode leaves text as JS string
});

test('round-trip all shape types through MD.DXF.parse', () => {
  checkRoundTrip(DXF.parse(W.write(LAYERS)));
});

test('round-trip with swapXY (mirror) restores shapes incl. arc direction', () => {
  const t = W.write(LAYERS, { swapXY: true });
  checkRoundTrip(DXF.parse(t, { swapXY: true }));
  // in the file x is northing
  const r = DXF.parse(t);
  nearPt(r.shapes[7].p, { e: SHAPES[7].p.n, n: SHAPES[7].p.e });
});

test('scale and z', () => {
  const t = W.write(LAYERS, { scale: 1000, z: 12.5 });
  checkRoundTrip(DXF.parse(t, { scale: 0.001 }));
  assert.ok(/\$EXTMIN\r\n 10\r\n[^\r]+\r\n 20\r\n[^\r]+\r\n 30\r\n12\.5\r\n/.test(t));
});

test('layers and ACI colors', () => {
  const r = DXF.parse(W.write(LAYERS));
  assert.deepStrictEqual(r.layers.map(l => l.name), ['0', 'MEASURE', '文字']);
  assert.strictEqual(r.layers[1].color, '#ff0000');
  assert.strictEqual(r.layers[2].color, '#00ff00');
  assert.ok(r.shapes.slice(0, 8).every(s => s.layer === 'MEASURE' && s.color === '#ff0000'));
  assert.ok(r.shapes.slice(8).every(s => s.layer === '文字'));

  assert.strictEqual(W.toAci('#ff0000'), 1);
  assert.strictEqual(W.toAci('#ffff00'), 2);
  assert.strictEqual(W.toAci('#00ff00'), 3);
  assert.strictEqual(W.toAci('#00ffff'), 4);
  assert.strictEqual(W.toAci('#0000ff'), 5);
  assert.strictEqual(W.toAci('#ff00ff'), 6);
  assert.strictEqual(W.toAci('#ffffff'), 7);
  assert.strictEqual(W.toAci('#000000'), 7);
  assert.strictEqual(W.toAci('#808080'), 8);
  assert.strictEqual(W.toAci('#ff8000'), 30);
  assert.strictEqual(W.toAci('#fe0102'), 1);   // nearest
  assert.strictEqual(W.toAci(42), 42);
  assert.strictEqual(W.toAci('bogus'), null);

  // aci number on layer; per-shape colour override; layer name sanitising
  const t = W.write([{ name: 'A/B', aci: 5, shapes: [
    { type: 'point', p: { e: 0, n: 0 } },
    { type: 'point', p: { e: 1, n: 1 }, color: '#ff00ff' },
    { type: 'point', p: { e: 2, n: 2 }, color: '#0000ff' }
  ] }]);
  const r2 = DXF.parse(t);
  assert.strictEqual(r2.layers[1].name, 'A_B');
  assert.deepStrictEqual(r2.shapes.map(s => s.color), ['#0000ff', '#ff00ff', '#0000ff']);
  assert.strictEqual((t.match(/\r\n 62\r\n/g) || []).length, 3); // 2 layers + 1 override
});

test('extents in header match parsed bounds', () => {
  const t = W.write(LAYERS);
  const r = DXF.parse(t);
  const m1 = /\$EXTMIN\r\n 10\r\n([^\r]+)\r\n 20\r\n([^\r]+)/.exec(t);
  const m2 = /\$EXTMAX\r\n 10\r\n([^\r]+)\r\n 20\r\n([^\r]+)/.exec(t);
  near(+m1[1], r.bounds.minE); near(+m1[2], r.bounds.minN);
  near(+m2[1], r.bounds.maxE); near(+m2[2], r.bounds.maxN);
  // arc-only extents include the quadrant point of the sweep
  const t2 = W.write([{ name: 'X', shapes: [{ type: 'arc', c: { e: 0, n: 0 }, r: 1, a0: -0.1, a1: 0.1 }] }]);
  const mx = /\$EXTMAX\r\n 10\r\n([^\r]+)/.exec(t2);
  near(+mx[1], 1);
  // empty drawing
  const t3 = W.write([]);
  assert.ok(/\$EXTMIN\r\n 10\r\n0\.0\r\n/.test(t3));
  assert.deepStrictEqual(DXF.parse(t3).shapes, []);
});

test('arc edge cases: full sweep → CIRCLE, wrap-around written in degrees', () => {
  const t = W.write([{ name: 'X', shapes: [
    { type: 'arc', c: { e: 0, n: 0 }, r: 2, a0: 1, a1: 1 + 2 * Math.PI },
    { type: 'arc', c: { e: 0, n: 0 }, r: 2, a0: 3 * Math.PI / 2, a1: Math.PI / 2 }
  ] }]);
  const r = DXF.parse(t);
  assert.strictEqual(r.shapes[0].type, 'circle');
  assert.ok(/ 50\r\n270\.0\r\n 51\r\n450\.0\r\n/.test(t) || / 50\r\n270\.0\r\n 51\r\n90\.0\r\n/.test(t));
  near(sweep(r.shapes[1]), Math.PI);
  nearAng(r.shapes[1].a0, 3 * Math.PI / 2);
});

test('encodings: ascii escapes non-ASCII as \\U+XXXX, utf8 omits codepage', () => {
  const L = [{ name: '測点', color: '#ff0000', shapes: [{ type: 'text', p: { e: 0, n: 0 }, text: 'No.1 測点°', h: 1, rot: 0 }] }];
  const ta = W.write(L, { encoding: 'ascii' });
  assert.ok(/^[\x00-\x7f]*$/.test(ta));
  assert.ok(ta.includes('No.1 \\U+6E2C\\U+70B9\\U+00B0'));
  assert.ok(/ANSI_1252/.test(ta));
  const ra = DXF.parse(ta);
  assert.strictEqual(ra.shapes[0].text, 'No.1 測点°');
  assert.strictEqual(ra.shapes[0].layer, '\\U+6E2C\\U+70B9'); // reader keeps table names raw
  assert.strictEqual(W.escapeAscii('a😀'), 'a?');
  const tu = W.write(L, { encoding: 'utf8' });
  assert.ok(!/DWGCODEPAGE/.test(tu));
  assert.strictEqual(DXF.parse(tu).shapes[0].text, 'No.1 測点°');
  // round-trip through actual bytes (utf8 path via MD.DXF.decode)
  assert.strictEqual(DXF.parse(DXF.decode(Buffer.from(tu, 'utf8'))).shapes[0].text, 'No.1 測点°');
});

test('text newlines are flattened, 1-point polyline becomes POINT', () => {
  const r = DXF.parse(W.write([{ name: 'X', shapes: [
    { type: 'text', p: { e: 0, n: 0 }, text: 'a\nb', h: 1, rot: 0 },
    { type: 'polyline', pts: [{ e: 3, n: 4 }], closed: false }
  ] }]));
  assert.strictEqual(r.shapes[0].text, 'a b');
  assert.strictEqual(r.shapes[1].type, 'point');
  nearPt(r.shapes[1].p, { e: 3, n: 4 });
});
