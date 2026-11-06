// 平面直角座標系 (JGD2011, 系 I〜XIX) — GRS80, m0 = 0.9999
// 国土地理院 河瀬 (2011) の n 級数による Gauss–Krüger 投影 (順算・逆算, 精度 < 1 mm)
(function (root) {
  root.MD = root.MD || {};

  var a = 6378137.0;
  var F = 298.257222101;
  var m0 = 0.9999;
  var n = 1 / (2 * F - 1);           // n = f / (2 - f)
  var DEG = Math.PI / 180;

  function dms(d, m, s) { return d + (m || 0) / 60 + (s || 0) / 3600; }

  // 原点 (緯度, 経度) [deg]
  var ORIGINS = {
    1: { lat: 33, lon: dms(129, 30) },
    2: { lat: 33, lon: 131 },
    3: { lat: 36, lon: dms(132, 10) },
    4: { lat: 33, lon: dms(133, 30) },
    5: { lat: 36, lon: dms(134, 20) },
    6: { lat: 36, lon: 136 },
    7: { lat: 36, lon: dms(137, 10) },
    8: { lat: 36, lon: dms(138, 30) },
    9: { lat: 36, lon: dms(139, 50) },
    10: { lat: 40, lon: dms(140, 50) },
    11: { lat: 44, lon: dms(140, 15) },
    12: { lat: 44, lon: dms(142, 15) },
    13: { lat: 44, lon: dms(144, 15) },
    14: { lat: 26, lon: 142 },
    15: { lat: 26, lon: dms(127, 30) },
    16: { lat: 26, lon: 124 },
    17: { lat: 26, lon: 131 },
    18: { lat: 20, lon: 136 },
    19: { lat: 26, lon: 154 }
  };

  var n2 = n * n, n3 = n2 * n, n4 = n3 * n, n5 = n4 * n, n6 = n5 * n;

  // 子午線弧長係数
  var A0 = 1 + n2 / 4 + n4 / 64;
  var Aj = [
    -3 / 2 * (n - n3 / 8 - n5 / 64),
    15 / 16 * (n2 - n4 / 4),
    -35 / 48 * (n3 - 5 / 16 * n5),
    315 / 512 * n4,
    -693 / 1280 * n5
  ];
  var alpha = [
    n / 2 - 2 * n2 / 3 + 5 * n3 / 16 + 41 * n4 / 180 - 127 * n5 / 288,
    13 * n2 / 48 - 3 * n3 / 5 + 557 * n4 / 1440 + 281 * n5 / 630,
    61 * n3 / 240 - 103 * n4 / 140 + 15061 * n5 / 26880,
    49561 * n4 / 161280 - 179 * n5 / 168,
    34729 * n5 / 80640
  ];
  var beta = [
    n / 2 - 2 * n2 / 3 + 37 * n3 / 96 - n4 / 360 - 81 * n5 / 512,
    n2 / 48 + n3 / 15 - 437 * n4 / 1440 + 46 * n5 / 105,
    17 * n3 / 480 - 37 * n4 / 840 - 209 * n5 / 4480,
    4397 * n4 / 161280 - 11 * n5 / 504,
    4583 * n5 / 161280
  ];
  var delta = [
    2 * n - 2 * n2 / 3 - 2 * n3 + 116 * n4 / 45 + 26 * n5 / 45 - 2854 * n6 / 675,
    7 * n2 / 3 - 8 * n3 / 5 - 227 * n4 / 45 + 2704 * n5 / 315 + 2323 * n6 / 945,
    56 * n3 / 15 - 136 * n4 / 35 - 1262 * n5 / 105 + 73814 * n6 / 2835,
    4279 * n4 / 630 - 332 * n5 / 35 - 399572 * n6 / 14175,
    4174 * n5 / 315 - 144838 * n6 / 6237,
    601676 * n6 / 22275
  ];

  var Abar = m0 * a / (1 + n) * A0;
  var twoSqrtN = 2 * Math.sqrt(n) / (1 + n);

  function atanh(x) { return 0.5 * Math.log((1 + x) / (1 - x)); }

  // 赤道から緯度 phi [rad] までの子午線弧長 × m0
  function meridianArc(phi) {
    var s = A0 * phi;
    for (var j = 0; j < 5; j++) s += Aj[j] * Math.sin(2 * (j + 1) * phi);
    return m0 * a / (1 + n) * s;
  }

  var Sbar = {};
  function originArc(zone) {
    if (Sbar[zone] === undefined) Sbar[zone] = meridianArc(ORIGINS[zone].lat * DEG);
    return Sbar[zone];
  }

  function checkZone(zone) {
    zone = Number(zone);
    if (!ORIGINS[zone]) throw new Error('JPRCS: invalid zone ' + zone);
    return zone;
  }

  function toPlane(lat, lon, zone) {
    zone = checkZone(zone);
    var phi = lat * DEG;
    var dl = (lon - ORIGINS[zone].lon) * DEG;
    var sp = Math.sin(phi);
    var t = Math.sinh(atanh(sp) - twoSqrtN * atanh(twoSqrtN * sp));
    var tb = Math.sqrt(1 + t * t);
    var lc = Math.cos(dl), ls = Math.sin(dl);
    var xi = Math.atan2(t, lc);
    var eta = atanh(ls / tb);
    var x = xi, y = eta;
    for (var j = 0; j < 5; j++) {
      var k = 2 * (j + 1);
      x += alpha[j] * Math.sin(k * xi) * Math.cosh(k * eta);
      y += alpha[j] * Math.cos(k * xi) * Math.sinh(k * eta);
    }
    return { e: Abar * y, n: Abar * x - originArc(zone) };
  }

  function toLatLng(e, nn, zone) {
    zone = checkZone(zone);
    var xi = (nn + originArc(zone)) / Abar;
    var eta = e / Abar;
    var xp = xi, ep = eta;
    for (var j = 0; j < 5; j++) {
      var k = 2 * (j + 1);
      xp -= beta[j] * Math.sin(k * xi) * Math.cosh(k * eta);
      ep -= beta[j] * Math.cos(k * xi) * Math.sinh(k * eta);
    }
    var chi = Math.asin(Math.sin(xp) / Math.cosh(ep));
    var phi = chi;
    for (var i = 0; i < 6; i++) phi += delta[i] * Math.sin(2 * (i + 1) * chi);
    var lam = Math.atan2(Math.sinh(ep), Math.cos(xp));
    return { lat: phi / DEG, lng: ORIGINS[zone].lon + lam / DEG };
  }

  // 最寄りの原点 (経度差は cos(lat) で補正) — 既定値の推定用
  function guessZone(lat, lon) {
    var best = 9, bd = Infinity;
    var cl = Math.cos(lat * DEG);
    for (var z = 1; z <= 19; z++) {
      var o = ORIGINS[z];
      var dy = lat - o.lat, dx = (lon - o.lon) * cl;
      var d = dx * dx + dy * dy;
      if (d < bd) { bd = d; best = z; }
    }
    return best;
  }

  var ROMAN = ['', 'I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X',
    'XI', 'XII', 'XIII', 'XIV', 'XV', 'XVI', 'XVII', 'XVIII', 'XIX'];

  root.MD.JPRCS = {
    ORIGINS: ORIGINS,
    ROMAN: ROMAN,
    EPSG: function (zone) { return 6668 + checkZone(zone); },
    toPlane: toPlane,
    toLatLng: toLatLng,
    guessZone: guessZone,
    meridianArc: meridianArc
  };
})(typeof window !== 'undefined' ? window : globalThis);
