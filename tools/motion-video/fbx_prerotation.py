"""Fold each bone's rest Lcl Rotation into PreRotation in a binary FBX.

    python3 fbx_prerotation.py in.fbx out.fbx

Mixamo FBX files keep a bone's rest orientation in PreRotation and leave Lcl
Rotation at zero, and Motion2MixamoRig's FK (T · PreRotation · R_anim) relies on
that. Blender's FBX exporter cannot write PreRotation: it puts the rest
orientation (including the Z-up → Y-up axis change, on the root bone) into Lcl
Rotation. This rewrites every LimbNode so PreRotation' = PreRotation · Lcl
Rotation and Lcl Rotation = 0, sets RotationActive = 1, and leaves everything
else byte-for-byte. The world rest pose, bind pose and skin are unchanged:
T · Rpre' · I is the same matrix as T · Rpre · R.

Pure Python (struct + math), so it runs inside Blender's Python or system python3.
"""

import math
import struct
import sys

MAGIC = b"Kaydara FBX Binary  \x00"


# ---- node tree ------------------------------------------------------------------
class Node:
    __slots__ = ("name", "nprops", "props", "children", "has_null")

    def __init__(self, name, nprops, props, children, has_null):
        self.name, self.nprops, self.props, self.children, self.has_null = name, nprops, props, children, has_null


def _read_node(data, pos, big):
    fmt, hdr = ("<QQQ", 24) if big else ("<III", 12)
    end, nprops, plen = struct.unpack_from(fmt, data, pos)
    pos += hdr
    namelen = data[pos]
    pos += 1
    if end == 0:
        return None, pos
    name = bytes(data[pos:pos + namelen])
    pos += namelen
    props = bytes(data[pos:pos + plen])
    pos += plen
    children, has_null = [], False
    if pos < end:
        has_null = True
        while pos < end:
            child, pos = _read_node(data, pos, big)
            if child is None:
                break
            children.append(child)
    return Node(name, nprops, props, children, has_null), end


def _write_node(n, start, big):
    fmt, hdr = ("<QQQ", 24) if big else ("<III", 12)
    head_len = hdr + 1 + len(n.name) + len(n.props)
    body = bytearray()
    pos = start + head_len
    for c in n.children:
        b = _write_node(c, pos, big)
        body += b
        pos += len(b)
    if n.has_null or n.children:
        body += b"\x00" * (hdr + 1)
    end = start + head_len + len(body)
    return struct.pack(fmt, end, n.nprops, len(n.props)) + bytes([len(n.name)]) + n.name + n.props + bytes(body)


def read_fbx(data):
    if not data.startswith(MAGIC):
        raise ValueError("not a binary FBX")
    version = struct.unpack_from("<I", data, 23)[0]
    big = version >= 7500
    pos, nodes = 27, []
    while True:
        node, pos = _read_node(data, pos, big)
        if node is None:
            break
        nodes.append(node)
    return data[:27], nodes, data[pos:], big


def write_fbx(header, nodes, footer, big):
    out = bytearray(header)
    for n in nodes:
        out += _write_node(n, len(out), big)
    out += b"\x00" * (25 if big else 13)
    out += footer
    return bytes(out)


# ---- primitive property lists (P records) ----------------------------------------
def parse_props(raw):
    vals, pos = [], 0
    while pos < len(raw):
        t = chr(raw[pos])
        pos += 1
        if t in "SR":
            ln = struct.unpack_from("<I", raw, pos)[0]
            pos += 4
            vals.append((t, raw[pos:pos + ln]))
            pos += ln
        else:
            fmt = {"Y": "<h", "C": "<?", "I": "<i", "F": "<f", "D": "<d", "L": "<q"}.get(t)
            if fmt is None:
                raise ValueError(f"array property {t!r} in a P record")
            vals.append((t, struct.unpack_from(fmt, raw, pos)[0]))
            pos += struct.calcsize(fmt)
    return vals


def pack_props(vals):
    out = bytearray()
    for t, v in vals:
        out += t.encode()
        if t in "SR":
            out += struct.pack("<I", len(v)) + v
        else:
            out += struct.pack({"Y": "<h", "C": "<?", "I": "<i", "F": "<f", "D": "<d", "L": "<q"}[t], v)
    return bytes(out)


def P(name, typ, label, flags, *values):
    vals = [("S", name.encode()), ("S", typ.encode()), ("S", label.encode()), ("S", flags.encode())]
    vals += list(values)
    return Node(b"P", len(vals), pack_props(vals), [], False)


# ---- rotation maths (FBX eEulerXYZ: R = Rz · Ry · Rx) ---------------------------
def euler_to_mat(deg):
    x, y, z = (math.radians(a) for a in deg)
    cx, sx, cy, sy, cz, sz = math.cos(x), math.sin(x), math.cos(y), math.sin(y), math.cos(z), math.sin(z)
    rx = [[1, 0, 0], [0, cx, -sx], [0, sx, cx]]
    ry = [[cy, 0, sy], [0, 1, 0], [-sy, 0, cy]]
    rz = [[cz, -sz, 0], [sz, cz, 0], [0, 0, 1]]
    return mul(rz, mul(ry, rx))


def mul(a, b):
    return [[sum(a[i][k] * b[k][j] for k in range(3)) for j in range(3)] for i in range(3)]


def mat_to_euler(m):
    sy = -m[2][0]
    sy = max(-1.0, min(1.0, sy))
    y = math.asin(sy)
    if abs(sy) < 0.999999:
        x = math.atan2(m[2][1], m[2][2])
        z = math.atan2(m[1][0], m[0][0])
    else:  # gimbal: fold everything into x
        x = math.atan2(-m[1][2], m[1][1])
        z = 0.0
    return [math.degrees(a) for a in (x, y, z)]


# ---- the fix ---------------------------------------------------------------------
def fold(nodes):
    objects = next((n for n in nodes if n.name == b"Objects"), None)
    if objects is None:
        raise ValueError("no Objects section")
    changed = 0
    for model in objects.children:
        if model.name != b"Model":
            continue
        head = parse_props(model.props)
        if len(head) < 3 or head[2][1] != b"LimbNode":
            continue
        p70 = next((c for c in model.children if c.name == b"Properties70"), None)
        if p70 is None:
            p70 = Node(b"Properties70", 0, b"", [], True)
            model.children.append(p70)
        recs = {parse_props(c.props)[0][1].decode(): c for c in p70.children if c.name == b"P"}
        vec = lambda name: [v for t, v in parse_props(recs[name].props)[4:]] if name in recs else [0.0, 0.0, 0.0]
        lcl, pre = vec("Lcl Rotation"), vec("PreRotation")
        new_pre = mat_to_euler(mul(euler_to_mat(pre), euler_to_mat(lcl)))
        new = {
            "PreRotation": P("PreRotation", "Vector3D", "Vector", "", *[("D", a) for a in new_pre]),
            "Lcl Rotation": P("Lcl Rotation", "Lcl Rotation", "", "A", ("D", 0.0), ("D", 0.0), ("D", 0.0)),
            "RotationActive": P("RotationActive", "bool", "", "", ("I", 1)),
        }
        kept = [c for c in p70.children if not (c.name == b"P" and parse_props(c.props)[0][1].decode() in new)]
        p70.children = kept + list(new.values())
        p70.has_null = True
        changed += 1
    return changed


def declare_y_up(nodes):
    """Set GlobalSettings to Mixamo's axes: Y up, +Z front, +X coord (right-handed)."""
    gs = next((n for n in nodes if n.name == b"GlobalSettings"), None)
    p70 = next((c for c in gs.children if c.name == b"Properties70"), None) if gs else None
    if p70 is None:
        raise ValueError("no GlobalSettings/Properties70")
    want = {"UpAxis": 1, "UpAxisSign": 1, "FrontAxis": 2, "FrontAxisSign": 1, "CoordAxis": 0, "CoordAxisSign": 1,
            "OriginalUpAxis": 1, "OriginalUpAxisSign": 1}
    kept = [c for c in p70.children if not (c.name == b"P" and parse_props(c.props)[0][1].decode() in want)]
    p70.children = kept + [P(k, "int", "Integer", "", ("I", v)) for k, v in want.items()]
    p70.has_null = True


def main(src, dst, y_up=False):
    with open(src, "rb") as f:
        header, nodes, footer, big = read_fbx(f.read())
    n = fold(nodes)
    if y_up:
        declare_y_up(nodes)
    with open(dst, "wb") as f:
        f.write(write_fbx(header, nodes, footer, big))
    return n


if __name__ == "__main__":
    args = [a for a in sys.argv[1:] if a != "--y-up"]
    if len(args) != 2:
        sys.exit("usage: fbx_prerotation.py in.fbx out.fbx [--y-up]")
    print(f"fbx_prerotation: folded {main(args[0], args[1], '--y-up' in sys.argv)} bones")
