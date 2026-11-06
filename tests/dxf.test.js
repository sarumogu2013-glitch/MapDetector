'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
require('../js/dxf.js');
const DXF = globalThis.MD.DXF;

const SAMPLE = path.join(__dirname, '..', 'samples', 'sample-drawing.dxf');
const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} != ${b}`);
const normA = a => ((a % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
const nearAng = (a, b) => { const d = Math.abs(normA(a) - normA(b)); assert.ok(d < 1e-6 || Math.abs(d - 2 * Math.PI) < 1e-6, `${a} != ${b}`); };

function dxf(entities, blocks = '', layers = '') {
  const L = [];
  if (layers) L.push('0', 'SECTION', '2', 'TABLES', '0', 'TABLE', '2', 'LAYER', layers, '0', 'ENDTAB', '0', 'ENDSEC');
  if (blocks) L.push('0', 'SECTION', '2', 'BLOCKS', blocks, '0', 'ENDSEC');
  L.push('0', 'SECTION', '2', 'ENTITIES', entities, '0', 'ENDSEC', '0', 'EOF');
  return L.join('\n');
}
const pairs = (...a) => a.join('\n');

test('sample drawing: decode (Shift_JIS), layers, shapes, bounds', () => {
  const txt = DXF.decode(fs.readFileSync(SAMPLE));
  const r = DXF.parse(txt);
  assert.deepStrictEqual(r.warnings, []);
  assert.deepStrictEqual(r.layers.map(l => l.name), ['0', '道路端', '中心線', '構造物', '文字']);
  assert.strictEqual(r.layers.find(l => l.name === '道路端').color, '#ff0000');
  assert.strictEqual(r.layers.find(l => l.name === '文字').color, '#000000');
  const texts = r.shapes.filter(s => s.type === 'text').map(s => s.text);
  assert.deepStrictEqual(texts, ['東京駅', 'BP ⌀600']);
  const types = r.shapes.map(s => s.type);
  assert.strictEqual(types.filter(t => t === 'arc').length, 3); // 2 ARC + 1 bulge
  assert.strictEqual(types.filter(t => t === 'circle').length, 2); // CIRCLE + block MH
  const center = r.shapes.find(s => s.layer === '中心線' && s.type === 'polyline');
  assert.strictEqual(center.pts.length, 5);
  assert.deepStrictEqual(center.pts[0], { e: -6400, n: -35600 });
  const magenta = r.shapes.find(s => s.type === 'arc' && s.color === '#ff00ff');
  assert.ok(magenta && magenta.r === 25);
  assert.ok(r.bounds.minE < -6400 && r.bounds.maxE === -5000 && r.bounds.maxN === -34600);
});

test('LINE + colors: 62 overrides layer, 256 BYLAYER, scale/offset', () => {
  const t = dxf(pairs(
    '0', 'LINE', '8', 'A', '62', '1', '10', '0', '20', '0', '11', '10', '21', '0',
    '0', 'LINE', '8', 'A', '62', '256', '10', '0', '20', '0', '11', '0', '21', '5',
    '0', 'LINE', '8', 'NEW', '10', '0', '20', '0', '11', '0', '21', '5'
  ), '', pairs('0', 'LAYER', '2', 'A', '70', '0', '62', '-5'));
  const r = DXF.parse(t, { scale: 2, offsetE: 100, offsetN: 200 });
  assert.strictEqual(r.shapes[0].color, '#ff0000');
  assert.strictEqual(r.shapes[1].color, '#0000ff');
  assert.strictEqual(r.layers[0].off, true);
  assert.strictEqual(r.layers[1].name, 'NEW');
  assert.deepStrictEqual(r.shapes[0].pts, [{ e: 100, n: 200 }, { e: 120, n: 200 }]);
  assert.deepStrictEqual(r.bounds, { minE: 100, minN: 200, maxE: 120, maxN: 210 });
  assert.strictEqual(DXF.aciToHex(7), '#000000');
  assert.strictEqual(DXF.aciToHex(10), '#ff0000');
  assert.strictEqual(DXF.aciToHex(11), '#ff8080');
  assert.strictEqual(DXF.aciToHex(30), '#ff8000');
  assert.strictEqual(DXF.aciToHex(250), '#333333');
});

test('LWPOLYLINE bulge → true arc + straight runs; plain polyline keeps closed flag', () => {
  // square 0,0 → 10,0 (bulge 1 = CCW semicircle to 10,10?) use bulge on 2nd vertex
  const t = dxf(pairs(
    '0', 'LWPOLYLINE', '8', 'P', '90', '4', '70', '1',
    '10', '0', '20', '0',
    '10', '10', '20', '0', '42', '1',
    '10', '10', '20', '10',
    '10', '0', '20', '10',
    '0', 'LWPOLYLINE', '8', 'P', '90', '3', '70', '1', '10', '0', '20', '0', '10', '5', '20', '0', '10', '5', '20', '5'
  ));
  const r = DXF.parse(t);
  const arcs = r.shapes.filter(s => s.type === 'arc');
  const polys = r.shapes.filter(s => s.type === 'polyline');
  assert.strictEqual(arcs.length, 1);
  const a = arcs[0];
  // semicircle from (10,0) to (10,10) CCW: centre (10,5), r 5, -90° → +90° (bulges to +x)
  near(a.c.e, 10); near(a.c.n, 5); near(a.r, 5);
  nearAng(a.a0, -Math.PI / 2); near(a.a1 - a.a0, Math.PI);
  // straight runs: (0,0)-(10,0) and (10,10)-(0,10)-(0,0)
  assert.strictEqual(polys.length, 3);
  assert.deepStrictEqual(polys[0].pts, [{ e: 0, n: 0 }, { e: 10, n: 0 }]);
  assert.strictEqual(polys[0].closed, false);
  assert.deepStrictEqual(polys[1].pts, [{ e: 10, n: 10 }, { e: 0, n: 10 }, { e: 0, n: 0 }]);
  assert.strictEqual(polys[2].closed, true);
  assert.strictEqual(polys[2].pts.length, 3);
});

test('negative bulge (CW arc) is emitted CCW from end to start', () => {
  const t = dxf(pairs('0', 'LWPOLYLINE', '8', 'P', '90', '2', '70', '0', '10', '0', '20', '0', '42', '-1', '10', '10', '20', '0'));
  const a = DXF.parse(t).shapes[0];
  assert.strictEqual(a.type, 'arc');
  near(a.c.e, 5); near(a.c.n, 0); near(a.r, 5);
  // CW from (0,0) to (10,0) via (5,5) → CCW from 0 to π
  nearAng(a.a0, 0); near(a.a1 - a.a0, Math.PI);
});

test('ARC degrees → radians; swapXY flips orientation correctly', () => {
  const t = dxf(pairs('0', 'ARC', '8', 'A', '10', '100', '20', '50', '40', '10', '50', '0', '51', '90'));
  const a = DXF.parse(t).shapes[0];
  near(a.c.e, 100); near(a.c.n, 50); nearAng(a.a0, 0); near(a.a1 - a.a0, Math.PI / 2);
  const s = DXF.parse(t, { swapXY: true }).shapes[0];
  // x→n, y→e: centre e=50, n=100. DXF start (110,50) → (e50,n110) = angle 90°, end (100,60) → (e60,n100) = 0°.
  near(s.c.e, 50); near(s.c.n, 100);
  nearAng(s.a0, 0); near(s.a1 - s.a0, Math.PI / 2);
  // mid point of swapped arc must equal swapped mid point of original (DXF 45°)
  const m = (s.a0 + s.a1) / 2;
  near(s.c.e + 10 * Math.cos(m), 50 + 10 * Math.sin(Math.PI / 4));
  near(s.c.n + 10 * Math.sin(m), 100 + 10 * Math.cos(Math.PI / 4));
  // bounds of swapped arc
  const b = DXF.parse(t, { swapXY: true }).bounds;
  near(b.minE, 50); near(b.maxE, 60); near(b.minN, 100); near(b.maxN, 110);
});

test('swapXY with 270° arc (sweep crossing 0)', () => {
  const t = dxf(pairs('0', 'ARC', '8', 'A', '10', '0', '20', '0', '40', '1', '50', '300', '51', '210'));
  const a = DXF.parse(t, { swapXY: true }).shapes[0];
  near(a.a1 - a.a0, 270 * Math.PI / 180);
  // original end at 210° → (cos210, sin210) → swapped (e=sin210, n=cos210) angle = 90-210 = -120°
  nearAng(a.a0, -120 * Math.PI / 180);
});

test('INSERT with rotation, scale, base point; BYBLOCK and layer 0 inheritance', () => {
  const blocks = pairs(
    '0', 'BLOCK', '8', '0', '2', 'B1', '70', '0', '10', '1', '20', '0',
    '0', 'LINE', '8', '0', '62', '0', '10', '1', '20', '0', '11', '3', '21', '0',
    '0', 'ARC', '8', 'FIX', '10', '1', '20', '0', '40', '1', '50', '0', '51', '90',
    '0', 'INSERT', '8', '0', '2', 'B2', '10', '0', '20', '0',
    '0', 'ENDBLK', '8', '0',
    '0', 'BLOCK', '8', '0', '2', 'B2', '70', '0', '10', '0', '20', '0',
    '0', 'POINT', '8', '0', '10', '1', '20', '1',
    '0', 'ENDBLK'
  );
  const ents = pairs('0', 'INSERT', '8', 'L', '62', '3', '2', 'B1', '10', '10', '20', '20', '41', '2', '42', '2', '50', '90');
  const r = DXF.parse(dxf(ents, blocks, pairs('0', 'LAYER', '2', 'L', '62', '5', '0', 'LAYER', '2', 'FIX', '62', '1')));
  const [ln, arc, pt] = r.shapes;
  assert.strictEqual(ln.layer, 'L'); assert.strictEqual(ln.color, '#00ff00'); // BYBLOCK → insert colour
  near(ln.pts[0].e, 10); near(ln.pts[0].n, 20);
  near(ln.pts[1].e, 10); near(ln.pts[1].n, 24); // (3-1)*2 rotated 90°
  assert.strictEqual(arc.layer, 'FIX'); assert.strictEqual(arc.color, '#ff0000');
  near(arc.r, 2); near(arc.c.e, 10); near(arc.c.n, 20);
  nearAng(arc.a0, Math.PI / 2); near(arc.a1 - arc.a0, Math.PI / 2);
  // nested: B2 point (1,1) in B1 coords → minus base (1,0) → (0,1)*2 → rot90 → (-2,0) + (10,20)
  assert.strictEqual(pt.type, 'point'); assert.strictEqual(pt.layer, 'L'); assert.strictEqual(pt.color, '#0000ff'); // BYLAYER on inherited layer L
  near(pt.p.e, 8); near(pt.p.n, 20);
});

test('INSERT with mirrored scale keeps arcs CCW; recursion depth limited', () => {
  const blocks = pairs(
    '0', 'BLOCK', '2', 'A', '10', '0', '20', '0', '0', 'ARC', '8', '0', '10', '0', '20', '0', '40', '1', '50', '0', '51', '90', '0', 'ENDBLK',
    '0', 'BLOCK', '2', 'SELF', '10', '0', '20', '0', '0', 'INSERT', '8', '0', '2', 'SELF', '10', '1', '20', '0', '0', 'ENDBLK'
  );
  const r = DXF.parse(dxf(pairs('0', 'INSERT', '8', 'X', '2', 'A', '10', '0', '20', '0', '41', '-1', '42', '1',
    '0', 'INSERT', '8', 'X', '2', 'SELF', '10', '0', '20', '0'), blocks));
  const a = r.shapes[0];
  // mirrored in x: quarter from 90° to 180°
  nearAng(a.a0, Math.PI / 2); near(a.a1 - a.a0, Math.PI / 2);
  assert.ok(r.warnings.some(w => w.includes('SELF')));
});

test('non-uniform INSERT scale turns circle into noVertexSnap polyline', () => {
  const blocks = pairs('0', 'BLOCK', '2', 'C', '10', '0', '20', '0', '0', 'CIRCLE', '8', '0', '10', '0', '20', '0', '40', '1', '0', 'ENDBLK');
  const r = DXF.parse(dxf(pairs('0', 'INSERT', '8', 'X', '2', 'C', '10', '0', '20', '0', '41', '2', '42', '1'), blocks));
  assert.strictEqual(r.shapes[0].type, 'polyline');
  assert.strictEqual(r.shapes[0].noVertexSnap, true);
  assert.strictEqual(r.shapes[0].closed, true);
  near(r.bounds.maxE, 2);
});

test('POLYLINE/VERTEX/SEQEND 2D with bulge and 3D', () => {
  const t = dxf(pairs(
    '0', 'POLYLINE', '8', 'P', '66', '1', '70', '0',
    '0', 'VERTEX', '8', 'P', '10', '0', '20', '0', '42', '0.41421356237',
    '0', 'VERTEX', '8', 'P', '10', '10', '20', '0',
    '0', 'VERTEX', '8', 'P', '10', '20', '20', '0',
    '0', 'SEQEND',
    '0', 'POLYLINE', '8', 'P', '66', '1', '70', '9',
    '0', 'VERTEX', '10', '0', '20', '0', '30', '5', '70', '32',
    '0', 'VERTEX', '10', '1', '20', '0', '30', '5', '70', '32',
    '0', 'VERTEX', '10', '1', '20', '1', '30', '5', '70', '32',
    '0', 'SEQEND'
  ));
  const r = DXF.parse(t);
  assert.deepStrictEqual(r.shapes.map(s => s.type), ['arc', 'polyline', 'polyline']);
  near(r.shapes[0].a1 - r.shapes[0].a0, Math.PI / 2, 1e-9); // bulge tan(22.5°) = 90°
  near(r.shapes[0].r, 10 / Math.SQRT2, 1e-9);
  assert.strictEqual(r.shapes[2].closed, true);
  assert.strictEqual(r.shapes[2].pts.length, 3);
});

test('TEXT / MTEXT formatting, rotation under swapXY', () => {
  const t = dxf(pairs(
    '0', 'TEXT', '8', 'T', '10', '1', '20', '2', '40', '2.5', '50', '30', '1', '%%d%%p%%%',
    '0', 'MTEXT', '8', 'T', '10', '0', '20', '0', '40', '3', '3', '{\\fMS Gothic|b0;\\H1.5x;abc}\\P', '1', 'd\\~e\\S1^2;\\U+6771'
  ));
  const r = DXF.parse(t);
  assert.strictEqual(r.shapes[0].text, '°±%');
  near(r.shapes[0].rot, Math.PI / 6); near(r.shapes[0].h, 2.5);
  assert.strictEqual(r.shapes[1].text, 'abc\nd e1/2東');
  const s = DXF.parse(t, { swapXY: true }).shapes[0];
  near(s.p.e, 2); near(s.p.n, 1);
  near(s.rot, Math.PI / 3); // direction (cos30, sin30) swapped → angle 60°
});

test('ELLIPSE and SPLINE are noVertexSnap polylines', () => {
  const t = dxf(pairs(
    '0', 'ELLIPSE', '8', 'E', '10', '0', '20', '0', '11', '2', '21', '0', '40', '0.5', '41', '0', '42', '6.283185307179586',
    '0', 'SPLINE', '8', 'S', '70', '8', '71', '2', '72', '6', '73', '3',
    '40', '0', '40', '0', '40', '0', '40', '1', '40', '1', '40', '1',
    '10', '0', '20', '0', '10', '1', '20', '2', '10', '2', '20', '0'
  ));
  const r = DXF.parse(t);
  const [el, sp] = r.shapes;
  assert.strictEqual(el.noVertexSnap, true); assert.strictEqual(el.closed, true);
  near(r.bounds.maxE, 2); near(el.pts[0].e, 2);
  assert.ok(el.pts.some(p => Math.abs(p.n - 1) < 1e-9));
  assert.strictEqual(sp.noVertexSnap, true); assert.strictEqual(sp.closed, false);
  near(sp.pts[0].e, 0); near(sp.pts[sp.pts.length - 1].e, 2);
  const mid = sp.pts[Math.floor(sp.pts.length / 2)];
  near(mid.e, 1); near(mid.n, 1); // quadratic Bezier peak
});

test('extrusion 0,0,-1 mirrors OCS x for CIRCLE/ARC', () => {
  const t = dxf(pairs('0', 'ARC', '8', 'A', '10', '5', '20', '0', '40', '1', '50', '0', '51', '90', '210', '0', '220', '0', '230', '-1'));
  const a = DXF.parse(t).shapes[0];
  near(a.c.e, -5); nearAng(a.a0, Math.PI / 2); near(a.a1 - a.a0, Math.PI / 2);
});

test('decode honours $DWGCODEPAGE ANSI_932 and UTF-8 for R2007+', () => {
  const head = '0\nSECTION\n2\nHEADER\n9\n$ACADVER\n1\nAC1015\n9\n$DWGCODEPAGE\n3\nANSI_932\n0\nENDSEC\n0\nSECTION\n2\nENTITIES\n0\nTEXT\n8\n0\n10\n0\n20\n0\n40\n1\n1\n';
  const tail = '\n0\nENDSEC\n0\nEOF\n';
  const enc = s => Array.from(s, c => c.charCodeAt(0));
  // 東京 in Shift_JIS: 93 8C 8B 9E
  const bytes = new Uint8Array([...enc(head), 0x93, 0x8c, 0x8b, 0x9e, ...enc(tail)]);
  const txt = DXF.decode(bytes.buffer);
  assert.strictEqual(DXF.parse(txt).shapes[0].text, '東京');
  const u8 = new TextEncoder().encode(head.replace('AC1015', 'AC1032') + '東京' + tail);
  assert.strictEqual(DXF.parse(DXF.decode(u8)).shapes[0].text, '東京');
});

test('unsupported entities and invisible/paper space produce warnings', () => {
  const t = dxf(pairs('0', 'HATCH', '8', 'H', '0', 'LINE', '8', 'L', '67', '1', '10', '0', '20', '0', '11', '1', '21', '1'));
  const r = DXF.parse(t);
  assert.strictEqual(r.shapes.length, 0);
  assert.strictEqual(r.bounds, null);
  assert.strictEqual(r.warnings.length, 2);
});
