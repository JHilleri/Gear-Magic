"""Contact sheet of a rigged unit GLB: rest pose + key frames of every clip, front and side.

    blender -b -P rig_preview.py -- unit.glb out.png [--items DIR] [--cell 200]

Renders the EXPORTED file (so it also validates the export): imports the GLB, attaches item
models (DIR/sword.glb, bow.glb, staff.glb, shield_*.glb ... if present, else simple stand-ins) to the
grip sockets, and renders each cell with Cycles CPU.  Rows: rest/idle, then one row per clip with
three key times; the left half of a row is the front view, the right half the side view.
"""
import glob
import math
import os
import sys
import tempfile

import bpy
import numpy as np
from mathutils import Matrix, Vector

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common as C  # noqa: E402

ROWS = [  # clip, times (s), item kit
    ("rest", [0.0], "sword"), ("idle", [0.0, 1.0], "sword"),
    ("walk", [0.0, 0.2, 0.4], "sword"),
    ("run", [0.0, 0.1, 0.2], "sword"),
    ("attack_melee", [0.32, 0.5, 0.62], "sword"),
    ("attack_ranged", [0.24, 0.5, 0.78], "bow"),
    ("cast", [0.3, 0.5, 0.7], "staff"),
    ("hit", [0.0, 0.09, 0.3], "sword"),
    ("death", [0.38, 0.7, 1.2], "sword"),
    ("work", [0.0, 0.28, 0.44], "tools"),
    ("ride_idle", [0.0, 1.0], "sword"),
    ("ride_attack", [0.32, 0.5, 0.62], "sword"),
]
SADDLE_Z = 0.55


def _mat(name, rgb, rough=0.6, metal=0.0, emit=None):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    bsdf = m.node_tree.nodes["Principled BSDF"]
    bsdf.inputs["Base Color"].default_value = (*rgb, 1)
    bsdf.inputs["Roughness"].default_value = rough
    bsdf.inputs["Metallic"].default_value = metal
    if emit:
        bsdf.inputs["Emission Color"].default_value = (*emit, 1)
        bsdf.inputs["Emission Strength"].default_value = 1.0
    return m


def _box(name, size, offset, mat, parent=None):
    bpy.ops.mesh.primitive_cube_add(size=1)
    o = bpy.context.active_object
    o.name = name
    o.scale = size
    o.location = offset
    bpy.ops.object.transform_apply(location=True, rotation=False, scale=True)
    o.data.materials.append(mat)
    return o


def _standin(kind):
    """Item stand-ins in item space (Blender: +Z = item up, -Y = edge/face), origin at the grip."""
    steel = _mat("steel", (0.75, 0.77, 0.8), 0.3, 1.0)
    wood = _mat("wood", (0.4, 0.25, 0.12))
    parts = []
    if kind == "sword":
        parts += [_box("blade", (0.012, 0.05, 0.42), (0, 0, 0.27), steel), _box("guard", (0.03, 0.12, 0.02), (0, 0, 0.055), steel),
                  _box("grip", (0.025, 0.025, 0.1), (0, 0, 0.0), wood)]
    elif kind == "bow":
        for i in range(9):
            a = (i - 4) / 4.0
            parts.append(_box(f"limb{i}", (0.02, 0.025, 0.08), (0, 0.06 * (1 - a * a) * -1 + 0.06, a * 0.3), wood))
        parts.append(_box("string", (0.004, 0.004, 0.62), (0, 0.07, 0), steel))
    elif kind == "staff":
        parts += [_box("shaft", (0.025, 0.025, 0.9), (0, 0, 0.09), wood),
                  _box("gem", (0.06, 0.06, 0.06), (0, 0, 0.56), _mat("gem", (0.3, 0.6, 1.0), 0.2, 0, (0.2, 0.5, 1.0)))]
    elif kind == "tools":
        parts += [_box("handle", (0.022, 0.022, 0.32), (0, 0, 0.1), wood), _box("head", (0.05, 0.13, 0.05), (0, 0, 0.26), steel)]
    elif kind == "shield":
        parts += [_box("shield", (0.30, 0.035, 0.40), (0, -0.02, 0), _mat("paint", (0.15, 0.3, 0.75), 0.5))]
    C._select_only(parts)
    bpy.ops.object.join()
    o = bpy.context.active_object
    o.name = "item_" + kind
    return o


def _load_item(kind, items_dir):
    names = {"shield": ["shield_human.glb", "shield.glb"]}.get(kind, [kind + ".glb"])
    if items_dir:
        for n in names:
            p = os.path.join(items_dir, n)
            if os.path.exists(p):
                before = set(bpy.data.objects)
                bpy.ops.import_scene.gltf(filepath=p)
                new = [o for o in bpy.data.objects if o not in before]
                meshes = [o for o in new if o.type == 'MESH']
                root = bpy.data.objects.new("item_" + kind, None)
                bpy.context.scene.collection.objects.link(root)
                for o in new:
                    if o.parent is None:
                        o.parent = root
                for o in meshes:
                    o.hide_render = False
                return root
    return _standin(kind)


def _attach(item, socket):
    item.parent = socket
    item.matrix_parent_inverse = Matrix.Identity(4)
    item.matrix_basis = Matrix.Identity(4)


def _set_visible(obj, vis):
    obj.hide_render = not vis
    for c in obj.children_recursive:
        c.hide_render = not vis


def _find_action(name):
    for a in bpy.data.actions:
        if a.name == name or a.name.startswith(name + "_") or a.name.startswith(name + "."):
            return a
    return None


def _bone_cells(arm, cam, label, tmp, sc):
    """Rest pose x-ray: translucent body + bone sticks (red = left, blue = right, yellow = centre)."""
    bodies = [o for o in sc.objects if o.type == 'MESH' and o.parent == arm]
    glass = _mat("xray", (0.8, 0.8, 0.85), 0.5)
    bsdf = glass.node_tree.nodes["Principled BSDF"]
    bsdf.inputs["Alpha"].default_value = 0.22
    saved = {o.name: [s.material for s in o.material_slots] for o in bodies}
    for o in bodies:
        for s in o.material_slots:
            s.material = glass
    cols = {"L": _mat("bl", (0.9, 0.1, 0.1), 0.5, 0, (0.9, 0.1, 0.1)), "R": _mat("br", (0.1, 0.3, 0.95), 0.5, 0, (0.1, 0.3, 0.95)),
            "C": _mat("bc", (0.95, 0.8, 0.1), 0.5, 0, (0.95, 0.8, 0.1))}
    sticks = []
    for b in arm.data.bones:
        h = arm.matrix_world @ b.head_local; t = arm.matrix_world @ b.tail_local
        d = t - h
        bpy.ops.mesh.primitive_cylinder_add(radius=0.006, depth=max(d.length, 1e-3), location=(h + t) / 2)
        o = bpy.context.active_object
        o.rotation_euler = d.to_track_quat('Z', 'Y').to_euler()
        o.data.materials.append(cols[b.name[-1] if b.name[-1] in "LR" else "C"])
        bpy.ops.mesh.primitive_uv_sphere_add(radius=0.011, location=h)
        j = bpy.context.active_object; j.data.materials.append(cols["C"])
        sticks += [o, j]
    for o in sc.objects:
        if o.name.startswith("item_"):
            _set_visible(o, False)
    out = []
    arm.data.pose_position = 'REST'
    for view in ("front", "side"):
        if view == "front":
            cam.location = (0.0, -4.0, 1.05); cam.rotation_euler = (math.radians(82), 0, 0)
        else:
            cam.location = (4.0, 0.0, 1.05); cam.rotation_euler = (math.radians(82), 0, math.radians(90))
        cam.data.ortho_scale = 1.32
        label.data.body = f"bones {view}"
        label.location = (-0.38 * 1.32, 0.43 * 1.32, -1)
        p = os.path.join(tmp, f"bones_{view}.png")
        sc.render.filepath = p
        bpy.ops.render.render(write_still=True)
        out.append(p)
    for o in sticks:
        bpy.data.objects.remove(o, do_unlink=True)
    for o in bodies:
        for s, m in zip(o.material_slots, saved[o.name]):
            s.material = m
    return out


def render_sheet(glb, out_png, items_dir=None, cell=200, rows=None, views=("front", "side")):
    C.reset_scene()
    bpy.ops.import_scene.gltf(filepath=glb)
    arm = next(o for o in bpy.context.scene.objects if o.type == 'ARMATURE')
    sockets = {o.name: o for o in bpy.context.scene.objects if o.type == 'EMPTY' and o.parent == arm}
    if arm.animation_data:
        for tr in list(arm.animation_data.nla_tracks):
            arm.animation_data.nla_tracks.remove(tr)
    sc = bpy.context.scene
    sc.render.engine = 'CYCLES'
    sc.cycles.device = 'CPU'
    sc.cycles.samples = 12
    sc.cycles.use_denoising = True
    sc.cycles.max_bounces = 3
    sc.render.resolution_x = cell
    sc.render.resolution_y = int(cell * 1.25)
    sc.render.film_transparent = False
    sc.view_settings.view_transform = 'Standard'
    world = bpy.data.worlds.new("w"); sc.world = world; world.use_nodes = True
    bg = world.node_tree.nodes["Background"]; bg.inputs[0].default_value = (0.62, 0.66, 0.72, 1); bg.inputs[1].default_value = 0.8
    sun = bpy.data.objects.new("sun", bpy.data.lights.new("sun", 'SUN')); sc.collection.objects.link(sun)
    sun.data.energy = 3.0; sun.data.angle = math.radians(8)
    sun.rotation_euler = (math.radians(40), 0, math.radians(-35))
    bpy.ops.mesh.primitive_plane_add(size=8, location=(0, 0, 0))
    ground = bpy.context.active_object
    ground.data.materials.append(_mat("ground", (0.42, 0.45, 0.4), 0.9))
    bpy.ops.mesh.primitive_cylinder_add(radius=0.17, depth=0.7, location=(0, 0, SADDLE_Z - 0.17), rotation=(math.pi / 2, 0, 0))
    barrel = bpy.context.active_object
    barrel.data.materials.append(_mat("horse", (0.35, 0.22, 0.12), 0.7))
    kits = {}
    for kind in ("sword", "bow", "staff", "tools", "shield"):
        kits[kind] = _load_item(kind, items_dir)
    shield = kits["shield"]
    if "grip.L" in sockets:
        _attach(shield, sockets["grip.L"])
    cam = bpy.data.objects.new("cam", bpy.data.cameras.new("cam")); sc.collection.objects.link(cam); sc.camera = cam
    cam.data.type = 'ORTHO'
    # label
    bpy.ops.object.text_add()
    label = bpy.context.active_object
    label.data.size = 0.075
    label.data.materials.append(_mat("label", (0.02, 0.02, 0.03), 1.0, 0, (0.0, 0.0, 0.0)))
    label.parent = cam
    tmp = tempfile.mkdtemp()
    cells = []
    for clip, times, kit in (rows or ROWS):
        row = []
        act = None if clip == "rest" else _find_action(clip)
        if clip != "rest" and act is None:
            print("[preview] missing clip", clip)
        riding = clip.startswith("ride")
        arm.location = (0, 0, SADDLE_Z if riding else 0)
        barrel.hide_render = not riding
        for k in kits:
            if k != "shield":
                _set_visible(kits[k], False)
        hold = kits[kit]
        sock = sockets.get("hold.L" if kit == "bow" else "grip.R")
        if sock:
            _attach(hold, sock)
            _set_visible(hold, True)
        _set_visible(shield, kit == "sword")
        arm.data.pose_position = 'REST' if clip == "rest" else 'POSE'
        if act is not None:
            arm.animation_data_create()
            arm.animation_data.action = act
            if hasattr(arm.animation_data, "action_slot") and act.slots:
                arm.animation_data.action_slot = act.slots[0]
        for view in views:
            for t in times:
                fr = t * sc.render.fps
                sc.frame_set(int(math.floor(fr)), subframe=fr - math.floor(fr))
                zc = 0.5 + (SADDLE_Z * 0.6 if riding else 0)
                scale = 1.55 if riding else 1.32
                if view == "front":
                    cam.location = (0.0, -4.0, zc + 0.55)
                    cam.rotation_euler = (math.radians(82), 0, 0)
                elif view == "back":
                    cam.location = (0.0, 4.0, zc + 0.55)
                    cam.rotation_euler = (math.radians(82), 0, math.radians(180))
                elif view == "three":
                    cam.location = (-2.8, -2.8, zc + 1.2)
                    cam.rotation_euler = (math.radians(74), 0, math.radians(-45))
                else:
                    yc = 0.3 if clip == "death" else 0.0
                    cam.location = (4.0, yc, zc + 0.55)
                    cam.rotation_euler = (math.radians(82), 0, math.radians(90))
                cam.data.ortho_scale = scale
                label.data.body = f"{clip} {t:.2f}s {view}"
                label.location = (-0.38 * scale, 0.43 * scale, -1)
                label.scale = (scale / 1.32,) * 3
                p = os.path.join(tmp, f"{clip}_{view}_{t:.2f}.png")
                sc.render.filepath = p
                bpy.ops.render.render(write_still=True)
                row.append(p)
        if clip == "rest":
            row += _bone_cells(arm, cam, label, tmp, sc)
        cells.append(row)
    # stitch rows (pad short rows)
    ncol = max(len(r) for r in cells)
    w, h = sc.render.resolution_x, sc.render.resolution_y
    sheet = np.ones((h * len(cells), w * ncol, 4), np.float32) * 0.9
    for ri, row in enumerate(cells):
        for ci, p in enumerate(row):
            im = bpy.data.images.load(p)
            px = np.array(im.pixels[:], np.float32).reshape(h, w, 4)
            y0 = (len(cells) - 1 - ri) * h
            sheet[y0:y0 + h, ci * w:(ci + 1) * w] = px
            bpy.data.images.remove(im)
    out = bpy.data.images.new("sheet", w * ncol, h * len(cells))
    out.pixels = sheet.ravel()
    out.filepath_raw = out_png
    out.file_format = 'PNG'
    out.save()
    print("[preview] wrote", out_png)


if __name__ == "__main__":
    a = C.script_args()
    items = a[a.index("--items") + 1] if "--items" in a else None
    cell = int(a[a.index("--cell") + 1]) if "--cell" in a else 200
    rows = None
    if "--rows" in a:   # e.g. --rows "idle@0,1;walk@0.2"
        rows = []
        for spec in a[a.index("--rows") + 1].split(";"):
            clip, ts = spec.split("@")
            kit = {"attack_ranged": "bow", "cast": "staff", "work": "tools"}.get(clip, "sword")
            rows.append((clip, [float(t) for t in ts.split(",")], kit))
    views = tuple(a[a.index("--views") + 1].split(",")) if "--views" in a else ("front", "side")
    render_sheet(a[0], a[1], items_dir=items, cell=cell, rows=rows, views=views)
