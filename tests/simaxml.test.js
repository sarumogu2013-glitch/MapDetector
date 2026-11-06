const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
require('../js/sima.js');
require('../js/simaxml.js');
const { SIMA, SIMAXML } = globalThis.MD;

const buf = fs.readFileSync(path.join(__dirname, '..', 'samples', 'sample-sima-jpgis.xml'));
const text = SIMA.decode(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));

test('detects SIMA XML and decodes Shift_JIS', () => {
  assert.ok(SIMAXML.isSimaXml(text));
  assert.ok(!SIMAXML.isSimaXml('G00,01,x,\r\nA01,1,a,0,0,0,'));
  assert.match(text, /サンプル現場/);
});

test('parses GenbaJoho, Sokuten, Kakuchi, KaihouKakuchi, Kijyunten', () => {
  const r = SIMAXML.parse(text);
  assert.strictEqual(r.zone, 9);
  assert.strictEqual(r.title, 'サンプル現場');
  assert.strictEqual(r.points.length, 10);
  const st = r.points.find(p => p.name === '東京駅');
  assert.ok(Math.abs(st.n - -35363.238) < 1e-9 && Math.abs(st.e - -5992.92) < 1e-9);
  assert.strictEqual(st.kind, '基準点');
  assert.strictEqual(r.points.find(p => p.name === 'T1').z, 3.5);
  assert.strictEqual(r.parcels.length, 1);
  assert.deepStrictEqual(r.parcels[0].pts.map(p => [p.n, p.e]), [[-35300, -6000], [-35300, -5950], [-35250, -5950], [-35250, -6000]]);
  assert.strictEqual(r.lines.length, 1);
  assert.strictEqual(r.lines[0].pts.length, 3);
  assert.deepStrictEqual(r.warnings, []);
});

test('builds route from BP/IP/EP names', () => {
  const r = SIMAXML.parse(text);
  assert.strictEqual(r.routes.length, 1);
  assert.deepStrictEqual(r.routes[0].ips.map(p => p.name), ['BP', 'IP.1', 'IP.2', 'IP.3', 'EP']);
});

test('inline GM_Point and entities', () => {
  const x = '<?xml version="1.0"?><GI><dataset><object><Sokuten><Number>7</Number><Name>A&amp;B</Name><RefPoint><GM_Point><GM_Point.position><DirectPosition><DirectPosition.coordinate>10.5 20.25 3</DirectPosition.coordinate></DirectPosition></GM_Point.position></GM_Point></RefPoint></Sokuten></object></dataset></GI>';
  const r = SIMAXML.parse(x);
  assert.deepStrictEqual(r.points.map(p => [p.name, p.n, p.e, p.z]), [['A&B', 10.5, 20.25, 3]]);
});
