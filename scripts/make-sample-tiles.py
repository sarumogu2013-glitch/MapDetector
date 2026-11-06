"""テスト用ダミータイル (XYZ, z/x/y.png) を生成する。
usage: python3 scripts/make-sample-tiles.py OUT_DIR [lat lon] [zmin zmax]
"""
import math, os, sys
from PIL import Image, ImageDraw

out = sys.argv[1]
lat = float(sys.argv[2]) if len(sys.argv) > 2 else 35.681
lon = float(sys.argv[3]) if len(sys.argv) > 3 else 139.767
zmin = int(sys.argv[4]) if len(sys.argv) > 4 else 14
zmax = int(sys.argv[5]) if len(sys.argv) > 5 else 17

def tile(lat, lon, z):
    n = 2 ** z
    x = (lon + 180) / 360 * n
    y = (1 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2 * n
    return int(x), int(y)

for z in range(zmin, zmax + 1):
    cx, cy = tile(lat, lon, z)
    r = 2 + (z - zmin)
    for x in range(cx - r, cx + r + 1):
        for y in range(cy - r, cy + r + 1):
            im = Image.new('RGB', (256, 256), ((x * 37) % 80 + 170, (y * 53) % 80 + 170, 200 - (z * 9) % 60))
            d = ImageDraw.Draw(im)
            d.rectangle([0, 0, 255, 255], outline=(90, 90, 90))
            d.text((8, 8), f'z{z}\n{x}\n{y}', fill=(20, 20, 20))
            os.makedirs(f'{out}/{z}/{x}', exist_ok=True)
            im.save(f'{out}/{z}/{x}/{y}.png')
print('done', out)
