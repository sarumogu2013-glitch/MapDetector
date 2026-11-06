// TREND-ONE 形式 (要素レコード C01/C02 の後に C04,点番号,IP名) の線形SIMA
const test = require('node:test');
const assert = require('node:assert');
require('../js/sima.js');
require('../js/alignment.js');
const { SIMA, Alignment } = globalThis.MD;

// 既知の線形 (BP→IP1 R=200 右カーブ→EP) から SIMA を合成
const ipsTrue = [{ name: 'KP=1000', e: 0, n: 0 }, { name: 'IP.1', e: 0, n: 300, R: 200 }, { name: 'KP=1600', e: 250, n: 500 }];
const al = Alignment.build(ipsTrue, {});
const start = 1000;
const kp = al.keyPoints.filter(k => ['BC', 'SP', 'EC'].includes(k.name));
const fmt = v => v.toFixed(3);
let no = 1;
const A = [], P = {};
function pt(name, e, n) { const k = no++; A.push(`A01,${k},${name},${fmt(n)},${fmt(e)},0.000,`); P[name] = k; return k; }
pt('KP=1000', 0, 0); pt('IP.1', 0, 300); pt('KP=1600', 250, 500);
const sta = [];
for (let c = 1000; c <= 1000 + al.length; c += 20) sta.push(c);
kp.forEach(k => sta.push(start + k.s));
sta.sort((a, b) => a - b);
sta.forEach(c => { const q = Alignment.pointAt(al, c - start); pt(String(+c.toFixed(2)), q.e, q.n); });
const L = [];
sta.forEach(c => { const q = Alignment.pointAt(al, c - start); pt(+c.toFixed(2) + '_L10', q.e - Math.sin(q.h) * 10, q.n + Math.cos(q.h) * 10); });
const kpName = k => String(+(start + k.s).toFixed(2));
const lines = ['Z00, /* TEST */,', 'G00,03,テスト工区,', 'A00,', ...A, 'A99,',
  'F00,1,1,IP線,1,', `B01,${P['KP=1000']},KP=1000,`, `B01,${P['IP.1']},IP.1,`, `B01,${P['KP=1600']},KP=1600,`, 'F99,',
  'F00,3,1,中心線,3,', 'F03,1000.000,  100.000,  100.000,'];
let inCurve = false;
sta.forEach(c => {
  const nm = String(+c.toFixed(2));
  lines.push(`B01,${P[nm]},${nm},`, `B03,${c.toFixed(3)},`);
  const k = kp.find(x => kpName(x) === nm);
  if (k && k.name !== 'EC') lines.push('C01,0,-200.000,', `C04,${P['IP.1']},IP.1,`);
});
lines.push('F99,', 'F00,4,1,巾杭 左 1,4,');
sta.forEach(c => { const nm = String(+c.toFixed(2)); lines.push(`B01,${P[nm + '_L10']},${nm}_L10,`, `B04,0,${nm},${c.toFixed(3)},   10.000,`); });
lines.push('F99,');
const text = lines.join('\r\n');

test('TREND 形式: 半径・路線名・追加距離・幅員を読む', () => {
  const r = SIMA.parse(text);
  assert.strictEqual(r.routes.length, 1);
  const rt = r.routes[0];
  assert.match(rt.name, /中心線/);
  assert.deepStrictEqual(rt.ips.map(p => p.R), [0, 200, 0]);
  assert.strictEqual(rt.ips[1].name, 'IP.1');
  assert.strictEqual(rt.ips[1].dir, 'R');
  assert.strictEqual(rt.startChainage, 1000);
  assert.strictEqual(rt.pitch, 20);
  assert.strictEqual(rt.widths.left, 10);
  assert.deepStrictEqual(r.lines.map(l => l.name), ['IP線', '巾杭 左 1']);
  assert.deepStrictEqual(rt.warnings, []);
});

test('TREND 形式: 計算した線形がファイルの測点・幅杭と一致', () => {
  const rt = SIMA.parse(text).routes[0];
  const a2 = Alignment.build(rt.ips, {});
  let mx = 0;
  rt.check.forEach(c => {
    assert.ok(c.sideKnown, c.name);
    const q = Alignment.pointAt(a2, c.chainage - rt.startChainage);
    mx = Math.max(mx, Math.hypot(q.e - Math.sin(q.h) * c.off - c.e, q.n + Math.cos(q.h) * c.off - c.n));
  });
  assert.ok(rt.check.length > 40);
  assert.ok(mx < 0.002, 'max diff ' + mx);
});

test('TREND 形式: 幅杭の参照線は追加距離順', () => {
  // 最後の B01 が途中の測点 (実ファイルで 69760_L20 が末尾にあるケース)
  const t2 = text.replace('F00,4,1,巾杭 左 1,4,', 'F00,4,1,巾杭 左 1,4,\r\nB01,' + P['1020_L10'] + ',1020_L10,\r\nB04,0,1020,1020.000,   10.000,');
  const r = SIMA.parse(t2);
  const ln = r.lines.find(l => /左/.test(l.name));
  assert.strictEqual(ln.pts[1].name, '1020_L10');
});
