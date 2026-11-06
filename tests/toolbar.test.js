'use strict';
const test = require('node:test');
const assert = require('node:assert');
require('../js/toolbar.js');
const TB = globalThis.MD.Toolbar;

test('DEFAULT_ITEMS: ids unique, label/icon/title present', () => {
  const ids = TB.DEFAULT_ITEMS.map((it) => it.id);
  assert.strictEqual(new Set(ids).size, ids.length);
  assert.strictEqual(ids.length, 17);
  for (const it of TB.DEFAULT_ITEMS) {
    assert.ok(it.label, it.id + ' label');
    assert.ok(it.title, it.id + ' title');
    assert.ok(TB.ICONS[it.icon], it.id + ' icon ' + it.icon);
  }
});

test('DEFAULT_ITEMS: order, groups contiguous, toggles', () => {
  const groups = [];
  for (const it of TB.DEFAULT_ITEMS) if (groups[groups.length - 1] !== it.group) groups.push(it.group);
  assert.deepStrictEqual(groups, ['ファイル', '読込', '操作', '表示', '編集', '出力']);
  assert.strictEqual(TB.DEFAULT_ITEMS[0].id, 'file.new');
  assert.strictEqual(TB.DEFAULT_ITEMS[TB.DEFAULT_ITEMS.length - 1].id, 'file.print');
  const toggles = TB.DEFAULT_ITEMS.filter((it) => it.toggle).map((it) => it.id);
  assert.deepStrictEqual(toggles, ['tool.pick', 'tool.snapToggle']);
});

test('iconSvg uses currentColor 18px', () => {
  const s = TB.iconSvg('pick');
  assert.match(s, /stroke="currentColor"/);
  assert.match(s, /width="18"/);
});
