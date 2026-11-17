"""Refit a raw reconstruction whose girth is right locally but whose lengths came out short.

    blender -b -t 2 --factory-startup -P blender/body_refit.py -- source.glb out.glb \
        [--width 1.30] [--depth 1.25] [--arms 0.9] [--crotch 0.50:0.52] [--soften-chest] [--flat-feet] [--shin 0.05:0.265:1.22] [--forehead 0.94:0.86]

Unlike body_proportions.py (a vertical stretch), this keeps limbs round. The body column
(legs, torso, head) is slimmed in width and depth relative to its height; the arms are scaled
uniformly about the shoulders, so their cross-section stays circular; an optional crotch
remap lengthens the legs. Output is normalized to one unit of height, feet on z=0.
The source file is never overwritten. Rig the result with rig_humanoid.py.
"""
import argparse
import json
import sys
from pathlib import Path
import bmesh
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import common as C
import rig_humanoid as RH


def smoothstep(t):
    t = np.clip(t, 0, 1)
    return t * t * (3 - 2 * t)


def drop_fins(obj):
    """Keep the main manifold sheet. Some reconstructions carry hundreds of tiny overlapping
    patches joined to the surface along 3-face edges; decimation and normal recalculation turn
    them into dark pits. They are removed and the openings underneath refilled."""
    bm = bmesh.new(); bm.from_mesh(obj.data); bm.faces.ensure_lookup_table()
    seen = set(); comps = []
    for f in bm.faces:
        if f.index in seen: continue
        stack = [f]; seen.add(f.index); comp = []
        while stack:
            g = stack.pop(); comp.append(g)
            for e in g.edges:
                if len(e.link_faces) == 2:
                    for h in e.link_faces:
                        if h.index not in seen: seen.add(h.index); stack.append(h)
        comps.append(comp)
    comps.sort(key=len, reverse=True)
    extra = [f for comp in comps[1:] for f in comp]
    bmesh.ops.delete(bm, geom=extra, context='FACES')
    # The patches were welded over small openings: close those again with clean faces.
    rim = [e for e in bm.edges if len(e.link_faces) == 1]
    filled = bmesh.ops.holes_fill(bm, edges=rim, sides=0)['faces']
    bmesh.ops.triangulate(bm, faces=filled)
    bmesh.ops.recalc_face_normals(bm, faces=list(bm.faces))
    left = sum(1 for e in bm.edges if len(e.link_faces) != 2)
    bm.to_mesh(obj.data); bm.free(); obj.data.update()
    return len(extra), left


def soften_chest(obj, v):
    """Relax the two frontmost chest tips: the base keeps smooth, non-detailed anatomy."""
    bm = bmesh.new(); bm.from_mesh(obj.data); bm.verts.ensure_lookup_table()
    for side in (-1, 1):
        sel = (v[:, 2] > .66) & (v[:, 2] < .80) & (v[:, 0] * side > .02) & (v[:, 0] * side < .12)
        if not sel.any(): continue
        ids = np.where(sel)[0]
        tip = v[ids[np.argmin(v[ids, 1])]]
        near = [bm.verts[i] for i in np.where(np.linalg.norm(v - tip, axis=1) < .022)[0]]
        for _ in range(30):
            bmesh.ops.smooth_vert(bm, verts=near, factor=.5, use_axis_x=True, use_axis_y=True, use_axis_z=True)
    bm.to_mesh(obj.data); bm.free(); obj.data.update()


def flatten_feet(v, ankle=.10):
    """Reconstructions of a front view often point the toes down. Rotate each foot about its
    ankle until its long axis is horizontal, blending through the ankle."""
    angles = []
    for side in (-1, 1):
        foot = (v[:, 0] * side > 0) & (v[:, 2] < ankle * .8)
        if foot.sum() < 20: continue
        q = v[foot][:, 1:] - v[foot][:, 1:].mean(0)
        axis = np.linalg.svd(q, full_matrices=False)[2][0]
        if axis[0] > 0: axis = -axis                     # toward the toes (front = -Y)
        angle = float(np.arctan2(-axis[1], -axis[0]))    # downward pitch of the toes
        if angle < np.radians(12): continue
        leg = (v[:, 0] * side > 0) & (v[:, 2] < ankle * 1.25)
        near = leg & (np.abs(v[:, 2] - ankle) < .01)
        pivot = np.array([v[near, 1].mean(), ankle])
        w = -smoothstep((ankle * 1.25 - v[leg, 2]) / (ankle * .6)) * angle
        d = v[leg][:, 1:] - pivot
        c, s_ = np.cos(w), np.sin(w)
        v[leg, 1] = pivot[0] + d[:, 0] * c - d[:, 1] * s_
        v[leg, 2] = pivot[1] + d[:, 0] * s_ + d[:, 1] * c
        angles.append(round(float(np.degrees(angle)), 1))
    return angles


def main():
    p = argparse.ArgumentParser()
    p.add_argument('source'); p.add_argument('out')
    p.add_argument('--width', type=float, default=1.30, help='divide body-column width by this')
    p.add_argument('--depth', type=float, default=1.25, help='divide body-column depth by this')
    p.add_argument('--arms', type=float, default=.9, help='uniform arm scale about the shoulder')
    p.add_argument('--crotch', default='', help='from:to normalized height, lengthening the legs')
    p.add_argument('--soften-chest', action='store_true')
    p.add_argument('--flat-feet', action='store_true')
    p.add_argument('--forehead', default='', help='brow:factor in output heights, lowering the skull above the brow line')
    p.add_argument('--shin', default='', help='ankle:knee:factor in output heights, lengthening the lower leg')
    a = p.parse_args(C.script_args())
    src = Path(a.source).resolve(); out = Path(a.out).resolve()
    if src == out: raise ValueError('Write a separate file, preserving the source')
    C.reset_scene(); obj = C.import_joined_mesh(str(src))
    fins, open_edges = drop_fins(obj)
    RH.orient_upright(obj); RH.orient_facing(obj); RH.normalize(obj)
    v = C.verts_np(obj)
    if a.soften_chest:
        soften_chest(obj, v); v = C.verts_np(obj)
    ax = np.abs(v[:, 0])
    # Arm axis: the T-pose arm is the only geometry beyond the torso's half width.
    arm = (ax > .20) & (v[:, 2] > .6)
    zc = float(np.median(v[arm, 2])); yc = float(np.median(v[arm, 1]))
    torso = v[(np.abs(v[:, 2] - zc) > .04) & (v[:, 2] > .6) & (v[:, 2] < .8)]
    xs = float(np.percentile(np.abs(torso[:, 0]), 98))   # shoulder pivot = chest half width
    w = smoothstep((ax - xs * .8) / (xs * .6)) * smoothstep((v[:, 2] - (zc - .14)) / .06)
    col = np.c_[v[:, 0] / a.width, v[:, 1] / a.depth, v[:, 2]]
    sx = np.sign(v[:, 0])
    armp = np.c_[sx * (xs / a.width + (ax - xs) * a.arms),
                 yc / a.depth + (v[:, 1] - yc) * a.arms,
                 zc + (v[:, 2] - zc) * a.arms]
    v = col * (1 - w[:, None]) + armp * w[:, None]
    record = {'source': str(src), 'width': a.width, 'depth': a.depth, 'arms': a.arms,
              'shoulder_pivot': xs, 'arm_axis_z': zc,
              'fin_faces_removed': fins, 'open_edges_left': open_edges}
    if a.crotch:
        z0, z1 = map(float, a.crotch.split(':'))
        v[:, 2] = np.interp(v[:, 2], [0, z0, 1], [0, z1, 1])
        record['crotch'] = [z0, z1]
    v[:, 2] -= v[:, 2].min(); v /= v[:, 2].max()
    if a.flat_feet:
        record['feet_rotated_deg'] = flatten_feet(v)
        v[:, 2] -= v[:, 2].min(); v /= v[:, 2].max()
    if a.shin:
        z0, z1, k = map(float, a.shin.split(':'))
        v[:, 2] = np.interp(v[:, 2], [0, z0, z1, 1], [0, z0, z0 + (z1 - z0) * k, 1 + (z1 - z0) * (k - 1)])
        v /= v[:, 2].max()
        record['shin'] = [z0, z1, k]
    if a.forehead:
        zb, k = map(float, a.forehead.split(':'))
        above = np.clip(v[:, 2] - zb, 0, None)
        # eased in over the first centimetre so the brow keeps its slope
        v[:, 2] -= above * (1 - k) * smoothstep(above / .012)
        v[:, 2] -= v[:, 2].min(); v /= v[:, 2].max()
        record['forehead'] = [zb, k]
    C.set_verts_np(obj, v); C.shade(obj, 'smooth')
    C.export_glb(str(out), animations=False, skins=False)
    out.with_suffix('.refit.json').write_text(json.dumps(record, indent=2) + '\n')
    print('BODY_REFIT', json.dumps(record), flush=True)


if __name__ == '__main__': main()
