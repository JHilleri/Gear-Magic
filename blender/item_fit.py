"""Item fit sheet: one rigged unit holding every processed item in its socket (Cycles CPU).

    blender -b -P item_fit.py -- unit.glb out.png --items DIR [--only sword,bow] [--cell 220]

One row per item found in DIR (*.glb).  Socket = the renderer's: bows in `hold.L`, shields
(`shield*`) on `grip.L`, everything else in `grip.R`.  Columns: idle front, idle side, idle
three-quarter, hand close-up (three-quarter, idle), then the item's action clip at its key frame
(sword/axe/spear/tools-less weapons: attack_melee 0.5 s; bow: attack_ranged 0.5 s; staff/wand:
cast 0.5 s; tools: work 0.28 s; shields: attack_melee 0.5 s) side and front.  Use it to validate
the grip / orientation tables in process_static.py on the REAL models.
"""
import math
import os
import sys
import tempfile

import bpy
import numpy as np
from mathutils import Matrix, Vector

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common as C  # noqa: E402
from rig_preview import _attach, _find_action, _mat, _set_visible  # noqa: E402

ACTION = {"bow": ("attack_ranged", 0.5), "staff": ("cast", 0.5), "wand": ("cast", 0.5), "tools": ("work", 0.28),
          "hammer": ("work", 0.28)}


def socket_for(item):
    if item == "bow":
        return "hold.L"
    if item.startswith("shield"):
        return "grip.L"
    return "grip.R"


def load_item(path, name):
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=path)
    new = [o for o in bpy.data.objects if o not in before]
    root = bpy.data.objects.new("item_" + name, None)
    bpy.context.scene.collection.objects.link(root)
    for o in new:
        if o.parent is None:
            o.parent = root
    return root


def main():
    a = C.script_args()
    unit, out = a[0], a[1]
    items_dir = a[a.index("--items") + 1]
    only = set(a[a.index("--only") + 1].split(",")) if "--only" in a else None
    cell = int(a[a.index("--cell") + 1]) if "--cell" in a else 220
    names = sorted(f[:-4] for f in os.listdir(items_dir) if f.endswith(".glb") and not f.endswith(".tmp.glb"))
    names = [n for n in names if not only or n in only]
    names.sort(key=lambda n: (n.startswith("shield"), n))
    C.reset_scene()
    bpy.ops.import_scene.gltf(filepath=unit)
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
    sc.view_settings.view_transform = 'Standard'
    world = bpy.data.worlds.new("w"); sc.world = world; world.use_nodes = True
    bg = world.node_tree.nodes["Background"]; bg.inputs[0].default_value = (0.62, 0.66, 0.72, 1); bg.inputs[1].default_value = 0.8
    sun = bpy.data.objects.new("sun", bpy.data.lights.new("sun", 'SUN')); sc.collection.objects.link(sun)
    sun.data.energy = 3.0; sun.data.angle = math.radians(8)
    sun.rotation_euler = (math.radians(40), 0, math.radians(-35))
    bpy.ops.mesh.primitive_plane_add(size=8, location=(0, 0, 0))
    bpy.context.active_object.data.materials.append(_mat("ground", (0.42, 0.45, 0.4), 0.9))
    cam = bpy.data.objects.new("cam", bpy.data.cameras.new("cam")); sc.collection.objects.link(cam); sc.camera = cam
    cam.data.type = 'ORTHO'
    bpy.ops.object.text_add()
    label = bpy.context.active_object
    label.data.size = 0.075
    label.data.materials.append(_mat("label", (0.02, 0.02, 0.03), 1.0, 0, (0.0, 0.0, 0.0)))
    label.parent = cam
    items = {n: load_item(os.path.join(items_dir, n + ".glb"), n) for n in names}
    for o in items.values():
        _set_visible(o, False)
    tmp = tempfile.mkdtemp()
    rows = []

    def shot(tag, loc, rot, scale, look_at=None):
        if look_at is not None:
            d = Vector(loc)
            cam.location = look_at + d
            cam.rotation_euler = (-d).to_track_quat('-Z', 'Y').to_euler()
        else:
            cam.location = loc
            cam.rotation_euler = rot
        cam.data.ortho_scale = scale
        label.data.body = tag
        label.location = (-0.38 * scale, 0.43 * scale, -1)
        label.scale = (scale / 1.32,) * 3
        p = os.path.join(tmp, f"{len(rows)}_{tag.replace(' ', '_')}.png")
        sc.render.filepath = p
        bpy.ops.render.render(write_still=True)
        return p

    def pose(clip, t):
        act = _find_action(clip)
        arm.animation_data_create()
        arm.animation_data.action = act
        if act is not None and hasattr(arm.animation_data, "action_slot") and act.slots:
            arm.animation_data.action_slot = act.slots[0]
        fr = t * sc.render.fps
        sc.frame_set(int(math.floor(fr)), subframe=fr - math.floor(fr))
        bpy.context.view_layer.update()

    FRONT = ((0.0, -4.0, 1.05), (math.radians(82), 0, 0))
    SIDE = ((4.0, 0.0, 1.05), (math.radians(82), 0, math.radians(90)))
    THREE = ((-2.8, -2.8, 1.75), (math.radians(74), 0, math.radians(-45)))
    for n in names:
        sock = sockets.get(socket_for(n))
        if sock is None:
            print("[item_fit] unit has no socket", socket_for(n))
            continue
        it = items[n]
        _attach(it, sock)
        _set_visible(it, True)
        row = []
        pose("idle", 0.0)
        row.append(shot(f"{n} idle front", *FRONT, 1.32))
        row.append(shot(f"{n} idle side", *SIDE, 1.32))
        row.append(shot(f"{n} idle 3/4", *THREE, 1.32))
        hand = sock.matrix_world.translation.copy()
        side = -1.0 if socket_for(n) == "grip.R" else 1.0     # look at the hand from its own side
        row.append(shot(f"{n} hand", (side * 2.0, -2.4, 1.0), None, 0.6, look_at=hand))
        clip, t = ACTION.get(n, ("attack_melee", 0.5))
        pose(clip, t)
        row.append(shot(f"{n} {clip} side", *SIDE, 1.32))
        row.append(shot(f"{n} {clip} front", *FRONT, 1.32))
        _set_visible(it, False)
        it.parent = None
        rows.append(row)
    if not rows:
        raise SystemExit("no items")
    ncol = max(len(r) for r in rows)
    w, h = sc.render.resolution_x, sc.render.resolution_y
    sheet = np.ones((h * len(rows), w * ncol, 4), np.float32) * 0.9
    for ri, row in enumerate(rows):
        for ci, p in enumerate(row):
            im = bpy.data.images.load(p)
            px = np.array(im.pixels[:], np.float32).reshape(h, w, 4)
            y0 = (len(rows) - 1 - ri) * h
            sheet[y0:y0 + h, ci * w:(ci + 1) * w] = px
            bpy.data.images.remove(im)
    img = bpy.data.images.new("sheet", w * ncol, h * len(rows))
    img.pixels = sheet.ravel()
    img.filepath_raw = out
    img.file_format = 'PNG'
    img.save()
    print("[item_fit] wrote", out)


if __name__ == "__main__":
    main()
