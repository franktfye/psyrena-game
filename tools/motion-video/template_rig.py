"""Unrigged T-pose GLB → Mixamo-named binary FBX, rigged from the mesh's shape.

    blender -b --factory-startup --python tools/motion-video/template_rig.py -- \
        in_tpose.glb out_mixamo.fbx [--report report.json] [--glb character.glb]

The fallback to tripo_to_mixamo.py for creatures Tripo's auto-rigger gets wrong
(2026-10-19, survival monsters: spines hung off legs, quadruped trees, missing
spines; a 20k-face re-rig did not help). Nothing is read from a rig: the
25-bone Mixamo skeleton is placed from the T-pose silhouette and skinned with
Blender's heat weights. Output is identical in form to tripo_to_mixamo.py's
(same bones, identity rest frames except Hand, Y-up, +Z front, 180 cm,
PreRotation folded), so m2mr and finish-clips.mjs take it unchanged.

Landmarks, on the model normalised to 180 cm, feet at z 0, facing -Y:
  arm line     the height band where the silhouette is widest (the T)
  shoulders    where the arm leaves the torso: torso half-width just below it
  wrist/elbow  0.73 / 0.37 of the way shoulder → fingertip, on the arm's centre line
  crotch       the highest point where the lower body still splits in two
               (robes that never split: 0.646 × arm height, human proportions)
  knee/ankle   0.54 / 0.085 of hip height, on each leg's own centre
  spine        Hips at the hip joints, then 10/35/65 % up to the arm line;
               Neck just above it, HeadTop at the top of the head column
Assumes the Tripo convention that the model faces +Z in glTF (-Y in Blender).
"""

import json
import math
import os
import sys

import bpy
from mathutils import Matrix, Vector

argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
if len(argv) < 2:
    sys.exit("usage: blender -b --python template_rig.py -- in.glb out.fbx [--report r] [--glb g]")
SRC, OUT = argv[0], argv[1]
opt = {argv[i][2:]: argv[i + 1] for i in range(2, len(argv) - 1) if argv[i].startswith("--")}
HEIGHT = 180.0


def fail(msg):
    raise SystemExit(f"template_rig: {msg}")


# ---- load + normalise ------------------------------------------------------------
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=SRC)
scene = bpy.context.scene
for o in [o for o in scene.objects if o.type == "ARMATURE"]:
    bpy.data.objects.remove(o, do_unlink=True)
meshes = [o for o in scene.objects if o.type == "MESH"]
if not meshes:
    fail("no mesh")
for m in meshes:
    mw = m.matrix_world.copy()
    m.parent = None
    for mod in list(m.modifiers):
        m.modifiers.remove(mod)
    m.data.transform(mw)
    m.matrix_world = Matrix.Identity(4)
pts = [v.co.copy() for m in meshes for v in m.data.vertices]

# Turn the T so the arms run along X (the longer horizontal extent), then the
# toes to -Y: feet stick out to the front of the ankles/shins above them.
def extent(axis):
    return max(getattr(p, axis) for p in pts) - min(getattr(p, axis) for p in pts)


R = Matrix.Rotation(math.radians(90), 4, "Z") if extent("y") > extent("x") else Matrix.Identity(4)
pts = [R @ p for p in pts]
z0 = min(p.z for p in pts)
h0 = max(p.z for p in pts) - z0
feet = [p.y for p in pts if p.z < z0 + 0.03 * h0]
shins = [p.y for p in pts if z0 + 0.15 * h0 < p.z < z0 + 0.3 * h0]
if feet and shins and sum(feet) / len(feet) > sum(shins) / len(shins):
    R = Matrix.Rotation(math.radians(180), 4, "Z") @ R
    pts = [Matrix.Rotation(math.radians(180), 4, "Z") @ p for p in pts]
for m in meshes:
    m.data.transform(R)
zmin = min(p.z for p in pts)
zmax = max(p.z for p in pts)
cx = (min(p.x for p in pts) + max(p.x for p in pts)) / 2
cy = (min(p.y for p in pts) + max(p.y for p in pts)) / 2
scale = HEIGHT / (zmax - zmin)
T = Matrix.Scale(scale, 4) @ Matrix.Translation(Vector((-cx, -cy, -zmin)))
for m in meshes:
    m.data.transform(T)
pts = [T @ p for p in pts]
# Measure on points spread over the triangles, not on the vertices: a 3k-triangle
# minion has vertices 5+ cm apart, which breaks every slice into false gaps.
import random
random.seed(1)
samples = []
for m in meshes:
    m.data.calc_loop_triangles()
    vs = m.data.vertices
    for tri in m.data.loop_triangles:
        a, b, c = (vs[i].co for i in tri.vertices)
        k = max(1, int(tri.area / 1.5))
        for _ in range(min(k, 200)):
            u, v = random.random(), random.random()
            if u + v > 1:
                u, v = 1 - u, 1 - v
            samples.append(a + (b - a) * u + (c - a) * v)
pts = pts + samples


# ---- silhouette measurements ------------------------------------------------------
def band(z0, z1):
    return [p for p in pts if z0 <= p.z < z1]


def intervals(xs, gap=3.0):
    """Sorted x values → list of (lo, hi) runs separated by more than `gap` cm."""
    xs = sorted(xs)
    if not xs:
        return []
    out, lo, prev = [], xs[0], xs[0]
    for x in xs[1:]:
        if x - prev > gap:
            out.append((lo, prev))
            lo = x
        prev = x
    out.append((lo, prev))
    return out


def width(z):
    b = band(z - 1.5, z + 1.5)
    return max((abs(p.x) for p in b), default=0.0)


# Arm line: the widest band between 45 % and 95 % of the height.
zs = [z * 0.5 for z in range(int(0.45 * HEIGHT * 2), int(0.95 * HEIGHT * 2))]
widths = {z: width(z) for z in zs}
span = max(widths.values())
arm_band = [z for z, w in widths.items() if w >= 0.93 * span]
z_arm = sorted(arm_band)[len(arm_band) // 2]
if span < 25:
    fail(f"no T-pose arm line found (half-span {span:.1f} cm)")


def central(z, h=1.5):
    """The run of the slice that contains x = 0 (the torso), or the nearest one."""
    runs = intervals([p.x for p in band(z - h, z + h)])
    if not runs:
        return (0.0, 0.0)
    return min(runs, key=lambda r: 0 if r[0] <= 0 <= r[1] else min(abs(r[0]), abs(r[1])))


# Torso half-width just below the armpit: below the arms' lower edge.
arm_low = min(arm_band)
torso_hw = 0.0
for dz in (8, 12, 16, 20):
    lo, hi = central(arm_low - dz)
    hw = max(-lo, hi)
    if hw < 0.6 * span:
        torso_hw = hw
        break
torso_hw = min(max(torso_hw, 8.0), 0.45 * span)


def centre_line(side, x):
    """(y, z) centre of the arm's cross-section near |x| on one side."""
    s = 1 if side == "Left" else -1
    sel = [p for p in pts if abs(p.x - s * x) < 2.0 and abs(p.z - z_arm) < 18]
    if not sel:
        return (0.0, z_arm)
    return (sum(p.y for p in sel) / len(sel), sum(p.z for p in sel) / len(sel))


# Crotch: scan up from the knees; the last height where the lower body is two runs.
crotch = None
for zi in range(int(0.06 * HEIGHT), int(z_arm - 15)):
    runs = intervals([p.x for p in band(zi - 1, zi + 1) if abs(p.x) < 1.6 * torso_hw])
    if len(runs) >= 2 and any(r[1] < 0 for r in runs) and any(r[0] > 0 for r in runs):
        crotch = zi
    elif crotch is not None and zi - crotch > 4:
        break
# A split far below the arms is a coat or dress hem, not the crotch (a human
# crotch sits at ~0.57 of shoulder height; Pac-man's short legs at ~0.49).
legs_ok = bool(crotch) and crotch > 0.12 * HEIGHT and crotch > 0.40 * z_arm
hip_z = crotch + 4.0 if legs_ok else 0.646 * z_arm
robe = not legs_ok


def leg_band(side, z, h):
    """One leg's slice: within 1.6 torso half-widths of the centre, or, when that
    is empty, 3.2 (a narrow torso on wide-set legs: the Tall Glass's 9 cm glass
    over legs 19 cm out left knees and ankles guessed between the legs)."""
    s = 1 if side == "Left" else -1
    for reach in (1.6, 3.2):
        b = [p for p in band(z - h, z + h) if s * p.x > 0 and abs(p.x) < reach * torso_hw]
        if b:
            return b
    return []


def leg_x(side, z):
    s = 1 if side == "Left" else -1
    b = leg_band(side, z, 2)
    if robe or not b:
        return s * 0.5 * torso_hw
    xs = [p.x for p in b]
    return (min(xs) + max(xs)) / 2


def leg_y(side, z):
    b = leg_band(side, z, 3)
    return sum(p.y for p in b) / len(b) if b else 0.0


def torso_y(z):
    b = [p for p in band(z - 2, z + 2) if abs(p.x) < torso_hw]
    return sum(p.y for p in b) / len(b) if b else 0.0


J = {}
mx = lambda n: "mixamorig:" + n

# Spine column.
J[mx("Hips")] = Vector((0, torso_y(hip_z), hip_z))
for name, f in (("Spine", 0.10), ("Spine1", 0.35), ("Spine2", 0.65)):
    z = hip_z + f * (z_arm - hip_z)
    J[mx(name)] = Vector((0, torso_y(z), z))
neck_z = z_arm + 0.035 * HEIGHT
J[mx("Neck")] = Vector((0, torso_y(neck_z), neck_z))
head_col = [p for p in pts if abs(p.x) < 0.5 * torso_hw and p.z > z_arm]
top = max((p.z for p in head_col), default=z_arm + 0.15 * HEIGHT)
head_z = neck_z + 0.3 * (top - neck_z)
J[mx("Head")] = Vector((0, torso_y(head_z), head_z))
J[mx("HeadTop_End")] = Vector((0, torso_y(head_z), top))

for side, s in (("Left", 1), ("Right", -1)):
    sh_x = torso_hw
    y, z = centre_line(side, sh_x + 3)
    J[mx(side + "Shoulder")] = Vector((s * max(3.0, 0.3 * torso_hw), y, z - 2))
    J[mx(side + "Arm")] = Vector((s * sh_x, y, z))
    wrist_x = sh_x + 0.73 * (span - sh_x)
    elbow_x = sh_x + 0.37 * (span - sh_x)
    ye, ze = centre_line(side, elbow_x)
    yw, zw = centre_line(side, wrist_x)
    J[mx(side + "ForeArm")] = Vector((s * elbow_x, ye, ze))
    J[mx(side + "Hand")] = Vector((s * wrist_x, yw, zw))
    knee_z, ankle_z = 0.54 * hip_z, 0.085 * hip_z
    J[mx(side + "UpLeg")] = Vector((leg_x(side, hip_z - 8), leg_y(side, hip_z - 4), hip_z))
    J[mx(side + "Leg")] = Vector((leg_x(side, knee_z), leg_y(side, knee_z), knee_z))
    ax = leg_x(side, ankle_z)
    J[mx(side + "Foot")] = Vector((ax, leg_y(side, ankle_z + 4), ankle_z))
    foot = [p for p in pts if p.z < ankle_z + 2 and abs(p.x - ax) < 0.6 * torso_hw]
    front = min((p.y for p in foot), default=J[mx(side + "Foot")].y - 15)   # front is -Y
    ankle_y = J[mx(side + "Foot")].y
    J[mx(side + "ToeBase")] = Vector((ax, ankle_y + 0.65 * (front - ankle_y), 0.02 * HEIGHT))
    J[mx(side + "Toe_End")] = Vector((ax, front, 0.02 * HEIGHT))

# ---- into Mixamo's frame: Y up, facing +Z (as tripo_to_mixamo.py) ------------------
TO_MIXAMO = Matrix.Rotation(math.radians(-90), 4, "X")
for m in meshes:
    m.data.transform(TO_MIXAMO)
J = {k: TO_MIXAMO @ v for k, v in J.items()}
HAND_DIR = {"Left": Vector((1, 0, 0)), "Right": Vector((-1, 0, 0))}

HIER = [("Hips", None), ("Spine", "Hips"), ("Spine1", "Spine"), ("Spine2", "Spine1"),
        ("Neck", "Spine2"), ("Head", "Neck"), ("HeadTop_End", "Head")]
for s in ("Left", "Right"):
    HIER += [(s + "Shoulder", "Spine2"), (s + "Arm", s + "Shoulder"), (s + "ForeArm", s + "Arm"),
             (s + "Hand", s + "ForeArm"),
             (s + "UpLeg", "Hips"), (s + "Leg", s + "UpLeg"), (s + "Foot", s + "Leg"),
             (s + "ToeBase", s + "Foot"), (s + "Toe_End", s + "ToeBase")]
CHILD = {"Hips": "Spine", "Spine": "Spine1", "Spine1": "Spine2", "Spine2": "Neck", "Neck": "Head",
         "Head": "HeadTop_End"}
for s in ("Left", "Right"):
    CHILD.update({s + "Shoulder": s + "Arm", s + "Arm": s + "ForeArm", s + "ForeArm": s + "Hand",
                  s + "UpLeg": s + "Leg", s + "Leg": s + "Foot", s + "Foot": s + "ToeBase",
                  s + "ToeBase": s + "Toe_End"})
END_BONES = {"HeadTop_End", "LeftToe_End", "RightToe_End"}

adata = bpy.data.armatures.new("Armature")
aobj = bpy.data.objects.new("Armature", adata)
scene.collection.objects.link(aobj)
bpy.context.view_layer.objects.active = aobj
bpy.ops.object.mode_set(mode="EDIT")
eb = {}
for name, parent in HIER:
    e = adata.edit_bones.new(mx(name))
    e.head = J[mx(name)]
    nxt = J.get(mx(CHILD[name])) if name in CHILD else None
    length = (nxt - e.head).length if nxt is not None else 5.0
    if name.endswith("Hand"):
        e.tail = e.head + HAND_DIR[name[:-4]] * 8.0
    else:
        e.tail = e.head + Vector((0, max(2.0, length), 0))   # identity rest frame
    e.roll = 0.0
    e.use_deform = name not in END_BONES
    if parent:
        e.parent = eb[parent]
    eb[name] = e
bpy.ops.object.mode_set(mode="OBJECT")


# ---- skin: weights from the bone SEGMENTS (joint → child joint) ----------------------
# Heat weighting needs bones that lie along their segments, but ours all point
# +Y (identity rest frames, which m2mr wants). So weight a temporary armature
# whose bones run joint → child joint, then copy the groups (same names) over.
def segment_end(name):
    a = J[mx(name)]
    if name.endswith("Hand"):
        return a + HAND_DIR[name[:-4]] * 0.11 * HEIGHT
    if name in CHILD:
        return J[mx(CHILD[name])]
    return a + Vector((0, 5.0, 0))


tdata = bpy.data.armatures.new("Heat")
tobj = bpy.data.objects.new("Heat", tdata)
scene.collection.objects.link(tobj)
bpy.context.view_layer.objects.active = tobj
bpy.ops.object.mode_set(mode="EDIT")
for name, _parent in HIER:
    if name in END_BONES:
        continue
    e = tdata.edit_bones.new(mx(name))
    e.head = J[mx(name)]
    e.tail = segment_end(name)
    if (e.tail - e.head).length < 1.0:
        e.tail = e.head + Vector((0, 2.0, 0))
bpy.ops.object.mode_set(mode="OBJECT")

heat_failed = []
# glTF import splits vertices at every UV seam, so heat sees a cloud of open
# pieces and gives up silently. Weight a welded copy, then transfer the groups
# back to the real meshes by nearest vertex.
import bmesh


def heat_on_weld(dist):
    """Duplicate + join + weld the meshes, heat-weight the copy; returns (copy, weighted share)."""
    bpy.ops.object.select_all(action="DESELECT")
    for m in meshes:
        m.select_set(True)
    bpy.context.view_layer.objects.active = meshes[0]
    bpy.ops.object.duplicate()
    dups = list(bpy.context.selected_objects)
    if len(dups) > 1:
        bpy.context.view_layer.objects.active = dups[0]
        bpy.ops.object.join()
    w = bpy.context.view_layer.objects.active
    bm = bmesh.new()
    bm.from_mesh(w.data)
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=dist)
    bm.to_mesh(w.data)
    bm.free()
    for g in list(w.vertex_groups):
        w.vertex_groups.remove(g)
    bpy.ops.object.select_all(action="DESELECT")
    w.select_set(True)
    tobj.select_set(True)
    bpy.context.view_layer.objects.active = tobj
    try:
        bpy.ops.object.parent_set(type="ARMATURE_AUTO")
    except RuntimeError as err:
        heat_failed.append(str(err))
    n = sum(1 for v in w.data.vertices if any(g.weight > 1e-4 for g in v.groups))
    return w, n / max(1, len(w.data.vertices))


# Wider welds close more of the cracks heat chokes on, at some cost in detail
# (the copy only carries weights; the real meshes are untouched).
weld, share, weld_dist = None, -1.0, None
for dist in (0.4, 1.5, 3.0):
    w, sh = heat_on_weld(dist)
    if sh > share:
        if weld is not None:
            bpy.data.objects.remove(weld, do_unlink=True)
        weld, share, weld_dist = w, sh, dist
    else:
        bpy.data.objects.remove(w, do_unlink=True)
    if share > 0.97:
        break
heat_verts = round(share, 3)
for m in meshes:
    for g in list(m.vertex_groups):
        m.vertex_groups.remove(g)
    for g in weld.vertex_groups:
        m.vertex_groups.new(name=g.name)
    dt = m.modifiers.new("dt", "DATA_TRANSFER")
    dt.object = weld
    dt.use_vert_data = True
    dt.data_types_verts = {"VGROUP_WEIGHTS"}
    dt.vert_mapping = "NEAREST"
    dt.layers_vgroup_select_src = "ALL"
    dt.layers_vgroup_select_dst = "NAME"
    bpy.context.view_layer.objects.active = m
    bpy.ops.object.modifier_apply(modifier=dt.name)
bpy.data.objects.remove(weld, do_unlink=True)


def seg_dist(name, co):
    a, b = J[mx(name)], segment_end(name)
    ab = b - a
    t = max(0.0, min(1.0, (co - a).dot(ab) / (ab.length_squared or 1.0)))
    return (co - (a + ab * t)).length


DEFORM = [n for n, _ in HIER if n not in END_BONES]
filled = 0
for m in meshes:
    names = {g.index: g.name for g in m.vertex_groups}
    for v in m.data.vertices:
        if any(g.weight > 1e-4 and names.get(g.group, "").startswith("mixamorig:") for g in v.groups):
            continue
        # Heat missed this vertex (non-manifold pieces, floating cloth): blend
        # the two nearest bone segments by inverse distance.
        d = sorted((seg_dist(n, v.co), n) for n in DEFORM)[:2]
        w = [1.0 / max(x, 0.5) ** 4 for x, _ in d]
        for (dist, n), wi in zip(d, w):
            g = m.vertex_groups.get(mx(n)) or m.vertex_groups.new(name=mx(n))
            g.add([v.index], wi / sum(w), "REPLACE")
        filled += 1
    m.parent = None
    for mod in [x for x in m.modifiers if x.type == "ARMATURE"]:
        m.modifiers.remove(mod)
    m.parent = aobj
    mod = m.modifiers.new("Armature", "ARMATURE")
    mod.object = aobj
bpy.data.objects.remove(tobj, do_unlink=True)

# ---- export (as tripo_to_mixamo.py) ------------------------------------------------
bpy.ops.object.select_all(action="DESELECT")
for o in [aobj, *meshes]:
    o.select_set(True)
bpy.context.view_layer.objects.active = aobj
bpy.ops.export_scene.fbx(
    filepath=OUT, use_selection=True, object_types={"ARMATURE", "MESH"},
    add_leaf_bones=False, bake_anim=False, path_mode="COPY", embed_textures=True,
    mesh_smooth_type="FACE", armature_nodetype="NULL",
    axis_forward="Y", axis_up="Z",
)
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import fbx_prerotation
print("template_rig: folded", fbx_prerotation.main(OUT, OUT, y_up=True), "bones into PreRotation")
if "glb" in opt:
    bpy.ops.export_scene.gltf(filepath=opt["glb"], use_selection=True, export_animations=False,
                              export_yup=False)

report = {
    "source": SRC, "fbx": OUT, "height_cm": HEIGHT, "scale_applied": round(scale, 5),
    "method": "template", "bones": len(HIER), "arm_line_cm": round(z_arm, 1),
    "half_span_cm": round(span, 1), "torso_half_width_cm": round(torso_hw, 1),
    "crotch_cm": crotch, "robe": robe, "heat_failed": heat_failed, "heat_share": heat_verts, "weld_cm": weld_dist, "verts_filled_by_distance": filled,
    "joints": {k: [round(x, 4) for x in v] for k, v in J.items()},
}
if "report" in opt:
    with open(opt["report"], "w") as f:
        json.dump(report, f, indent=1)
print("template_rig: wrote", OUT, "| robe" if robe else "", "| filled", filled, "| heat", "FAILED" if heat_failed else "ok")
