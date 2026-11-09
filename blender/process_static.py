"""Normalise / clean / decimate a static TRELLIS.2 GLB for the game.

    blender -b -P process_static.py -- in.glb out.glb --kind building|prop|item|mount|monster
                                       [--id name] [--tris N] [--tex N] [--quality 82]
                                       [--yaw DEG] [--preview out.png]

All conventions follow ASSETS.md (Blender: Z up, front = -Y = glTF +Z):
  building  ground (lowest significant surface) at z=0, centred, footprint radius 0.82, walls snapped to
            the axes, front kept toward the image camera (-Y).
  prop      ground at z=0, centred, height from PROPS (radius clamped).
  item      long axis vertical, origin at the grip point (ITEMS table), real size for a 1.0-tall unit,
            edge / face toward -Y (glTF +Z); shields: origin at the centre of the back, face toward -Y.
  mount     head toward -Y, withers height from MOUNTS; the saddle point (top of the back at mid-length) is
            printed as JSON and written to <out>.meta.json as glTF coordinates [x, y, z].
  monster   ground at z=0, centred, head toward -Y, height from MONSTERS.
Cleanup: loose floaters removed, normals recalculated, collapse-decimated (UVs kept), textures
downscaled and stored as JPEG (WebP when a material needs alpha).  --yaw adds a manual override.
"""
import json
import math
import os
import sys

import bpy
import numpy as np
from mathutils import Matrix, Vector

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common as C  # noqa: E402

DEFAULT_TRIS = {"building": 14000, "prop": 1500, "item": 2500, "mount": 6000, "monster": 6000}
DEFAULT_TEX = {"building": 1024, "prop": 512, "item": 512, "mount": 1024, "monster": 1024}
SHADING = {"building": ("angle", 48), "prop": ("smooth", 0), "item": ("angle", 55), "mount": ("smooth", 0),
           "monster": ("smooth", 0)}
FOOTPRINT = 0.82

# props: target height and maximum footprint radius (both in hex units, hex radius = 1)
PROPS = {
    "pine": (0.75, 0.32), "oak": (0.70, 0.38), "deadtree": (0.62, 0.32), "tree": (0.72, 0.36),
    "rock": (0.30, 0.34), "peak": (1.20, 0.86), "mountain": (1.20, 0.86), "crystal": (0.50, 0.30),
    "bush": (0.28, 0.30), "ruin": (0.45, 0.62), "reeds": (0.40, 0.28), "stump": (0.18, 0.2),
}
PROP_DEFAULT = (0.5, 0.5)
# props are drawn hundreds of times (instanced decor): triangle budgets sized to their screen size
PROP_TRIS = {"bush": 300, "reeds": 300, "stump": 250, "rock": 400, "crystal": 500, "deadtree": 600, "pine": 700,
             "oak": 800, "tree": 800, "ruin": 1000, "peak": 1400, "mountain": 1400}
# Rocks and bushes: shade smooth looks blobby on faceted stone -> by angle
PROP_SHADING = {"rock": ("angle", 40), "peak": ("angle", 40), "mountain": ("angle", 40), "ruin": ("angle", 45),
                "crystal": ("angle", 35)}

# items: total length (1.0-tall unit), grip position as a fraction of the length from the bottom,
# alignment rule for the edge/face direction
ITEMS = {
    "sword": dict(length=0.55, grip=0.12, align="blade"),
    "spear": dict(length=1.00, grip=0.38, align="blade"),
    "axe": dict(length=0.50, grip=0.22, align="head"),
    "bow": dict(length=0.65, grip=0.50, align="bow"),
    "staff": dict(length=0.90, grip=0.40, align="head"),
    "wand": dict(length=0.25, grip=0.25, align="head"),
    "tools": dict(length=0.35, grip=0.18, align="head"),
    "hammer": dict(length=0.35, grip=0.18, align="head"),
    "shield": dict(length=0.40, grip=None, align="shield"),
}

MOUNTS = {"horse": 0.75, "nightmare": 0.75, "wolf": 0.62}          # height to the withers (ASSETS.md: horse ~0.75)
MONSTERS = {"golem": (1.10, "biped"), "elemental": (1.00, "biped"), "spider": (0.45, "quad"),
            "wolf": (0.45, "quad")}


def parse_args():
    a = C.script_args()
    if len(a) < 2:
        raise SystemExit(__doc__)
    opt = {"in": a[0], "out": a[1], "kind": None, "id": None, "tris": None, "tex": None, "quality": 82,
           "yaw": 0.0, "preview": None}
    i = 2
    while i < len(a):
        k = a[i]
        v = a[i + 1] if i + 1 < len(a) else None
        if k == "--kind": opt["kind"] = v
        elif k == "--id": opt["id"] = v
        elif k == "--tris": opt["tris"] = int(v)
        elif k == "--tex": opt["tex"] = int(v)
        elif k == "--quality": opt["quality"] = int(v)
        elif k == "--yaw": opt["yaw"] = float(v)
        elif k == "--preview": opt["preview"] = v
        else: raise SystemExit(f"unknown option {k}")
        i += 2
    if opt["kind"] not in DEFAULT_TRIS:
        raise SystemExit("--kind must be one of " + ", ".join(DEFAULT_TRIS))
    if not opt["id"]:
        opt["id"] = os.path.splitext(os.path.basename(opt["out"]))[0]
    return opt


# ----------------------------------------------------------------------------- helpers

def area_weighted_points(obj):
    c, a, n = C.faces_np(obj)
    return c, a, n


def weighted_percentile(x, w, q):
    o = np.argsort(x)
    cw = np.cumsum(w[o])
    cw /= cw[-1]
    return float(x[o][np.searchsorted(cw, q / 100.0)])


def ground_z(obj):
    """Lowest significant surface: area-weighted 0.4th percentile of face heights (ignores
    a few stray faces poking below the base)."""
    c, a, _ = area_weighted_points(obj)
    return weighted_percentile(c[:, 2], a, 0.4)


def yaw_rotate(obj, deg):
    if abs(deg) > 1e-6:
        C.apply_matrix(obj, Matrix.Rotation(math.radians(deg), 4, 'Z'))


def wall_snap_angle(obj):
    """Dominant wall direction (mod 90 deg) from near-vertical faces, or None when there is none."""
    c, a, n = area_weighted_points(obj)
    sel = np.abs(n[:, 2]) < 0.25
    if sel.sum() < 50:
        return None
    ang = np.degrees(np.arctan2(n[sel, 1], n[sel, 0])) % 90.0
    w = a[sel]
    hist, edges = np.histogram(ang, bins=90, range=(0, 90), weights=w)
    # circular smoothing
    k = np.array([1, 2, 3, 2, 1], float); k /= k.sum()
    hs = np.convolve(np.concatenate([hist[-2:], hist, hist[:2]]), k, mode='valid')
    peak = int(np.argmax(hs))
    strength = hs[peak] / (hs.mean() + 1e-12)
    if strength < 2.2:
        return None
    theta = edges[peak] + 0.5
    if theta > 45:
        theta -= 90
    return float(theta), float(strength)


def horizontal_pca(obj):
    c, a, _ = area_weighted_points(obj)
    ev, evec, cen = C.principal_axes(c[:, :2], a)
    return evec[:, 0], ev, cen


# ----------------------------------------------------------------------------- per kind

def do_building(obj, opt):
    snap = wall_snap_angle(obj)
    if snap:
        theta, strength = snap
        # rotate so the walls align with the axes; |theta| <= 45 keeps the camera-facing side in front
        yaw_rotate(obj, -theta)
        C.log(f"walls snapped by {-theta:.1f} deg (peak strength {strength:.1f})")
    yaw_rotate(obj, opt["yaw"])
    v = C.verts_np(obj)
    z0 = ground_z(obj)
    lo = np.percentile(v[:, :2], 0.5, axis=0); hi = np.percentile(v[:, :2], 99.5, axis=0)
    cxy = (lo + hi) / 2
    v -= [cxy[0], cxy[1], z0]
    r = np.percentile(np.hypot(v[:, 0], v[:, 1]), 99.7)
    v *= FOOTPRINT / r
    C.set_verts_np(obj, v)
    return {}


def do_prop(obj, opt):
    yaw_rotate(obj, opt["yaw"])
    pid = opt["id"].split("_")[0]
    height, maxr = PROPS.get(opt["id"], PROPS.get(pid, PROP_DEFAULT))
    v = C.verts_np(obj)
    z0 = ground_z(obj)
    base = v[v[:, 2] < z0 + 0.25 * (v[:, 2].max() - z0)]
    cxy = (np.percentile(base[:, :2], 2, axis=0) + np.percentile(base[:, :2], 98, axis=0)) / 2
    v -= [cxy[0], cxy[1], z0]
    s = height / v[:, 2].max()          # floaters are gone, so the true top (thin tree tips!) counts
    r = np.percentile(np.hypot(v[:, 0], v[:, 1]), 99.5) * s
    if r > maxr:
        s *= maxr / r
    v *= s
    C.set_verts_np(obj, v)
    return {}


def _largest_cluster_centre(pts, bin_w):
    """Centre (x, y) of the biggest blob of a thin horizontal slice."""
    if len(pts) < 3:
        return pts[:, :2].mean(0) if len(pts) else np.zeros(2)
    ivx = C.intervals(pts[:, 0], bin_w, min_count=1)
    best = max(ivx, key=lambda iv: np.sum((pts[:, 0] >= iv[0]) & (pts[:, 0] <= iv[1])))
    sub = pts[(pts[:, 0] >= best[0]) & (pts[:, 0] <= best[1])]
    ivy = C.intervals(sub[:, 1], bin_w, min_count=1)
    besty = max(ivy, key=lambda iv: np.sum((sub[:, 1] >= iv[0]) & (sub[:, 1] <= iv[1])))
    sub = sub[(sub[:, 1] >= besty[0]) & (sub[:, 1] <= besty[1])]
    return np.array([0.5 * (sub[:, 0].min() + sub[:, 0].max()), 0.5 * (sub[:, 1].min() + sub[:, 1].max())])


def do_item(obj, opt):
    iid = opt["id"]
    key = "shield" if iid.startswith("shield") else iid
    spec = ITEMS.get(key, dict(length=0.5, grip=0.25, align="none"))
    v = C.verts_np(obj)
    ext = v.max(0) - v.min(0)
    # long axis vertical (TRELLIS keeps the image's up; only fix clearly lying items)
    if key != "shield" and ext[2] < 0.8 * ext.max():
        ax = int(np.argmax(ext))
        C.apply_matrix(obj, Matrix.Rotation(math.radians(90), 4, 'Y' if ax == 0 else 'X'))
        C.log("long axis was", "XYZ"[ax], "-> made vertical")
        v = C.verts_np(obj)
    z0, z1 = v[:, 2].min(), v[:, 2].max()
    h = z1 - z0
    u = (v[:, 2] - z0) / h
    align = spec["align"]
    # shaft axis at the grip height (or the middle) -> rotation centre
    gz = spec["grip"] if spec["grip"] is not None else 0.5
    sl = v[np.abs(u - gz) < 0.03]
    axis_xy = _largest_cluster_centre(sl, 0.01 * h) if len(sl) > 3 else v[:, :2].mean(0)
    yaw = 0.0
    if align == "blade":
        part = v[(u > 0.45) & (u < 0.9)]
        ev, evec, _ = C.principal_axes(part[:, :2])
        d = evec[:, 0]                                   # blade width direction -> Y
        yaw = 90.0 - math.degrees(math.atan2(d[1], d[0]))
    elif align == "head":
        part = v[u > 0.72]
        off = part[:, :2].mean(0) - axis_xy
        if np.linalg.norm(off) > 0.04 * h:
            # head (axe blade, hammer face) sticks out on one side: that side faces -Y (glTF +Z)
            yaw = -90.0 - math.degrees(math.atan2(off[1], off[0]))
        else:
            ev, evec, _ = C.principal_axes(part[:, :2])
            d = evec[:, 0]
            yaw = 90.0 - math.degrees(math.atan2(d[1], d[0]))
    elif align == "bow":
        ev, evec, _ = C.principal_axes(v[:, :2])
        d = evec[:, 0]                                   # plane of the limbs' curve -> Y
        yaw = 90.0 - math.degrees(math.atan2(d[1], d[0]))
    elif align == "shield":
        ev, evec, _ = C.principal_axes(v[:, :2])
        d = evec[:, 1]                                   # thin direction -> Y (face toward -Y kept)
        yaw = 90.0 - math.degrees(math.atan2(d[1], d[0]))
        yaw = (yaw + 90) % 180 - 90                      # smallest rotation keeps the image front
    yaw = (yaw + 180) % 360 - 180
    if align in ("blade", "bow"):
        yaw = (yaw + 90) % 180 - 90                      # symmetric: take the smaller turn
    m = Matrix.Translation((axis_xy[0], axis_xy[1], 0)) @ Matrix.Rotation(math.radians(yaw + opt["yaw"]), 4, 'Z') \
        @ Matrix.Translation((-axis_xy[0], -axis_xy[1], 0))
    C.apply_matrix(obj, m)
    v = C.verts_np(obj)
    if align == "bow":
        # string side (tips) toward +Y = toward the archer; the bow's back faces -Y (glTF +Z)
        mid = v[np.abs(u - 0.5) < 0.06]
        tips = v[(u < 0.1) | (u > 0.9)]
        cmid = _largest_cluster_centre(mid, 0.01 * h)
        if tips[:, 1].mean() < cmid[1]:
            C.apply_matrix(obj, Matrix.Rotation(math.pi, 4, 'Z'))
            v = C.verts_np(obj)
    if key == "shield":
        lo, hi = v.min(0), v.max(0)
        c = (lo + hi) / 2
        # centre of the back: the plate's rear surface at the middle (straps / handles that stick out
        # further back are ignored -- they sit around the forearm)
        P = C.surface_points(obj, 60000)
        mid = P[(np.abs(P[:, 0] - c[0]) < 0.2 * (hi[0] - lo[0])) & (np.abs(P[:, 2] - c[2]) < 0.2 * (hi[2] - lo[2]))]
        if len(mid) > 50:
            yfront = np.percentile(mid[:, 1], 2)
            # plate thickness from the rim, where there is no handle
            rim = P[(np.abs(P[:, 0] - c[0]) > 0.3 * (hi[0] - lo[0])) & (np.abs(P[:, 2] - c[2]) < 0.3 * (hi[2] - lo[2]))]
            thick = np.percentile(rim[:, 1], 95) - np.percentile(rim[:, 1], 5) if len(rim) > 50 else 0.02 * (hi[2] - lo[2])
            yback = min(np.percentile(mid[:, 1], 98), yfront + max(thick, 0.01 * (hi[2] - lo[2])) * 1.6)
        else:
            yback = hi[1]
        origin = np.array([c[0], yback, c[2]])
        s = spec["length"] / (hi[2] - lo[2])
    else:
        u = (v[:, 2] - z0) / h
        sl = v[np.abs(u - spec["grip"]) < 0.03]
        cxy = _largest_cluster_centre(sl, 0.01 * h) if len(sl) > 3 else v[:, :2].mean(0)
        origin = np.array([cxy[0], cxy[1], z0 + spec["grip"] * h])
        s = spec["length"] / h
    v = (v - origin) * s
    C.set_verts_np(obj, v)
    return {"grip": spec["grip"], "length": spec["length"]}


def head_end_sign(obj):
    """+1 if the head of a quadruped (aligned along Y) is at -Y.  Cues: the image prior (TRELLIS puts
    the camera side toward -Y and the prompts ask for a three-quarter FRONT view), the neck / head
    rising above the back line, and the thin tail end."""
    v = C.verts_np(obj)
    y0, y1 = v[:, 1].min(), v[:, 1].max()
    Ly = y1 - y0
    z0, z1 = v[:, 2].min(), v[:, 2].max()
    H = z1 - z0
    front = v[v[:, 1] < y0 + 0.25 * Ly]
    back = v[v[:, 1] > y1 - 0.25 * Ly]
    score = 0.0
    # height of the ends (head held higher than the rump/tail)
    score += 2.0 * (np.percentile(front[:, 2], 98) - np.percentile(back[:, 2], 98)) / H
    # bulk above mid-height (head + neck) vs a thin tail
    score += 1.0 * (np.sum(front[:, 2] > z0 + 0.6 * H) - np.sum(back[:, 2] > z0 + 0.6 * H)) / max(len(v) * 0.05, 1)
    return score


def _orient_quadruped(obj, opt, prior_dir):
    d, ev, cen = horizontal_pca(obj)
    if ev[0] > 1.15 * ev[1]:
        # rotate so the long axis lies along Y, choosing the turn that keeps the image-front side forward
        ang = math.degrees(math.atan2(d[1], d[0]))
        cands = [90 - ang, -90 - ang]
        cands = [((c + 180) % 360) - 180 for c in cands]
        # prior: the end nearest the camera (-Y before rotation) should end up at -Y
        best = None
        for c in cands:
            R = Matrix.Rotation(math.radians(c), 3, 'Z')
            head_dir = R.inverted() @ Vector((0, -1, 0))   # original-space direction that becomes the front
            pri = -head_dir.y                              # > 0 when that end faced the camera
            best = max(best or (c, -9), (c, pri), key=lambda t: t[1])
        yaw_rotate(obj, best[0])
        s = head_end_sign(obj)
        C.log(f"long axis aligned (yaw {best[0]:.0f}), head score {s:+.2f}")
        if s < -0.6:           # geometry strongly disagrees with the camera prior
            yaw_rotate(obj, 180)
            C.log("head was at +Y -> turned 180")
    yaw_rotate(obj, opt["yaw"])


def back_profile(v, nb=60):
    y0, y1 = v[:, 1].min(), v[:, 1].max()
    xs = np.abs(v[:, 0] - np.median(v[:, 0])) < 0.2 * np.ptp(v[:, 0])
    ys = np.linspace(y0, y1, nb + 1)
    prof = np.full(nb, np.nan)
    for i in range(nb):
        sel = xs & (v[:, 1] >= ys[i]) & (v[:, 1] < ys[i + 1])
        if sel.sum() > 3:
            prof[i] = np.percentile(v[sel, 2], 99)
    return 0.5 * (ys[:-1] + ys[1:]), prof


def legs_y(v):
    """y of the front and rear leg groups (slice above the hooves)."""
    z0, z1 = v[:, 2].min(), v[:, 2].max()
    H = z1 - z0
    sl = v[(v[:, 2] > z0 + 0.06 * H) & (v[:, 2] < z0 + 0.22 * H)]
    if len(sl) < 20:
        return v[:, 1].min(), v[:, 1].max()
    iv = C.intervals(sl[:, 1], 0.02 * np.ptp(v[:, 1]), min_count=3)
    if len(iv) >= 2:
        return 0.5 * (iv[0][0] + iv[0][1]), 0.5 * (iv[-1][0] + iv[-1][1])
    return np.percentile(sl[:, 1], 12), np.percentile(sl[:, 1], 88)


def do_mount(obj, opt):
    _orient_quadruped(obj, opt, -1)
    target = MOUNTS.get(opt["id"], 0.6)
    z0 = ground_z(obj)
    P = C.surface_points(obj, 160000)          # dense, tessellation-independent sample
    P[:, 2] -= z0
    yf, yr = legs_y(P)
    C.log(f"legs at y {yf:.3f} / {yr:.3f}")
    L = yr - yf
    ys, prof = back_profile(P)
    sel = (ys > yf + 0.05 * L) & (ys < yf + 0.35 * L) & np.isfinite(prof)
    withers = float(np.nanmedian(prof[sel])) if sel.any() else float(np.nanmax(prof))
    s = target / withers
    cx = 0.5 * (np.percentile(P[:, 0], 1) + np.percentile(P[:, 0], 99))
    cy = 0.5 * (yf + yr)
    v = C.verts_np(obj)
    v = (v - [cx, cy, z0]) * s
    C.set_verts_np(obj, v)
    P = (P - [cx, cy, 0]) * s
    ys, prof = back_profile(P)
    yf, yr = (yf - cy) * s, (yr - cy) * s
    ysd = yf + 0.42 * (yr - yf)          # saddle sits a little forward of mid-length
    near = (np.abs(ys - ysd) < 0.08 * (yr - yf)) & np.isfinite(prof)
    zs = float(np.median(prof[near])) if near.any() else target
    saddle = [0.0, round(zs, 4), round(float(-ysd), 4)]   # glTF: (x, z_blender, -y_blender)
    C.log(f"withers {target}, saddle (glTF) {saddle}")
    print(json.dumps({"id": opt["id"], "saddle": saddle}))
    return {"saddle": saddle, "withers": target}


def do_monster(obj, opt):
    height, body = MONSTERS.get(opt["id"], (0.8, "quad"))
    if body == "quad":
        _orient_quadruped(obj, opt, -1)
    else:
        yaw_rotate(obj, opt["yaw"])
    v = C.verts_np(obj)
    z0 = ground_z(obj)
    lo = np.percentile(v[:, :2], 1, axis=0); hi = np.percentile(v[:, :2], 99, axis=0)
    c = (lo + hi) / 2
    v -= [c[0], c[1], z0]
    v *= height / v[:, 2].max()
    C.set_verts_np(obj, v)
    return {}


# ----------------------------------------------------------------------------- main

def main():
    opt = parse_args()
    C.reset_scene()
    obj = C.import_joined_mesh(opt["in"], name=opt["id"])
    n = C.remove_small_islands(obj)
    C.log(f"{opt['kind']} {opt['id']}: {len(obj.data.vertices)} verts, removed {n} floating islands")
    C.recalc_normals(obj)
    meta = {"kind": opt["kind"], "id": opt["id"]}
    meta.update({"building": do_building, "prop": do_prop, "item": do_item, "mount": do_mount,
                 "monster": do_monster}[opt["kind"]](obj, opt))
    target = opt["tris"] or (PROP_TRIS.get(opt["id"]) if opt["kind"] == "prop" else None) or DEFAULT_TRIS[opt["kind"]]
    tris = C.decimate(obj, target)
    mode, ang = SHADING[opt["kind"]]
    if opt["kind"] == "prop":
        mode, ang = PROP_SHADING.get(opt["id"], (mode, ang))
    C.shade(obj, mode, ang)
    alpha = C.prepare_materials([obj], opt["tex"] or DEFAULT_TEX[opt["kind"]])
    C.purge_orphans()
    v = C.verts_np(obj)
    lo, hi = v.min(0), v.max(0)
    meta["bbox_gltf"] = {"min": [round(float(lo[0]), 4), round(float(lo[2]), 4), round(float(-hi[1]), 4)],
                         "max": [round(float(hi[0]), 4), round(float(hi[2]), 4), round(float(-lo[1]), 4)]}
    meta["tris"] = tris
    size = C.export_glb(opt["out"], alpha=alpha, quality=opt["quality"])
    meta["bytes"] = size
    with open(os.path.splitext(opt["out"])[0] + ".meta.json", "w") as f:
        json.dump(meta, f, indent=1)
    C.log(f"wrote {opt['out']} ({size / 1e6:.2f} MB, {tris} tris)")
    if opt["preview"]:
        import preview
        preview.render(opt["out"], opt["preview"], kind=opt["kind"])


if __name__ == "__main__":
    main()
