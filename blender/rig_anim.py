"""Procedural clip authoring for rig_humanoid.py.

Poses are described by a small parameter set (spine euler angles, IK targets for hands and feet,
pole vectors, forearm twist, wrist angles, FK leg angles for seated clips).  Clips are either
procedural functions of time (idle, walk) or key poses whose parameters are interpolated with a
monotone cubic (no overshoot, eased ends, periodic tangents for loops).  Every frame is solved
(2-bone IK with explicit hinge axes, so elbows and knees only bend the anatomical way) and baked
to one Blender action per clip; glTF export turns each action into one animation.

Conventions (Blender space, character faces -Y, its left is +X):
  euler (pitch, yaw, roll) degrees: +pitch bends forward, +yaw turns left, +roll leans left.
  arm targets (out, fwd, up) are in units of the arm reach, relative to the rest shoulder joint,
  expressed in the chest's frame;  leg targets (out, fwd, up) are offsets of the ankle from rest
  in model units (height = 1), in the root frame.
"""
import math

import bpy
import numpy as np
from mathutils import Matrix, Vector

FPS = 30
WALK_SPEED = 0.56      # model heights per second covered by the planted foot in `walk`
SIDE = {"L": 1.0, "R": -1.0}
ORDER = ["root", "hips", "spine", "chest", "neck", "head",
         "shoulder.L", "upperarm.L", "forearm.L", "hand.L",
         "shoulder.R", "upperarm.R", "forearm.R", "hand.R",
         "thigh.L", "shin.L", "foot.L", "thigh.R", "shin.R", "foot.R"]


# ----------------------------------------------------------------------------- math

def Rx(d): return Matrix.Rotation(math.radians(d), 3, 'X')
def Ry(d): return Matrix.Rotation(math.radians(d), 3, 'Y')
def Rz(d): return Matrix.Rotation(math.radians(d), 3, 'Z')


def euler(p):
    pitch, yaw, roll = p
    return Rz(yaw) @ Rx(pitch) @ Ry(roll)


def rot_axis(axis, deg):
    return Matrix.Rotation(math.radians(deg), 3, axis.normalized())


def rot_between(a, b):
    return a.normalized().rotation_difference(b.normalized()).to_matrix()


def frame(a, h):
    a = a.normalized()
    h = (h - a * h.dot(a))
    h = h.normalized() if h.length > 1e-9 else a.orthogonal().normalized()
    c = a.cross(h)
    return Matrix((a, h, c)).transposed()


class Aff:
    """Rigid transform p -> R p + t."""
    __slots__ = ("R", "t")

    def __init__(self, R=None, t=None):
        self.R = R if R is not None else Matrix.Identity(3)
        self.t = t if t is not None else Vector((0, 0, 0))

    def __matmul__(self, o):
        return Aff(self.R @ o.R, self.R @ o.t + self.t)

    def __call__(self, p):
        return self.R @ p + self.t

    def inv(self):
        Rt = self.R.transposed()
        return Aff(Rt, -(Rt @ self.t))


def pivot(c, R, d=None):
    """Rotate by R about c, then translate by d (Blender pose: T(loc) * R about the bone head)."""
    return Aff(R, c - R @ c + (d if d is not None else Vector((0, 0, 0))))


def two_bone(S, T, L1, L2, pole, a0_u, a0_f, h0):
    """Absolute rotations (rest -> pose, same frame as the inputs) of a two-bone chain whose root is
    at S reaching T.  h0 is the rest hinge axis: a positive rotation about it bends the joint."""
    d = T - S
    D = max(d.length, 1e-6)
    u = d / D
    D = min(max(D, abs(L1 - L2) + 1e-4), (L1 + L2) * 0.9995)
    a = (L1 * L1 - L2 * L2 + D * D) / (2 * D)
    h = math.sqrt(max(L1 * L1 - a * a, 0.0))
    w = pole - u * pole.dot(u)
    w = w.normalized() if w.length > 1e-6 else u.orthogonal().normalized()
    E = S + u * a + w * h
    Tc = S + u * D
    a1 = (E - S).normalized()
    f1 = (Tc - E).normalized()
    n1 = a1.cross(f1)
    if n1.length < 1e-5:
        n1 = w.cross(a1)
    Du = frame(a1, n1) @ frame(a0_u, h0).transposed()
    Df = rot_between(Du @ a0_f, f1) @ Du
    return Du, Df, E


# ----------------------------------------------------------------------------- rig model

class RigInfo:
    def __init__(self, arm, J, L):
        self.L = L
        bones = arm.data.bones
        self.M = {n: bones[n].matrix_local.to_3x3().normalized() for n in ORDER}
        self.head = {n: bones[n].head_local.copy() for n in ORDER}
        self.tail = {n: bones[n].tail_local.copy() for n in ORDER}
        self.reach, self.L1, self.L2 = {}, {}, {}
        self.leg1, self.leg2 = {}, {}
        for s in "LR":
            S, E, W = self.head[f"upperarm.{s}"], self.head[f"forearm.{s}"], self.head[f"hand.{s}"]
            self.L1[s], self.L2[s] = (E - S).length, (W - E).length
            self.reach[s] = self.L1[s] + self.L2[s]
            H, K, A = self.head[f"thigh.{s}"], self.head[f"shin.{s}"], self.head[f"foot.{s}"]
            self.leg1[s], self.leg2[s] = (K - H).length, (A - K).length
        self.leglen = 0.5 * sum(self.leg1[s] + self.leg2[s] for s in "LR")
        self.hang = self._hang_angle()
        # the rest leg is slightly bent (knee hinge hint + scan noise) and a near-straight 2-bone
        # chain is hypersensitive, so raise the hips a hair until the legs are ~straight at rest
        dz = []
        for s in "LR":
            H, A = self.head[f"thigh.{s}"], self.head[f"foot.{s}"]
            d = A - H
            want = 0.994 * (self.leg1[s] + self.leg2[s])
            horiz = math.hypot(d.x, d.y)
            dz.append(math.sqrt(max(want * want - horiz * horiz, 0.0)) - abs(d.z))
        self.stand_dz = max(0.0, min(0.02, sum(dz) / 2))

    def _hang_angle(self):
        """Outward angle (deg) the idle arm needs to clear the torso and hips."""
        L = self.L
        prof = sorted((float(k), float(w)) for k, w in L["torso_hw"].items())
        zs_, ws_ = np.array([p[0] for p in prof]), np.array([p[1] for p in prof])
        S = self.head["upperarm.L"]
        need = 4.0
        R = self.reach["L"]
        # only the elbow region and the forearm matter visually (the upper arm always touches the
        # torso near the armpit); clothing may compress by half the arm radius
        for dz in np.arange(0.75 * self.L1["L"], self.L1["L"] + 0.6 * self.L2["L"], 0.01):
            zz = S.z - dz
            hw = float(np.interp(zz, zs_, ws_))
            r = 0.5 * L["tarm"] * (1.0 - 0.35 * dz / R)
            gap = hw + 0.5 * r + 0.006 - S.x
            if gap > 0:
                need = max(need, math.degrees(math.atan2(gap, dz)))
        return float(min(need, 20.0))

    def arm_target(self, s, rel):
        """Shoulder-relative (out, fwd, up) in reach units -> chest-frame rest coordinates."""
        S = self.head[f"upperarm.{s}"]
        R = self.reach[s]
        return S + Vector((SIDE[s] * rel[0], -rel[1], rel[2])) * R

    def rel_of(self, s, p):
        """Inverse of arm_target for an absolute chest-frame point."""
        S = self.head[f"upperarm.{s}"]
        d = (Vector(p) - S) / self.reach[s]
        return (SIDE[s] * d.x, -d.y, d.z)


def solve(rig, p, legmode="ik", armframe="chest"):
    """Pose parameters -> {bone: relative rotation (rest axes)}, {bone: translation (parent axes)}."""
    Rr = {}
    H = rig.head
    Rr["root"] = euler(p["root.rot"])
    Rr["hips"] = euler(p["hips.rot"])
    for b in ("spine", "chest", "neck", "head"):
        Rr[b] = euler(p[b + ".rot"])
    root_loc = Vector(p["root.loc"]); hips_loc = Vector(p["hips.loc"])
    if legmode == "ik":
        hips_loc = hips_loc + Vector((0, 0, rig.stand_dz))
    A_hips = pivot(H["hips"], Rr["hips"], hips_loc)                       # in the root frame
    A_chest = A_hips @ pivot(H["spine"], Rr["spine"]) @ pivot(H["chest"], Rr["chest"])
    for s in "LR":
        sg = SIDE[s]
        raise_, fwd = p["sh." + s]
        Rsh = Rz(-sg * fwd) @ Ry(-sg * raise_)
        Rr["shoulder." + s] = Rsh
        A_sh = pivot(H["shoulder." + s], Rsh)
        S = A_sh(H["upperarm." + s])
        T = rig.arm_target(s, p["arm." + s])
        if armframe == "root":
            T = A_chest.inv()(T)
        po = p["pole." + s]
        pole = Vector((sg * po[0], -po[1], po[2]))
        a0u = H["forearm." + s] - H["upperarm." + s]
        a0f = H["hand." + s] - H["forearm." + s]
        h0 = Vector((0, 0, -sg))
        Du, Df, _ = two_bone(S, T, rig.L1[s], rig.L2[s], pole, a0u, a0f, h0)
        tw = p["tw." + s]
        if abs(tw) > 1e-6:
            Df = rot_axis(Df @ a0f, sg * tw) @ Df
        flex, dev = p["hand." + s]
        aim = p["aim." + s]
        if aim[3] > 1e-3:
            # point the held item (= thumb direction, see the grip sockets) toward `aim`:
            # forearm twist brings the thumb into the aim plane, wrist deviation tilts it
            Av = Vector((sg * aim[0], -aim[1], aim[2])).normalized()
            hd = (Df @ a0f).normalized()
            t = Df @ Vector((0, -1, 0))
            t = (t - hd * t.dot(hd)).normalized()
            ap = Av - hd * Av.dot(hd)
            if ap.length > 1e-4:
                ap.normalize()
                ang = math.degrees(math.atan2(t.cross(ap).dot(hd), t.dot(ap))) * aim[3]
                ang = max(-80.0, min(80.0, ang))
                Rt = rot_axis(hd, ang)
                Df = Rt @ Df
                t = Rt @ t
            alpha = math.degrees(math.atan2(Av.dot(hd), Av.dot(t)))
            dev = max(-50.0, min(28.0, dev - alpha * aim[3]))
        Rr["upperarm." + s] = Rsh.transposed() @ Du
        Rr["forearm." + s] = Du.transposed() @ Df
        Rr["hand." + s] = Ry(sg * flex) @ Rz(-sg * dev)
        # legs
        toes, toe_out = p["foot." + s]
        if legmode == "fk":
            pitch, abd, twist, knee = p["legfk." + s]
            Rr["thigh." + s] = Rx(-pitch) @ Ry(-sg * abd) @ Rz(sg * twist)
            Rr["shin." + s] = Rx(knee)
            Rr["foot." + s] = Rx(-toes)
        else:
            Hj = A_hips(H["thigh." + s])
            off = p["leg." + s]
            A0 = H["foot." + s]
            T = A0 + Vector((sg * off[0], -off[1], off[2]))
            kp = p["kpole." + s]
            pole = Vector((sg * kp[0], -kp[1], kp[2]))
            a0u = H["shin." + s] - H["thigh." + s]
            a0f = H["foot." + s] - H["shin." + s]
            Dt, Ds, _ = two_bone(Hj, T, rig.leg1[s], rig.leg2[s], pole, a0u, a0f, Vector((1, 0, 0)))
            Rr["thigh." + s] = Rr["hips"].transposed() @ Dt
            Rr["shin." + s] = Dt.transposed() @ Ds
            Dfoot = Rz(-sg * toe_out) @ Rx(-toes)
            Rr["foot." + s] = Ds.transposed() @ Dfoot
    locs = {"root": root_loc, "hips": hips_loc}
    return Rr, locs


# ----------------------------------------------------------------------------- curves

class Curve:
    """Monotone cubic (Fritsch-Carlson) through keys; periodic for loops."""

    def __init__(self, ts, ys, loop=False):
        self.loop = loop
        ts = np.asarray(ts, float); ys = np.asarray(ys, float)
        if ys.ndim == 1:
            ys = ys[:, None]
        self.T = ts[-1]
        self.ts, self.ys = ts, ys
        n = len(ts)
        if n == 1:
            self.m = np.zeros_like(ys)
            return
        d = np.diff(ys, axis=0) / np.diff(ts)[:, None]
        m = np.zeros_like(ys)
        for k in range(1, n - 1):
            m[k] = 0.5 * (d[k - 1] + d[k])
            m[k][np.sign(d[k - 1]) != np.sign(d[k])] = 0
        if loop and n > 2:
            m0 = 0.5 * (d[-1] + d[0])
            m0[np.sign(d[-1]) != np.sign(d[0])] = 0
            m[0] = m[-1] = m0
        for k in range(n - 1):
            for j in range(ys.shape[1]):
                if abs(d[k, j]) < 1e-12:
                    m[k, j] = m[k + 1, j] = 0
                    continue
                a, b = m[k, j] / d[k, j], m[k + 1, j] / d[k, j]
                s = a * a + b * b
                if s > 9:
                    t = 3 / math.sqrt(s)
                    m[k, j] = t * a * d[k, j]; m[k + 1, j] = t * b * d[k, j]
        self.m = m

    def __call__(self, t):
        ts, ys, m = self.ts, self.ys, self.m
        if len(ts) == 1:
            return ys[0]
        if self.loop:
            t = t % self.T if t != self.T else t
        t = min(max(t, ts[0]), ts[-1])
        k = int(np.searchsorted(ts, t, side="right") - 1)
        k = min(max(k, 0), len(ts) - 2)
        h = ts[k + 1] - ts[k]
        u = (t - ts[k]) / h
        h00 = 2 * u ** 3 - 3 * u ** 2 + 1; h10 = u ** 3 - 2 * u ** 2 + u
        h01 = -2 * u ** 3 + 3 * u ** 2; h11 = u ** 3 - u ** 2
        return h00 * ys[k] + h10 * h * m[k] + h01 * ys[k + 1] + h11 * h * m[k + 1]


def keyed(base, keys, loop=False):
    """keys: [(t, {param: value})].  Unspecified params hold their previous key value."""
    names = sorted(set().union(*[k.keys() for _, k in keys]))
    ts = [t for t, _ in keys]
    curves = {}
    for n in names:
        vals, cur = [], base[n]
        for _, k in keys:
            cur = k.get(n, cur)
            vals.append(cur)
        curves[n] = Curve(ts, [np.atleast_1d(np.asarray(v, float)) for v in vals], loop)

    def sample(t):
        p = dict(base)
        for n, c in curves.items():
            v = c(t)
            p[n] = tuple(float(x) for x in v) if len(v) > 1 else float(v[0])
        return p
    return sample


def mix(a, b, w):
    """Blend two parameter dicts (w=0 -> a)."""
    out = {}
    for k in a:
        va, vb = a[k], b.get(k, a[k])
        if isinstance(va, tuple):
            out[k] = tuple(x + (y - x) * w for x, y in zip(va, vb))
        else:
            out[k] = va + (vb - va) * w
    return out


def over(base, **kw):
    d = dict(base)
    for k, v in kw.items():
        d[k.replace("_", ".", 1) if "." not in k else k] = v
    return d


def smoothstep(a, b, x):
    t = min(max((x - a) / (b - a), 0.0), 1.0)
    return t * t * (3 - 2 * t)


# ----------------------------------------------------------------------------- poses & clips

def base_pose(rig):
    p = {"root.loc": (0, 0, 0), "root.rot": (0, 0, 0), "hips.loc": (0, 0, -0.0015), "hips.rot": (0, 0, 0),
         "spine.rot": (2, 0, 0), "chest.rot": (1, 0, 0), "neck.rot": (-1, 0, 0), "head.rot": (-2, 0, 0)}
    a = math.radians(rig.hang + 3)
    b = math.radians(9)
    r = 0.955
    for s in "LR":
        p["sh." + s] = (-3.0, 2.0)
        p["arm." + s] = (r * math.sin(a), r * math.cos(a) * math.sin(b), -r * math.cos(a) * math.cos(b))
        p["pole." + s] = (0.45, -1.0, 0.0)
        p["tw." + s] = 0.0
        p["hand." + s] = (6.0, 0.0)
        p["aim." + s] = (0.08, 0.62, 0.78, 1.0)   # item points forward-up, slightly outward
        p["leg." + s] = (0.0, 0.0, 0.0)
        p["kpole." + s] = (0.15, 1.0, 0.0)
        p["foot." + s] = (0.0, 0.0)
        p["legfk." + s] = (0.0, 0.0, 0.0, 0.0)
    return p


def clip_idle(rig, base):
    T = 2.0

    def f(t):
        ph = 2 * math.pi * t / T
        b = math.sin(ph)
        p = dict(base)
        p["chest.rot"] = (base["chest.rot"][0] - 1.4 * b, 0.6 * math.sin(ph + 0.7), 0)
        p["spine.rot"] = (base["spine.rot"][0] + 0.4 * b, 0, 0.5 * math.sin(ph))
        p["head.rot"] = (base["head.rot"][0] + 1.0 * b, 2.0 * math.sin(ph + 0.4), 0)
        p["hips.loc"] = (0.004 * math.sin(ph + 1.2), 0, base["hips.loc"][2] - 0.0025 * (1 - b))
        p["hips.rot"] = (0, 0, -0.8 * math.sin(ph + 1.2))
        for s in "LR":
            sg = SIDE[s]
            p["sh." + s] = (base["sh." + s][0] + 1.6 * b, base["sh." + s][1])
            o, fw, u = base["arm." + s]
            p["arm." + s] = (o + 0.012 * b, fw + 0.008 * math.sin(ph + 0.5 * sg), u + 0.006 * b)
        return p
    return T, True, f


def clip_walk(rig, base):
    T = 0.8
    stance = 0.6
    Lg = rig.leglen
    # every unit walks at the same ground speed (WALK_SPEED model heights / s) so the renderer can use
    # one timeScale for all; the stride / leg-length ratio stays within a natural range
    S = min(max(WALK_SPEED * stance * T, 0.45 * Lg), 0.8 * Lg)   # distance a planted foot travels per step
    lift = 0.14 * Lg
    d_ms = 0.006 * Lg
    d_ds = Lg - math.sqrt((0.985 * Lg) ** 2 - (S / 2) ** 2)
    d_ds = max(d_ds, d_ms + 0.004)
    rig.walk_speed = S / (stance * T)
    A = 20.0
    toe_len = 0.7 * (rig.head["foot.L"] - rig.tail["foot.L"]).length + 0.02

    def f(t):
        ph = (t / T) % 1.0
        c = math.cos(2 * math.pi * ph)
        p = dict(base)
        drop = d_ms + (d_ds - d_ms) * 0.5 * (1 + math.cos(4 * math.pi * (ph - 0.05)))
        p["hips.loc"] = (0.012 * math.sin(2 * math.pi * (ph - 0.05)), 0.0, -drop)
        p["hips.rot"] = (2.0, -5.0 * c, -3.0 * math.sin(2 * math.pi * (ph - 0.05)))
        p["spine.rot"] = (4.0, 2.0 * c, 1.5 * math.sin(2 * math.pi * (ph - 0.05)))
        p["chest.rot"] = (1.0, 7.0 * c, 1.0 * math.sin(2 * math.pi * (ph - 0.05)))
        p["neck.rot"] = (-2.0, -2.0 * c, 0)
        p["head.rot"] = (-3.0 + 1.5 * math.cos(4 * math.pi * (ph - 0.05)), -2.0 * c, 0)
        for s, off in (("L", 0.0), ("R", 0.5)):
            q = (ph + off) % 1.0
            if q < stance:
                u = q / stance
                fwd = S / 2 - S * u
                up = 0.0
                toes = 12.0 * (1 - smoothstep(0.0, 0.16, u)) - 30.0 * smoothstep(0.62, 1.0, u)
                if toes < 0:
                    up += toe_len * math.sin(math.radians(-toes)) * 0.9
            else:
                u = (q - stance) / (1 - stance)
                fwd = -S / 2 + S * (1 - math.cos(math.pi * u)) / 2
                up = lift * math.sin(math.pi * min(1.0, u * 1.1)) ** 1.2 + 0.25 * toe_len * (1 - u) ** 2
                toes = -30.0 * (1 - smoothstep(0.0, 0.35, u)) + 14.0 * smoothstep(0.35, 1.0, u)
            p["leg." + s] = (0.0, fwd, up)
            p["foot." + s] = (toes, 3.0)
            sg = SIDE[s]
            th = (-A if s == "L" else A) * math.cos(2 * math.pi * (ph - 0.04))
            o, fw, upa = base["arm." + s]
            rad = math.radians(th)
            fw2 = fw * math.cos(rad) - upa * math.sin(rad)
            up2 = fw * math.sin(rad) + upa * math.cos(rad)
            k = 1.0 - 0.06 * max(0.0, th) / A
            p["arm." + s] = (o * k, fw2 * k, up2 * k)
            p["hand." + s] = (base["hand." + s][0] + 6 * max(0.0, th) / A, base["hand." + s][1])
            p["sh." + s] = (base["sh." + s][0], base["sh." + s][1] + 3.0 * th / A)
        return p
    return T, True, f


def clip_run(rig, base):
    """Running gait: duty factor 0.28 (a flight phase between steps), long stride, forward lean,
    bent elbows.  Hips are lowest at mid-stance and highest in flight (the opposite of walking)."""
    T = 0.6
    duty = 0.28
    Lg = rig.leglen
    S = 0.9 * Lg                                   # distance the planted foot travels during stance
    d_c = max(Lg - math.sqrt((0.975 * Lg) ** 2 - (S / 2) ** 2), 0.03 * Lg)   # hip drop at contact
    d_m = d_c + 0.05 * Lg                          # mid-stance (knee absorbs the landing)
    d_f = max(d_c - 0.045 * Lg, 0.0)               # flight apex
    lift = 0.34 * Lg
    rig.run_speed = S / (duty * T)
    A = 34.0
    toe_len = 0.7 * (rig.head["foot.L"] - rig.tail["foot.L"]).length + 0.02
    hs = duty / 0.5                                # stance share of one step (half cycle)

    def f(t):
        ph = (t / T) % 1.0
        c = math.cos(2 * math.pi * ph)
        p = dict(base)
        h = (ph % 0.5) / 0.5
        if h < hs:
            drop = d_c + (d_m - d_c) * math.sin(math.pi * h / hs)
        else:
            drop = d_c - (d_c - d_f) * math.sin(math.pi * (h - hs) / (1 - hs))
        sway = math.sin(2 * math.pi * (ph - 0.05))
        p["hips.loc"] = (0.008 * sway, 0.0, -drop)
        p["hips.rot"] = (4.0, -7.0 * c, -2.0 * sway)
        p["spine.rot"] = (9.0, 3.0 * c, 1.0 * sway)
        p["chest.rot"] = (4.0, 9.0 * c, 0.5 * sway)
        p["neck.rot"] = (-4.0, -3.0 * c, 0)
        p["head.rot"] = (-7.0 + 1.5 * math.cos(4 * math.pi * ph), -3.0 * c, 0)
        for s, off in (("L", 0.0), ("R", 0.5)):
            q = (ph + off) % 1.0
            if q < duty:
                u = q / duty
                fwd = S / 2 - S * u
                up = 0.0
                toes = 8.0 * (1 - smoothstep(0.0, 0.2, u)) - 34.0 * smoothstep(0.55, 1.0, u)
                if toes < 0:
                    up += toe_len * math.sin(math.radians(-toes)) * 0.9
            else:
                u = (q - duty) / (1 - duty)
                # heel kicks up behind first, then the knee drives forward and the foot reaches out
                fwd = -S / 2 + S * (1 - math.cos(math.pi * u)) / 2 - 0.1 * Lg * math.sin(math.pi * min(1.0, u / 0.6))
                up = lift * math.sin(math.pi * min(1.0, u * 1.08)) ** 0.9 + 0.3 * toe_len * (1 - u) ** 2
                toes = -34.0 * (1 - smoothstep(0.0, 0.3, u)) + 10.0 * smoothstep(0.4, 1.0, u)
            p["leg." + s] = (0.0, fwd, up)
            p["foot." + s] = (toes, 3.0)
            th = (-A if s == "L" else A) * math.cos(2 * math.pi * (ph - 0.04))
            o = base["arm." + s][0]
            fw, upa = 0.22, -0.55                     # elbow bent ~90 degrees, forearm forward
            rad = math.radians(th)
            fw2 = fw * math.cos(rad) - upa * math.sin(rad)
            up2 = fw * math.sin(rad) + upa * math.cos(rad)
            p["arm." + s] = (o * 0.55, fw2, up2)
            p["pole." + s] = (0.35, -1.0, -0.15)
            p["hand." + s] = (base["hand." + s][0] + 8 * max(0.0, th) / A, base["hand." + s][1])
            p["sh." + s] = (base["sh." + s][0] - 1.5, base["sh." + s][1] + 4.0 * th / A)
        return p
    return T, True, f


def _seat(rig):
    L = rig.L
    return L["zhip"] - 0.9 * 0.5 * (L["thigh_r_L"] + L["thigh_r_R"])


def seated_base(rig, base):
    p = dict(base)
    seat = _seat(rig)
    p["root.loc"] = (0, 0.0, -seat)
    p["hips.loc"] = (0, 0, 0)
    p["hips.rot"] = (-4, 0, 0)
    p["spine.rot"] = (7, 0, 0); p["chest.rot"] = (3, 0, 0); p["head.rot"] = (-8, 0, 0)
    for s in "LR":
        p["legfk." + s] = (80.0, 24.0, -6.0, 86.0)
        p["foot." + s] = (14.0, 0.0)
        p["arm." + s] = (-0.10, 0.52, -0.60)
        p["pole." + s] = (0.7, -1.0, -0.2)
        p["hand." + s] = (14.0, 4.0)
    return p


def clip_ride_idle(rig, base):
    T = 2.0
    sb = seated_base(rig, base)

    def f(t):
        ph = 2 * math.pi * t / T
        p = dict(sb)
        bob = math.sin(2 * ph)
        p["root.loc"] = (0, 0, sb["root.loc"][2] + 0.004 * bob)
        p["chest.rot"] = (sb["chest.rot"][0] - 1.2 * math.sin(ph), 0, 0)
        p["head.rot"] = (sb["head.rot"][0] + 1.5 * math.sin(ph), 3.0 * math.sin(ph + 0.6), 0)
        for s in "LR":
            o, fw, u = sb["arm." + s]
            p["arm." + s] = (o, fw + 0.01 * bob, u + 0.012 * bob)
            p["sh." + s] = (sb["sh." + s][0] + 1.2 * math.sin(ph), sb["sh." + s][1])
        return p
    return T, True, f


def _back(b, names):
    return {n: b[n] for n in names}


def _melee_keys(rig, base, seated=False):
    """Overhead diagonal swing with the right arm (key list)."""
    b = base
    hl = (lambda x: b["hips.loc"]) if seated else (lambda x: x)
    legs = (lambda d: {}) if seated else (lambda d: d)
    yaw = 0.6 if seated else 1.0
    k = [(0.00, {})]
    k.append((0.12, {"chest.rot": (-2, -12 * yaw, 2), "spine.rot": (0, -4 * yaw, 0),
                     "arm.R": (0.42, 0.30, -0.30), "pole.R": (1.0, -0.6, -0.4), "hand.R": (-10, 0),
                     "aim.R": (0.35, 0.25, 0.9, 1.0),
                     "arm.L": (0.30, 0.45, -0.55), "pole.L": (1.0, -0.6, -0.8)}))
    k.append((0.32, {"chest.rot": (-7, -30 * yaw, 5), "spine.rot": (-4, -10 * yaw, 0), "hips.rot": (0, -10 * yaw, 0),
                     "hips.loc": hl((0, 0.012, -0.03)), "head.rot": (-4, 18 * yaw, 0),
                     "arm.R": (0.32, -0.10, 0.80), "pole.R": (1.0, -0.2, 0.7), "hand.R": (-30, 0),
                     "aim.R": (0.15, -0.75, 0.55, 1.0),
                     "arm.L": (0.20, 0.72, -0.25), "pole.L": (1.0, -0.2, -1.0), "sh.R": (8, -4),
                     **legs({"leg.L": (0.0, 0.07, 0.0), "leg.R": (0.0, -0.05, 0.0)})}))
    k.append((0.41, {"chest.rot": (-4, -18 * yaw, 3), "arm.R": (0.24, 0.28, 0.86), "pole.R": (1.0, 0.1, 0.5),
                     "hand.R": (-20, 0), "aim.R": (0.05, 0.1, 1.0, 1.0)}))
    k.append((0.50, {"chest.rot": (14, 22 * yaw, -4), "spine.rot": (8, 8 * yaw, 0), "hips.rot": (2, 10 * yaw, 0),
                     "hips.loc": hl((0, -0.025, -0.045)), "head.rot": (2, -14 * yaw, 0),
                     "arm.R": (-0.12, 0.88, -0.12), "pole.R": (1.0, -0.2, -0.6), "hand.R": (20, 0),
                     "aim.R": (-0.3, 0.9, -0.3, 1.0),
                     "arm.L": (0.42, 0.30, -0.60), "pole.L": (1.0, -0.8, -0.4), "sh.R": (-2, 6)}))
    k.append((0.62, {"chest.rot": (18, 30 * yaw, -4), "spine.rot": (10, 10 * yaw, 0),
                     "arm.R": (-0.38, 0.52, -0.58), "pole.R": (1.0, -0.6, -0.5), "hand.R": (25, 0),
                     "aim.R": (-0.55, 0.35, -0.75, 1.0)}))
    k.append((0.80, {"chest.rot": (6, 8 * yaw, 0), "spine.rot": (4, 2 * yaw, 0), "hips.rot": (0, 2 * yaw, 0),
                     "hips.loc": hl((0, -0.006, -0.012)), "head.rot": (-2, -3, 0), "sh.R": b["sh.R"],
                     "arm.R": tuple(0.5 * (x + y) for x, y in zip(b["arm.R"], (0.1, 0.4, -0.6))),
                     "pole.R": b["pole.R"], "hand.R": b["hand.R"], "arm.L": b["arm.L"], "pole.L": b["pole.L"],
                     "aim.R": tuple(0.5 * (x + y) for x, y in zip(b["aim.R"], (-0.2, 0.7, -0.2, 1.0))),
                     **legs({"leg.L": (0.0, 0.02, 0.0), "leg.R": (0.0, -0.01, 0.0)})}))
    k.append((1.00, _back(b, ("chest.rot", "spine.rot", "hips.rot", "hips.loc", "head.rot", "arm.R", "pole.R",
                              "hand.R", "aim.R", "arm.L", "pole.L", "sh.R", "leg.L", "leg.R"))))
    return k


def clip_attack_melee(rig, base):
    return 1.0, False, keyed(base, _melee_keys(rig, base))


def clip_ride_attack(rig, base):
    sb = seated_base(rig, base)
    return 1.0, False, keyed(sb, _melee_keys(rig, sb, seated=True))


def clip_attack_ranged(rig, base):
    """Bow (held in the LEFT hand, socket hold.L) drawn with the right hand to the cheek."""
    b = base
    L = rig.L
    yaw = {"hips.rot": (0, -14, 0), "spine.rot": (1, -10, 0), "chest.rot": (0, -14, 0)}
    net = 38.0                      # total torso yaw: the left arm aims straight ahead in world space
    aim = (0.985 * math.sin(math.radians(net)), 0.985 * math.cos(math.radians(net)), 0.10)
    look = {"neck.rot": (-2, 10, 0), "head.rot": (-4, 26, 0)}
    # right cheek, carried by the neck + head yaw (the head turns back toward the target)
    cheek = Vector((-0.035, L["y_head_front"] + 0.035, L["zn"] + 0.025))
    piv = rig.head["neck"]
    cheek = piv + Rz(look["neck.rot"][1] + look["head.rot"][1]) @ (cheek - piv)
    draw = rig.rel_of("R", cheek)
    nock = (aim[0] - 0.55, aim[1] - 0.12, aim[2] - 0.02)
    rel = (draw[0] + 0.16, draw[1] - 0.18, draw[2] + 0.04)
    stance = {"leg.L": (0.02, 0.08, 0.0), "leg.R": (-0.02, -0.06, 0.0), "hips.loc": (0, 0, -0.018)}
    bow_up = (0.12, 0.0, 1.0, 1.0)
    free = (0.0, 0.5, 0.8, 0.0)
    keys = [
        (0.00, {}),
        (0.24, {**yaw, **look, **stance, "arm.L": aim, "pole.L": (0.3, 0.0, -1.0), "hand.L": (0, 0), "aim.L": bow_up,
                "arm.R": nock, "pole.R": (1.0, -0.3, -0.4), "hand.R": (10, 0), "aim.R": free, "sh.L": (2, 4)}),
        (0.50, {"arm.R": draw, "pole.R": (1.0, -0.7, 0.15), "hand.R": (-5, -8), "sh.R": (6, -6), "chest.rot": (-1, -16, 0)}),
        (0.72, {"arm.R": (draw[0] + 0.02, draw[1] - 0.02, draw[2])}),
        (0.77, {"arm.R": rel, "hand.R": (-25, -15), "pole.R": (1.0, -0.8, 0.2)}),
        (0.92, {"arm.L": tuple(0.6 * x + 0.4 * y for x, y in zip(aim, b["arm.L"])),
                "arm.R": tuple(0.5 * (x + y) for x, y in zip(rel, b["arm.R"]))}),
        (1.10, _back(b, ("hips.rot", "spine.rot", "chest.rot", "neck.rot", "head.rot", "leg.L", "leg.R", "hips.loc",
                         "arm.L", "pole.L", "hand.L", "aim.L", "arm.R", "pole.R", "hand.R", "aim.R", "sh.L", "sh.R"))),
    ]
    return 1.1, False, keyed(base, keys)


def clip_cast(rig, base):
    """Both arms gather in front, then thrust forward and up (staff in the right hand stays upright)."""
    b = base
    up = (0.0, 0.2, 1.0, 1.0)
    keys = [
        (0.00, {}),
        (0.30, {"spine.rot": (-6, 0, 0), "chest.rot": (-5, 0, 0), "head.rot": (-9, 0, 0), "hips.loc": (0, 0.014, -0.016),
                "arm.R": (-0.28, 0.42, -0.32), "pole.R": (1.0, -0.4, -0.8), "arm.L": (-0.28, 0.42, -0.30), "pole.L": (1.0, -0.4, -0.8),
                "hand.R": (-10, 0), "hand.L": (-10, 0), "aim.R": up, "aim.L": (0.0, 0.3, 1.0, 0.6), "sh.L": (4, 6), "sh.R": (4, 6)}),
        (0.50, {"spine.rot": (8, 0, 0), "chest.rot": (6, 0, 0), "head.rot": (2, 0, 0), "hips.loc": (0, -0.02, -0.026),
                "arm.R": (-0.02, 0.90, 0.30), "pole.R": (0.6, 0.0, -1.0), "arm.L": (0.04, 0.86, 0.26), "pole.L": (0.6, 0.0, -1.0),
                "hand.R": (-15, 0), "hand.L": (-30, 0), "aim.R": (0.0, 0.1, 1.0, 1.0),
                "leg.L": (0, 0.05, 0), "leg.R": (0, -0.03, 0), "sh.L": (6, 10), "sh.R": (6, 10)}),
        (0.70, {"arm.R": (-0.02, 0.88, 0.32), "arm.L": (0.06, 0.84, 0.30)}),
        (1.00, _back(b, ("spine.rot", "chest.rot", "head.rot", "hips.loc", "arm.R", "pole.R", "arm.L", "pole.L",
                         "hand.R", "hand.L", "aim.R", "aim.L", "leg.L", "leg.R", "sh.L", "sh.R"))),
    ]
    return 1.0, False, keyed(base, keys)


def clip_hit(rig, base):
    b = base
    ar = lambda s, d: tuple(x + y for x, y in zip(b["arm." + s], d))
    keys = [
        (0.00, {}),
        (0.09, {"spine.rot": (-9, 0, 3), "chest.rot": (-7, 4, 0), "neck.rot": (-6, 0, 0), "head.rot": (-14, 6, 4),
                "hips.loc": (0, 0.028, -0.012), "sh.L": (8, -6), "sh.R": (8, -6),
                "arm.L": ar("L", (0.10, -0.10, 0.06)), "arm.R": ar("R", (0.12, -0.12, 0.08)),
                "leg.L": (0, 0, 0), "leg.R": (0, -0.03, 0.0)}),
        (0.24, {"spine.rot": (-3, 0, 1), "chest.rot": (-2, 1, 0), "head.rot": (-5, 2, 1), "hips.loc": (0, 0.012, -0.008)}),
        (0.50, _back(b, ("spine.rot", "chest.rot", "neck.rot", "head.rot", "hips.loc", "sh.L", "sh.R",
                         "arm.L", "arm.R", "leg.L", "leg.R"))),
    ]
    return 0.5, False, keyed(base, keys)


def clip_death(rig, base):
    """Recoil, knees buckle, fall onto the back; the last frame lies on the ground (clamp it)."""
    L = rig.L
    lift = L["back_y"] + 0.006 + getattr(rig, "death_extra", 0.0)
    limp = lambda s: (base["aim." + s][0], base["aim." + s][1], base["aim." + s][2], 0.0)
    keys = [
        (0.00, {}),
        (0.14, {"spine.rot": (-10, 0, 2), "chest.rot": (-8, 3, 0), "head.rot": (-18, 4, 0), "root.rot": (-5, 0, 0),
                "hips.loc": (0, 0.02, -0.02), "arm.L": (0.42, 0.18, -0.58), "arm.R": (0.45, 0.15, -0.55),
                "sh.L": (6, -4), "sh.R": (6, -4)}),
        (0.38, {"hips.loc": (0, 0.03, -0.11), "root.rot": (-20, 0, 2), "spine.rot": (-6, 0, 0), "chest.rot": (-6, 0, 0),
                "head.rot": (-10, 6, 0), "arm.L": (0.55, 0.25, -0.40), "arm.R": (0.60, 0.20, -0.35),
                "aim.L": limp("L"), "aim.R": limp("R")}),
        (0.70, {"root.rot": (-88, 0, 3), "root.loc": (0, 0, lift), "hips.loc": (0, 0, -0.02), "spine.rot": (0, 0, 0),
                "chest.rot": (-2, 0, 0), "head.rot": (-6, 22, 0), "arm.L": (0.80, 0.04, -0.42), "arm.R": (0.72, 0.10, -0.55),
                "pole.L": (0.0, -0.3, 1.0), "pole.R": (0.0, -0.3, 1.0), "leg.L": (0.05, 0.0, 0.0), "leg.R": (-0.02, 0.02, 0.0),
                "foot.L": (-15, 18), "foot.R": (-12, 10), "hand.L": (0, 0), "hand.R": (0, 0)}),
        (0.80, {"root.rot": (-84, 0, 3), "head.rot": (-8, 24, 0)}),
        (0.95, {"root.rot": (-90, 0, 3), "head.rot": (-6, 26, 0)}),
        (1.20, {"root.rot": (-90, 0, 3)}),
    ]
    return 1.2, False, keyed(base, keys)


def clip_work(rig, base):
    """Hammering down in front of the body with the right hand (loop)."""
    wb = dict(base)
    wb.update({"spine.rot": (16, 0, 0), "chest.rot": (6, 0, 0), "head.rot": (-10, 0, 0), "hips.loc": (0, 0.02, -0.04),
               "leg.L": (0.01, 0.06, 0.0), "leg.R": (-0.01, -0.04, 0.0),
               "arm.L": (-0.10, 0.55, -0.70), "pole.L": (1.0, -1.0, 0.0), "hand.L": (10, 0)})
    up = {"arm.R": (0.16, 0.36, 0.05), "pole.R": (1.0, -0.6, -0.1), "hand.R": (-25, 0), "aim.R": (0.05, -0.25, 1.0, 1.0),
          "spine.rot": (14, 0, 0), "chest.rot": (6, 0, 0)}
    keys = [
        (0.00, up),
        (0.28, {"arm.R": (0.17, 0.30, 0.20), "pole.R": (1.0, -0.6, 0.1), "hand.R": (-35, 0), "aim.R": (0.05, -0.55, 0.85, 1.0),
                "spine.rot": (12, 0, 0), "chest.rot": (3, -4, 0)}),
        (0.44, {"arm.R": (0.02, 0.62, -0.62), "pole.R": (1.0, -0.8, -0.2), "hand.R": (22, 0), "aim.R": (0.0, 0.9, -0.4, 1.0),
                "spine.rot": (20, 0, 0), "chest.rot": (8, 4, 0)}),
        (0.52, {"arm.R": (0.04, 0.58, -0.52), "hand.R": (12, 0), "aim.R": (0.0, 0.95, -0.1, 1.0), "spine.rot": (19, 0, 0)}),
        (0.90, up),
    ]
    return 0.9, True, keyed(wb, keys, loop=True)


CLIPS = [("idle", clip_idle, "ik"), ("walk", clip_walk, "ik"), ("run", clip_run, "ik"), ("attack_melee", clip_attack_melee, "ik"),
         ("attack_ranged", clip_attack_ranged, "ik"), ("cast", clip_cast, "ik"), ("hit", clip_hit, "ik"),
         ("death", clip_death, "ik"), ("work", clip_work, "ik"), ("ride_idle", clip_ride_idle, "fk"),
         ("ride_attack", clip_ride_attack, "fk")]


# ----------------------------------------------------------------------------- baking

def _apply(arm, rig, R, locs, prev=None):
    out = {}
    for n in ORDER:
        pb = arm.pose.bones[n]
        M = rig.M[n]
        q = (M.transposed() @ R.get(n, Matrix.Identity(3)) @ M).to_quaternion()
        if prev is not None and n in prev and prev[n].dot(q) < 0:
            q.negate()
        pb.rotation_mode = 'QUATERNION'
        pb.rotation_quaternion = q
        out[n] = q
        if n in locs:
            pb.location = M.transposed() @ locs[n]
        else:
            pb.location = (0, 0, 0)
        pb.scale = (1, 1, 1)
    return out


def _bake(arm, rig, base, name, fn, legmode):
    dur, loop, sampler = fn(rig, base)
    old = bpy.data.actions.get(name)
    if old is not None:
        for tr in list(arm.animation_data.nla_tracks):
            if tr.name == name:
                arm.animation_data.nla_tracks.remove(tr)
        bpy.data.actions.remove(old)
    act = bpy.data.actions.new(name)
    act.use_fake_user = True
    arm.animation_data.action = act
    n = int(round(dur * FPS))
    prev = None
    for fr in range(n + 1):
        t = min(fr / FPS, dur)
        R, locs = solve(rig, sampler(t), legmode)
        prev = _apply(arm, rig, R, locs, prev)
        for b in ORDER:
            pb = arm.pose.bones[b]
            pb.keyframe_insert("rotation_quaternion", frame=fr, group=b)
            if b in ("root", "hips"):
                pb.keyframe_insert("location", frame=fr, group=b)
    tr = arm.animation_data.nla_tracks.new()
    tr.name = name
    st = tr.strips.new(name, 0, act)
    st.name = name
    tr.mute = True
    return act, dur, loop, n


def _lowest_z(arm, body, act, frame):
    arm.animation_data.action = act
    bpy.context.scene.frame_set(frame)
    dg = bpy.context.evaluated_depsgraph_get()
    ev = body.evaluated_get(dg)
    me = ev.to_mesh()
    z = min((ev.matrix_world @ v.co).z for v in me.vertices)
    ev.to_mesh_clear()
    arm.animation_data.action = None
    return z


def author_all(arm, J, L, body=None):
    rig = RigInfo(arm, J, L)
    base = base_pose(rig)
    prefs = bpy.context.preferences.edit
    prefs.keyframe_new_interpolation_type = 'LINEAR'
    arm.animation_data_create()
    info = {"clips": {}}
    for name, fn, legmode in CLIPS:
        act, dur, loop, n = _bake(arm, rig, base, name, fn, legmode)
        if name == "death" and body is not None:
            # the corpse must rest exactly on the ground: measure the deformed mesh, re-bake
            z = _lowest_z(arm, body, act, n)
            if abs(z) > 0.002:
                rig.death_extra = -z
                act, dur, loop, n = _bake(arm, rig, base, name, fn, legmode)
                print(f"[pipeline] death pose lifted by {-z:+.3f}")
        arm.animation_data.action = None
        info["clips"][name] = {"duration": round(dur, 4), "loop": loop}
    # leave the armature in the idle pose (exported as the default node pose)
    R, locs = solve(rig, clip_idle(rig, base)[2](0.0), "ik")
    _apply(arm, rig, R, locs)
    bpy.context.scene.frame_set(0)
    info["walk_speed"] = round(rig.walk_speed, 4)
    info["run_speed"] = round(rig.run_speed, 4)
    info["seat"] = round(_seat(rig), 4)
    info["idle_arm_angle"] = round(rig.hang, 2)
    return info
