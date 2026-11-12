"""Hair / beard piece: key out the green mannequin head, register the piece on a head, grey it.

    blender -b -P fit_hair.py -- in.glb out.glb --kind hair|beard [--thick 0.05] [--scale 1] [--dy 0] [--dz 0]
                                 [--tris 5000 (beards 3000)] [--tex 768] [--quality 85]
                                 [--zmin Z] [--neck R] [--low-z Z] [--low-x X] [--low-y Y] [--low-front Y] [--face-clear Z]
                                 [--hang Z] [--maps DIR] [--no-register]

The source (art/tools/make_appearance_manifest.py) is a pale blonde wig or beard on a pure green
faceless mannequin head.  The piece is exported in the **head frame** every body shares, so the game
can put it on any head (render/units.ts):

    origin = top of the skull (crown), on the centre line, at the back of the skull (occiput)
    unit   = skull depth, forehead to occiput
    glTF axes: +Y up (the piece hangs below y = 0), +Z forward (the forehead is at z = 1)

head_frame.py measures the same frame on a bald body.  Here the skull is hidden by the wig, so the
frame is first guessed from the wig (its breadth high on the head, the green forehead, its top) and
then **registered**: the mannequin's visible skin (its face under a wig, its skull over a beard) is
laid on the generic head, the mean shape of the faces (`--maps DIR`, headmap.py).  Faces differ, so
the piece also carries, per vertex, the distance of the surface it was modelled on (a second UV set,
"fit"): the game conforms the piece to whichever face wears it.  --scale / --dy (forward) / --dz
(up), in skull depths, still correct a piece by eye; --no-register keeps the first guess.

What is not hair is cut away: everything under `--zmin` (how far the cut hangs), a column of radius
`--neck` around the neck below the jaw (the mannequin's neck in the shade of its chin is too dark to
key), under the shoulder line (`--low-z`) whatever lies beyond `--low-x` or in front of `--low-y`
(the pale bust the image model draws; for a tail, everything that is not behind the head), and
every island that lies wholly under the jaw (`--hang`): hair hangs from the head, shards do not.

The texture is replaced by its luminance, levelled to a light grey, so `material.color` tints the
piece to any hair colour.  Sidecar <out>.meta.json: the frame found and the bounding box.
"""
import json
import os
import sys

import bpy
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common as C  # noqa: E402
import headmap as HM  # noqa: E402

GREY = 0.74  # mean texture level of the hair after levelling (sRGB)


def opt(a, name, default, cast=float):
    return cast(a[a.index(name) + 1]) if name in a else default


def base_image(obj):
    for slot in obj.material_slots:
        m = slot.material
        if m and m.node_tree:
            for n in m.node_tree.nodes:
                if n.type == 'BSDF_PRINCIPLED' and n.inputs["Base Color"].is_linked:
                    src = n.inputs["Base Color"].links[0].from_node
                    if src.type == 'TEX_IMAGE' and src.image:
                        return src.image
    for im in bpy.data.images:
        if im.size[0] > 8:
            return im
    raise RuntimeError("no base colour texture")


def is_green(rgb):
    r, g, b = rgb[..., 0], rgb[..., 1], rgb[..., 2]
    m = np.maximum(r, b)
    # (dark green too: the mannequin's neck in the shade of its chin)
    return (g > 1.25 * m) & (g - m > 0.012)


def green_faces(obj, px):
    """Per polygon: is its texture green (majority of 7 samples across the triangle)?"""
    me = obj.data
    h, w = px.shape[:2]
    uv = np.zeros(len(me.loops) * 2, np.float32)
    me.uv_layers.active.data.foreach_get("uv", uv)
    uv = uv.reshape(-1, 2)
    me.calc_loop_triangles()
    nt = len(me.loop_triangles)
    loops = np.zeros(nt * 3, np.int32); me.loop_triangles.foreach_get("loops", loops)
    poly = np.zeros(nt, np.int32); me.loop_triangles.foreach_get("polygon_index", poly)
    t = uv[loops.reshape(-1, 3)]  # nt,3,2
    bary = np.array([[1/3, 1/3, 1/3], [.6, .2, .2], [.2, .6, .2], [.2, .2, .6], [.8, .1, .1], [.1, .8, .1], [.1, .1, .8]], np.float32)
    s = np.einsum('kb,tbc->tkc', bary, t)  # nt,7,2
    x = np.clip((s[..., 0] % 1.0) * w, 0, w - 1).astype(np.int32)
    y = np.clip((s[..., 1] % 1.0) * h, 0, h - 1).astype(np.int32)
    g = is_green(px[y, x, :3]).mean(1) > 0.5
    out = np.zeros(len(me.polygons), bool)
    np.logical_or.at(out, poly, g)
    return out


def dark_faces(obj, px):
    """Per polygon: is its texture dark (mean of 7 samples under 0.2)?  Not hair: that is pale blonde."""
    me = obj.data
    h, w = px.shape[:2]
    uv = np.zeros(len(me.loops) * 2, np.float32)
    me.uv_layers.active.data.foreach_get("uv", uv)
    uv = uv.reshape(-1, 2)
    me.calc_loop_triangles()
    nt = len(me.loop_triangles)
    loops = np.zeros(nt * 3, np.int32); me.loop_triangles.foreach_get("loops", loops)
    poly = np.zeros(nt, np.int32); me.loop_triangles.foreach_get("polygon_index", poly)
    t = uv[loops.reshape(-1, 3)]
    bary = np.array([[1/3, 1/3, 1/3], [.6, .2, .2], [.2, .6, .2], [.2, .2, .6], [.8, .1, .1], [.1, .8, .1], [.1, .1, .8]], np.float32)
    s = np.einsum('kb,tbc->tkc', bary, t)
    x = np.clip((s[..., 0] % 1.0) * w, 0, w - 1).astype(np.int32)
    y = np.clip((s[..., 1] % 1.0) * h, 0, h - 1).astype(np.int32)
    lum = px[y, x, :3].mean(2).mean(1)
    out = np.zeros(len(me.polygons), bool)
    np.logical_or.at(out, poly, lum < 0.2)
    return out


def register(G, generic, kind):
    """(s, ty, tz): scale and shift (frame units) that lay the mannequin's visible skin `G` on the
    generic head.  The mannequin shows its face under a wig and its skull over a beard; both are a
    far better guide to where its head is than the wig, whose buns, volume and tails say little."""
    P = G[(np.abs(G[:, 0]) < 0.33) & (G[:, 2] > (-1.25 if kind == "hair" else -0.8))]   # no ears, no neck / no beard line
    if len(P) < 120:
        return 1.0, 0.0, 0.0
    if len(P) > 1500:
        P = P[np.random.default_rng(1).choice(len(P), 1500, replace=False)]

    def cost(sc, ty, tz):
        Q = P * sc
        Q[:, 1] += ty; Q[:, 2] += tz
        u, v, rho = HM.dir_uv(Q)
        res = np.abs(rho - HM.sample(generic, u, v))
        return float(np.minimum(res, 0.15).mean()) + 0.03 * (abs(sc - 1.0) + abs(ty) + abs(tz))

    best = (cost(1.0, 0.0, 0.0), 1.0, 0.0, 0.0)
    span = (0.2, 0.24, 0.36)
    for n in (9, 5, 5, 5):                    # coarse to fine around the best so far
        _, s0, y0, z0 = best
        for sc in np.linspace(s0 - span[0], s0 + span[0], n):
            for ty in np.linspace(y0 - span[1], y0 + span[1], n):
                for tz in np.linspace(z0 - span[2], z0 + span[2], n):
                    c = cost(sc, ty, tz)
                    if c < best[0]:
                        best = (c, float(sc), float(ty), float(tz))
        span = tuple(x / 3.0 for x in span)
    C.log(f"register: scale {best[1]:.3f} forward {-best[2]:.3f} up {best[3]:.3f} (residual {best[0]:.4f}, was {cost(1.0, 0.0, 0.0):.4f})")
    return best[1], best[2], best[3]


def drop_low_islands(obj, zmax):
    """Delete the islands that lie wholly under `zmax`: a hair cut or a beard hangs from the head,
    the shards of the mannequin's bust do not."""
    me = obj.data
    nv = len(me.vertices)
    e = np.empty(len(me.edges) * 2, dtype=np.int64)
    me.edges.foreach_get("vertices", e)
    lab = C._components(nv, e.reshape(-1, 2))
    V = C.verts_np(obj)
    top = np.full(nv, -1e9)
    np.maximum.at(top, lab, V[:, 2])
    dead = np.nonzero(top[lab] < zmax)[0]
    if len(dead) == 0:
        return 0
    import bmesh
    bm = bmesh.new(); bm.from_mesh(me)
    bm.verts.ensure_lookup_table()
    bmesh.ops.delete(bm, geom=[bm.verts[i] for i in dead], context='VERTS')
    bm.to_mesh(me); bm.free(); me.update()
    return len(dead)


def main():
    a = C.script_args()
    src, dst = a[0], a[1]
    kind = opt(a, "--kind", "hair", str)
    thick = opt(a, "--thick", 0.05)
    C.reset_scene()
    obj = C.import_joined_mesh(src, "Hair")
    C.remove_small_islands(obj)
    img = base_image(obj)
    w, h = img.size
    px = np.array(img.pixels[:], np.float32).reshape(h, w, 4)
    px0 = px.copy()

    green = green_faces(obj, px)
    V = C.verts_np(obj)                      # Blender: +Z up, front = -Y
    me = obj.data
    gv = np.zeros(len(V), bool)
    hv = np.zeros(len(V), bool)
    for p in me.polygons:
        (gv if green[p.index] else hv)[list(p.vertices)] = True
    G, H = V[gv], V[hv & ~gv]
    C.log(f"faces {len(green)} green {int(green.sum())}  verts green {len(G)} hair {len(H)}")
    if len(H) < 50:
        raise RuntimeError("no hair found (everything is green?)")

    # ---- head frame (see the module docstring)
    if kind == "beard" and len(G) > 200:
        cx = 0.5 * (G[:, 0].min() + G[:, 0].max())
        top = G[:, 2].max()
        hh = None
        depth = 0.2
        for _ in range(3):
            band = G[(G[:, 2] < top - 0.12 * depth) & (G[:, 2] > top - 0.45 * depth)]
            back = band[:, 1].max(); front = band[:, 1].min()
            depth = back - front
    else:
        # The wig hides the skull.  Buns, tails and braids stick out behind and above it, so only the
        # parts of the wig that hug it are trusted: its sides high on the head (skull breadth; a skull
        # is ~1.22 times as deep as it is broad), the green forehead (front), and the top of the wig
        # over the front 60 % of the skull (crown).
        cx = 0.5 * (H[:, 0].min() + H[:, 0].max())
        ratio = opt(a, "--ratio", 1.22)
        depth = 0.6 * (H[:, 0].max() - H[:, 0].min())
        top = H[:, 2].max()
        for _ in range(6):
            t = thick * depth
            lo, hi = top - 0.45 * depth, top - 0.15 * depth
            hb = H[(H[:, 2] > lo) & (H[:, 2] < hi)]
            gb = G[(G[:, 2] > lo) & (G[:, 2] < hi)] if len(G) else G
            # forehead: the green face where it shows, else just under the fringe
            front = min(gb[:, 1].min(), hb[:, 1].min() + t) if len(gb) > 20 else hb[:, 1].min() + t
            cx = 0.5 * (hb[:, 0].min() + hb[:, 0].max())
            depth = ratio * (hb[:, 0].max() - hb[:, 0].min() - 2 * t)
            back = front + depth
            crown = H[(H[:, 1] < front + 0.6 * depth) & (np.abs(H[:, 0] - cx) < 0.3 * depth)]
            top = (crown[:, 2].max() if len(crown) else H[:, 2].max()) - t
    # ---- register on the generic head (the mean of the faces): the mannequin's own skin decides
    maps = opt(a, "--maps", None, str)
    generic = HM.load_generic(maps) if maps else None
    if generic is not None and len(G) > 150 and "--no-register" not in a:
        gf = G[G[:, 2] > top - 1.25 * depth]
        cx = 0.5 * float(np.percentile(gf[:, 0], 2) + np.percentile(gf[:, 0], 98))
        sc, ty, tz = register((G - np.array([cx, back, top])) / depth, generic, kind)
        depth = depth / sc                    # p' = sc * p + t  is the frame (origin - t * depth', depth')
        back -= ty * depth
        top -= tz * depth
        front = back - depth
    scale = opt(a, "--scale", 1.0)
    depth_fit = depth / scale
    origin = np.array([cx, back - opt(a, "--dy", 0.0) * depth, top - opt(a, "--dz", 0.0) * depth])
    C.log(f"frame cx {cx:.4f} top {top:.4f} back {back:.4f} front {front:.4f} depth {depth:.4f}")

    # ---- the surface the piece was modelled on, by direction (headmap.py): the generic head,
    # corrected by what the mannequin shows of itself (its skin, and the piece's own edge, which lies
    # on it), and never above the piece itself.  The game moves each vertex by target - source.
    src_map = None
    if generic is not None:
        Gf = (G - origin) / depth_fit
        Gf = Gf[Gf[:, 2] > -1.6]
        u, v, rho = HM.dir_uv(Gf)
        iu = np.clip((u * HM.W).astype(np.int64), 0, HM.W - 1); iv = np.clip((v * HM.H).astype(np.int64), 0, HM.H - 1)
        acc = np.zeros((HM.H, HM.W)); cnt = np.zeros((HM.H, HM.W))
        np.add.at(acc, (iv, iu), rho - HM.sample(generic, u, v)); np.add.at(cnt, (iv, iu), 1.0)
        # (where the mannequin does not show, under the hair or the beard, its surface is taken to differ
        # from the generic head as it does at the nearest places where it shows)
        src_map = generic + np.clip(HM.extend(np.where(cnt > 0, acc / np.maximum(cnt, 1), 0.0), cnt > 0), -0.25, 0.25)

    # ---- drop the mannequin
    import bmesh
    bm = bmesh.new(); bm.from_mesh(me)
    bm.faces.ensure_lookup_table()
    bmesh.ops.delete(bm, geom=[f for f in bm.faces if green[f.index]], context='FACES')
    bm.to_mesh(me); bm.free()
    C.remove_small_islands(obj, area_frac=0.0006)
    V = C.verts_np(obj)
    V = (V - origin) / depth_fit
    C.set_verts_np(obj, V)

    # ---- drop what is not hair: the bust the image model drew under the neck (pale, so not keyed
    # out), the back of a beard's mannequin.  Head-frame units: z up from the crown (eyes ~ -0.55,
    # chin ~ -1.07, shoulders ~ -1.3), y from 0 (occiput) to -1 (forehead), x from the centre line.
    zmin = opt(a, "--zmin", -1.3 if kind == "hair" else -1.6)
    lowx = opt(a, "--low-x", 0.72)         # below the shoulders line, keep only |x| under this
    lowy = opt(a, "--low-y", -0.82)        # ... and only y above this (drops a chest plate)
    rear = opt(a, "--rear", 0.0 if kind == "hair" else -0.42)  # beards: nothing behind this y
    # the neck itself (what is left of the mannequin's, in the shade under the chin): a column
    # around the neck axis below the jaw; hanging hair and beards lie outside it
    neck = opt(a, "--neck", 0.36)
    neck_top = -1.12 if kind == "hair" else -1.2
    # A beard's mannequin has a face: its eye sockets, brow and nostrils are in shade, too dark to key.
    # A beard is pale (it is modelled blonde), lies under the nose on the centre of the face, and
    # climbs the cheeks only at the sides.
    dark = dark_faces(obj, px0)
    lowz = opt(a, "--low-z", -1.35 if kind == "hair" else -1.22)   # the "shoulders line" of --low-x / --low-y
    if kind == "beard":                    # a beard hangs in front of the neck, on the centre line
        lowx = opt(a, "--low-x", 0.4)
        lowy = -9.0
    lowfront = opt(a, "--low-front", 9.0 if kind == "hair" else -0.55)   # under that line, keep only y in front of this
    # a cut without a fringe leaves the face bare: nothing on its front under this height (0: off)
    face_clear = opt(a, "--face-clear", 0.0)
    bm = bmesh.new(); bm.from_mesh(me)
    bm.faces.ensure_lookup_table()
    kill = []
    for f in bm.faces:
        c = f.calc_center_median()
        if kind == "beard" and ((dark[f.index] and c.z > -0.8) or c.z > -0.5 or (c.z > -0.8 and abs(c.x) < 0.3)):
            kill.append(f)
            continue
        # (a wig's mannequin may have a face too: dark bits on the front of the face, under the hairline)
        if kind == "hair" and dark[f.index] and c.y < -0.55 and c.z < -0.3:
            kill.append(f)
            continue
        low = c.z < lowz
        in_neck = neck > 0 and c.z < neck_top and (c.x * c.x + (c.y + 0.42) ** 2) < neck * neck
        in_face = face_clear < 0 and c.z < face_clear and c.z > -1.35 and c.y < -0.6 and abs(c.x) < 0.34
        if (c.z < zmin or in_neck or in_face or (low and abs(c.x) > lowx) or (low and c.y < lowy) or (low and c.y > lowfront)
                or (rear < 0 and c.y > rear)):
            kill.append(f)
    bmesh.ops.delete(bm, geom=kill, context='FACES')
    bm.to_mesh(me); bm.free()
    C.remove_small_islands(obj, area_frac=0.0006)
    loose = drop_low_islands(obj, opt(a, "--hang", -1.2))
    C.log(f"cut {len(kill)} faces (zmin {zmin}, neck {neck}, low-x {lowx}, low-y {lowy}, rear {rear}), {loose} vertices of islands under the jaw")

    # ---- grey, levelled texture (tinted in game)
    hair_px = ~is_green(px[..., :3])
    lum = 0.2126 * px[..., 0] + 0.7152 * px[..., 1] + 0.0722 * px[..., 2]
    # level on the texels the hair faces use: sample the mean over non-green, non-black texels
    use = hair_px & (lum > 0.08)
    mean = float(lum[use].mean()) if use.any() else 0.6
    lum = np.clip(lum * (GREY / max(mean, 1e-3)), 0.0, 1.0)
    px[..., 0] = lum; px[..., 1] = lum; px[..., 2] = lum
    img.pixels = px.ravel()
    img.update()
    for slot in obj.material_slots:
        m = slot.material
        if m and m.node_tree:
            for n in m.node_tree.nodes:
                if n.type == 'BSDF_PRINCIPLED':
                    for nm, val in (("Metallic", 0.0), ("Roughness", 0.75)):
                        s = n.inputs[nm]
                        for l in list(s.links):
                            m.node_tree.links.remove(l)
                        s.default_value = val

    C.recalc_normals(obj)
    C.decimate(obj, opt(a, "--tris", 5000 if kind == "hair" else 3000, int))
    C.shade(obj, "smooth")
    C.prepare_materials([obj], max_tex=opt(a, "--tex", 768, int), double_sided=True)
    V = C.verts_np(obj)
    if src_map is not None:
        # second UV set "fit": u = the source surface's distance along the vertex's direction, v = 1 - weight
        # (the exporter flips v, so the game reads the weight).  The weight fades straight under the
        # head, where no head has a surface.
        u, v, rho = HM.dir_uv(V)
        r_src = np.minimum(HM.sample(src_map, u, v), rho - 0.008)
        down = (V[:, 2] - HM.CENTRE[2]) / np.maximum(rho, 1e-9)
        wt = np.clip((down + 0.985) / 0.055, 0.0, 1.0)
        wt = wt * wt * (3 - 2 * wt)
        me = obj.data
        layer = me.uv_layers.new(name="fit")
        vi = np.zeros(len(me.loops), np.int32)
        me.loops.foreach_get("vertex_index", vi)
        layer.data.foreach_set("uv", np.stack([r_src[vi], 1.0 - wt[vi]], 1).astype(np.float32).ravel())
        C.log(f"fit: source surface {r_src.min():.3f}..{r_src.max():.3f}, clearance {float((rho - r_src).min()):.3f}..{float(np.median(rho - r_src)):.3f} (median)")
    size = C.export_glb(dst, quality=opt(a, "--quality", 85, int))
    mn, mx = C.bbox(V)
    meta = {"kind": kind, "fit": src_map is not None, "frame": {"cx": cx, "top": top, "back": back, "front": front, "depth": depth},
            # glTF axes: x, y = Blender z, z = -Blender y
            "bbox": [[float(mn[0]), float(mn[2]), float(-mx[1])], [float(mx[0]), float(mx[2]), float(-mn[1])]],
            "tris": C.tri_count(obj)}
    with open(os.path.splitext(dst)[0] + ".meta.json", "w") as f:
        json.dump(meta, f, indent=1)
    C.log(f"WROTE {dst} {size} bytes, {meta['tris']} tris")


if __name__ == "__main__":
    main()
