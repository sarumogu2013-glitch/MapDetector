// 無圧縮 (store) ZIP 作成。UTF-8 ファイル名 (flag bit 11)、CRC32、必要時 ZIP64。
// MD.Zip.create(files:[{name, data:Uint8Array|string}], {date?}) → Uint8Array
// MD.Zip.crc32(u8, crc?) → uint32
(function (root) {
  root.MD = root.MD || {};

  var TABLE = (function () {
    var t = new Uint32Array(256 * 4);
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    for (var i = 0; i < 256; i++) {
      t[256 + i] = (t[t[i] & 0xFF] ^ (t[i] >>> 8)) >>> 0;
      t[512 + i] = (t[t[256 + i] & 0xFF] ^ (t[256 + i] >>> 8)) >>> 0;
      t[768 + i] = (t[t[512 + i] & 0xFF] ^ (t[512 + i] >>> 8)) >>> 0;
    }
    return t;
  })();

  // slicing-by-4
  function crc32(u8, prev) {
    var c = (prev === undefined ? 0 : prev) ^ 0xFFFFFFFF;
    var i = 0, len = u8.length, end4 = len - (len & 3);
    for (; i < end4; i += 4) {
      c ^= u8[i] | (u8[i + 1] << 8) | (u8[i + 2] << 16) | (u8[i + 3] << 24);
      c = TABLE[768 + (c & 0xFF)] ^ TABLE[512 + ((c >>> 8) & 0xFF)] ^
        TABLE[256 + ((c >>> 16) & 0xFF)] ^ TABLE[c >>> 24];
    }
    for (; i < len; i++) c = TABLE[(c ^ u8[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  function utf8(s) {
    if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(s);
    var out = [], i = 0;
    s = unescape(encodeURIComponent(s));
    for (; i < s.length; i++) out.push(s.charCodeAt(i));
    return new Uint8Array(out);
  }

  var U32 = 0xFFFFFFFF, U16 = 0xFFFF;

  function dosTime(d) {
    var y = d.getFullYear();
    if (y < 1980) return { time: 0, date: (1 << 5) | 1 };
    return {
      time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
      date: ((y - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()
    };
  }

  function setU64(dv, p, v) {
    dv.setUint32(p, v % 0x100000000, true);
    dv.setUint32(p + 4, Math.floor(v / 0x100000000), true);
  }

  function create(files, opts) {
    opts = opts || {};
    var dt = dosTime(opts.date || new Date());
    var entries = new Array(files.length);
    var offset = 0, i, e;

    // 1st pass: サイズ計算
    for (i = 0; i < files.length; i++) {
      var f = files[i];
      if (!f || f.name == null || f.name === '') throw new Error('Zip.create: name が空のエントリがあります (#' + i + ')');
      var name = utf8(String(f.name).replace(/\\/g, '/'));
      if (name.length > U16) throw new Error('Zip.create: ファイル名が長すぎます: ' + f.name);
      var data = typeof f.data === 'string' ? utf8(f.data)
        : f.data instanceof ArrayBuffer ? new Uint8Array(f.data)
          : f.data == null ? new Uint8Array(0) : f.data;
      if (!(data instanceof Uint8Array)) throw new Error('Zip.create: data は Uint8Array か文字列にしてください: ' + f.name);
      var size = data.length;
      var big = size >= U32;              // サイズが 32bit に収まらない
      var offBig = offset >= U32;         // ローカルヘッダ位置が 32bit に収まらない
      var localLen = 30 + name.length + (big ? 20 : 0);
      e = {
        name: name, data: data, size: size, crc: crc32(data),
        offset: offset, big: big, offBig: offBig, localLen: localLen
      };
      e.cExtra = (big ? 16 : 0) + (offBig ? 8 : 0);
      if (e.cExtra) e.cExtra += 4;
      entries[i] = e;
      offset += localLen + size;
    }
    var cdOff = offset, cdLen = 0;
    for (i = 0; i < entries.length; i++) cdLen += 46 + entries[i].name.length + entries[i].cExtra;
    var cdEnd = cdOff + cdLen;
    var zip64 = entries.length >= U16 || cdOff >= U32 || cdLen >= U32 ||
      entries.some(function (x) { return x.big || x.offBig; });
    var total = cdEnd + (zip64 ? 56 + 20 : 0) + 22;
    if (total > Number.MAX_SAFE_INTEGER) throw new Error('Zip.create: 大きすぎます');

    var out;
    try { out = new Uint8Array(total); }
    catch (err) { throw new Error('Zip.create: 出力バッファ (' + total + ' bytes) を確保できません'); }
    var dv = new DataView(out.buffer);
    var p = 0;

    // ローカルヘッダ + データ
    for (i = 0; i < entries.length; i++) {
      e = entries[i];
      var ver = e.big ? 45 : 20;
      dv.setUint32(p, 0x04034b50, true);
      dv.setUint16(p + 4, ver, true);
      dv.setUint16(p + 6, 0x0800, true);
      dv.setUint16(p + 8, 0, true);
      dv.setUint16(p + 10, dt.time, true);
      dv.setUint16(p + 12, dt.date, true);
      dv.setUint32(p + 14, e.crc, true);
      dv.setUint32(p + 18, e.big ? U32 : e.size, true);
      dv.setUint32(p + 22, e.big ? U32 : e.size, true);
      dv.setUint16(p + 26, e.name.length, true);
      dv.setUint16(p + 28, e.big ? 20 : 0, true);
      out.set(e.name, p + 30);
      p += 30 + e.name.length;
      if (e.big) {
        dv.setUint16(p, 0x0001, true); dv.setUint16(p + 2, 16, true);
        setU64(dv, p + 4, e.size); setU64(dv, p + 12, e.size);
        p += 20;
      }
      out.set(e.data, p);
      p += e.size;
    }

    // セントラルディレクトリ
    for (i = 0; i < entries.length; i++) {
      e = entries[i];
      var v2 = e.cExtra ? 45 : 20;
      dv.setUint32(p, 0x02014b50, true);
      dv.setUint16(p + 4, v2, true);       // version made by (MS-DOS)
      dv.setUint16(p + 6, v2, true);       // version needed
      dv.setUint16(p + 8, 0x0800, true);
      dv.setUint16(p + 10, 0, true);
      dv.setUint16(p + 12, dt.time, true);
      dv.setUint16(p + 14, dt.date, true);
      dv.setUint32(p + 16, e.crc, true);
      dv.setUint32(p + 20, e.big ? U32 : e.size, true);
      dv.setUint32(p + 24, e.big ? U32 : e.size, true);
      dv.setUint16(p + 28, e.name.length, true);
      dv.setUint16(p + 30, e.cExtra, true);
      dv.setUint16(p + 32, 0, true);
      dv.setUint16(p + 34, 0, true);
      dv.setUint16(p + 36, 0, true);
      var isDir = e.name.length && e.name[e.name.length - 1] === 0x2F;
      dv.setUint32(p + 38, isDir ? 0x10 : 0, true);
      dv.setUint32(p + 42, e.offBig ? U32 : e.offset, true);
      out.set(e.name, p + 46);
      p += 46 + e.name.length;
      if (e.cExtra) {
        dv.setUint16(p, 0x0001, true); dv.setUint16(p + 2, e.cExtra - 4, true);
        var q = p + 4;
        if (e.big) { setU64(dv, q, e.size); setU64(dv, q + 8, e.size); q += 16; }
        if (e.offBig) { setU64(dv, q, e.offset); q += 8; }
        p += e.cExtra;
      }
    }

    var n = entries.length;
    if (zip64) {
      var z64 = p;
      dv.setUint32(p, 0x06064b50, true);
      setU64(dv, p + 4, 44);
      dv.setUint16(p + 12, 45, true);
      dv.setUint16(p + 14, 45, true);
      dv.setUint32(p + 16, 0, true);
      dv.setUint32(p + 20, 0, true);
      setU64(dv, p + 24, n);
      setU64(dv, p + 32, n);
      setU64(dv, p + 40, cdLen);
      setU64(dv, p + 48, cdOff);
      p += 56;
      dv.setUint32(p, 0x07064b50, true);
      dv.setUint32(p + 4, 0, true);
      setU64(dv, p + 8, z64);
      dv.setUint32(p + 16, 1, true);
      p += 20;
    }
    dv.setUint32(p, 0x06054b50, true);
    dv.setUint16(p + 4, 0, true);
    dv.setUint16(p + 6, 0, true);
    dv.setUint16(p + 8, Math.min(n, U16), true);
    dv.setUint16(p + 10, Math.min(n, U16), true);
    dv.setUint32(p + 12, Math.min(cdLen, U32), true);
    dv.setUint32(p + 16, Math.min(cdOff, U32), true);
    dv.setUint16(p + 20, 0, true);
    return out;
  }

  root.MD.Zip = { create: create, crc32: crc32 };
})(typeof window !== 'undefined' ? window : globalThis);
