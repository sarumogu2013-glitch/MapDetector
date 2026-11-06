'use strict';
const test = require('node:test');
const assert = require('node:assert');
require('../js/jprcs.js');
const J = globalThis.MD.JPRCS;

// Reference values generated with pyproj 3.8 (EPSG:6668 -> EPSG:6668+zone, always_xy=True).
// [zone, lat, lon, e (=Y), n (=X)]
const REF = [
  [1, 33.6, 130.4, 83526.990823, 66902.285818],
  [2, 31.6, 131.4, 37956.769512, -155163.985296],
  [3, 34.4, 132.45, 26049.793012, -177456.685649],
  [4, 33.56, 133.53, 2785.473061, 62103.486073],
  [5, 34.7, 135.5, 106882.043250, -143597.168241],
  [6, 35.0, 135.77, -20994.198846, -110914.504256],
  [7, 36.56, 136.65, -46248.555345, 62257.951511],
  [8, 37.9, 139.05, 48368.724621, 210977.320853],
  [9, 35.681236, 139.767125, -5992.919570, -35363.237745],
  [9, 36.0, 139.833333333, -0.000030, 0.000000],
  [9, 35.0, 141.2, 124752.103700, -110085.184942],
  [10, 38.27, 140.87, 3208.359259, -192041.430225],
  [11, 43.06, 141.35, 89599.161953, -103839.166690],
  [12, 43.77, 142.36, 8855.806670, -25546.863104],
  [13, 42.98, 144.38, 10602.703551, -113304.803791],
  [14, 26.6, 142.16, 15935.004119, 66478.883080],
  [15, 26.21, 127.68, 17987.246298, 23275.969201],
  [16, 24.34, 124.16, 16235.615960, -183859.554642],
  [17, 25.85, 131.24, 24056.322406, -16594.396861],
  [18, 20.42, 136.08, 8348.506026, 46494.292072],
  [19, 24.28, 153.98, -2030.405177, -190513.850559]

];

test('ORIGINS has 19 zones', () => {
  for (let z = 1; z <= 19; z++) assert.ok(J.ORIGINS[z], 'zone ' + z);
  assert.strictEqual(J.ORIGINS[9].lat, 36);
  assert.ok(Math.abs(J.ORIGINS[9].lon - (139 + 50 / 60)) < 1e-12);
});

test('origin maps to (0,0)', () => {
  for (let z = 1; z <= 19; z++) {
    const o = J.ORIGINS[z];
    const p = J.toPlane(o.lat, o.lon, z);
    assert.ok(Math.abs(p.e) < 1e-6 && Math.abs(p.n) < 1e-6, 'zone ' + z);
  }
});

test('forward matches pyproj < 1 mm', () => {
  for (const [z, lat, lon, e, n] of REF) {
    const p = J.toPlane(lat, lon, z);
    const d = Math.hypot(p.e - e, p.n - n);
    assert.ok(d < 0.001, `zone ${z} (${lat},${lon}) diff ${d} m`);
  }
});

test('inverse matches pyproj < 1e-8 deg', () => {
  for (const [z, lat, lon, e, n] of REF) {
    const q = J.toLatLng(e, n, z);
    assert.ok(Math.abs(q.lat - lat) < 1e-8, `zone ${z} lat diff ${q.lat - lat}`);
    assert.ok(Math.abs(q.lng - lon) < 1e-8, `zone ${z} lng diff ${q.lng - lon}`);
  }
});

test('round trip far from meridian', () => {
  for (let z = 1; z <= 19; z++) {
    const o = J.ORIGINS[z];
    const lat = o.lat + 1.3, lon = o.lon - 2.1;
    const p = J.toPlane(lat, lon, z);
    const q = J.toLatLng(p.e, p.n, z);
    assert.ok(Math.abs(q.lat - lat) < 1e-10 && Math.abs(q.lng - lon) < 1e-10);
  }
});

test('guessZone', () => {
  assert.strictEqual(J.guessZone(35.68, 139.76), 9);  // Tokyo
  assert.strictEqual(J.guessZone(43.06, 141.35), 12); // Sapporo (nearest origin)
  assert.strictEqual(J.guessZone(26.21, 127.68), 15); // Naha
  assert.strictEqual(J.guessZone(33.59, 130.40), 2);  // Fukuoka: nearest origin is II (130.40 vs 129.5/131)
});

test('invalid zone throws', () => {
  assert.throws(() => J.toPlane(35, 139, 20));
});
