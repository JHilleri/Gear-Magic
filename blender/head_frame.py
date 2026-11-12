"""Head frame of a rigged, bald unit body, and previews of hair / beard pieces on it.

    blender -b -P head_frame.py -- body.glb [--write] [--preview out.png --pieces a.glb,b.glb+c.glb]
                                   [--tint 7a5233] [--cell 256] [--face face.png] [--eyes "x,y;x,y"]

The **head frame** (shared with fit_hair.py, which exports every piece in it):
    origin = crown of the skull, on the centre line, at the occiput;  unit = skull depth (forehead to occiput)
measured on the bind-pose mesh above the neck landmark of the body's sidecar (`zn`).
--write stores it in <body>.meta.json as  "head": {"x", "y", "z", "depth"}  in glTF axes (the game puts
piece vertex p at  head + p * depth), and with --eyes the two iris centres as "eyes": [[x, y, z], ...]
plus "eye_r".  --eyes takes pixel coordinates read off the --face image (flat-lit front close-up of
the face, 768 px); each is snapped to the darkest blob nearby (the pupil) unless the list starts with "=".
--preview renders rows of piece combinations ("+" joins pieces of one row) from four sides, tinted.
"""
import json
import math
import os
import sys
import tempfile

import bpy
import numpy as np
from mathutils import Vector

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common as C  # noqa: E402
import headmap as HM  # noqa: E402

FACE_PX = 768


def opt(a, name, default=None):
    return a[a.index(name) + 1] if name in a else default


def frame(V, zn):
    """(cx, top, back, depth, hh) in Blender axes (+Z up, front -Y) from head vertices."""
    Hd = V[(V[:, 2] > zn) & (np.abs(V[:, 0]) < 0.14)]
    top = Hd[:, 2].max()
    hh = top - zn
    depth = 0.75 * hh
    for _ in range(3):
        band = Hd[(Hd[:, 2] < top - 0.12 * depth) & (Hd[:, 2] > top - 0.45 * depth)]
        back, front = band[:, 1].max(), band[:, 1].min()
        depth = back - front
    cx = 0.5 * (band[:, 0].min() + band[:, 0].max())
    return cx, top, back, depth, hh


def setup_render(cell, flat=False):
    sc = bpy.context.scene
    sc.render.engine = 'CYCLES'
    sc.cycles.device = 'CPU'; sc.cycles.samples = 12 if flat else 20; sc.cycles.use_denoising = not flat
    sc.view_settings.view_transform = 'Standard'
    sc.render.resolution_x = cell; sc.render.resolution_y = cell
    world = bpy.data.worlds.new("w"); sc.world = world; world.use_nodes = True
    bg = world.node_tree.nodes["Background"]
    bg.inputs[0].default_value = (1, 1, 1, 1) if flat else (0.62, 0.66, 0.72, 1)
    bg.inputs[1].default_value = 1.0 if flat else 0.9
    if not flat:
        sun = bpy.data.objects.new("sun", bpy.data.lights.new("sun", 'SUN')); sc.collection.objects.link(sun)
        sun.data.energy = 3.0; sun.rotation_euler = (math.radians(50), 0, math.radians(25))
    cam = bpy.data.objects.new("cam", bpy.data.cameras.new("cam")); sc.collection.objects.link(cam); sc.camera = cam
    cam.data.type = 'ORTHO'
    return sc, cam


def load_pixels(path, cell):
    im = bpy.data.images.load(path)
    return np.array(im.pixels[:], np.float32).reshape(cell, cell, 4)


def save_sheet(sheet, out):
    h, w = sheet.shape[:2]
    img = bpy.data.images.new("out", w, h)
    img.pixels = sheet.ravel()
    img.filepath_raw = out; img.file_format = 'PNG'; img.save()
    print("WROTE", out)


def add_piece(path, cx, top, back, depth, tint):
    before = set(bpy.context.scene.objects)
    bpy.ops.import_scene.gltf(filepath=path)
    new = [o for o in bpy.context.scene.objects if o not in before]
    for o in new:
        if o.parent is None:
            # piece (Blender axes after import): x, y = -forward, z = up, in skull depths from the crown/occiput
            o.scale = (depth, depth, depth)
            o.location = (cx, back, top)
        if o.type == 'MESH':
            for slot in o.material_slots:
                m = slot.material
                if m and m.node_tree:
                    nt = m.node_tree
                    b = next(n for n in nt.nodes if n.type == 'BSDF_PRINCIPLED')
                    s = b.inputs["Base Color"]
                    if s.is_linked:
                        src = s.links[0].from_socket
                        mix = nt.nodes.new("ShaderNodeMix"); mix.data_type = 'RGBA'; mix.blend_type = 'MULTIPLY'
                        mix.inputs["Factor"].default_value = 1.0
                        nt.links.new(src, mix.inputs["A"])
                        mix.inputs["B"].default_value = (*tint, 1)
                        nt.links.new(mix.outputs["Result"], s)
    return new


def main():
    a = C.script_args()
    body = a[0]
    meta_path = os.path.splitext(body)[0] + ".meta.json"
    meta = json.load(open(meta_path)) if os.path.exists(meta_path) else {}
    zn = float(meta.get("landmarks", {}).get("zn", 0.85))
    C.reset_scene()
    # the rigged GLB: keep the mesh in its bind pose (drop the armature modifier), read it in world axes
    bpy.ops.import_scene.gltf(filepath=body)
    # (the importer also adds an untextured icosphere as the bones' display shape: not the body)
    meshes = [o for o in bpy.context.scene.objects if o.type == 'MESH' and len(o.material_slots) > 0]
    for o in bpy.context.scene.objects:
        if o.type == 'MESH' and o not in meshes:
            o.hide_render = True
    parts, cparts = [], []
    for o in meshes:
        for m in list(o.modifiers):
            o.modifiers.remove(m)
        mw = np.array(o.matrix_world)
        v = C.verts_np(o)
        parts.append(v @ mw[:3, :3].T + mw[:3, 3])
        cparts.append(C.vertex_texture_colors(o))
    for o in bpy.context.scene.objects:
        if o.type not in ('MESH', 'ARMATURE'):
            o.hide_render = True
    V = np.concatenate(parts)
    colours = np.concatenate(cparts) if all(c is not None for c in cparts) else None
    cx, top, back, depth, hh = frame(V, zn)
    C.log(f"head cx {cx:.4f} top {top:.4f} back {back:.4f} depth {depth:.4f} hh {hh:.4f}")
    # "neck": the throat line (where the neck begins under the chin) in frame units: the game hides
    # the body's own head above it when the unit wears a face model (fit_head.py)
    Vf = (V - np.array([cx, back, top])) / depth
    throat = HM.find_throat(Vf[np.abs(Vf[:, 0]) < 0.6])
    head = {"x": round(float(cx), 5), "y": round(float(top), 5), "z": round(float(-back), 5), "depth": round(float(depth), 5),
            "neck": round(throat, 4)}
    skin = None
    if colours is not None:
        # (the cheeks: always skin, where the neck may be a collar or a gorget)
        m = (V[:, 2] < top - 0.75 * depth) & (V[:, 2] > top - 1.15 * depth) & (np.abs(V[:, 0] - cx) < 0.25 * depth) & (V[:, 1] < back - 0.75 * depth)
        if m.sum() > 10:
            skin = [round(float(x), 4) for x in np.median(colours[m], axis=0)]
    # the neck just under that line, as the face model's is measured (headmap.neck_ring): the game
    # shapes the face's neck onto it when it is bare skin
    ring = HM.neck_ring(Vf, throat, colours)
    if ring:
        head["ring"] = ring
    C.log("neck", head["neck"], "ring", ring, "skin", skin)

    # ---- flat front close-up of the face, for reading the eye positions
    span = 1.25 * hh
    centre = Vector((cx, back - depth, top - 0.5 * hh))
    face = opt(a, "--face")
    eyes_arg = opt(a, "--eyes")
    if face or eyes_arg:
        tmp = os.path.join(tempfile.mkdtemp(), "face.png")
        sc, cam = setup_render(FACE_PX, flat=True)
        cam.data.ortho_scale = span
        cam.location = centre + Vector((0, -2, 0)); cam.rotation_euler = (math.radians(90), 0, 0)
        sc.render.filepath = tmp
        bpy.ops.render.render(write_still=True)
        px = load_pixels(tmp, FACE_PX)
        if eyes_arg:
            lum = px[..., :3].mean(2)
            eyes = []
            r = int(0.018 * hh / span * FACE_PX) + 2
            exact = eyes_arg.startswith("=")      # "=x,y;x,y": take the points as given, no snapping
            for part in eyes_arg.lstrip("=").split(";"):
                ex, ey = [float(t) for t in part.split(",")]
                ix, iy = int(round(ex)), int(round(FACE_PX - 1 - ey))  # image rows are bottom-up
                win = lum[iy - r:iy + r + 1, ix - r:ix + r + 1]
                thr = np.percentile(win, 12)
                ys, xs = np.nonzero(win <= thr)
                sx, sy = (ix, iy) if exact else (ix - r + xs.mean(), iy - r + ys.mean())
                wx = centre.x + (sx + 0.5 - FACE_PX / 2) / FACE_PX * span
                wz = centre.z + (sy + 0.5 - FACE_PX / 2) / FACE_PX * span
                # depth: the surface at that spot (front-most vertex nearby)
                near = V[(np.abs(V[:, 0] - wx) < 0.012) & (np.abs(V[:, 2] - wz) < 0.012) & (V[:, 1] < back - 0.5 * depth)]
                wy = float(near[:, 1].min()) if len(near) else back - 0.9 * depth
                eyes.append([round(float(wx), 5), round(float(wz), 5), round(float(-wy), 5)])  # glTF axes
                C.log(f"eye px ({ex:.0f},{ey:.0f}) -> snapped ({sx:.1f},{FACE_PX - 1 - sy:.1f}) -> {eyes[-1]}")
                # mark it on the sheet
                yy, xx = int(sy), int(sx)
                px[yy - 1:yy + 2, xx - 9:xx + 10] = (1, 0, 0, 1); px[yy - 9:yy + 10, xx - 1:xx + 2] = (1, 0, 0, 1)
            meta["eyes"] = eyes
            meta["eye_r"] = round(float(0.0062 * hh / 0.15), 5)
        if face:
            save_sheet(px, face)
    if "--write" in a:
        meta["head"] = head
        if skin:
            meta["skin"] = skin
        with open(meta_path, "w") as f:
            json.dump(meta, f, indent=1)
        C.log("meta updated", meta_path)

    # ---- pieces on the head
    prev = opt(a, "--preview")
    if prev:
        cell = int(opt(a, "--cell", 256))
        t = opt(a, "--tint", "7a5233")
        tint = tuple((int(t[i:i + 2], 16) / 255) ** 2.2 for i in (0, 2, 4))
        rows = [r for r in (opt(a, "--pieces", "") or "").split(",")]
        sc, cam = setup_render(cell)
        cam.data.ortho_scale = 2.3 * hh
        mid = Vector((cx, back - 0.5 * depth, top - 0.75 * hh))
        angles = [0, 40, 90, 180]
        sheet = np.zeros((cell * len(rows), cell * len(angles), 4), np.float32)
        tmp = tempfile.mkdtemp()
        for ri, row in enumerate(rows):
            added = []
            for p in [x for x in row.split("+") if x]:
                added += add_piece(p, cx, top, back, depth, tint)
            for ci, ang in enumerate(angles):
                r = math.radians(ang)
                cam.location = mid + Vector((math.sin(r) * 3, -math.cos(r) * 3, 0.35))
                cam.rotation_euler = (mid - cam.location).to_track_quat('-Z', 'Y').to_euler()
                p = os.path.join(tmp, f"r{ri}c{ci}.png"); sc.render.filepath = p
                bpy.ops.render.render(write_still=True)
                y0 = (len(rows) - 1 - ri) * cell
                sheet[y0:y0 + cell, ci * cell:(ci + 1) * cell] = load_pixels(p, cell)
            for o in added:
                bpy.data.objects.remove(o, do_unlink=True)
        save_sheet(sheet, prev)


if __name__ == "__main__":
    main()
