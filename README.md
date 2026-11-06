# MapDetector

ローカルの地図タイル (z/x/y.png) をスムーズに表示し、クリックで座標を取得するデスクトップアプリ (Windows / Electron)。
図面 (DXF・画像・GeoJSON) と線形SIMAを重ねて表示でき、線形には指定した幅員の横断線を魚の骨のように描画します。

## 主な機能
- **タイルフォルダを開く**: `z/x/y.png|jpg|webp` 構造を自動検出します (1〜3階層下にあっても検出)。`tilemapresource.xml` があればTMS(Y反転)と判定し、手動でも切り替えられます。デスクトップ版は独自プロトコル `mdtile://` で直接配信し、ネイティブズーム外は拡大縮小で表示します。
- **座標取得**: 取得モード (P) でクリックすると、平面直角座標 X/Y (JGD2011 I〜XIX系) と緯度経度を記録します。CSV、SIMA (Shift_JIS)、クリップボードに出力できます。
- **スナップ**: 端点・中点・交点・円/円弧の中心・点・線上 (最近点)。図面、線形の中心線、幅員線、横断線、IP、主要点のすべてが対象です。Alt を押している間はスナップを無効にします。
- **図面オーバーレイ**: DXF (R12〜, Shift_JIS対応, ブロック/バルジ/円弧) は平面直角座標として配置します。XY入替と単位 (m/cm/mm) を指定できます。画像は3点ハンドルで位置合わせし、GeoJSON にも対応します。
- **線形SIMA**: IP、曲線半径R、クロソイドA1/A2から中心線を計算します。表示するもの:
  - 測点 (No.k+端数) と中間点
  - 主要点 (BC/EC/SP/KA/KE)
  - 左右幅員の横断線 (魚の骨)
  - 幅員線
  
  IP表は画面で編集できます。取得点からIPを作ることもできます。カーソル位置と取得点には、測点と中心線からの離れ (左+/右−) を表示します。横断線の座標はCSVで出力できます。
- **背景地図**: 地理院タイル (淡色/標準/写真) を任意で表示できます。

## 開発
```bash
npm install
```
```bash
npm start
```
```bash
npm test
```
ブラウザ版として `index.html` を Chrome/Edge で直接開いても動きます (File System Access API を使用。Shift_JIS での保存はデスクトップ版のみ)。

テスト用のダミータイルは次で生成できます。
```bash
python3 scripts/make-sample-tiles.py /path/to/tiles
```
サンプルは `samples/` にあります。

## バージョンと自動更新
- バージョンは `package.json` の `version` (0.0.0 形式) だけで管理します。`npm run sync-version` で `js/version.js` を生成し、`npm start` と `npm run build` の前には自動で実行されます。
- リリース手順: 次を実行し、コミットしてから `v0.1.1` のようなタグを push します。`.github/workflows/release.yml` が Windows インストーラを作って GitHub Releases に公開し、インストール済みのアプリは起動時と6時間ごとに更新を確認して自動更新します。
  ```bash
  npm version patch --no-git-tag-version
  ```
- 自動更新 (electron-updater) はトークンなしで GitHub Releases を読むため、**リポジトリは public である必要があります**。
- ビルドは今は `windows-latest` で行います。セルフホストランナー (SARU_MOGU3) をこのリポジトリに登録すれば、`runs-on: [self-hosted, Windows, X64]` に切り替えられます。

## 構成
| ファイル | 内容 |
|---|---|
| `electron/main.js`, `preload.js` | ウィンドウ、メニュー、`mdtile://`、ファイルIO、自動更新 |
| `js/menu-def.js` | メニュー定義 (ネイティブメニューとブラウザ版HTMLメニューで共通) |
| `js/app.js` | 画面ロジック |
| `js/tiles.js` | ローカルタイル |
| `js/imageoverlay.js` | 画像位置合わせ |
| `js/jprcs.js` | 平面直角座標変換 (pyproj と比べて誤差 < 1mm) |
| `js/alignment.js` | 線形計算 |
| `js/sima.js`, `js/dxf.js` | SIMA / DXF 読み書き |
| `js/snap.js` | スナップ (空間インデックス) |
| `docs/CONTRACTS.md` | モジュール間の仕様 |

SIMA の路線レコード (F00〜F99, C00〜C99) はメーカーによって項目が違うため、寛容に解釈しています。読み込み結果が違う場合は、実際のファイルを共有してもらえれば合わせます。
