"""Front + side view of a rigged character.glb with its joints, for eyeballing a rig.

    python3 tools/motion-video/rig_check.py character.glb report.json out.png
"""
import json, struct, sys
import numpy as np
from PIL import Image, ImageDraw

glb, rep, out = sys.argv[1:4]
b = open(glb, "rb").read()
jl = struct.unpack("<I", b[12:16])[0]
j = json.loads(b[20:20 + jl])
bin0 = 20 + jl + 8
pts = []
for m in j["meshes"]:
    for p in m["primitives"]:
        a = j["accessors"][p["attributes"]["POSITION"]]
        bv = j["bufferViews"][a["bufferView"]]
        off = bin0 + bv.get("byteOffset", 0) + a.get("byteOffset", 0)
        stride = bv.get("byteStride", 12)
        arr = np.frombuffer(b, dtype=np.uint8, count=stride * a["count"], offset=off).reshape(a["count"], stride)
        pts.append(arr[:, :12].copy().view(np.float32).reshape(-1, 3))
P = np.concatenate(pts)
J = json.load(open(rep))["joints"]
S, M = 600, 30
lo, hi = P.min(0), P.max(0)
sc = (S - 2 * M) / max(hi[1] - lo[1], hi[0] - lo[0], 1)
img = Image.new("RGB", (2 * S, S), "white")
d = ImageDraw.Draw(img)
for k, (ax, ox) in enumerate(((0, 0), (2, S))):         # front: x/y · side: z/y
    xs = (P[:, ax] - (lo[ax] + hi[ax]) / 2) * sc + S / 2 + ox
    ys = S - M - (P[:, 1] - lo[1]) * sc
    for x, y in zip(xs[::3], ys[::3]):
        d.point((x, y), fill=(150, 150, 170))
    for name, v in J.items():
        x = (v[ax] - (lo[ax] + hi[ax]) / 2) * sc + S / 2 + ox
        y = S - M - (v[1] - lo[1]) * sc
        d.ellipse((x - 4, y - 4, x + 4, y + 4), fill=(220, 20, 20))
img.save(out)
