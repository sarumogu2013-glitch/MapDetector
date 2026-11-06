'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
require('../js/sima.js');
const SIMA = globalThis.MD.SIMA;

const SAMPLE = path.join(__dirname, '..', 'samples', 'sample-alignment.sim');

test('sample: title, points, parcels', () => {
  const r = SIMA.parse(SIMA.decode(fs.readFileSync(SAMPLE)));
  assert.strictEqual(r.title, '東京駅周辺 線形サンプル');
  assert.strictEqual(r.points.length, 10);
  const bp = r.points[0];
  assert.deepStrictEqual(bp, { no: '1', name: 'BP', e: -6400, n: -35600, z: 0 });
  const st = r.points.find(p => p.name === '東京駅');
  assert.ok(Math.abs(st.n - -35363.238) < 1e-9 && Math.abs(st.e - -5992.92) < 1e-9);
  assert.strictEqual(r.parcels.length, 1);
  assert.strictEqual(r.parcels[0].name, '画地1');
  assert.deepStrictEqual(r.parcels[0].pts.map(p => p.name), ['T1', 'T2', 'T3', 'T4']);
  assert.deepStrictEqual(r.warnings, []);
});

test('sample: route with radii and clothoid', () => {
  const r = SIMA.parse(SIMA.decode(fs.readFileSync(SAMPLE)));
  assert.strictEqual(r.routes.length, 1);
  const rt = r.routes[0];
  assert.strictEqual(rt.name, '本線');
  assert.deepStrictEqual(rt.ips.map(i => i.name), ['BP', 'IP.1', 'IP.2', 'IP.3', 'EP']);
  assert.deepStrictEqual(rt.ips.map(i => i.R), [0, 200, 150, 250, 0]);
  assert.strictEqual(rt.ips[2].A1, 80);
  assert.strictEqual(rt.ips[2].A2, 80);
  assert.strictEqual(rt.ips[1].A1, 0);
  assert.deepStrictEqual({ e: rt.ips[4].e, n: rt.ips[4].n }, { e: -5000, n: -34600 });
  assert.deepStrictEqual(rt.warnings, []);
});

test('C block without point ref attaches to preceding IP; asymmetric clothoid', () => {
  const txt = [
    'G00,01,t,', 'A00,',
    'A01,1,BP,0,0,0,', 'A01,2,IP1,100,0,0,', 'A01,3,IP2,100,100,0,', 'A01,4,EP,200,100,0,', 'A99,',
    'F00,7,R7,', 'F01,1,BP,', 'F01,2,IP1,', 'C00,', 'C02,50,', 'C01,120,', 'C02,60,', 'C99,',
    'F01,3,IP2,', 'C00,', 'C01,90,', 'C99,', 'F01,4,EP,', 'F99,'
  ].join('\r\n');
  const r = SIMA.parse(txt);
  const ips = r.routes[0].ips;
  assert.strictEqual(r.routes[0].no, '7');
  assert.deepStrictEqual(ips.map(i => [i.name, i.R, i.A1, i.A2]), [
    ['BP', 0, 0, 0], ['IP1', 120, 50, 60], ['IP2', 90, 0, 0], ['EP', 0, 0, 0]
  ]);
  // A01 X=northing: IP1 X=100,Y=0 → n=100,e=0
  assert.deepStrictEqual([ips[1].e, ips[1].n], [0, 100]);
});

test('C block opened before its IP reference, name-only refs, single C02 with A1,A2', () => {
  const txt = [
    'A01,1,BP,0,0,', 'A01,2,IP.1,100,0,', 'A01,3,EP,100,100,',
    'F00,1,X,', 'F02,BP,', 'C00,', 'F02,IP.1,', 'C01,150,', 'C02,40,45,', 'C99,', 'F02,EP,', 'F99,'
  ].join('\n');
  const r = SIMA.parse(txt);
  const ips = r.routes[0].ips;
  assert.deepStrictEqual(ips.map(i => i.name), ['BP', 'IP.1', 'EP']);
  assert.deepStrictEqual([ips[1].R, ips[1].A1, ips[1].A2], [150, 40, 45]);
});

test('inline coordinates and missing points produce warnings', () => {
  const txt = ['F00,1,X,', 'F01,1,BP,0,0,', 'F01,2,IP.1,100,50,', 'F01,3,IP.9,', 'F01,4,EP,200,50,', 'F99,'].join('\n');
  const r = SIMA.parse(txt);
  const ips = r.routes[0].ips;
  assert.deepStrictEqual(ips.map(i => [i.name, i.e, i.n]), [['BP', 0, 0], ['IP.1', 50, 100], ['EP', 50, 200]]);
  assert.ok(r.routes[0].warnings.some(w => w.includes('IP.9')));
});

test('fallback route from point names, ordered by IP number', () => {
  const txt = [
    'G00,01,現場,', 'A00,',
    'A01,1,EP,300,0,0,', 'A01,2,IP-2,200,10,0,', 'A01,3,ＩＰ１,100,10,0,', 'A01,4,BP,0,0,0,', 'A01,5,KP,5,5,0,', 'A99,'
  ].join('\r\n');
  const r = SIMA.parse(txt);
  assert.strictEqual(r.routes.length, 1);
  assert.deepStrictEqual(r.routes[0].ips.map(i => i.name), ['BP', 'ＩＰ１', 'IP-2', 'EP']);
  assert.ok(r.routes[0].ips.every(i => i.R === 0));
  assert.ok(r.routes[0].warnings.length >= 1);
});

test('no route when no route-like names', () => {
  const r = SIMA.parse('A01,1,P1,0,0,0,\r\nA01,2,P2,1,1,0,\r\n');
  assert.strictEqual(r.routes.length, 0);
  assert.strictEqual(r.points.length, 2);
});

test('decode: UTF-8 and Shift_JIS bytes', () => {
  // "A01,1,点,1,2,3," in Shift_JIS: 点 = 0x93 0x5F
  const sj = new Uint8Array([0x41, 0x30, 0x31, 0x2c, 0x31, 0x2c, 0x93, 0x5f, 0x2c, 0x31, 0x2c, 0x32, 0x2c, 0x33, 0x2c]);
  const t = SIMA.decode(sj.buffer);
  assert.strictEqual(t, 'A01,1,点,1,2,3,');
  const p = SIMA.parse(t).points[0];
  assert.deepStrictEqual(p, { no: '1', name: '点', e: 2, n: 1, z: 3 });
  // half-width katakana ﾃﾞｰﾀ in SJIS: C3 DE B0 C0
  assert.strictEqual(SIMA.decode(new Uint8Array([0xc3, 0xde, 0xb0, 0xc0])), 'ﾃﾞｰﾀ');
  const u = new TextEncoder().encode('﻿G00,01,東京,');
  assert.strictEqual(SIMA.decode(u), 'G00,01,東京,');
});

test('exportPoints round trip with CRLF', () => {
  const pts = [{ no: 1, name: 'A', e: -6000.1234, n: -35000.5, z: 1.25 }, { name: 'B,x', e: 1, n: 2 }];
  const s = SIMA.exportPoints(pts, '題名');
  assert.ok(s.startsWith('G00,01,題名,\r\nZ00,'));
  assert.ok(s.endsWith('A99,\r\n'));
  assert.ok(!/[^\r]\n/.test(s));
  assert.ok(s.includes('A01,1,A,-35000.500,-6000.123,1.250,\r\n'));
  const back = SIMA.parse(s);
  assert.strictEqual(back.title, '題名');
  assert.strictEqual(back.points.length, 2);
  assert.strictEqual(back.points[1].no, '2');
  assert.strictEqual(back.points[1].name, 'B x');
  assert.deepStrictEqual([back.points[1].e, back.points[1].n, back.points[1].z], [1, 2, 0]);
});
