'use strict';
const test = require('node:test');
const assert = require('node:assert');
require('../js/zip.js');
const Z = globalThis.MD.Zip;
const zlib = require('node:zlib');

function parseZip(u8) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  let p = u8.length - 22;
  while (p >= 0 && dv.getUint32(p, true) !== 0x06054b50) p--;
  assert.ok(p >= 0, 'EOCD found');
  let n = dv.getUint16(p + 10, true), cdOff = dv.getUint32(p + 16, true);
  if (n === 0xFFFF || cdOff === 0xFFFFFFFF) {
    const loc = p - 20;
    assert.strictEqual(dv.getUint32(loc, true), 0x07064b50);
    const z = Number(dv.getBigUint64(loc + 8, true));
    assert.strictEqual(dv.getUint32(z, true), 0x06064b50);
    n = Number(dv.getBigUint64(z + 32, true));
    cdOff = Number(dv.getBigUint64(z + 48, true));
  }
  const out = [];
  let q = cdOff;
  const td = new TextDecoder();
  for (let i = 0; i < n; i++) {
    assert.strictEqual(dv.getUint32(q, true), 0x02014b50);
    const flags = dv.getUint16(q + 8, true);
    const method = dv.getUint16(q + 10, true);
    const crc = dv.getUint32(q + 16, true);
    const size = dv.getUint32(q + 24, true);
    const nl = dv.getUint16(q + 28, true), xl = dv.getUint16(q + 30, true), cl = dv.getUint16(q + 32, true);
    const lho = dv.getUint32(q + 42, true);
    const name = td.decode(u8.subarray(q + 46, q + 46 + nl));
    assert.strictEqual(dv.getUint32(lho, true), 0x04034b50);
    const lnl = dv.getUint16(lho + 26, true), lxl = dv.getUint16(lho + 28, true);
    const data = u8.subarray(lho + 30 + lnl + lxl, lho + 30 + lnl + lxl + size);
    out.push({ name, flags, method, crc, data });
    q += 46 + nl + xl + cl;
  }
  return out;
}

test('crc32 matches zlib / known values', () => {
  assert.strictEqual(Z.crc32(new TextEncoder().encode('123456789')), 0xCBF43926);
  assert.strictEqual(Z.crc32(new Uint8Array(0)), 0);
  const buf = new Uint8Array(100003);
  for (let i = 0; i < buf.length; i++) buf[i] = (i * 31 + (i >> 7)) & 255;
  if (zlib.crc32) assert.strictEqual(Z.crc32(buf), zlib.crc32(buf));
  // incremental
  assert.strictEqual(Z.crc32(buf.subarray(50001), Z.crc32(buf.subarray(0, 50001))), Z.crc32(buf));
});

test('create: store-only, UTF-8 names, CRC, contents', () => {
  const files = [
    { name: 'a.txt', data: 'hello' },
    { name: '日本語/測点.csv', data: 'No.1,100.0\r\n' },
    { name: 'bin.dat', data: new Uint8Array([0, 1, 2, 255]) },
    { name: 'empty', data: new Uint8Array(0) }
  ];
  const zip = Z.create(files);
  const ents = parseZip(zip);
  assert.strictEqual(ents.length, 4);
  ents.forEach((e, i) => {
    assert.strictEqual(e.name, files[i].name);
    assert.strictEqual(e.method, 0);
    assert.ok(e.flags & 0x0800);
    const want = typeof files[i].data === 'string' ? new TextEncoder().encode(files[i].data) : files[i].data;
    assert.deepStrictEqual(Array.from(e.data), Array.from(want));
    assert.strictEqual(e.crc, Z.crc32(want));
  });
});

test('create: many small files, ZIP64 when > 65535 entries', () => {
  const files = [];
  for (let i = 0; i < 70000; i++) files.push({ name: 't/' + i + '.png', data: String(i) });
  const zip = Z.create(files);
  const ents = parseZip(zip);
  assert.strictEqual(ents.length, 70000);
  assert.strictEqual(ents[69999].name, 't/69999.png');
  assert.strictEqual(new TextDecoder().decode(ents[69999].data), '69999');
});

test('create: rejects bad input', () => {
  assert.throws(() => Z.create([{ name: '', data: 'x' }]));
  assert.throws(() => Z.create([{ name: 'x', data: 123 }]));
});
