"""Turntable preview of a static GLB (Cycles CPU).

    blender -b -P preview.py -- in.glb out.png [views] [--kind building|prop|item|mount|monster] [--cell 384]

Renders `views` (default 4) views around the model on a ground grid with a hex outline (radius 1)
for scale, a red arrow on the ground pointing to the model's front (glTF +Z = Blender -Y), and a
small cross at the origin; a 1.0-tall grey reference figure stands next to items, mounts and
monsters.  Prints the bounding box and triangle count.  Also importable: preview.render(...).
"""
import math
import os
import sys
import tempfile

import bpy
import numpy as np
from mathutils import Vector

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common as C  # noqa: E402


def _mat(name, rgb, rough=0.7, emit=0.0):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    b = m.node_tree.nodes["Principled BSDF"]
    b.inputs["Base Color"].default_value = (*rgb, 1)
    b.inputs["Roughness"].default_value = rough
    if emit:
        b.inputs["Emission Color"].default_value = (*rgb, 1)
        b.inputs["Emission Strength"].default_value = emit
    return m


def _helpers(kind, size, lift=0.0):
    objs = []
    # hex outline (pointy-top, radius 1) for buildings / props
    if kind in ("building", "prop"):
        pts = [(math.cos(math.radians(30 + 60 * i)), math.sin(math.radians(30 + 60 * i))) for i in range(6)]
        for i in range(6):
            a, b = Vector((*pts[i], 0.003)), Vector((*pts[(i + 1) % 6], 0.003))
            bpy.ops.mesh.primitive_cylinder_add(radius=0.008, depth=(b - a).length, location=(a + b) / 2)
            o = bpy.context.active_object
            o.rotation_euler = (b - a).to_track_quat('Z', 'Y').to_euler()
            o.data.materials.append(_mat("hex", (0.95, 0.95, 0.95), emit=0.6))
            objs.append(o)
    # front arrow
    L = max(0.25, 0.6 * size)
    bpy.ops.mesh.primitive_cylinder_add(radius=0.01 * max(1, size), depth=L, location=(0, -L / 2, 0.004), rotation=(math.pi / 2, 0, 0))
    o = bpy.context.active_object; o.data.materials.append(_mat("arrow", (0.9, 0.1, 0.05), emit=1.0)); objs.append(o)
    bpy.ops.mesh.primitive_cone_add(radius1=0.03 * max(1, size), depth=0.07 * max(1, size), location=(0, -L, 0.004), rotation=(math.pi / 2, 0, 0))
    o = bpy.context.active_object; o.data.materials.append(_mat("arrow", (0.9, 0.1, 0.05), emit=1.0)); objs.append(o)
    # origin marker
    for ax in ((1, 0, 0), (0, 1, 0), (0, 0, 1)):
        bpy.ops.mesh.primitive_cylinder_add(radius=0.004, depth=0.08, location=(0, 0, lift))
        o = bpy.context.active_object
        o.rotation_euler = Vector(ax).to_track_quat('Z', 'Y').to_euler()
        o.data.materials.append(_mat("origin", (0.1, 0.9, 0.2), emit=1.0)); objs.append(o)
    if kind in ("item", "mount", "monster"):
        # 1.0-tall reference figure (capsule) beside the model
        x = -(0.35 if kind == "item" else 0.75)
        bpy.ops.mesh.primitive_cylinder_add(radius=0.09, depth=0.62, location=(x, 0.3, 0.31 + 0.05))
        o = bpy.context.active_object; o.data.materials.append(_mat("ref", (0.55, 0.55, 0.58))); objs.append(o)
        bpy.ops.mesh.primitive_uv_sphere_add(radius=0.1, location=(x, 0.3, 0.9))
        o = bpy.context.active_object; o.data.materials.append(_mat("ref", (0.55, 0.55, 0.58))); objs.append(o)
    return objs


def render(src, out, views=4, kind="prop", cell=384):
    C.reset_scene()
    bpy.ops.import_scene.gltf(filepath=src)
    objs = [o for o in bpy.context.scene.objects if o.type == 'MESH']
    mn = Vector((1e9,) * 3); mx = Vector((-1e9,) * 3)
    tris = 0
    for o in objs:
        for c in o.bound_box:
            w = o.matrix_world @ Vector(c)
            mn = Vector(map(min, mn, w)); mx = Vector(map(max, mx, w))
        o.data.calc_loop_triangles()
        tris += len(o.data.loop_triangles)
    print("BBOX", tuple(round(v, 3) for v in mn), tuple(round(v, 3) for v in mx), "tris", tris)
    lift = 0.0
    if kind == "item":
        # items float at their grip origin: lift into view above the ground (marker follows the grip)
        lift = -mn.z + 0.02
        for o in bpy.context.scene.objects:
            if o.parent is None:
                o.location.z += lift
        mx.z += lift; mn.z = 0.02
    size = max(mx - mn)
    sc = bpy.context.scene
    _helpers(kind, size, lift)
    bpy.ops.mesh.primitive_plane_add(size=max(6, size * 6), location=(0, 0, 0))
    bpy.context.active_object.data.materials.append(_mat("ground", (0.36, 0.4, 0.34), 0.95))
    sc.render.engine = 'CYCLES'
    sc.cycles.device = 'CPU'; sc.cycles.samples = 24; sc.cycles.use_denoising = True
    sc.view_settings.view_transform = 'Standard'
    sc.render.resolution_x = cell; sc.render.resolution_y = cell
    world = bpy.data.worlds.new("w"); sc.world = world; world.use_nodes = True
    bg = world.node_tree.nodes["Background"]; bg.inputs[0].default_value = (0.6, 0.65, 0.72, 1); bg.inputs[1].default_value = 0.9
    sun = bpy.data.objects.new("sun", bpy.data.lights.new("sun", 'SUN')); sc.collection.objects.link(sun)
    sun.data.energy = 3.2; sun.rotation_euler = (math.radians(45), 0, math.radians(30))
    cam = bpy.data.objects.new("cam", bpy.data.cameras.new("cam")); sc.collection.objects.link(cam); sc.camera = cam
    cam.data.type = 'ORTHO'
    center = (mn + mx) / 2
    span = max(size, 2.1 if kind in ("building", "prop") else size)
    cam.data.ortho_scale = span * 1.3
    tmp = tempfile.mkdtemp()
    paths = []
    for i in range(views):
        a = math.radians(-30 + i * (360 / views))      # first view: front-left three-quarter
        d = span * 3
        cam.location = center + Vector((math.sin(a) * d, -math.cos(a) * d, d * 0.6))
        cam.rotation_euler = (center - cam.location).to_track_quat('-Z', 'Y').to_euler()
        p = os.path.join(tmp, f"v{i}.png"); sc.render.filepath = p
        bpy.ops.render.render(write_still=True); paths.append(p)
    w = h = cell
    sheet = np.zeros((h, w * views, 4), np.float32)
    for k, p in enumerate(paths):
        im = bpy.data.images.load(p)
        sheet[:, k * w:(k + 1) * w] = np.array(im.pixels[:], np.float32).reshape(h, w, 4)
    img = bpy.data.images.new("out", w * views, h)
    img.pixels = sheet.ravel()
    img.filepath_raw = out; img.file_format = 'PNG'; img.save()
    print("WROTE", out)


if __name__ == "__main__":
    a = C.script_args()
    kind = a[a.index("--kind") + 1] if "--kind" in a else "prop"
    cell = int(a[a.index("--cell") + 1]) if "--cell" in a else 384
    pos = [x for i, x in enumerate(a) if not x.startswith("--") and (i == 0 or not a[i - 1].startswith("--"))]
    render(pos[0], pos[1], int(pos[2]) if len(pos) > 2 else 4, kind=kind, cell=cell)
