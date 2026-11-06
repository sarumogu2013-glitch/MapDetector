'use strict';
const test = require('node:test');
const assert = require('node:assert');
require('../js/grid.js');
const G = globalThis.MD.Grid;

const COLS = [
  { key: 'no', label: '点番号', type: 'text' },
  { key: 'name', label: '点名', type: 'text' },
  { key: 'x', label: 'X', type: 'number', decimals: 3 },
  { key: 'y', label: 'Y', type: 'number', decimals: 3 },
  { key: 'z', label: '標高', type: 'number', decimals: 3 }
];

test('parseNumber: basic, full-width, commas, minus variants', () => {
  assert.strictEqual(G.parseNumber('123.456'), 123.456);
  assert.strictEqual(G.parseNumber(' -35600.5 '), -35600.5);
  assert.strictEqual(G.parseNumber('１２３．５'), 123.5);
  assert.strictEqual(G.parseNumber('－１２３'), -123);
  assert.strictEqual(G.parseNumber('−6400'), -6400);   // U+2212
  assert.strictEqual(G.parseNumber('‐1'), -1);         // U+2010
  assert.strictEqual(G.parseNumber('ー2.5'), -2.5);    // 長音 (誤入力)
  assert.strictEqual(G.parseNumber('1,234,567.89'), 1234567.89);
  assert.strictEqual(G.parseNumber('１，２３４'), 1234);
  assert.strictEqual(G.parseNumber('+5'), 5);
  assert.strictEqual(G.parseNumber('.5'), 0.5);
  assert.strictEqual(G.parseNumber('1e3'), 1000);
  assert.strictEqual(G.parseNumber(42), 42);
});

test('parseNumber: empty → null, invalid → NaN', () => {
  assert.strictEqual(G.parseNumber(''), null);
  assert.strictEqual(G.parseNumber('   '), null);
  assert.strictEqual(G.parseNumber('　'), null);
  assert.strictEqual(G.parseNumber(null), null);
  assert.strictEqual(G.parseNumber(undefined), null);
  assert.ok(Number.isNaN(G.parseNumber('abc')));
  assert.ok(Number.isNaN(G.parseNumber('1.2.3')));
  assert.ok(Number.isNaN(G.parseNumber('12a')));
  assert.ok(Number.isNaN(G.parseNumber('-')));
  assert.ok(Number.isNaN(G.parseNumber('1-2')));
});

test('parseClipboard: simple TSV with CRLF and trailing newline', () => {
  assert.deepStrictEqual(G.parseClipboard('a\tb\tc\r\n1\t2\t3\r\n'), [['a', 'b', 'c'], ['1', '2', '3']]);
  assert.deepStrictEqual(G.parseClipboard('a\tb\n1\t2'), [['a', 'b'], ['1', '2']]);
  assert.deepStrictEqual(G.parseClipboard('x\r\ny\r\n'), [['x'], ['y']]);
  assert.deepStrictEqual(G.parseClipboard('single'), [['single']]);
  assert.deepStrictEqual(G.parseClipboard(''), []);
  assert.deepStrictEqual(G.parseClipboard('\r\n'), [['']]);
});

test('parseClipboard: empty cells kept', () => {
  assert.deepStrictEqual(G.parseClipboard('a\t\tc\r\n\t\t\r\n'), [['a', '', 'c'], ['', '', '']]);
  assert.deepStrictEqual(G.parseClipboard('a\t'), [['a', '']]);
});

test('parseClipboard: Excel quoted cells with tabs, newlines, quotes', () => {
  const t = '1\t"line1\r\nline2"\t3\r\n"say ""hi"""\t"a\tb"\t\r\n';
  assert.deepStrictEqual(G.parseClipboard(t), [['1', 'line1\nline2', '3'], ['say "hi"', 'a\tb', '']]);
  // 途中に引用符があるセルはリテラル
  assert.deepStrictEqual(G.parseClipboard('5"\t6'), [['5"', '6']]);
  // 閉じ引用符の後に文字が続く場合もリテラル扱い
  assert.deepStrictEqual(G.parseClipboard('"ab"c\td'), [['"ab"c', 'd']]);
});

test('parseClipboard: CSV-ish detection', () => {
  assert.deepStrictEqual(G.parseClipboard('1,BP,-35600,-6400\n2,IP1,-35500,-6300\n'), [['1', 'BP', '-35600', '-6400'], ['2', 'IP1', '-35500', '-6300']]);
  assert.deepStrictEqual(G.parseClipboard('a,"b,c",d'), [['a', 'b,c', 'd']]);
  // 桁区切りカンマ付き単一値は分割しない
  assert.deepStrictEqual(G.parseClipboard('1,234.5'), [['1,234.5']]);
  assert.deepStrictEqual(G.parseClipboard('1,234\r\n5,678\r\n'), [['1,234'], ['5,678']]);
  // タブがあればタブ優先
  assert.deepStrictEqual(G.parseClipboard('1,234\t5\r\n'), [['1,234', '5']]);
});

test('toTSV and round trip', () => {
  assert.strictEqual(G.toTSV([['a', 1.23456789, null], [undefined, '', -0.5]]), 'a\t1.23456789\t\r\n\t\t-0.5');
  const m = [['x\ty', 'line1\nline2', 'q"q'], ['1', '', '3']];
  const tsv = G.toTSV(m);
  assert.strictEqual(tsv, '"x\ty"\t"line1\nline2"\t"q""q"\r\n1\t\t3');
  assert.deepStrictEqual(G.parseClipboard(tsv), m);
  assert.strictEqual(G.toTSV([]), '');
});

test('convertValue / formatValue / isInvalid', () => {
  const num = COLS[2], txt = COLS[1];
  assert.strictEqual(G.convertValue(num, '１２．５'), 12.5);
  assert.strictEqual(G.convertValue(num, ''), null);
  assert.strictEqual(G.convertValue(num, 'abc'), 'abc');
  assert.strictEqual(G.convertValue(txt, 12), '12');
  assert.strictEqual(G.formatValue(num, -35600), '-35600.000');
  assert.strictEqual(G.formatValue(num, 1.23456), '1.235');
  assert.strictEqual(G.formatValue(num, null), '');
  assert.strictEqual(G.formatValue(num, 'abc'), 'abc');
  assert.strictEqual(G.formatValue({ type: 'number' }, 1.23456), '1.23456');
  assert.ok(G.isInvalid(num, 'abc'));
  assert.ok(!G.isInvalid(num, 1));
  assert.ok(!G.isInvalid(num, null));
  assert.ok(!G.isInvalid(txt, 'abc'));
});

test('applyPaste: in place, conversion, original untouched, extra keys preserved', () => {
  const rows = [
    { no: '1', name: 'BP', x: 0, y: 0, z: 0, extra: 'keep' },
    { no: '2', name: 'IP1', x: 10, y: 10, z: 1 }
  ];
  const before = JSON.stringify(rows);
  const out = G.applyPaste(rows, COLS, 0, 2, [['１００．５', '-200'], ['bad', '']], null);
  assert.strictEqual(JSON.stringify(rows), before, 'input not mutated');
  assert.notStrictEqual(out, rows);
  assert.deepStrictEqual(out[0], { no: '1', name: 'BP', x: 100.5, y: -200, z: 0, extra: 'keep' });
  assert.deepStrictEqual(out[1], { no: '2', name: 'IP1', x: 'bad', y: null, z: 1 });
});

test('applyPaste: appends rows beyond end via newRow, ignores overflow columns', () => {
  const rows = [{ no: '1', name: 'A', x: 1, y: 2, z: 3 }];
  const calls = [];
  const newRow = (i) => { calls.push(i); return { no: String(i + 1), name: '', x: null, y: null, z: null, src: 'new' }; };
  const out = G.applyPaste(rows, COLS, 0, 3, [['5', '6', 'overflow'], ['7', '8'], ['9', '10']], newRow);
  assert.strictEqual(out.length, 3);
  assert.deepStrictEqual(calls, [1, 2]);
  assert.deepStrictEqual(out[0], { no: '1', name: 'A', x: 1, y: 5, z: 6 });
  assert.deepStrictEqual(out[2], { no: '3', name: '', x: null, y: 9, z: 10, src: 'new' });
  assert.strictEqual(rows.length, 1);
});

test('applyPaste: default new row when no factory; gap rows filled; readOnly skipped', () => {
  const cols = [{ key: 'a', type: 'text' }, { key: 'b', type: 'number', readOnly: true }, { key: 'c', type: 'number' }];
  const out = G.applyPaste([], cols, 2, 0, [['x', '1', '2']]);
  assert.strictEqual(out.length, 3);
  assert.deepStrictEqual(out[0], { a: '', b: null, c: null });
  assert.deepStrictEqual(out[2], { a: 'x', b: null, c: 2 });
});
