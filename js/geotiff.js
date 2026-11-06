// GeoTIFF 書き出し (自前・非圧縮/PackBits ベースライン TIFF + GeoKey) と読み込み (vendor/geotiff = geotiff.js ライブラリ)
// 書き出し: MD.GeoTIFF.write(opts) → Uint8Array, MD.GeoTIFF.worldFile(origin, pixelSize) → .tfw 文字列
// 読み込み: MD.GeoTIFF.read(arrayBuffer, {maxSize}) → Promise<{width,height,srcWidth,srcHeight,rgba,epsg,corners,noData}>
(function (root) {
  root.MD = root.MD || {};

  // 地理座標系として扱う EPSG (GTModelType=2 + GeographicTypeGeoKey)
  var GEOGRAPHIC = { 4326: 1, 4258: 1, 4269: 1, 4301: 1, 4612: 1, 6668: 1, 4019: 1, 4167: 1 };

  // TIFF field types
  var T_SHORT = 3, T_LONG = 4, T_RATIONAL = 5, T_DOUBLE = 12;
  var TYPE_SIZE = { 3: 2, 4: 4, 5: 8, 12: 8 };

  var STRIP_TARGET = 256 * 1024;

  // ---- PackBits (行単位) ----
  function packBitsRow(src, start, len, out, pos) {
    var end = start + len, i = start;
    while (i < end) {
      // 連続 (run) の長さ
      var j = i + 1;
      while (j < end && j - i < 128 && src[j] === src[i]) j++;
      var run = j - i;
      if (run >= 3 || (run === 2 && i + 2 >= end)) {
        out[pos++] = (257 - run) & 0xFF; out[pos++] = src[i]; i = j;
        continue;
      }
      // literal: 次に 3 連続以上が始まるまで (最大 128)
      var k = i;
      while (k < end && k - i < 128) {
        if (k + 2 < end && src[k] === src[k + 1] && src[k] === src[k + 2]) break;
        k++;
      }
      if (k === i) k = i + 1;
      var n = k - i;
      out[pos++] = n - 1;
      for (var m = i; m < k; m++) out[pos++] = src[m];
      i = k;
    }
    return pos;
  }

  function write(opts) {
    var width = opts.width | 0, height = opts.height | 0;
    if (!(width > 0 && height > 0)) throw new Error('GeoTIFF.write: width/height が不正です');
    var rgba = opts.rgba;
    if (!rgba || rgba.length < width * height * 4) throw new Error('GeoTIFF.write: rgba の長さが width*height*4 未満です');
    var epsg = +opts.epsg;
    if (!(epsg > 0)) throw new Error('GeoTIFF.write: epsg が不正です');
    var origin = opts.origin || { x: 0, y: 0 };
    var ps = opts.pixelSize || { x: 1, y: 1 };
    var sx = Math.abs(+ps.x), sy = Math.abs(+ps.y);
    if (!(sx > 0 && sy > 0)) throw new Error('GeoTIFF.write: pixelSize が不正です');
    var comp = opts.compression || 'none';
    if (comp !== 'none' && comp !== 'packbits') {
      throw new Error('GeoTIFF.write: 未対応の圧縮形式: ' + comp + " ('none' | 'packbits')");
    }
    var packbits = comp === 'packbits';
    var ch = opts.noAlpha ? 3 : 4;
    var rowBytes = width * ch;
    var rps = Math.max(1, Math.min(height, Math.floor(STRIP_TARGET / rowBytes)));
    var nStrips = Math.ceil(height / rps);

    // ---- ピクセルデータ (strip ごと) ----
    var strips = []; // {data:Uint8Array} (packbits) or null (none: 直接コピー)
    var stripCounts = new Array(nStrips);
    var dataLen = 0;
    if (packbits) {
      var rowBuf = new Uint8Array(rowBytes);
      var worst = rowBytes + Math.ceil(rowBytes / 128) + 1;
      for (var s = 0; s < nStrips; s++) {
        var r0 = s * rps, r1 = Math.min(height, r0 + rps);
        var tmp = new Uint8Array(worst * (r1 - r0)), tp = 0;
        for (var r = r0; r < r1; r++) {
          var srcRow;
          if (ch === 4) {
            srcRow = rgba.subarray(r * width * 4, (r + 1) * width * 4);
          } else {
            var b = r * width * 4;
            for (var x = 0, q = 0; x < width; x++, b += 4) {
              rowBuf[q++] = rgba[b]; rowBuf[q++] = rgba[b + 1]; rowBuf[q++] = rgba[b + 2];
            }
            srcRow = rowBuf;
          }
          tp = packBitsRow(srcRow, 0, rowBytes, tmp, tp);
        }
        strips.push(tmp.subarray(0, tp));
        stripCounts[s] = tp;
        dataLen += tp;
      }
    } else {
      for (var s2 = 0; s2 < nStrips; s2++) {
        var rows = Math.min(height, (s2 + 1) * rps) - s2 * rps;
        stripCounts[s2] = rows * rowBytes;
      }
      dataLen = rowBytes * height;
    }

    // ---- タグ ----
    var geographic = !!GEOGRAPHIC[epsg];
    var geoKeys = geographic
      ? [[1024, 2], [1025, 1], [2048, epsg], [2054, 9102]]
      : [[1024, 1], [1025, 1], [3072, epsg], [3076, 9001]];
    var gkd = [1, 1, 0, geoKeys.length];
    geoKeys.forEach(function (k) { gkd.push(k[0], 0, 1, k[1]); });

    var bps = []; for (var c = 0; c < ch; c++) bps.push(8);
    var offsetsPlaceholder = new Array(nStrips);
    var tags = [
      [256, T_LONG, [width]],
      [257, T_LONG, [height]],
      [258, T_SHORT, bps],
      [259, T_SHORT, [packbits ? 32773 : 1]],
      [262, T_SHORT, [2]],
      [273, T_LONG, offsetsPlaceholder],
      [277, T_SHORT, [ch]],
      [278, T_LONG, [rps]],
      [279, T_LONG, stripCounts],
      [282, T_RATIONAL, [72, 1]],
      [283, T_RATIONAL, [72, 1]],
      [284, T_SHORT, [1]],
      [296, T_SHORT, [2]]
    ];
    if (ch === 4) tags.push([338, T_SHORT, [2]]);
    tags.push([33550, T_DOUBLE, [sx, sy, 0]]);
    tags.push([33922, T_DOUBLE, [0, 0, 0, +origin.x, +origin.y, 0]]);
    tags.push([34735, T_SHORT, gkd]);

    function valueBytes(t) {
      var cnt = t[1] === T_RATIONAL ? t[2].length / 2 : t[2].length;
      return cnt * TYPE_SIZE[t[1]];
    }

    var ifdOff = 8;
    var ifdSize = 2 + tags.length * 12 + 4;
    var extOff = ifdOff + ifdSize;
    var extLen = 0;
    tags.forEach(function (t) {
      var nb = valueBytes(t);
      if (nb > 4) { t.ext = extOff + extLen; extLen += nb + (nb & 1); }
    });
    var dataOff = extOff + extLen;
    dataOff += (8 - (dataOff % 8)) % 8;
    var total = dataOff + dataLen;
    if (total > 0xFFFFFFFF) throw new Error('GeoTIFF.write: 4GB を超えるため通常 TIFF で書けません');

    // strip offsets
    var off = dataOff;
    for (var s3 = 0; s3 < nStrips; s3++) { offsetsPlaceholder[s3] = off; off += stripCounts[s3]; }

    var out = new Uint8Array(total);
    var dv = new DataView(out.buffer);
    out[0] = 0x49; out[1] = 0x49; dv.setUint16(2, 42, true); dv.setUint32(4, ifdOff, true);
    dv.setUint16(ifdOff, tags.length, true);

    function writeVals(t, pos) {
      var v = t[2], i;
      switch (t[1]) {
        case T_SHORT: for (i = 0; i < v.length; i++) dv.setUint16(pos + i * 2, v[i], true); break;
        case T_LONG: for (i = 0; i < v.length; i++) dv.setUint32(pos + i * 4, v[i], true); break;
        case T_RATIONAL: for (i = 0; i < v.length; i++) dv.setUint32(pos + i * 4, v[i], true); break;
        case T_DOUBLE: for (i = 0; i < v.length; i++) dv.setFloat64(pos + i * 8, v[i], true); break;
      }
    }
    tags.forEach(function (t, i) {
      var p = ifdOff + 2 + i * 12;
      var cnt = t[1] === T_RATIONAL ? t[2].length / 2 : t[2].length;
      dv.setUint16(p, t[0], true);
      dv.setUint16(p + 2, t[1], true);
      dv.setUint32(p + 4, cnt, true);
      if (t.ext != null) { dv.setUint32(p + 8, t.ext, true); writeVals(t, t.ext); }
      else writeVals(t, p + 8);
    });
    dv.setUint32(ifdOff + 2 + tags.length * 12, 0, true);

    // pixels
    if (packbits) {
      for (var s4 = 0; s4 < nStrips; s4++) out.set(strips[s4], offsetsPlaceholder[s4]);
    } else if (ch === 4) {
      out.set(rgba.length === width * height * 4 ? rgba : rgba.subarray(0, width * height * 4), dataOff);
    } else {
      var n = width * height, si = 0, di = dataOff;
      for (var k = 0; k < n; k++, si += 4) {
        out[di++] = rgba[si]; out[di++] = rgba[si + 1]; out[di++] = rgba[si + 2];
      }
    }
    return out;
  }

  // .tfw (ピクセル中心基準): A, D, B, E, C, F
  function worldFile(origin, pixelSize) {
    var sx = Math.abs(+pixelSize.x), sy = Math.abs(+pixelSize.y);
    var lines = [sx, 0, 0, -sy, +origin.x + sx / 2, +origin.y - sy / 2];
    return lines.map(function (v) { return fmt(v); }).join('\r\n') + '\r\n';
  }
  function fmt(v) {
    if (v === 0) return '0.0000000000';
    var s = v.toFixed(10);
    return +s === v ? s : String(v);
  }

  // ---------------- 読み込み ----------------
  function lib() {
    var G = root.GeoTIFF;
    if (!G || typeof G.fromArrayBuffer !== 'function') {
      throw new Error('GeoTIFF ライブラリ (vendor/geotiff/geotiff.js) が読み込まれていません');
    }
    return G;
  }

  function toArrayBuffer(buf) {
    if (buf instanceof ArrayBuffer) return buf;
    if (ArrayBuffer.isView(buf)) {
      return buf.byteOffset === 0 && buf.byteLength === buf.buffer.byteLength
        ? buf.buffer : buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    }
    throw new Error('GeoTIFF.read: ArrayBuffer を渡してください');
  }

  function pixelToModelFn(image, fd, geoKeys) {
    var pointShift = geoKeys && geoKeys.GTRasterTypeGeoKey === 2 ? -0.5 : 0;
    var M = fd.ModelTransformation;
    if (M && M.length >= 16) {
      return function (i, j) {
        i += pointShift; j += pointShift;
        return { x: M[0] * i + M[1] * j + M[3], y: M[4] * i + M[5] * j + M[7] };
      };
    }
    var tp = fd.ModelTiepoint, sc = fd.ModelPixelScale;
    if (tp && tp.length >= 6 && sc && sc.length >= 2) {
      var I = tp[0], J = tp[1], X = tp[3], Y = tp[4], sx = sc[0], sy = sc[1];
      return function (i, j) {
        i += pointShift; j += pointShift;
        return { x: X + (i - I) * sx, y: Y - (j - J) * sy };
      };
    }
    return null;
  }

  function epsgOf(geoKeys) {
    if (!geoKeys) return null;
    var p = geoKeys.ProjectedCSTypeGeoKey;
    if (p && p !== 32767) return p;
    var g = geoKeys.GeographicTypeGeoKey;
    if (g && g !== 32767) return g;
    return null;
  }

  function isNoData(v, nd) {
    return nd != null && (v === nd || (nd !== nd && v !== v));
  }

  async function read(arrayBuffer, opts) {
    opts = opts || {};
    var maxSize = opts.maxSize || 4096;
    var G = lib();
    var tiff = await G.fromArrayBuffer(toArrayBuffer(arrayBuffer));
    var image = await tiff.getImage(0);
    var fd = image.fileDirectory;
    var srcW = image.getWidth(), srcH = image.getHeight();
    var scale = Math.min(1, maxSize / Math.max(srcW, srcH));
    var w = Math.max(1, Math.round(srcW * scale)), h = Math.max(1, Math.round(srcH * scale));
    var geoKeys = null;
    try { geoKeys = image.getGeoKeys(); } catch (e) { geoKeys = null; }
    var noData = null;
    try { noData = image.getGDALNoData(); } catch (e) { noData = null; }
    var spp = image.getSamplesPerPixel();
    var pi = fd.PhotometricInterpretation;
    var bps = fd.BitsPerSample ? fd.BitsPerSample[0] : 8;
    var fmtS = fd.SampleFormat ? fd.SampleFormat[0] : 1;
    var palette = (pi === 3 || spp === 1) && fd.ColorMap && fd.ColorMap.length ? fd.ColorMap : null;
    var extra = fd.ExtraSamples ? Array.prototype.slice.call(fd.ExtraSamples) : [];
    var resample = opts.resampleMethod ||
      (scale < 1 && (palette || noData != null) ? 'nearest' : 'bilinear');
    var rOpts = { interleave: true, width: w, height: h, resampleMethod: resample };
    var n = w * h;
    var rgba = new Uint8ClampedArray(n * 4);
    var i, k;

    if (pi === 5 || pi === 6 || pi === 8) {
      // CMYK / YCbCr (JPEG 等) / CIELab はライブラリの RGB 変換に任せる
      rOpts.enableAlpha = true;
      var rgb = await image.readRGB(rOpts);
      var cc = rgb.length / n;
      for (i = 0, k = 0; i < n; i++, k += cc) {
        rgba[i * 4] = rgb[k]; rgba[i * 4 + 1] = rgb[k + 1]; rgba[i * 4 + 2] = rgb[k + 2];
        rgba[i * 4 + 3] = cc >= 4 ? rgb[k + 3] : 255;
      }
    } else {
      var data = await image.readRasters(rOpts);
      var nb = spp;
      var colorBands = palette || spp < 3 ? 1 : 3;
      var alphaBand = -1;
      if (spp > colorBands) {
        var ex0 = extra[0];
        if (ex0 === 1 || ex0 === 2 || (ex0 == null && ((colorBands === 3 && spp === 4) || (colorBands === 1 && spp === 2)))) {
          alphaBand = colorBands;
        }
      }
      var is8 = bps === 8 && fmtS === 1;
      var lo = 0, hi = 255;
      if (!is8 && !palette) {
        lo = Infinity; hi = -Infinity;
        for (i = 0; i < n; i++) {
          for (var c = 0; c < colorBands; c++) {
            var v = data[i * nb + c];
            if (v !== v || isNoData(v, noData)) continue;
            if (v < lo) lo = v;
            if (v > hi) hi = v;
          }
        }
        if (!(hi >= lo)) { lo = 0; hi = 1; }
      }
      var span = hi - lo || 1;
      var alphaMax = is8 ? 255 : (fmtS === 3 ? 1 : Math.pow(2, bps) - 1);
      var cmN = palette ? palette.length / 3 : 0;
      var invert = pi === 0;
      for (i = 0, k = 0; i < n; i++, k += nb) {
        var o = i * 4, a = 255, nd = noData != null;
        if (palette) {
          var idx = data[k];
          rgba[o] = palette[idx] >> 8; rgba[o + 1] = palette[cmN + idx] >> 8; rgba[o + 2] = palette[2 * cmN + idx] >> 8;
          nd = nd && isNoData(idx, noData);
        } else {
          for (var c2 = 0; c2 < 3; c2++) {
            var sv = data[k + (colorBands === 3 ? c2 : 0)];
            if (nd && !isNoData(sv, noData)) nd = false;
            var u = is8 ? sv : (sv - lo) * 255 / span;
            if (invert) u = 255 - u;
            rgba[o + c2] = u;
          }
        }
        if (alphaBand >= 0) a = is8 ? data[k + alphaBand] : data[k + alphaBand] * 255 / alphaMax;
        if (nd) a = 0;
        rgba[o + 3] = a;
      }
    }

    var f = pixelToModelFn(image, fd, geoKeys);
    var corners = f ? { tl: f(0, 0), tr: f(srcW, 0), bl: f(0, srcH), br: f(srcW, srcH) } : null;
    var res = {
      width: w, height: h, srcWidth: srcW, srcHeight: srcH,
      rgba: rgba, epsg: epsgOf(geoKeys), corners: corners
    };
    if (noData != null) res.noData = noData;
    return res;
  }

  root.MD.GeoTIFF = { write: write, worldFile: worldFile, read: read };
})(typeof window !== 'undefined' ? window : globalThis);
