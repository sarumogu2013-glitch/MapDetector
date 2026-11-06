# Module contracts (shared by all modules)

All renderer JS is classic scripts (no ES modules, so index.html works from file://).
Every module uses this UMD wrapper and attaches to the global `MD` namespace:

```js
(function (root) {
  root.MD = root.MD || {};
  root.MD.Foo = { ... };
})(typeof window !== 'undefined' ? window : globalThis);
```
Node tests load them with `require('../js/foo.js')` and then read `globalThis.MD.Foo`.
Tests use `node:test` + `node:assert` and live in `tests/<module>.test.js` (`npm test` = `node --test tests/`).
No external npm deps in renderer modules.

## Coordinates
Internal plane coordinates are **{e, n}** in metres: e = easting = 平面直角座標 **Y**, n = northing = 平面直角座標 **X**.
Angles/headings: radians, math convention in the e–n plane (0 = +e/east, CCW positive, π/2 = north).
In UI/export, show Japanese convention X (=n), Y (=e).

## Shapes (vector features, plane coords)
```
{type:'polyline', pts:[{e,n},...], closed:bool, layer:string, color:'#rrggbb'}   // optional noVertexSnap:true (tessellated curve: only first/last vertex snap as end, no mid)
{type:'circle',   c:{e,n}, r, layer, color}
{type:'arc',      c:{e,n}, r, a0, a1, layer, color}   // CCW from a0 to a1 (radians, math convention)
{type:'point',    p:{e,n}, layer, color, name?}
{type:'text',     p:{e,n}, text, h, rot, layer, color}
```

## MD.JPRCS  (js/jprcs.js) — JGD2011 平面直角座標系 I–XIX, GRS80, m0=0.9999
- `ORIGINS` : index 1..19 → {lat, lon} in degrees
- `toPlane(lat, lon, zone)` → {e, n}
- `toLatLng(e, n, zone)` → {lat, lng}
- `guessZone(lat, lon)` → zone number (nearest origin; good enough default)

## MD.Alignment  (js/alignment.js)
- `build(ips, opts)` ; ips = [{e,n, R?, A1?, A2?, name?}] (first = BP, last = EP; R/A only meaningful on intermediate IPs; R=0/absent → no curve (angle point)).
  Returns `{elements:[{type:'line'|'arc'|'clothoid', s0, len, p0:{e,n}, h0, k0, k1}], length, keyPoints:[{s, name, ipIndex}], warnings:[string]}`.
  Curvature k positive = left turn. keyPoint names: 'BP','EP','BC','EC','SP'(curve mid),'KA1','KE1','KE2','KA2' (with ipIndex), and 'IP' for angle points.
- `pointAt(al, s)` → {e, n, h}  (clamped to [0,length])
- `stations(al, {pitch=20, sub=0, startChainage=0, includeKeyPoints=true, endInclude=true})` → [{s, chainage, label, kind:'main'|'sub'|'key', keyName?}] sorted by s. Label 'No.3', 'No.3+10.00'; key: label like 'BC1 No.5+3.21'.
- `fishbone(al, stations, {left, right})` → [{station, c:{e,n}, l:{e,n}, r:{e,n}, h}]  (l = left side point at distance left, r = right at distance right, perpendicular to heading)
- `sample(al, step=1)` → [{e,n}] centerline (includes element boundaries)
- `offset(al, d, step=1)` → [{e,n}] parallel line, d>0 left, d<0 right

## MD.SIMA  (js/sima.js)
- `decode(arrayBuffer)` → string (UTF-8 if valid, else Shift_JIS via TextDecoder('shift_jis'))
- `parse(text)` → `{title, points:[{no,name,e,n,z}], routes:[{no,name, ips:[{name,e,n,R,A1,A2}], warnings:[]}], parcels:[{no,name,pts:[{e,n,name}]}], warnings:[]}`
  (A01 records: `A01,点番号,点名,X座標,Y座標,標高` → n=X, e=Y)
- `exportPoints(points, title)` → string with CRLF line endings (G00/Z00/A00/A01/A99)

## MD.DXF  (js/dxf.js)
- `decode(arrayBuffer)` → string (honours $DWGCODEPAGE ANSI_932 → shift_jis; else UTF-8 if valid else shift_jis)
- `parse(text, {swapXY=false, scale=1, offsetE=0, offsetN=0})` → `{shapes:[...Shape], layers:[{name, color}], bounds:{minE,minN,maxE,maxN}|null, warnings:[]}`
  Default DXF x → e, y → n. swapXY: x → n, y → e.

## MD.Snap  (js/snap.js)
- `new MD.Snap.Index(cellSize=50)`; `setGroup(id, shapes)`, `removeGroup(id)`, `clear()`
- `query(p{e,n}, tol, modes)` → `{p:{e,n}, kind, shape}` or null.
  modes = {end, mid, near, inter, center, node} booleans. kinds: 'end','mid','near','inter','center','node'.
  Priority within tol: node/end/center/inter beat mid beat near; ties by distance.
