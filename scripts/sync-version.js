// バージョンの一元管理: package.json の "version" (0.0.0 形式) が唯一の情報源。
// このスクリプトが js/version.js を生成し、ブラウザ版/Electron版の両方から参照される。
// バージョンを上げるときは `npm version patch|minor|major --no-git-tag-version` → `npm run sync-version`。
const fs = require('fs');
const path = require('path');
const pkg = require('../package.json');
if (!/^\d+\.\d+\.\d+$/.test(pkg.version)) {
  console.error(`package.json version "${pkg.version}" は 0.0.0 形式ではありません`);
  process.exit(1);
}
const out = `// 自動生成ファイル (scripts/sync-version.js) — 直接編集しないこと。\n` +
  `(function (root) { root.MD = root.MD || {}; root.MD.VERSION = ${JSON.stringify(pkg.version)}; })(typeof window !== 'undefined' ? window : globalThis);\n`;
fs.writeFileSync(path.join(__dirname, '..', 'js', 'version.js'), out);
console.log('version', pkg.version);
