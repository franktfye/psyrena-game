"""Decimate an (unrigged) GLB to a triangle budget, keeping UVs and materials.

    blender -b --factory-startup --python tools/motion-video/decimate_glb.py -- in.glb out.glb <max_tris>

For survival monsters (docs/survival-design.md §10): Tripo's --face-limit
overshoots the triangle count about 1.8×, and meshoptimizer (gltf-transform
simplify) stalls well above the budget on Tripo meshes because their UV seams
lock it. Blender's collapse decimation reaches the target and keeps the UVs.
"""
import sys

import bpy

argv = sys.argv[sys.argv.index("--") + 1:]
SRC, OUT, BUDGET = argv[0], argv[1], int(argv[2])

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=SRC)
meshes = [o for o in bpy.context.scene.objects if o.type == "MESH"]


def tris():
    n = 0
    for m in meshes:
        m.data.calc_loop_triangles()
        n += len(m.data.loop_triangles)
    return n


before = tris()
ratio = min(1.0, BUDGET / before)
for _ in range(3):                      # collapse lands a little high on some meshes
    if tris() <= BUDGET:
        break
    for m in meshes:
        mod = m.modifiers.new("dec", "DECIMATE")
        mod.decimate_type = "COLLAPSE"
        mod.ratio = ratio
        mod.use_collapse_triangulate = True
        bpy.context.view_layer.objects.active = m
        bpy.ops.object.modifier_apply(modifier=mod.name)
    ratio = min(1.0, BUDGET / tris()) * 0.98
bpy.ops.object.select_all(action="SELECT")
bpy.ops.export_scene.gltf(filepath=OUT, use_selection=True, export_animations=False)
print(f"decimate_glb: {before} -> {tris()} tris (budget {BUDGET})")
