"""Radial map of a head: how far its surface lies from a point inside it, by direction.

Faces differ in shape, so a hair cut or a beard placed rigidly fits only the head it was tuned on.
The game therefore **conforms** each piece to the face it is put on (render/appearance.ts): a
vertex at distance rho from the head centre along direction d moves to

    rho + r_target(d) - r_source(d)

where r_target is the radial map of the face (computed in the game from its geometry) and r_source
is the surface the piece was modelled on, stored per vertex by fit_hair.py.  This module is the one
definition of that map for the Blender side; the game mirrors `CENTRE`, `W`, `H` and `dir_uv`.

All points are in **head-frame** units and Blender axes: x right, y from 0 (occiput) to -1
(forehead), z up from the crown (so negative).  glTF axes are (x, z, -y).
"""
import json
import os

import numpy as np

W, H = 64, 32
# Inside the head, low enough that the jaw and chin are seen at a fair angle (not edge-on from above).
CENTRE = np.array([0.0, -0.5, -0.72])
# Barycentric samples of a triangle (the bins are far larger than the triangles of a fitted head).
_BARY = np.array([[1, 0, 0], [0, 1, 0], [0, 0, 1], [.5, .5, 0], [0, .5, .5], [.5, 0, .5], [1/3, 1/3, 1/3],
                  [.66, .17, .17], [.17, .66, .17], [.17, .17, .66]], np.float64)


def dir_uv(P):
    """(u, v, rho) of points: u around the vertical axis (0.5 = straight ahead), v from up (0) to down (1)."""
    rel = np.asarray(P, np.float64) - CENTRE
    rho = np.linalg.norm(rel, axis=1)
    d = rel / np.maximum(rho, 1e-9)[:, None]
    u = np.arctan2(d[:, 0], -d[:, 1]) / (2 * np.pi) + 0.5
    v = np.arccos(np.clip(d[:, 2], -1.0, 1.0)) / np.pi
    return u, v, rho


def _blur(a, passes=1):
    for _ in range(passes):
        p = np.concatenate([a[:, -1:], a, a[:, :1]], axis=1)          # wrap around (u)
        p = np.concatenate([p[:1], p, p[-1:]], axis=0)                # clamp at the poles (v)
        a = sum(p[i:i + H, j:j + W] for i in range(3) for j in range(3)) / 9.0
    return a


def _fill(val, has):
    """Fill the cells without data from their neighbours, outward."""
    val, has = val.copy(), has.astype(np.float64)
    for _ in range(W):
        if has.min() > 0:
            break
        s = _blur(val * has)
        n = _blur(has)
        new = (has == 0) & (n > 0)
        val[new] = s[new] / n[new]
        has[new] = 1.0
    return val


def radial_map(V, tris):
    """HxW map of the outer surface of a mesh (vertices Nx3, triangles Mx3 vertex indices)."""
    P = np.einsum('kb,tbc->tkc', _BARY, V[tris]).reshape(-1, 3)
    u, v, rho = dir_uv(P)
    iu = np.clip((u * W).astype(np.int64), 0, W - 1)
    iv = np.clip((v * H).astype(np.int64), 0, H - 1)
    m = np.zeros((H, W))
    np.maximum.at(m, (iv, iu), rho)
    return _blur(_fill(m, m > 0), 1)


def sample(m, u, v):
    """Bilinear lookup (cell centres), wrapping in u."""
    x = u * W - 0.5
    y = np.clip(v * H - 0.5, 0, H - 1)
    x0 = np.floor(x).astype(np.int64); y0 = np.floor(y).astype(np.int64)
    fx = x - x0; fy = y - y0
    x1 = (x0 + 1) % W; x0 = x0 % W
    y1 = np.minimum(y0 + 1, H - 1)
    return (m[y0, x0] * (1 - fx) + m[y0, x1] * fx) * (1 - fy) + (m[y1, x0] * (1 - fx) + m[y1, x1] * fx) * fy


def mesh_tris(obj):
    me = obj.data
    me.calc_loop_triangles()
    t = np.zeros(len(me.loop_triangles) * 3, np.int32)
    me.loop_triangles.foreach_get("vertices", t)
    return t.reshape(-1, 3)


def save(path, m):
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    with open(path, "w") as f:
        json.dump({"w": W, "h": H, "centre": [float(c) for c in CENTRE], "map": [[round(float(x), 4) for x in row] for row in m]}, f)


def load_generic(folder):
    """Mean radial map of every face in `folder` (<id>.map.json, written by fit_head.py); None without any."""
    maps = []
    if os.path.isdir(folder):
        for fn in sorted(os.listdir(folder)):
            if fn.endswith(".map.json"):
                with open(os.path.join(folder, fn)) as f:
                    d = json.load(f)
                if d.get("w") == W and d.get("h") == H and np.allclose(d.get("centre", []), CENTRE):
                    maps.append(np.array(d["map"], np.float64))
    return np.mean(maps, axis=0) if maps else None


def extend(val, has):
    """Sparse observations (value per cell, where `has`) extended smoothly over the whole map."""
    if not has.any():
        return np.zeros((H, W))
    return _blur(_fill(val, has), 2)


def find_throat(V):
    """Height of the throat: where the front of the neck begins under the chin (frame units, Blender axes).

    Going down the centre line, the front profile juts out at the chin and then drops back by a
    large step onto the neck: the throat is the first height at which it lies well behind the most
    forward point just above.  The head / neck line of both a body and a face model."""
    mid = V[np.abs(V[:, 0]) < 0.15]
    zs = np.arange(-0.8, -1.7, -0.02)
    prof = np.full(len(zs), np.nan)
    for i, z in enumerate(zs):
        sl = mid[(mid[:, 2] <= z + 0.03) & (mid[:, 2] > z - 0.03)]   # (thick slices: a body's head has few vertices)
        if len(sl):
            prof[i] = sl[:, 1].min()
    for i in range(len(zs) - 4):
        if np.isnan(prof[i]) or zs[i] > -0.95:
            continue
        above = prof[max(0, i - 10):max(0, i - 2)]    # 0.04 to 0.2 above
        above = above[~np.isnan(above)]
        after = prof[i:i + 4]                         # ... and it stays back: the neck, not a gap in the mesh
        if len(above) and not np.isnan(after).any() and after.min() - above.min() > 0.15:
            return float(zs[i]) + 0.02
    return -1.2


def skin_like(c):
    """Per colour (Nx3, sRGB 0..1): red over green over blue, neither grey nor vivid (cloth and steel are not)."""
    mx, mn = c.max(1), c.min(1)
    sat = (mx - mn) / np.maximum(mx, 1e-3)
    return (c[:, 0] > c[:, 1]) & (c[:, 1] > c[:, 2]) & (c[:, 0] > 0.35) & (sat > 0.15) & (sat < 0.75)


def neck_ring(V, throat, cols=None):
    """The neck just under the throat line as an ellipse (cx, cy, rx, ry) and its skin colour.

    V in frame units, Blender axes; the slab is the 0.09 skull depths under the throat.  "skin"
    is None when the neck is not bare all the way round there (a collar, a gorget, a hood): the
    ellipse is then that of whatever is there.  Returns None when the slab is empty."""
    m = (V[:, 2] < throat - 0.01) & (V[:, 2] > throat - 0.09) & (np.abs(V[:, 0]) < 0.75) & (V[:, 1] > -1.25) & (V[:, 1] < 0.35)
    if m.sum() < 12:
        return None
    P = V[m]
    skin = None
    if cols is not None:
        sk = skin_like(cols[m])
        if sk.sum() >= 12:
            S = P[sk]
            c0 = np.median(S[:, :2], axis=0)
            sectors = np.unique(((np.arctan2(S[:, 1] - c0[1], S[:, 0] - c0[0]) / (2 * np.pi) + 0.5) * 12).astype(np.int64) % 12)
            if len(sectors) >= 9:
                P = S
                skin = [round(float(x), 4) for x in np.median(cols[m][sk], axis=0)]
    x0, x1 = np.percentile(P[:, 0], [2, 98])
    y0, y1 = np.percentile(P[:, 1], [2, 98])
    return {"cx": round(float((x0 + x1) / 2), 4), "cy": round(float((y0 + y1) / 2), 4),
            "rx": round(float((x1 - x0) / 2), 4), "ry": round(float((y1 - y0) / 2), 4), "skin": skin}
