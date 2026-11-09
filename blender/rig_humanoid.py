"""Auto-rig a T-pose humanoid GLB (TRELLIS.2 / Pixal3D output) into a game-ready skinned unit.

    blender -b -P rig_humanoid.py -- in.glb out.glb [--preview out.png] [--tris 9000] [--tex 1024]
                                     [--quality 82] [--voxel 0.008] [--items DIR] [--no-anim]

Pipeline: import + join -> drop floaters -> detect up axis / facing -> normalise (height 1, feet
on z=0, centred, front = Blender -Y = glTF +Z) -> T-pose landmark analysis by mesh slicing ->
armature with the ASSETS.md bone set -> heat weights on a voxel-remeshed watertight proxy,
transferred to the decimated render mesh + anatomical masks -> grip / chest sockets ->
procedural keyframed clips (rig_anim.py) -> texture downscale -> GLB (JPEG textures, one glTF
animation per action). --preview renders a contact sheet from the EXPORTED file (rig_preview.py).
A sidecar <out>.meta.json records landmarks, walk speed and seat height for the renderer.
"""
import json
import math
import os
import sys
import time

import bpy
import numpy as np
from mathutils import Matrix, Vector

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common as C  # noqa: E402

BONES = ["root", "hips", "spine", "chest", "neck", "head",
         "shoulder.L", "upperarm.L", "forearm.L", "hand.L",
         "shoulder.R", "upperarm.R", "forearm.R", "hand.R",
         "thigh.L", "shin.L", "foot.L", "thigh.R", "shin.R", "foot.R"]
PARENT = {"root": None, "hips": "root", "spine": "hips", "chest": "spine", "neck": "chest", "head": "neck",
          "shoulder.L": "chest", "upperarm.L": "shoulder.L", "forearm.L": "upperarm.L", "hand.L": "forearm.L",
          "shoulder.R": "chest", "upperarm.R": "shoulder.R", "forearm.R": "upperarm.R", "hand.R": "forearm.R",
          "thigh.L": "hips", "shin.L": "thigh.L", "foot.L": "shin.L",
          "thigh.R": "hips", "shin.R": "thigh.R", "foot.R": "shin.R"}
SIDE = {"L": 1.0, "R": -1.0}   # character's left is +X when facing -Y


def parse_args():
    a = C.script_args()
    if len(a) < 2:
        raise SystemExit(__doc__)
    opt = {"in": a[0], "out": a[1], "preview": None, "tris": 9000, "tex": 1024, "quality": 82,
           "voxel": 0.008, "items": None, "anim": True}
    i = 2
    while i < len(a):
        k = a[i]
        if k == "--preview": opt["preview"] = a[i + 1]; i += 2
        elif k == "--tris": opt["tris"] = int(a[i + 1]); i += 2
        elif k == "--tex": opt["tex"] = int(a[i + 1]); i += 2
        elif k == "--quality": opt["quality"] = int(a[i + 1]); i += 2
        elif k == "--voxel": opt["voxel"] = float(a[i + 1]); i += 2
        elif k == "--items": opt["items"] = a[i + 1]; i += 2
        elif k == "--no-anim": opt["anim"] = False; i += 1
        else: raise SystemExit(f"unknown option {k}")
    return opt


# =============================================================================== orientation

def _ends_clusters(v, axis, end, span_axis):
    """Number of distinct blobs (along span_axis) in the 3% slice at one end of `axis`."""
    lo, hi = v[:, axis].min(), v[:, axis].max()
    h = hi - lo
    sel = v[:, axis] < lo + 0.03 * h if end < 0 else v[:, axis] > hi - 0.03 * h
    return len(C.intervals(v[sel][:, span_axis], 0.012 * h, min_count=2))


def orient_upright(obj):
    """Make the body stand along +Z with the arm span along X. glTF Y-up is trusted unless the
    vertical extent is clearly not the body's long axis (then the axis with the most evenly spread
    mass is taken: in a T-pose the span axis has its mass concentrated in the torso)."""
    v = C.verts_np(obj)
    ext = v.max(0) - v.min(0)
    up = 2
    if ext[2] < 0.75 * ext.max():
        nv = [np.var(v[:, i]) / max(ext[i], 1e-9) ** 2 for i in range(3)]
        cand = np.argsort(ext)[-2:]
        up = int(max(cand, key=lambda i: nv[i]))
        if up != 2:
            rot = Matrix.Rotation(math.radians(-90 if up == 1 else 90), 4, 'X' if up == 1 else 'Y')
            C.apply_matrix(obj, rot)
            C.log("up axis was", "XYZ"[up], "-> rotated")
            v = C.verts_np(obj)
            ext = v.max(0) - v.min(0)
    span = 0 if ext[0] >= ext[1] else 1
    # upside down?  feet end shows two blobs, head end one
    bot = _ends_clusters(v, 2, -1, span); top = _ends_clusters(v, 2, +1, span)
    if top >= 2 and bot == 1:
        C.apply_matrix(obj, Matrix.Rotation(math.pi, 4, 'Y'))
        C.log("model was upside down -> flipped")
    if span == 1:
        C.apply_matrix(obj, Matrix.Rotation(math.radians(90), 4, 'Z'))
        C.log("arm span was along Y -> rotated 90 deg")


def facing_score(v):
    """> 0 when the character faces -Y.  Cues: toes stick out in front of the ankles (strong),
    the nose / face is in front of the head's centre of mass, the chest is in front of the hips."""
    z = v[:, 2]
    zmin, zmax = z.min(), z.max()
    h = zmax - zmin
    score = 0.0
    feet = v[z < zmin + 0.035 * h]
    ank = v[(z > zmin + 0.09 * h) & (z < zmin + 0.15 * h)]
    if len(feet) > 20 and len(ank) > 20:
        ay = np.median(ank[:, 1])
        fwd = ay - np.percentile(feet[:, 1], 2)      # toe reach toward -Y
        back = np.percentile(feet[:, 1], 98) - ay    # heel reach toward +Y
        foot_len = max(fwd + back, 1e-6)
        score += 3.0 * (fwd - back) / foot_len
    head = v[z > zmax - 0.12 * h]
    if len(head) > 50:
        hy = np.median(head[:, 1])
        # face is flatter and further from the median than the rounded back of the skull
        score += 0.5 * ((hy - np.percentile(head[:, 1], 1)) - (np.percentile(head[:, 1], 99) - hy)) / (np.ptp(head[:, 1]) + 1e-6)
    return score


def orient_facing(obj):
    v = C.verts_np(obj)
    s = facing_score(v)
    C.log(f"facing score {s:+.2f} (>0 = already facing -Y)")
    if s < 0:
        C.apply_matrix(obj, Matrix.Rotation(math.pi, 4, 'Z'))
        C.log("rotated 180 deg to face -Y (glTF +Z)")
    return s


def normalize(obj):
    """Height 1.0, lowest point on z=0, centred on the torso (x) and the ankles (y)."""
    v = C.verts_np(obj)
    z0, z1 = v[:, 2].min(), v[:, 2].max()
    s = 1.0 / (z1 - z0)
    v = (v - [0, 0, z0]) * s
    tor = v[(v[:, 2] > 0.52) & (v[:, 2] < 0.66)]
    # torso slice also contains nothing of the arms in a T-pose; use its x-extent centre
    xc = 0.5 * (np.percentile(tor[:, 0], 1) + np.percentile(tor[:, 0], 99)) if len(tor) > 20 else 0.0
    ank = v[(v[:, 2] > 0.04) & (v[:, 2] < 0.14)]
    yc = 0.5 * (np.percentile(ank[:, 1], 5) + np.percentile(ank[:, 1], 95)) if len(ank) > 20 else 0.0
    v -= [xc, yc, 0]
    C.set_verts_np(obj, v)
    C.log(f"normalised: scale {s:.4f}")


# =============================================================================== landmarks

class Landmarks(dict):
    __getattr__ = dict.__getitem__


def _slab(v, axis, lo, hi):
    return v[(v[:, axis] >= lo) & (v[:, axis] < hi)]


def _gap_split(xs, bin_w=0.006):
    """Return x of the gap between two leg clusters (largest empty run near 0) or None.
    Sparse bins (cloth hems, belt tassels hanging between the legs) count as empty."""
    if len(xs) < 10:
        return None
    nb = max(1, int(np.ceil(np.ptp(xs) / bin_w)))
    cnt = np.bincount(np.clip(((xs - xs.min()) / bin_w).astype(int), 0, nb - 1), minlength=nb)
    thr = max(2, int(0.06 * np.median(cnt[cnt > 0]))) if np.any(cnt > 0) else 2
    iv = C.intervals(xs, bin_w, min_count=thr)
    if len(iv) < 2:
        return None
    best = None
    for (a0, a1), (b0, b1) in zip(iv[:-1], iv[1:]):
        g = 0.5 * (a1 + b0)
        if abs(g) < 0.12 and (b0 - a1) >= bin_w * 0.99:
            left = np.sum(xs > g); right = np.sum(xs < g)
            if min(left, right) > 0.15 * len(xs):
                if best is None or abs(g) < abs(best):
                    best = g
    return best


def find_landmarks(v):
    L = Landmarks()
    z = v[:, 2]
    # ---- arms: tips, thickness and centre line come from the pure-arm region (half to 4/5 of the
    # span), which no torso, cape, pauldron or hair reaches in a T-pose.
    up = v[z > 0.5]
    for s in "LR":
        sg = SIDE[s]
        sx = up[:, 0] * sg
        tip = float(np.percentile(sx, 99.97))
        band = up[(sx > 0.5 * tip) & (sx < 0.8 * tip)]
        zm = np.median(band[:, 2])
        band = band[np.abs(band[:, 2] - zm) < 0.12]
        th = []
        for b in np.arange(0.5 * tip, 0.8 * tip, 0.01):
            sl = band[(np.abs(band[:, 0]) >= b) & (np.abs(band[:, 0]) < b + 0.01)]
            if len(sl) > 10:
                th.append(np.ptp(sl[:, 2]))
        t_arm = float(np.median(th)) if th else 0.07
        L[f"tarm_{s}"] = t_arm
        L[f"tip_{s}"] = tip
    # ---- torso edge: front half of the chest just below the armpit (capes wrap the back and sides)
    tip0 = 0.5 * (L.tip_L + L.tip_R); t0 = 0.5 * (L.tarm_L + L.tarm_R)
    arm_band = up[(np.abs(up[:, 0]) > 0.5 * tip0) & (np.abs(up[:, 0]) < 0.8 * tip0)]
    z_arm0 = float(np.median(arm_band[:, 2])) if len(arm_band) else 0.8
    zt = z_arm0 - 0.5 * t0 - 0.045
    sl = v[(np.abs(z - zt) < 0.012) & (np.abs(v[:, 0]) < 0.45 * tip0)]
    if len(sl) > 30:
        mid = sl[np.abs(sl[:, 0]) < 0.05]
        mid = mid if len(mid) > 10 else sl
        yf, yb = np.percentile(mid[:, 1], 1), np.percentile(mid[:, 1], 99)
        # widest point of the cross-section within the front 55% of the depth: the ribcage's
        # widest point is near the centre, a cape wrapping the sides only widens it further back
        ybins = np.linspace(yf, yf + 0.55 * (yb - yf), 9)
        for s in "LR":
            sx = sl[:, 0] * SIDE[s]
            best = 0.0
            for y0, y1 in zip(ybins[:-1], ybins[1:]):
                sel = (sl[:, 1] >= y0) & (sl[:, 1] < y1) & (sx > 0)
                if sel.sum() > 5:
                    best = max(best, float(np.percentile(sx[sel], 99)))
            L[f"xt_{s}"] = best if best > 0 else 0.26 * L[f"tip_{s}"]
    else:
        L["xt_L"] = L["xt_R"] = 0.26 * tip0
    for s in "LR":
        L[f"xt_{s}"] = float(np.clip(L[f"xt_{s}"], 0.17 * L[f"tip_{s}"], 0.36 * L[f"tip_{s}"]))
    # mirror-average arm measurements for symmetry of the rig
    xt = 0.5 * (L.xt_L + L.xt_R); tip = 0.5 * (L.tip_L + L.tip_R); t_arm = 0.5 * (L.tarm_L + L.tarm_R)
    L["xt"], L["tip"], L["tarm"] = xt, tip, t_arm
    # arm axis line z(x), y(x) from slab centres between torso edge and wrist
    zs, ys, xs_ = [], [], []
    for s in "LR":
        sg = SIDE[s]
        sx = up[:, 0] * sg
        for b in np.arange(max(xt + 0.02, 0.42 * tip), 0.8 * tip, 0.01):
            sl = up[(sx >= b) & (sx < b + 0.01)]
            if len(sl) < 5:
                continue
            # keep the arm band only (ignore stray cape/hair verts far from the arm line)
            zm = np.median(sl[:, 2])
            sl = sl[np.abs(sl[:, 2] - zm) < 1.5 * t_arm]
            xs_.append(b + 0.005); zs.append(0.5 * (sl[:, 2].min() + sl[:, 2].max())); ys.append(0.5 * (sl[:, 1].min() + sl[:, 1].max()))
    xs_, zs, ys = map(np.array, (xs_, zs, ys))
    if len(xs_) >= 4:
        az = np.polyfit(xs_, zs, 1); ay = np.polyfit(xs_, ys, 1)
    else:
        az = np.array([0.0, 0.8]); ay = np.array([0.0, 0.0])
    L["arm_line_z"], L["arm_line_y"] = az.tolist(), ay.tolist()
    arm_z = lambda x: float(np.polyval(az, x))
    arm_y = lambda x: float(np.polyval(ay, x))
    # shoulder joint sits a little inside the chest's side surface
    xs = 0.86 * xt
    # wrist: narrowest point (in y) between forearm and hand
    best = None
    for s in "LR":
        sg = SIDE[s]
        sx = up[:, 0] * sg
        prof = []
        for b in np.arange(xs + 0.62 * (tip - xs), xs + 0.82 * (tip - xs), 0.006):
            sl = up[(sx >= b) & (sx < b + 0.006)]
            if len(sl) < 4:
                continue
            zm = arm_z(b)
            sl = sl[np.abs(sl[:, 2] - zm) < 1.5 * t_arm]
            if len(sl) < 4:
                continue
            prof.append((b + 0.003, np.ptp(sl[:, 1]) + 0.5 * np.ptp(sl[:, 2])))
        if len(prof) >= 3:
            prof = np.array(prof)
            k = np.convolve(prof[:, 1], np.ones(3) / 3, mode='same')
            k[0], k[-1] = prof[0, 1], prof[-1, 1]
            # prior: the wrist sits ~73% of the way from the shoulder to the finger tips
            u = (prof[:, 0] - xs) / (tip - xs)
            k = k * (1.0 + 12.0 * (u - 0.73) ** 2)
            best = (best or []) + [prof[int(np.argmin(k)), 0]]
    xw = float(np.mean(best)) if best else xs + 0.8 * (tip - xs)
    xw = float(np.clip(xw, xs + 0.64 * (tip - xs), xs + 0.81 * (tip - xs)))
    xe = xs + 0.52 * (xw - xs)
    L.update(xs=float(xs), xw=xw, xe=float(xe), zs=arm_z(xs), ys=arm_y(xs), ze=arm_z(xe), ye=arm_y(xe),
             zw=arm_z(xw), yw=arm_y(xw), zh=arm_z(xw + 0.5 * (tip - xw)), yh=arm_y(xw + 0.5 * (tip - xw)))
    # hand thickness (for the grip socket)
    hs = up[(np.abs(up[:, 0]) > xw + 0.01) & (np.abs(up[:, 0]) < xw + 0.6 * (tip - xw))]
    L["hand_t"] = float(np.ptp(hs[:, 2])) if len(hs) > 10 else 0.03
    L["hand_w"] = float(np.ptp(hs[:, 1])) if len(hs) > 10 else 0.05

    # ---- torso half-width profile (centre cluster only)
    def torso_halfwidth(zc, dz=0.01):
        sl = v[(np.abs(z - zc) < dz) & (np.abs(v[:, 0]) < xt + 0.02)]
        if len(sl) < 5:
            return 0.0
        return float(max(np.percentile(sl[:, 0], 99.5), -np.percentile(sl[:, 0], 0.5)))
    L["torso_hw"] = {round(float(zz), 3): torso_halfwidth(zz) for zz in np.arange(0.05, 0.95, 0.025)}

    # ---- neck: the front profile (most forward surface near the mid-line) recedes under the chin;
    # the deepest point of that recession between chest and face is the neck.  Width breaks ties.
    zsh = L.zs
    prof = []
    for zz in np.arange(zsh + 0.015, zsh + 0.62 * (1.0 - zsh), 0.004):
        sl = v[(np.abs(z - zz) < 0.004) & (np.abs(v[:, 0]) < 0.05)]
        wide = v[(np.abs(z - zz) < 0.004) & (np.abs(v[:, 0]) < xs)]
        if len(sl) < 4 or len(wide) < 4:
            continue
        prof.append((zz, np.percentile(sl[:, 1], 3), np.percentile(wide[:, 0], 98) - np.percentile(wide[:, 0], 2)))
    if len(prof) >= 5:
        prof = np.array(prof)
        front = np.convolve(prof[:, 1], np.ones(3) / 3, mode='same'); front[0], front[-1] = prof[0, 1], prof[-1, 1]
        width = prof[:, 2]
        sc = (front - front.min()) / (np.ptp(front) + 1e-6) - 0.35 * (width - width.min()) / (np.ptp(width) + 1e-6)
        zn = float(prof[int(np.argmax(sc)), 0])
    else:
        zn = zsh + 0.35 * (1.0 - zsh)
    zn = float(np.clip(zn, zsh + 0.035, zsh + 0.55 * (1 - zsh)))
    L["zn"] = zn
    L["z_neckbase"] = float(min(zsh + 0.4 * t_arm, 0.5 * (zsh + zn) + 0.01))
    hsl = v[(z > zn + 0.02) & (z < zn + 0.10) & (np.abs(v[:, 0]) < xs)]
    L["y_head"] = float(0.5 * (hsl[:, 1].min() + hsl[:, 1].max())) if len(hsl) > 10 else 0.0
    L["y_head_front"] = float(hsl[:, 1].min()) if len(hsl) > 10 else -0.06

    # ---- crotch: scan up from the shins until the two legs merge
    zc = None
    gaps = {}
    separated_seen = False
    # only the leg cores: tabards hang in front of the thighs, capes behind them
    ank = v[(z > 0.06) & (z < 0.16)]
    y_leg = float(np.median(ank[:, 1])) if len(ank) > 10 else 0.0
    band = lambda sl: sl[np.abs(sl[:, 1] - y_leg) < 0.045] if np.sum(np.abs(sl[:, 1] - y_leg) < 0.045) > 20 else sl
    for zz in np.arange(0.12, 0.62, 0.005):
        sl = band(v[(np.abs(z - zz) < 0.004) & (np.abs(v[:, 0]) < xt)])
        g = _gap_split(sl[:, 0])
        if g is not None:
            separated_seen = True
            gaps[round(float(zz), 3)] = g
        elif separated_seen:
            # require it to stay merged for a few slices (ignore a single noisy slice)
            ok = True
            for dz in (0.01, 0.02):
                sl2 = band(v[(np.abs(z - (zz + dz)) < 0.004) & (np.abs(v[:, 0]) < xt)])
                if _gap_split(sl2[:, 0]) is not None:
                    ok = False
            if ok:
                zc = float(zz)
                break
    L["robe"] = zc is None or zc < 0.25
    if L.robe:
        zc = 0.45
    L["zc"] = zc
    gx = float(np.median(list(gaps.values()))) if gaps else 0.0
    L["gap_x"] = gx

    def leg_centre(zz, s, dz=0.006):
        sl = band(v[(np.abs(z - zz) < dz) & (np.abs(v[:, 0]) < xt)])
        sg = SIDE[s]
        part = sl[(sl[:, 0] - gx) * sg > 0]
        if len(part) < 5:
            return None
        return (float(0.5 * (part[:, 0].min() + part[:, 0].max())), float(0.5 * (part[:, 1].min() + part[:, 1].max())),
                float(np.ptp(part[:, 0])), float(np.ptp(part[:, 1])))

    # hips width for robes
    hw = torso_halfwidth(zc)
    L["hip_hw"] = hw
    for s in "LR":
        sg = SIDE[s]
        top = leg_centre(zc - 0.05, s) if not L.robe else None
        # robes: a flared skirt says nothing about the hips -> cap by the chest width
        hx = top[0] if top else sg * 0.5 * min(hw, 0.95 * xt)
        L[f"hip_x_{s}"] = hx
        L[f"thigh_r_{s}"] = 0.5 * top[3] if top else 0.06
        # ankle: where the foot's front-back extent drops toward the shin depth
        feet = v[(z < 0.03) & ((v[:, 0] - gx) * sg > 0)]
        foot_len = np.ptp(feet[:, 1]) if len(feet) > 5 else 0.15
        za = 0.06
        for zz in np.arange(0.02, 0.16, 0.004):
            c = leg_centre(zz, s, 0.004)
            if c and c[3] < 0.62 * foot_len:
                za = zz
                break
        za = float(np.clip(za * 0.95, 0.035, 0.11))
        c = leg_centre(za + 0.02, s) or (hx, 0.0, 0.05, 0.05)
        L[f"ankle_{s}"] = (c[0], c[1], za)
        toe_y = float(np.percentile(feet[:, 1], 1)) if len(feet) > 5 else c[1] - 0.1
        toe_x = float(np.median(feet[feet[:, 1] < toe_y + 0.03][:, 0])) if len(feet) > 5 else c[0]
        L[f"toe_{s}"] = (toe_x, toe_y, 0.02)
        L[f"heel_y_{s}"] = float(np.percentile(feet[:, 1], 99)) if len(feet) > 5 else c[1] + 0.03
    L["zhip"] = float(zc + 0.045)
    for s in "LR":
        ax, ay, za = L[f"ankle_{s}"]
        zk = za + 0.5 * (L.zhip - za)
        c = leg_centre(zk, s)
        kx, ky = (c[0], c[1]) if c and not L.robe else (0.5 * (L[f"hip_x_{s}"] + ax), ay)
        L[f"knee_{s}"] = (kx, ky - 0.006, zk)  # tiny forward bend so the knee hinge is unambiguous

    # torso centre y per height (spine line)
    def torso_y(zz):
        sl = v[(np.abs(z - zz) < 0.01) & (np.abs(v[:, 0]) < 0.7 * xt)]
        if len(sl) < 5:
            return 0.0, 0.12
        return float(0.5 * (sl[:, 1].min() + sl[:, 1].max())), float(np.ptp(sl[:, 1]))
    L["torso_y"] = {k: torso_y(k) for k in (L.zhip, 0.5 * (L.zhip + L.z_neckbase), L.z_neckbase - 0.03)}
    # back surface (for the death pose ground contact) and chest front (trinket socket)
    body = v[z > L.zc]
    L["back_y"] = float(np.percentile(body[:, 1], 99.5)) if len(body) else 0.08
    chest_z = L.zs - 0.06
    ch = v[(np.abs(z - chest_z) < 0.012) & (np.abs(v[:, 0]) < 0.06)]
    L["chest_front_y"] = float(np.percentile(ch[:, 1], 1)) if len(ch) > 5 else -0.08
    L["chest_socket_z"] = float(chest_z)
    return L


def build_joints(L):
    """Bone head/tail positions (Blender space) from the landmarks."""
    J = {}
    zh, znb, zn = L.zhip, L.z_neckbase, L.zn
    ty = lambda zz: L.torso_y[min(L.torso_y, key=lambda k: abs(k - zz))][0]
    depth = lambda zz: L.torso_y[min(L.torso_y, key=lambda k: abs(k - zz))][1]
    yb = lambda zz: ty(zz) + 0.12 * depth(zz)   # spine sits toward the back
    z_sp = zh + 0.28 * (znb - zh)
    z_ch = zh + 0.62 * (znb - zh)
    J["root"] = (Vector((0, 0, 0)), Vector((0, 0, 0.12)))
    J["hips"] = (Vector((0, yb(zh), zh)), Vector((0, yb(z_sp), z_sp)))
    J["spine"] = (Vector((0, yb(z_sp), z_sp)), Vector((0, yb(z_ch), z_ch)))
    J["chest"] = (Vector((0, yb(z_ch), z_ch)), Vector((0, yb(znb), znb)))
    zhd = zn + 0.015
    J["neck"] = (Vector((0, yb(znb), znb)), Vector((0, L.y_head + 0.004, zhd)))
    J["head"] = (Vector((0, L.y_head + 0.004, zhd)), Vector((0, L.y_head, 1.0)))
    for s in "LR":
        sg = SIDE[s]
        S = Vector((sg * L.xs, L.ys, L.zs))
        E = Vector((sg * L.xe, L.ye, L.ze))
        W = Vector((sg * L.xw, L.yw, L.zw))
        Ht = Vector((sg * (L.xw + 0.8 * (L.tip - L.xw)), L.yh, L.zh))
        clav = Vector((sg * 0.22 * L.xs, yb(znb) - 0.01, L.zs + 0.004))
        J[f"shoulder.{s}"] = (clav, S)
        J[f"upperarm.{s}"] = (S, E)
        J[f"forearm.{s}"] = (E, W)
        J[f"hand.{s}"] = (W, Ht)
        hx = L[f"hip_x_{s}"]
        Hp = Vector((hx, ty(zh), zh))
        K = Vector(L[f"knee_{s}"])
        A = Vector(L[f"ankle_{s}"])
        T = Vector(L[f"toe_{s}"])
        ball = A + 0.72 * (Vector((T.x, T.y, 0.025)) - A)
        ball.z = max(0.02, min(ball.z, 0.035))
        J[f"thigh.{s}"] = (Hp, K)
        J[f"shin.{s}"] = (K, A)
        J[f"foot.{s}"] = (A, ball)
    return J


# =============================================================================== armature

def build_armature(J):
    arm_data = bpy.data.armatures.new("Armature")
    arm = bpy.data.objects.new("Armature", arm_data)
    bpy.context.scene.collection.objects.link(arm)
    C._select_only([arm])
    bpy.ops.object.mode_set(mode='EDIT')
    eb = arm_data.edit_bones
    for name in BONES:
        b = eb.new(name)
        b.head, b.tail = J[name]
        b.use_deform = name != "root"
    for name in BONES:
        b = eb[name]
        if PARENT[name]:
            b.parent = eb[PARENT[name]]
            b.use_connect = False
        # consistent rolls: local Z forward (-Y) for vertical bones and arms, up (+Z) for feet
        b.align_roll(Vector((0, 0, 1)) if name.startswith("foot") else Vector((0, -1, 0)))
    bpy.ops.object.mode_set(mode='OBJECT')
    arm_data.display_type = 'STICK'
    return arm


# =============================================================================== skinning

def _deform_bones():
    return [b for b in BONES if b != "root"]


def get_weights(obj, names):
    idx = {obj.vertex_groups[n].index: i for i, n in enumerate(names) if n in obj.vertex_groups}
    W = np.zeros((len(obj.data.vertices), len(names)))
    for v in obj.data.vertices:
        for g in v.groups:
            j = idx.get(g.group)
            if j is not None:
                W[v.index, j] = g.weight
    return W


def set_weights(obj, names, W):
    obj.vertex_groups.clear()
    groups = [obj.vertex_groups.new(name=n) for n in names]
    for j, g in enumerate(groups):
        col = W[:, j]
        nz = np.nonzero(col > 1e-4)[0]
        # group verts by identical weight is not worth it; add per vertex
        for i in nz:
            g.add([int(i)], float(col[i]), 'REPLACE')


def seg_dist(P, a, b):
    ab = b - a
    t = np.clip(((P - a) @ ab) / max(ab @ ab, 1e-12), 0, 1)
    return np.linalg.norm(P - (a + t[:, None] * ab), axis=1)


def region_mask(P, L, names, J=None):
    """Allowed-bone mask (N x B) from simple anatomical rules (T-pose)."""
    N = len(P)
    M = np.ones((N, len(names)))
    x, y, z = P[:, 0], P[:, 1], P[:, 2]
    ix = {n: i for i, n in enumerate(names)}
    armpit_z = L.zs - 0.55 * L.tarm
    for s in "LR":
        sg = SIDE[s]
        sx = x * sg
        arm = [f"upperarm.{s}", f"forearm.{s}", f"hand.{s}"]
        # other side of the body never moves this arm
        for n in arm + [f"shoulder.{s}"]:
            M[sx < -0.03, ix[n]] = 0
        # torso below the armpit / legs / head do not follow the arm
        inner = (sx < L.xs - 0.015) & (z < armpit_z)
        for n in arm:
            M[inner, ix[n]] = 0
        # anything hanging well below the T-pose arm's underside (capes, cloaks, long hair) stays
        # with the body; a deeper band is allowed along the forearm so wide sleeves still follow
        below_arm = np.polyval(L.arm_line_z, np.maximum(sx, 0)) - 0.5 * L.tarm - z
        allow = np.where(sx > L.xe - 0.03, 0.08, 0.022)
        fade = np.clip(1.0 - (below_arm - allow) / 0.02, 0, 1)
        fade[sx < L.xs - 0.015] = np.minimum(fade[sx < L.xs - 0.015], 1.0)
        for n in arm:
            M[:, ix[n]] *= np.where(below_arm > allow, fade, 1.0)
        M[z < L.zc + 0.05, ix[f"shoulder.{s}"]] = 0
        M[sx < L.xe - 0.06, ix[f"forearm.{s}"]] = 0
        M[sx < L.xw - 0.03, ix[f"hand.{s}"]] = 0
        M[(sx < 0.6 * L.xs) & (z > L.z_neckbase), ix[f"upperarm.{s}"]] = 0
        # legs: hard left/right split below the crotch, nothing above the belly
        leg = [f"thigh.{s}", f"shin.{s}", f"foot.{s}"]
        below = z < L.zc - 0.012
        other = (x - L.gap_x) * sg < 0
        for n in leg:
            M[below & other, ix[n]] = 0
            M[z > L.zhip + 0.07, ix[n]] = 0
            M[sx < -0.05, ix[n]] = 0
        M[z > L.zhip * 0.62 + 0.02, ix[f"foot.{s}"]] = 0
        M[z > L.zhip + 0.01, ix[f"shin.{s}"]] = 0
        # outer arm does not follow the torso
        outer = sx > L.xs + 0.5 * (L.xe - L.xs)
        for n in ("hips", "spine", "chest", "neck", "head"):
            M[outer, ix[n]] = 0
    M[z < L.zn - 0.035, ix["head"]] = 0
    M[z < L.zs - 0.03, ix["neck"]] = 0
    M[z > L.zn + 0.04, ix["neck"]] = 0
    for n in ("spine", "chest"):
        M[z < L.zc - 0.02, ix[n]] = 0
    M[z > L.zs + 0.6 * L.tarm, ix["spine"]] = 0
    return M


def fallback_weights(P, J, names, M):
    """Inverse-distance weights to the allowed bone segments (used where heat weighting failed)."""
    D = np.stack([seg_dist(P, np.array(J[n][0]), np.array(J[n][1])) for n in names], 1)
    D = np.where(M > 0, D, np.inf)
    W = 1.0 / (D + 0.01) ** 4
    W[~np.isfinite(D)] = 0
    W /= np.maximum(W.sum(1, keepdims=True), 1e-12)
    return W


def _clean_proxy(obj, merge):
    """Remove the near-degenerate edges the voxel remesher leaves (they break the heat solver)."""
    import bmesh
    bm = bmesh.new(); bm.from_mesh(obj.data)
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=merge)
    bmesh.ops.dissolve_degenerate(bm, dist=merge, edges=bm.edges)
    bmesh.ops.triangulate(bm, faces=bm.faces)
    bm.to_mesh(obj.data); bm.free(); obj.data.update()


def _heat(proxy, arm, names):
    """Automatic (bone heat) weights on `proxy`; returns (weights, fraction of unweighted verts)."""
    C._select_only([proxy, arm], active=arm)
    bpy.ops.object.parent_set(type='ARMATURE_AUTO')
    W = get_weights(proxy, names)
    return W, float((W.sum(1) < 1e-3).mean())


def _make_proxy(src, kind, voxel):
    proxy = src.copy(); proxy.data = src.data.copy(); proxy.name = "Proxy_" + kind
    bpy.context.scene.collection.objects.link(proxy)
    proxy.vertex_groups.clear()
    C._select_only([proxy])
    if kind == "voxel":
        r = proxy.modifiers.new("remesh", 'REMESH')
        r.mode = 'VOXEL'; r.voxel_size = voxel; r.adaptivity = 0.0
        bpy.ops.object.modifier_apply(modifier=r.name)
        _clean_proxy(proxy, voxel * 0.25)
    else:
        _clean_proxy(proxy, 1e-5)
    if C.tri_count(proxy) > 90000:
        C.decimate(proxy, 80000)
    return proxy


def skin(body, src, arm, J, L, voxel):
    """Weight `body` (render mesh).  Bone-heat weights are solved on a proxy -- the full-resolution
    source mesh, else a watertight voxel remesh of it, else the render mesh itself -- then transferred
    (nearest face, interpolated), constrained by anatomical masks, limited to 4 influences."""
    names = _deform_bones()
    Wp = None
    proxy = None
    t0 = time.time()
    for kind in ("source", "voxel", "render"):
        cand = _make_proxy(body if kind == "render" else src, kind, voxel)
        W, miss = _heat(cand, arm, names)
        C.log(f"heat weights on {kind} proxy ({len(cand.data.vertices)} verts): {miss * 100:.1f}% unweighted")
        if miss < 0.02:
            proxy, Wp = cand, W
            break
        bpy.data.objects.remove(cand, do_unlink=True)
    if proxy is None:
        C.log("heat weighting failed on every proxy -> distance weights")
        proxy = _make_proxy(src, "source", voxel)
        Wp = np.zeros((len(proxy.data.vertices), len(names)))
    C.log(f"skinning solve {time.time() - t0:.1f}s")
    Pp = C.verts_np(proxy)
    Mp = region_mask(Pp, L, names, J)
    Wp = Wp * Mp
    bad = Wp.sum(1) < 1e-3
    if bad.any():
        Wp[bad] = fallback_weights(Pp[bad], J, names, Mp[bad])
    Wp = cloth_blend(Pp, Wp, L, J, names)
    Wp /= np.maximum(Wp.sum(1, keepdims=True), 1e-12)
    set_weights(proxy, names, Wp)
    # transfer to the render mesh
    for n in names:
        body.vertex_groups.new(name=n)
    dt = body.modifiers.new("dt", 'DATA_TRANSFER')
    dt.object = proxy
    dt.use_vert_data = True
    dt.data_types_verts = {'VGROUP_WEIGHTS'}
    dt.vert_mapping = 'POLYINTERP_NEAREST'
    dt.layers_vgroup_select_src = 'ALL'
    dt.layers_vgroup_select_dst = 'NAME'
    C._select_only([body])
    bpy.ops.object.modifier_apply(modifier=dt.name)
    P = C.verts_np(body)
    W = get_weights(body, names)
    M = region_mask(P, L, names, J)
    W *= M
    bad = W.sum(1) < 1e-3
    if bad.any():
        W[bad] = fallback_weights(P[bad], J, names, M[bad])
    # keep the 4 strongest influences, drop crumbs, normalise
    order = np.argsort(-W, axis=1)
    keep = np.zeros_like(W, bool)
    np.put_along_axis(keep, order[:, :4], True, axis=1)
    W = np.where(keep, W, 0)
    W /= np.maximum(W.sum(1, keepdims=True), 1e-12)
    W[W < 0.02] = 0
    W /= np.maximum(W.sum(1, keepdims=True), 1e-12)
    set_weights(body, names, W)
    bpy.data.objects.remove(proxy, do_unlink=True)
    body.parent = arm
    mod = body.modifiers.new("Armature", 'ARMATURE')
    mod.object = arm
    return W


def cloth_blend(P, W, L, J, names):
    """Capes, tabards and robe skirts below the crotch: geometry well outside both legs follows the
    pelvis instead of tearing between the thighs (a soft blend by distance from the leg axes)."""
    ix = {n: i for i, n in enumerate(names)}
    z = P[:, 2]
    below = z < L.zhip
    if not below.any():
        return W
    d = np.full(len(P), np.inf)
    for s in "LR":
        for b in (f"thigh.{s}", f"shin.{s}"):
            d = np.minimum(d, seg_dist(P, np.array(J[b][0]), np.array(J[b][1])))
    r = max(0.045, 0.5 * (L.thigh_r_L + L.thigh_r_R))
    # 0 inside ~1.35 leg radii, 1 beyond ~2.6 radii
    t = np.clip((d - 1.35 * r) / (1.25 * r), 0, 1)
    t = t * t * (3 - 2 * t)
    t[~below] = 0
    # fade the effect out toward the feet (boots stay on the shins)
    t *= np.clip((z - 0.08) / 0.12, 0, 1)
    legs = [ix[f"{b}.{s}"] for s in "LR" for b in ("thigh", "shin", "foot")]
    moved = W[:, legs].sum(1) * t
    W = W.copy()
    W[:, legs] *= (1 - t)[:, None]
    W[:, ix["hips"]] += moved
    return W


# =============================================================================== sockets

def add_sockets(arm, J, L):
    """grip.R (main hand), hold.L (off-hand palm, e.g. the bow), grip.L (shield on the left
    forearm), chest_socket.  Blender local +Z of an empty becomes the node's glTF +Y and local -Y
    becomes glTF +Z, so: item up (+Y) = local Z, item edge/face (+Z) = local -Y."""
    sk = {}

    def make(name, bone, mat):
        e = bpy.data.objects.new(name, None)
        e.empty_display_type = 'ARROWS'; e.empty_display_size = 0.05
        bpy.context.scene.collection.objects.link(e)
        e.parent = arm; e.parent_type = 'BONE'; e.parent_bone = bone
        bpy.context.view_layer.update()
        e.matrix_world = mat
        sk[name] = e
        return e

    for s, name in (("R", "grip.R"), ("L", "hold.L")):
        sg = SIDE[s]
        W, Ht = J[f"hand.{s}"]
        hand_dir = (Ht - W).normalized()
        pos = W + 0.42 * (Ht - W) + Vector((0, 0, -0.25 * L.hand_t))
        zax = Vector((0, -1, 0))                    # thumb direction in a palms-down T-pose
        yax = -hand_dir                              # local -Y = knuckles = edge direction
        yax = (yax - zax * yax.dot(zax)).normalized()
        xax = yax.cross(zax)
        m = C.mat_from_cols(xax, yax, zax); m.translation = pos
        make(name, f"hand.{s}", m)
    # shield: back of the left forearm, top toward the elbow, face outward (back of the hand)
    E, W = J["forearm.L"]
    fdir = (W - E).normalized()
    pos = E + 0.6 * (W - E) + Vector((0, 0, 0.5 * L.tarm * 0.8))
    zax = -fdir
    yax = Vector((0, 0, -1))                         # local -Y = +Z world (back of the forearm)
    yax = (yax - zax * yax.dot(zax)).normalized()
    xax = yax.cross(zax)
    m = C.mat_from_cols(xax, yax, zax); m.translation = pos
    make("grip.L", "forearm.L", m)
    m = Matrix.Identity(4); m.translation = Vector((0, L.chest_front_y - 0.005, L.chest_socket_z))
    make("chest_socket", "chest", m)
    return sk


# =============================================================================== main

def main():
    opt = parse_args()
    t0 = time.time()
    C.reset_scene()
    body = C.import_joined_mesh(opt["in"])
    n = C.remove_small_islands(body)
    C.log(f"imported {len(body.data.vertices)} verts, removed {n} floating islands")
    orient_upright(body)
    orient_facing(body)
    normalize(body)
    v = C.surface_points(body, 240000)
    L = find_landmarks(v)
    J = build_joints(L)
    C.log("landmarks:", json.dumps({k: (round(x, 3) if isinstance(x, float) else x) for k, x in L.items()
                                    if not isinstance(x, dict)}, default=str))
    # render mesh: decimate a copy, keep the full mesh for the proxy
    render = body.copy(); render.data = body.data.copy(); render.name = "Body_render"
    bpy.context.scene.collection.objects.link(render)
    C.recalc_normals(render)
    tris = C.decimate(render, opt["tris"])
    C.shade(render, "smooth")
    C.log("render mesh tris", tris)
    arm = build_armature(J)
    skin(render, body, arm, J, L, opt["voxel"])
    bpy.data.objects.remove(body, do_unlink=True)
    render.name = "Body"; render.data.name = "Body"
    sockets = add_sockets(arm, J, L)
    meta = {"height": 1.0}
    if opt["anim"]:
        import rig_anim
        meta.update(rig_anim.author_all(arm, J, L, render))
    alpha = C.prepare_materials([render], opt["tex"])
    C.purge_orphans()
    size = C.export_glb(opt["out"], alpha=alpha, animations=opt["anim"], skins=True, quality=opt["quality"],
                        extra=dict(export_animation_mode='ACTIONS', export_rest_position_armature=False,
                                   export_force_sampling=True, export_optimize_animation_size=True,
                                   export_optimize_animation_keep_anim_armature=True, export_def_bones=False,
                                   export_influence_nb=4, export_reset_pose_bones=True, export_leaf_bone=False))
    meta["landmarks"] = {k: x for k, x in L.items() if not isinstance(x, dict)}
    with open(os.path.splitext(opt["out"])[0] + ".meta.json", "w") as f:
        json.dump(meta, f, indent=1, default=float)
    C.log(f"wrote {opt['out']} ({size / 1e6:.2f} MB, {tris} tris) in {time.time() - t0:.0f}s")
    if opt["preview"]:
        import rig_preview
        rig_preview.render_sheet(opt["out"], opt["preview"], items_dir=opt["items"])


if __name__ == "__main__":
    main()
