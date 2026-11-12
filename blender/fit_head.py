"""A face: a bald head and neck from image-to-3D → `models/heads/<id>.glb`, in the head frame.

    blender -b -P fit_head.py -- in.glb out.glb [--tris 7000] [--tex 1024] [--quality 88]
                                 [--eyes "x,y;x,y" | "=x,y;x,y"] [--face face.png] [--maps DIR]

A full-body model has a few dozen texels of face.  The game hides that head and puts one of these on
the head bone instead (render/appearance.ts), so a portrait has a real face.  The head is exported in
the **head frame** every body and hair piece shares (fit_hair.py): origin = crown of the skull, on the
centre line, at the occiput; unit = skull depth; glTF +Y up, +Z forward (forehead at z = 1).

* The skull is measured exactly as head_frame.py measures a body's.
* **Throat**: where the front of the neck begins under the chin (headmap.find_throat).  The body keeps its own neck
  below its throat line; the head keeps 0.3 skull depths of its own under that line, which the game
  shapes onto the body's neck (same width and colour at the join, then inside it), so the two always
  overlap.  The line rises 0.25 skull depths toward the nape.  `neck_ring` is the neck just under
  the line as an ellipse, with its skin colour.
* **Skin**: the median colour of the cheeks, so the game can tint the head to the body's skin.
* **Eyes**: the two iris centres, found as the darker part of the pale patch (the eye) in each eye box of a flat front
  render (--face writes it with the result marked).  --eyes overrides them with pixel coordinates read
  off that render ("=" in front: taken as given, else snapped to the nearest pupil).

Sidecar <out>.meta.json: "eyes" [[x, y, z], [x, y, z]], "eye_r", "neck" (throat height), "neck_ring", "skin" [r, g, b].
--maps DIR also writes <id>.map.json there: the radial map of the face (headmap.py), the target hair
and beards are fitted against.
"""
import json
import math
import os
import sys
import tempfile

import bpy
import bmesh
import numpy as np
from mathutils import Vector

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common as C  # noqa: E402
import head_frame as HF  # noqa: E402
import headmap as HM  # noqa: E402

PX = 768
SPAN = 1.9          # frame units covered by the face render
MID_Z = -0.72       # its centre (below the crown)
NAPE_RISE = 0.25    # the neck line: throat height at the front, this much higher at the nape
PLUG = 0.3          # neck kept below the line (the game shapes it to the body's neck)
NECK_R = 0.62       # ... and only within this radius of the neck axis (the shoulders and the shirt go)
IRIS_R = 0.034      # iris radius in skull depths


def opt(a, name, default, cast=float):
    return cast(a[a.index(name) + 1]) if name in a else default


def neck_line(y, throat):
    """Height of the head/neck line at depth y (Blender frame axes: y = 0 occiput … -1 forehead)."""
    return throat + NAPE_RISE * (1.0 - np.clip(-y, 0.0, 0.8) / 0.8)


def main():
    a = C.script_args()
    src, dst = a[0], a[1]
    C.reset_scene()
    obj = C.import_joined_mesh(src, "Head")
    C.remove_small_islands(obj)
    V = C.verts_np(obj)                       # Blender: +Z up, front = -Y

    # ---- skull frame (as head_frame.frame, without a neck landmark to start from)
    top = V[:, 2].max()
    depth = 0.8 * (V[:, 1].max() - V[:, 1].min())
    for _ in range(5):
        band = V[(V[:, 2] < top - 0.12 * depth) & (V[:, 2] > top - 0.45 * depth)]
        back, front = band[:, 1].max(), band[:, 1].min()
        depth = back - front
    cx = 0.5 * (band[:, 0].min() + band[:, 0].max())
    V = (V - np.array([cx, back, top])) / depth
    C.set_verts_np(obj, V)
    C.log(f"skull cx {cx:.4f} top {top:.4f} back {back:.4f} depth {depth:.4f}")

    # ---- throat: where the neck begins under the chin (the head / neck line)
    throat = HM.find_throat(V)
    C.log(f"throat {throat:.3f}")

    # ---- skin: median texel of the cheeks (as head_frame.py samples a body's)
    cols = C.vertex_texture_colors(obj)
    skin = [0.8, 0.62, 0.52]
    if cols is not None:
        m = (V[:, 2] < -0.75) & (V[:, 2] > -1.15) & (np.abs(V[:, 0]) < 0.25) & (V[:, 1] < -0.75)
        if m.sum() > 30:
            skin = [float(x) for x in np.median(cols[m], axis=0)]
    C.log("skin", [round(x, 3) for x in skin])

    # ---- the neck under the throat line: its ring (the game shapes it to the body's neck), then cut
    ring = HM.neck_ring(V, throat, cols)
    C.log("neck ring", ring)
    line = neck_line(V[:, 1], throat)
    below = line - V[:, 2]
    axis = np.array([ring["cx"], ring["cy"]]) if ring else np.array([0.0, -0.45])
    me = obj.data
    bm = bmesh.new(); bm.from_mesh(me)
    # (the shirt the image model draws: bright and nearly grey, where skin is not)
    shirt = np.zeros(len(V), bool)
    if cols is not None:
        mx, mn = cols.max(1), cols.min(1)
        shirt = ((mx - mn) / np.maximum(mx, 1e-3) < 0.14) & (mx > 0.45) & (below > -0.2)
    bm.verts.ensure_lookup_table()
    kill = []
    for f in bm.faces:
        c = f.calc_center_median()
        if any(shirt[v.index] for v in f.verts):
            kill.append(f)
            continue
        under = float(neck_line(np.array(c.y), throat)) - c.z
        if under > PLUG or (under > 0.04 and math.hypot(c.x - axis[0], c.y - axis[1]) > NECK_R):
            kill.append(f)
    bmesh.ops.delete(bm, geom=kill, context='FACES')
    bm.to_mesh(me); bm.free()
    # a head is one shell: whatever else is left (shards of the bust) goes
    C.remove_small_islands(obj, area_frac=0.03, far_area_frac=0.2, far_dist_frac=0.0)
    C.log(f"cut {len(kill)} faces below the neck plug")

    C.recalc_normals(obj)
    C.decimate(obj, opt(a, "--tris", 7000, int))
    C.shade(obj, "smooth")
    for slot in obj.material_slots:
        m = slot.material
        if m and m.node_tree:
            for n in m.node_tree.nodes:
                if n.type == 'BSDF_PRINCIPLED':
                    s = n.inputs["Metallic"]
                    for l in list(s.links):
                        m.node_tree.links.remove(l)
                    s.default_value = 0.0
    C.prepare_materials([obj], max_tex=opt(a, "--tex", 1024, int), double_sided=True)
    V = C.verts_np(obj)

    # ---- eyes: flat front render, darkest blob of each eye box
    sc, cam = HF.setup_render(PX, flat=True)
    cam.data.ortho_scale = SPAN
    centre = Vector((0.0, -1.0, MID_Z))
    cam.location = centre + Vector((0, -4, 0)); cam.rotation_euler = (math.radians(90), 0, 0)
    tmp = os.path.join(tempfile.mkdtemp(), "face.png")
    sc.render.filepath = tmp
    bpy.ops.render.render(write_still=True)
    px = HF.load_pixels(tmp, PX)
    lum = px[..., :3].mean(2)
    sat = (px[..., :3].max(2) - px[..., :3].min(2)) / np.maximum(px[..., :3].max(2), 1e-3)
    to_px = lambda x, z: ((x - centre.x) / SPAN * PX + PX / 2, (z - centre.z) / SPAN * PX + PX / 2)   # image rows bottom-up
    to_w = lambda ix, iy: (centre.x + (ix + 0.5 - PX / 2) / PX * SPAN, centre.z + (iy + 0.5 - PX / 2) / PX * SPAN)
    given = opt(a, "--eyes", None, str)
    pts = []
    if given:
        exact = given.startswith("=")
        for part in given.lstrip("=").split(";"):
            ex, ey = [float(t) for t in part.split(",")]
            pts.append((ex, PX - 1 - ey, exact))
    else:
        for sx in (-1, 1):   # the eye boxes: beside the nose, around mid-face
            x0, y0 = to_px(sx * 0.15, -0.56)
            pts.append((x0, y0, False))
    eyes = []
    r = int(0.1 / SPAN * PX)
    for ix, iy, exact in pts:
        ix, iy = int(round(ix)), int(round(iy))
        if not exact:
            # The eye is the pale, nearly grey patch of the box (skin is far more saturated); the iris
            # is its darker part.  Without such a patch, the darkest blob (the pupil).
            sl = (slice(iy - r, iy + r + 1), slice(ix - r, ix + r + 1))
            wl, ws = lum[sl], sat[sl]
            eye = (ws < 0.22) & (wl > 0.25)
            if eye.sum() > 40:
                dark = eye & (wl < np.percentile(wl[eye], 35))
            else:
                dark = wl <= np.percentile(wl, 2.5)
            ys, xs = np.nonzero(dark)
            ix, iy = ix - r + xs.mean(), iy - r + ys.mean()
        wx, wz = to_w(ix, iy)
        near = V[(np.abs(V[:, 0] - wx) < 0.06) & (np.abs(V[:, 2] - wz) < 0.06) & (V[:, 1] < -0.5)]
        wy = float(near[:, 1].min()) if len(near) else -0.92
        eyes.append([round(float(wx), 4), round(float(wz), 4), round(float(-wy), 4)])        # glTF frame axes
        C.log(f"eye -> px ({ix:.1f},{PX - 1 - iy:.1f}) -> {eyes[-1]}")
        yy, xx = int(iy), int(ix)
        rr = int(IRIS_R / SPAN * PX)
        for t in np.linspace(0, 2 * math.pi, 90):
            px[int(yy + rr * math.sin(t)), int(xx + rr * math.cos(t))] = (1, 0, 0, 1)
        px[yy, xx - 3:xx + 4] = (1, 0, 0, 1); px[yy - 3:yy + 4, xx] = (1, 0, 0, 1)
    face = opt(a, "--face", None, str)
    if face:
        HF.save_sheet(px, face)
    for o in list(bpy.context.scene.objects):
        if o.type != 'MESH':
            bpy.data.objects.remove(o, do_unlink=True)

    size = C.export_glb(dst, quality=opt(a, "--quality", 88, int))
    # the shape of this face, for fitting hair and beards (headmap.py): kept with the previews, not shipped
    maps = opt(a, "--maps", None, str)
    if maps:
        HM.save(os.path.join(maps, os.path.splitext(os.path.basename(dst))[0] + ".map.json"), HM.radial_map(V, HM.mesh_tris(obj)))
    meta = {"eyes": eyes, "eye_r": IRIS_R, "neck": round(throat, 4), "skin": [round(x, 4) for x in skin], "tris": C.tri_count(obj)}
    if ring:
        meta["neck_ring"] = ring
    with open(os.path.splitext(dst)[0] + ".meta.json", "w") as f:
        json.dump(meta, f, indent=1)
    C.log(f"WROTE {dst} {size} bytes, {meta['tris']} tris")


if __name__ == "__main__":
    main()
