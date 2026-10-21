"""Tripo-rigged GLB → Mixamo-named binary FBX, for Motion2MixamoRig (m2mr).

    blender -b --factory-startup --python tools/motion-video/tripo_to_mixamo.py -- \
        in_tripo_rig.glb out_mixamo.fbx [--report report.json] [--glb preview.glb]

Why: `tripo anim rig --spec mixamo` cannot deliver what m2mr reads. FBX output
fails server-side (error 1001) and the GLB keeps Tripo's own bone names, some
of which do not even match their role (`tripo::Spine_3` is the LEFT clavicle).
m2mr needs a binary FBX whose core bones are named `mixamorig:<Bone>` and
include the chain tips (HeadTop_End, ToeBase, Toe_End).

How: the Tripo skeleton is read by STRUCTURE, never by name:
  root's children   → the spine branch (holds the head) + two leg branches
  spine branch      → single-child chain up to the chest (first ≥3-way fork)
  chest's children  → neck branch (highest) + two arm branches (widest)
  arm               → clavicle → upper arm → forearm → hand (first fork; the
                      fingers below it fold into Hand, which m2mr ignores)
  leg               → hip → knee → ankle [→ toe]; a missing toe/tip is placed
                      from the foot's mesh (Tripo rigs ship none)
Facing comes from where the toes point; left = up × forward. The result is
normalised to 1.8 m, feet on the floor, facing -Y in Blender (+Z in the FBX,
like Mixamo), in the same T-pose. A new armature is built at the Tripo joint
positions and the skin weights are renamed/merged onto it.

Tested on Blender 4.0 (gpu-box) and 4.3 (py2).
"""

import json
import math
import os
import sys

import bpy
from mathutils import Matrix, Vector

argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
if len(argv) < 2:
    sys.exit("usage: blender -b --python tripo_to_mixamo.py -- in.glb out.fbx [--report r.json] [--glb p.glb]")
SRC, OUT = argv[0], argv[1]
opt = {argv[i][2:]: argv[i + 1] for i in range(2, len(argv) - 1) if argv[i].startswith("--")}

UP = Vector((0, 0, 1))
# Mixamo FBX files are in centimetres; Blender writes positions as-is with
# UnitScaleFactor 1 (= cm), so the character is built 180 units tall.
HEIGHT = 180.0


def fail(msg):
    raise SystemExit(f"tripo_to_mixamo: {msg}")


# ---- load -------------------------------------------------------------------
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=SRC)
scene = bpy.context.scene
arms = [o for o in scene.objects if o.type == "ARMATURE"]
if len(arms) != 1:
    fail(f"expected one armature, found {len(arms)}")
src_arm = arms[0]
meshes = [o for o in scene.objects if o.type == "MESH" and any(
    m.type == "ARMATURE" and m.object == src_arm for m in o.modifiers)]
if not meshes:
    fail("no mesh is skinned to the armature")

bones = src_arm.data.bones
pos = {b.name: src_arm.matrix_world @ b.head_local for b in bones}


def subtree(b):
    out = [b]
    for c in b.children:
        out += subtree(c)
    return out


def top(b):
    return max(pos[x.name].z for x in subtree(b))


def single_chain(b):
    """b, then its only child, … up to and including the first fork or leaf."""
    chain = [b]
    while len(chain[-1].children) == 1:
        chain.append(chain[-1].children[0])
    return chain


# ---- structure ----------------------------------------------------------------
roots = [b for b in bones if b.parent is None]
root = max(roots, key=lambda b: len(subtree(b)))
kids = sorted(root.children, key=top, reverse=True)
if len(kids) < 3:
    fail(f"root {root.name} has {len(kids)} children; expected spine + two legs")
spine_start = kids[0]
# Legs are the two LONGEST chains, not the next-tallest subtrees: a coat or
# skirt makes Tripo hang 1-joint hem bones off the root at hip height
# (Ainsworth: four, mid-thigh cardigan), and those top out above the hips.
leg_starts = sorted(kids[1:], key=lambda b: len(single_chain(b)), reverse=True)[:2]
hem_starts = [b for b in kids[1:] if b not in leg_starts]

spine = single_chain(spine_start)
chest = spine[-1]
if len(chest.children) < 3:
    fail(f"spine ends at {chest.name} with {len(chest.children)} children; expected neck + two arms")
ck = list(chest.children)
neck_start = max(ck, key=top)
arm_starts = sorted((c for c in ck if c != neck_start),
                    key=lambda c: max((pos[x.name] - pos[chest.name]).xy.length for x in subtree(c)),
                    reverse=True)[:2]

arm_chains = [single_chain(a) for a in arm_starts]
for ch in arm_chains:
    if len(ch) < 4:
        fail(f"arm {ch[0].name} chain has {len(ch)} joints before the hand fork; expected clavicle/arm/forearm/hand")
leg_chains = [single_chain(l) for l in leg_starts]
for ch in leg_chains:
    if len(ch) < 3:
        fail(f"leg {ch[0].name} has {len(ch)} joints; expected hip/knee/ankle")
neck_chain = single_chain(neck_start)

# ---- facing: toes point forward ---------------------------------------------
vg_weight = {}  # (mesh, vertex index) -> {group name: w}
def weights_of(mesh):
    names = {g.index: g.name for g in mesh.vertex_groups}
    mw = mesh.matrix_world
    for v in mesh.data.vertices:
        yield mw @ v.co, {names[g.group]: g.weight for g in v.groups if g.group in names}


def verts_owned_by(group_names, below=None):
    pts = []
    for m in meshes:
        for co, w in weights_of(m):
            own = sum(w.get(n, 0) for n in group_names)
            if own > 0.5 and (below is None or co.z < below):
                pts.append(co)
    return pts


fwd = Vector((0, 0, 0))
foot_pts = {}
for ch in leg_chains:
    ankle = ch[2]
    names = [b.name for b in subtree(ankle)]
    pts = verts_owned_by(names, below=pos[ankle.name].z)
    if not pts:
        fail(f"no foot vertices weighted to {ankle.name}")
    foot_pts[ankle.name] = pts
    c = sum(pts, Vector()) / len(pts)
    d = c - pos[ankle.name]
    d.z = 0
    fwd += d
fwd.z = 0
if fwd.length < 1e-6:
    fail("could not tell which way the character faces")
fwd.normalize()
left = UP.cross(fwd).normalized()

center = sum((pos[ch[0].name] for ch in leg_chains), Vector()) / 2


def side(b):
    return "Left" if (pos[b.name] - center).dot(left) > 0 else "Right"


arm_by = {side(ch[0]): ch for ch in arm_chains}
leg_by = {side(ch[0]): ch for ch in leg_chains}
if set(arm_by) != {"Left", "Right"} or set(leg_by) != {"Left", "Right"}:
    fail(f"side detection failed: arms {list(arm_by)}, legs {list(leg_by)}")

# ---- normalise: face -Y, 1.8 m, feet at z 0, centred ------------------------
all_pts = [co for m in meshes for co, _ in weights_of(m)]
zmin = min(p.z for p in all_pts)
zmax = max(p.z for p in all_pts)
scale = HEIGHT / (zmax - zmin)
theta = math.atan2(-1.0, 0.0) - math.atan2(fwd.y, fwd.x)   # turn fwd onto -Y
yaw = Matrix.Rotation(theta, 4, "Z")
if (yaw @ fwd - Vector((0, -1, 0))).length > 1e-3:
    fail("could not rotate the character to face -Y")
T = Matrix.Scale(scale, 4) @ yaw @ Matrix.Translation(Vector((-center.x, -center.y, -zmin)))


def P(v):
    return T @ v


# ---- target joints ------------------------------------------------------------
J = {}          # mixamo name -> world position (normalised)
MAP = {}        # tripo bone -> mixamo bone (skin weights)
synth = []


def put(name, src_bone=None, at=None):
    J[name] = P(pos[src_bone.name]) if src_bone is not None else at
    if src_bone is not None:
        MAP[src_bone.name] = name


mx = lambda n: "mixamorig:" + n

# Hips: midway between the hip joints, at the height of the spine's first joint
# when the Tripo root sits on the floor (it does); its weights go to Hips.
hip_mid = (P(pos[leg_by["Left"][0].name]) + P(pos[leg_by["Right"][0].name])) / 2
hips_z = (hip_mid.z + P(pos[spine[0].name]).z) / 2 if P(pos[root.name]).z < hip_mid.z else P(pos[root.name]).z
J[mx("Hips")] = Vector((hip_mid.x, hip_mid.y, hips_z))
MAP[root.name] = mx("Hips")

# Spine: first → Spine, last (chest) → Spine2, everything between → Spine1.
put(mx("Spine"), spine[0])
put(mx("Spine2"), spine[-1])
if len(spine) >= 3:
    mid = spine[1:-1]
    put(mx("Spine1"), mid[len(mid) // 2])
    for b in mid:
        MAP[b.name] = mx("Spine1")
else:
    J[mx("Spine1")] = (J[mx("Spine")] + J[mx("Spine2")]) / 2
    synth.append("Spine1")

put(mx("Neck"), neck_chain[0])
if len(neck_chain) >= 2:
    put(mx("Head"), neck_chain[1])
    for b in neck_chain[2:]:
        MAP[b.name] = mx("Head")
else:
    J[mx("Head")] = J[mx("Neck")] + Vector((0, 0, 0.045 * HEIGHT))
    synth.append("Head")
J[mx("HeadTop_End")] = Vector((J[mx("Head")].x, J[mx("Head")].y, HEIGHT))
synth.append("HeadTop_End")

# Hem bones follow the nearer thigh. Unmapped, their vertices would end up with
# no weights at all and stay frozen at the rest pose while the legs walk out.
for h in hem_starts:
    s = min(("Left", "Right"), key=lambda s: (pos[h.name] - pos[leg_by[s][0].name]).length)
    for b in subtree(h):
        MAP[b.name] = mx(s + "UpLeg")

hand_src = {}
for s in ("Left", "Right"):
    clav, upper, fore, hand = arm_by[s][:4]
    put(mx(s + "Shoulder"), clav)
    put(mx(s + "Arm"), upper)
    put(mx(s + "ForeArm"), fore)
    put(mx(s + "Hand"), hand)
    for b in subtree(hand)[1:]:
        MAP[b.name] = mx(s + "Hand")      # fingers: m2mr drives none of them
    hand_src[s] = [b.name for b in subtree(hand)]
    lg = leg_by[s]
    put(mx(s + "UpLeg"), lg[0])
    put(mx(s + "Leg"), lg[1])
    put(mx(s + "Foot"), lg[2])
    ankle = lg[2]
    if len(lg) >= 4:
        put(mx(s + "ToeBase"), lg[3])
        for b in subtree(lg[3])[1:]:
            MAP[b.name] = mx(s + "ToeBase")
    for b in subtree(ankle)[1:]:
        MAP.setdefault(b.name, mx(s + "Foot"))
    # Toe tip = furthest-forward foot vertex; ToeBase = the ball of the foot.
    pts = [P(p) for p in foot_pts[ankle.name]]
    tip = min(pts, key=lambda p: p.y)                     # forward is -Y now
    a = J[mx(s + "Foot")]
    tip_end = Vector((a.x + (tip.x - a.x) * 0.9, tip.y, max(0.011 * HEIGHT, min(p.z for p in pts) + 0.011 * HEIGHT)))
    if mx(s + "ToeBase") not in J:
        J[mx(s + "ToeBase")] = Vector((a.x + (tip.x - a.x) * 0.6, a.y + (tip.y - a.y) * 0.65, tip_end.z + 0.011 * HEIGHT))
        synth.append(s + "ToeBase")
    J[mx(s + "Toe_End")] = tip_end
    synth.append(s + "Toe_End")

unmapped = [b.name for b in bones if b.name not in MAP]
for n in unmapped:                                       # anything left: nearest parent that mapped
    b = bones[n]
    while b is not None and b.name not in MAP:
        b = b.parent
    MAP[n] = MAP[b.name] if b is not None else mx("Hips")

# ---- into Mixamo's frame: Y up, facing +Z -------------------------------------
# Rx(-90°) takes Blender's Z-up/-Y-front to Y-up/+Z-front. The exporter is then
# told to do NO axis conversion: with conversion it parks the rotation on the
# root bone and the mesh node, which m2mr ignores (the figure lies on its back).
TO_MIXAMO = Matrix.Rotation(math.radians(-90), 4, "X")
T = TO_MIXAMO @ T
J = {k: TO_MIXAMO @ v for k, v in J.items()}

# Where each hand points: wrist → mean of its 40 farthest vertices (fingertips).
# m2mr aims a Hand bone's local +Y along the human wrist→palm direction
# (`_hand_rotation`, HAND_LOCAL_AXIS), i.e. it assumes the Mixamo convention
# that +Y runs along the hand. With +Y pointing up instead, every wrist came out
# bent 90° (palms turned in, hands held out like a tray).
HAND_DIR = {}
for s in ("Left", "Right"):
    wrist = J[mx(s + "Hand")]
    pts = [T @ p for p in verts_owned_by(hand_src[s])]
    if not pts:
        fail(f"no vertices weighted to the {s} hand")
    pts.sort(key=lambda p: (p - wrist).length, reverse=True)
    tip = sum(pts[:40], Vector()) / len(pts[:40])
    HAND_DIR[s] = (tip - wrist).normalized()

# ---- build the Mixamo armature -----------------------------------------------
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

adata = bpy.data.armatures.new("Armature")
aobj = bpy.data.objects.new("Armature", adata)
scene.collection.objects.link(aobj)
bpy.context.view_layer.objects.active = aobj
bpy.ops.object.mode_set(mode="EDIT")
eb = {}
for name, parent in HIER:
    e = adata.edit_bones.new(mx(name))
    e.head = J[mx(name)]
    # Every bone points straight UP (+Y here) with zero roll, whatever its chain
    # does, so its rest frame is identity: m2mr aims these bones from joint
    # positions (parent → child), not from their axes. The exception is Hand,
    # which m2mr aims by its own +Y; it gets +Y along the hand (see HAND_DIR).
    # Non-identity rest frames are fine either way: fbx_prerotation.py moves
    # them into PreRotation, where m2mr's FK (T·PreRotation·R) expects them.
    nxt = J.get(mx(CHILD[name])) if name in CHILD else None
    length = (nxt - e.head).length if nxt is not None else 5.0
    if name.endswith("Hand"):
        e.tail = e.head + HAND_DIR[name[:-4]] * 8.0
    else:
        e.tail = e.head + Vector((0, max(2.0, length), 0))   # +Y, roll 0 = identity
    e.roll = 0.0
    if parent:
        e.parent = eb[parent]
    eb[name] = e
bpy.ops.object.mode_set(mode="OBJECT")

# ---- move the meshes + their weights over -------------------------------------
STRAY_CM = HEIGHT / 6     # 30 cm: well past any real influence of a bone on its own skin
stray_dropped = [0]


def seg_dist(bone, co):
    """Rest-pose distance from a point to a Mixamo bone's segment (joint → child joint)."""
    name = bone[len("mixamorig:"):]
    a = J[bone]
    if name.endswith("Hand"):
        b = a + HAND_DIR[name[:-4]] * 0.11 * HEIGHT
    elif name in CHILD:
        b = J[mx(CHILD[name])]
    else:
        return (co - a).length
    ab = b - a
    t = max(0.0, min(1.0, (co - a).dot(ab) / (ab.length_squared or 1.0)))
    return (co - (a + ab * t)).length


for m in meshes:
    mw = m.matrix_world.copy()
    for mod in [x for x in m.modifiers if x.type == "ARMATURE"]:
        m.modifiers.remove(mod)
    m.parent = None
    m.data.transform(T @ mw)
    m.matrix_world = Matrix.Identity(4)
    names = {g.index: g.name for g in m.vertex_groups}
    acc = []
    for v in m.data.vertices:
        w = {}
        for g in v.groups:
            tgt = MAP.get(names.get(g.group))
            if tgt:
                w[tgt] = w.get(tgt, 0.0) + g.weight
        # Tripo's auto-skin leaks small weights across the body (Ainsworth: 52
        # hand vertices weighted to the OTHER hand, one to a foot). At rest
        # they are invisible; once the two bones move apart the vertex is
        # dragged between them and the mesh tears into long shards. Drop any
        # weight from a bone segment farther than STRAY_CM from the vertex.
        near = {n: x for n, x in w.items() if seg_dist(n, v.co) <= STRAY_CM}
        if near and len(near) < len(w):
            stray_dropped[0] += 1
            w = near
        acc.append(w)
    for g in list(m.vertex_groups):
        m.vertex_groups.remove(g)
    groups = {}
    for i, w in enumerate(acc):
        total = sum(w.values()) or 1.0
        for n, x in w.items():
            if n not in groups:
                groups[n] = m.vertex_groups.new(name=n)
            groups[n].add([i], x / total, "REPLACE")
    m.parent = aobj
    mod = m.modifiers.new("Armature", "ARMATURE")
    mod.object = aobj

bpy.data.objects.remove(src_arm, do_unlink=True)

# ---- export ---------------------------------------------------------------------
bpy.ops.object.select_all(action="DESELECT")
for o in [aobj, *meshes]:
    o.select_set(True)
bpy.context.view_layer.objects.active = aobj
bpy.ops.export_scene.fbx(
    filepath=OUT, use_selection=True, object_types={"ARMATURE", "MESH"},
    add_leaf_bones=False, bake_anim=False, path_mode="COPY", embed_textures=True,
    mesh_smooth_type="FACE", armature_nodetype="NULL",
    axis_forward="Y", axis_up="Z",   # identity: the data is already Y-up/+Z-front
)
# Blender cannot write PreRotation; fold the rest Lcl Rotation into it.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import fbx_prerotation
print("tripo_to_mixamo: folded", fbx_prerotation.main(OUT, OUT, y_up=True), "bones into PreRotation")
if "glb" in opt:
    # Textured twin of the FBX: same bones, same identity rest frames, in cm.
    # The data is already Y-up, so the glTF exporter must not convert it again.
    bpy.ops.export_scene.gltf(filepath=opt["glb"], use_selection=True, export_animations=False,
                              export_yup=False)

report = {
    "source": SRC, "fbx": OUT, "height_cm": HEIGHT, "scale_applied": round(scale, 5),
    "facing_source": [round(x, 3) for x in fwd], "bones": len(HIER),
    "synthesized": synth,
    "stray_weights_dropped": stray_dropped[0],
    "map": {k: v for k, v in sorted(MAP.items())},
    "joints": {k: [round(x, 4) for x in v] for k, v in J.items()},
}
if "report" in opt:
    with open(opt["report"], "w") as f:
        json.dump(report, f, indent=1)
print("tripo_to_mixamo: wrote", OUT, "| synthesized:", ", ".join(synth))
