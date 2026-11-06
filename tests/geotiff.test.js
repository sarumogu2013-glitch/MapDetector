'use strict';
const test = require('node:test');
const assert = require('node:assert');
// vendor のブラウザ UMD バンドルは読み込み時に Worker を参照するため node ではスタブを置く
if (typeof globalThis.Worker === 'undefined') globalThis.Worker = function Worker() { throw new Error('no worker in tests'); };
globalThis.GeoTIFF = require('../vendor/geotiff/geotiff.js');
require('../js/geotiff.js');
const GT = globalThis.MD.GeoTIFF;

function near(a, b, eps = 1e-9) { assert.ok(Math.abs(a - b) <= eps, a + ' != ' + b); }

test('write → read roundtrip 2x3 RGBA (EPSG:6677)', async () => {
  const w = 2, h = 3;
  const rgba = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < rgba.length; i++) rgba[i] = (i * 37 + 11) & 255;
  const tif = GT.write({ width: w, height: h, rgba, epsg: 6677, origin: { x: -6000, y: -35000 }, pixelSize: { x: 0.5, y: 0.5 } });
  assert.strictEqual(String.fromCharCode(tif[0], tif[1]), 'II');
  assert.strictEqual(tif[2], 42);
  const r = await GT.read(tif.buffer);
  assert.strictEqual(r.width, 2); assert.strictEqual(r.height, 3);
  assert.strictEqual(r.srcWidth, 2); assert.strictEqual(r.srcHeight, 3);
  assert.strictEqual(r.epsg, 6677);
  assert.deepStrictEqual(Array.from(r.rgba), Array.from(rgba));
  near(r.corners.tl.x, -6000); near(r.corners.tl.y, -35000);
  near(r.corners.br.x, -6000 + 0.5 * w); near(r.corners.br.y, -35000 - 0.5 * h);
  near(r.corners.tr.x, -5999); near(r.corners.bl.y, -35001.5);
});

for (const compression of ['none', 'packbits']) {
  test('write → read roundtrip 300x200 RGB (' + compression + ')', async () => {
    const w = 300, h = 200;
    const rgba = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      rgba[o] = x & 255; rgba[o + 1] = y; rgba[o + 2] = (x < 150) ? 7 : (x * y) & 255; rgba[o + 3] = 255;
    }
    const tif = GT.write({ width: w, height: h, rgba, epsg: 6669, origin: { x: 1000, y: 2000 }, pixelSize: { x: 0.25, y: 0.25 }, noAlpha: true, compression });
    const r = await GT.read(tif);
    assert.strictEqual(r.width, w); assert.strictEqual(r.height, h);
    assert.strictEqual(r.epsg, 6669);
    assert.deepStrictEqual(Array.from(r.rgba), Array.from(rgba));
    near(r.corners.br.x, 1075); near(r.corners.br.y, 1950);
  });
}

test('read downsamples to maxSize; multi-strip', async () => {
  const w = 400, h = 300;
  const rgba = new Uint8ClampedArray(w * h * 4).fill(200);
  const tif = GT.write({ width: w, height: h, rgba, epsg: 6677, origin: { x: 0, y: 0 }, pixelSize: { x: 1, y: 1 } });
  const r = await GT.read(tif, { maxSize: 100 });
  assert.strictEqual(r.width, 100); assert.strictEqual(r.height, 75);
  assert.strictEqual(r.srcWidth, 400);
  assert.strictEqual(r.rgba[0], 200);
  near(r.corners.br.x, 400); near(r.corners.br.y, -300);
});

test('EPSG:4326 writes geographic keys', async () => {
  const rgba = new Uint8ClampedArray(4 * 4).fill(255);
  const tif = GT.write({ width: 2, height: 2, rgba, epsg: 4326, origin: { x: 139, y: 36 }, pixelSize: { x: 0.001, y: 0.001 } });
  const r = await GT.read(tif);
  assert.strictEqual(r.epsg, 4326);
  near(r.corners.br.x, 139.002); near(r.corners.br.y, 35.998);
});

test('large strip layout: 2000x1000 RGBA write is a single buffer, strips <= 256KB', () => {
  const w = 2000, h = 1000;
  const rgba = new Uint8ClampedArray(w * h * 4);
  const tif = GT.write({ width: w, height: h, rgba, epsg: 6677, origin: { x: 0, y: 0 }, pixelSize: { x: 1, y: 1 } });
  assert.ok(tif.length >= w * h * 4 && tif.length < w * h * 4 + 4096);
});

test('worldFile: pixel-center convention', () => {
  const s = GT.worldFile({ x: -6000, y: -35000 }, { x: 0.5, y: 0.5 });
  const v = s.trim().split(/\r?\n/).map(Number);
  assert.deepStrictEqual(v, [0.5, 0, 0, -0.5, -5999.75, -35000.25]);
});

test('write validates input', () => {
  assert.throws(() => GT.write({ width: 2, height: 2, rgba: new Uint8ClampedArray(3), epsg: 6677, origin: { x: 0, y: 0 }, pixelSize: { x: 1, y: 1 } }));
  assert.throws(() => GT.write({ width: 1, height: 1, rgba: new Uint8ClampedArray(4), epsg: 6677, origin: { x: 0, y: 0 }, pixelSize: { x: 1, y: 1 }, compression: 'lzma' }));
});
