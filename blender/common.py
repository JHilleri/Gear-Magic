"""Shared helpers for the headless Blender asset pipeline (Blender 5.x, run with `blender -b -P`).

Everything here works on a scene that holds ONE joined, transform-applied mesh object, so the
mesh data is in world space (Blender: Z up, front = -Y = glTF +Z).
"""
import math
import os
import sys

import bpy
import numpy as np
from mathutils import Matrix, Vector


# ----------------------------------------------------------------------------- CLI

def script_args():
    """Arguments after the `--` separator of a `blender -b -P script.py -- ...` call."""
    return sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []


def log(*a):
    print("[pipeline]", *a, flush=True)


# ----------------------------------------------------------------------------- scene / import

def reset_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    sc = bpy.context.scene
    sc.render.fps = 30
    sc.unit_settings.system = 'METRIC'


def _select_only(objs, active=None):
    for o in bpy.context.view_layer.objects:
        o.select_set(False)
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = active or (objs[0] if objs else None)


def import_joined_mesh(path, name="Body"):
    """Import a GLB, bake every transform into the mesh data, drop non-mesh objects, skins,
    shape keys and vertex groups, and join everything into one mesh object."""
    bpy.ops.import_scene.gltf(filepath=path, merge_vertices=True, import_shading='NORMALS')
    meshes = [o for o in bpy.context.scene.objects if o.type == 'MESH']
    if not meshes:
        raise RuntimeError(f"no mesh in {path}")
    for o in meshes:
        for m in list(o.modifiers):
            o.modifiers.remove(m)
        if o.data.shape_keys:
            o.shape_key_clear()
        o.vertex_groups.clear()
    # world matrices before un-parenting (parents may be empties/armatures that we delete)
    mats = {o.name: o.matrix_world.copy() for o in meshes}
    for o in meshes:
        o.parent = None
        o.matrix_world = mats[o.name]
    for o in list(bpy.context.scene.objects):
        if o.type != 'MESH':
            bpy.data.objects.remove(o, do_unlink=True)
    _select_only(meshes)
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    if len(meshes) > 1:
        bpy.ops.object.join()
    obj = bpy.context.view_layer.objects.active
    obj.name = name
    obj.data.name = name
    weld(obj)
    return obj


def weld(obj, rel=2e-6):
    """Merge coincident vertices (flat-shaded / per-face-split exports would otherwise look like
    thousands of loose islands).  UVs are per face corner, so seams survive."""
    import bmesh
    v = verts_np(obj)
    if len(v) == 0:
        return 0
    size = float(np.max(v.max(0) - v.min(0)))
    bm = bmesh.new(); bm.from_mesh(obj.data)
    n0 = len(bm.verts)
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=max(size * rel, 1e-7))
    n1 = len(bm.verts)
    bm.to_mesh(obj.data); bm.free(); obj.data.update()
    return n0 - n1


def apply_matrix(obj, mat):
    """Transform mesh data in place (object stays at identity)."""
    obj.data.transform(mat)
    obj.data.update()


# ----------------------------------------------------------------------------- numpy views

def verts_np(obj):
    me = obj.data
    v = np.empty(len(me.vertices) * 3, dtype=np.float64)
    me.vertices.foreach_get("co", v)
    return v.reshape(-1, 3)


def set_verts_np(obj, v):
    obj.data.vertices.foreach_set("co", np.ascontiguousarray(v, dtype=np.float64).ravel())
    obj.data.update()


def faces_np(obj):
    """(centers Nx3, areas N, normals Nx3) of polygons."""
    me = obj.data
    n = len(me.polygons)
    c = np.empty(n * 3); a = np.empty(n); nr = np.empty(n * 3)
    me.polygons.foreach_get("center", c)
    me.polygons.foreach_get("area", a)
    me.polygons.foreach_get("normal", nr)
    return c.reshape(-1, 3), a, nr.reshape(-1, 3)


def tri_count(obj):
    me = obj.data
    lt = np.empty(len(me.polygons), dtype=np.int32)
    me.polygons.foreach_get("loop_total", lt)
    return int((lt - 2).sum())


# ----------------------------------------------------------------------------- cleanup

def _components(nv, edges):
    """Connected components of a vertex graph (vectorised label propagation + pointer jumping)."""
    lab = np.arange(nv)
    if len(edges) == 0:
        return lab
    a, b = edges[:, 0], edges[:, 1]
    for _ in range(10000):
        la, lb = lab[a], lab[b]
        m = np.minimum(la, lb)
        new = lab.copy()
        np.minimum.at(new, a, m)
        np.minimum.at(new, b, m)
        new = new[new]  # pointer jumping
        new = new[new]
        if np.array_equal(new, lab):
            break
        lab = new
    return lab


def remove_small_islands(obj, area_frac=0.0015, far_area_frac=0.02, far_dist_frac=0.06):
    """Delete loose floaters: islands with < area_frac of the total surface, or < far_area_frac
    that sit farther than far_dist_frac*size from the largest island."""
    me = obj.data
    nv = len(me.vertices)
    e = np.empty(len(me.edges) * 2, dtype=np.int64)
    me.edges.foreach_get("vertices", e)
    lab = _components(nv, e.reshape(-1, 2))
    uniq, inv = np.unique(lab, return_inverse=True)
    if len(uniq) <= 1:
        return 0
    # per-face island and area
    fc, fa, _ = faces_np(obj)
    lt = np.empty(len(me.polygons), dtype=np.int64); me.polygons.foreach_get("loop_start", lt)
    lv = np.empty(len(me.loops), dtype=np.int64); me.loops.foreach_get("vertex_index", lv)
    face_island = inv[lv[lt]]
    isl_area = np.bincount(face_island, weights=fa, minlength=len(uniq))
    total = isl_area.sum()
    v = verts_np(obj)
    size = float(np.max(v.max(0) - v.min(0)))
    main = int(np.argmax(isl_area))
    main_v = v[inv == main]
    lo, hi = main_v.min(0) - far_dist_frac * size, main_v.max(0) + far_dist_frac * size
    kill = np.zeros(len(uniq), bool)
    for i in range(len(uniq)):
        if i == main:
            continue
        frac = isl_area[i] / total
        if frac < area_frac:
            kill[i] = True
            continue
        if frac < far_area_frac:
            iv = v[inv == i]
            c = iv.mean(0)
            if np.any(c < lo) or np.any(c > hi):
                kill[i] = True
    if not kill.any():
        return 0
    import bmesh
    bm = bmesh.new(); bm.from_mesh(me)
    bm.verts.ensure_lookup_table()
    dead = [bm.verts[i] for i in np.nonzero(kill[inv])[0]]
    bmesh.ops.delete(bm, geom=dead, context='VERTS')
    bm.to_mesh(me); bm.free(); me.update()
    return int(kill.sum())


def recalc_normals(obj):
    _select_only([obj])
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.select_all(action='SELECT')
    bpy.ops.mesh.delete_loose(use_verts=True, use_edges=True, use_faces=False)
    bpy.ops.mesh.select_all(action='SELECT')
    bpy.ops.mesh.normals_make_consistent(inside=False)
    bpy.ops.object.mode_set(mode='OBJECT')


def shade(obj, mode="smooth", angle=50.0):
    """mode: smooth | angle (sharp edges above `angle` degrees) | flat."""
    _select_only([obj])
    me = obj.data
    if me.has_custom_normals:
        bpy.ops.mesh.customdata_custom_splitnormals_clear()
    if mode == "flat":
        bpy.ops.object.shade_flat()
    elif mode == "angle":
        bpy.ops.object.shade_smooth_by_angle(angle=math.radians(angle), keep_sharp_edges=False)
    else:
        bpy.ops.object.shade_smooth(keep_sharp_edges=False)


def decimate(obj, target_tris, passes=4):
    """Collapse-decimate to roughly target_tris triangles (UVs are kept by the collapse decimator).

    Collapse cannot reduce a mesh below its number of disconnected islands (a TRELLIS bush is hundreds
    of loose leaf cards), so when a pass stalls nearby vertices are welded (growing radius) to join
    the islands and the collapse is repeated."""
    _select_only([obj])
    if tri_count(obj) <= target_tris:
        mod = obj.modifiers.new("tri", 'TRIANGULATE')
        bpy.ops.object.modifier_apply(modifier=mod.name)
        return tri_count(obj)
    size = max(obj.dimensions) or 1.0
    weld = 0.004
    for _ in range(passes):
        tris = tri_count(obj)
        if tris <= target_tris * 1.1:
            break
        mod = obj.modifiers.new("decimate", 'DECIMATE')
        mod.decimate_type = 'COLLAPSE'
        mod.ratio = max(0.001, target_tris / tris)
        mod.use_collapse_triangulate = True
        bpy.ops.object.modifier_apply(modifier=mod.name)
        if tri_count(obj) > max(target_tris * 1.1, tris * 0.9):
            bpy.ops.object.mode_set(mode='EDIT')
            bpy.ops.mesh.select_all(action='SELECT')
            bpy.ops.mesh.remove_doubles(threshold=weld * size)
            bpy.ops.object.mode_set(mode='OBJECT')
            weld *= 2.5
    return tri_count(obj)


# ----------------------------------------------------------------------------- materials / textures

def material_uses_alpha(mat):
    if not mat or not mat.node_tree:
        return False
    for n in mat.node_tree.nodes:
        if n.type == 'BSDF_PRINCIPLED':
            s = n.inputs.get("Alpha")
            if s is not None and (s.is_linked or s.default_value < 0.999):
                return True
    return False


def prepare_materials(objs, max_tex=1024, double_sided=False):
    """Downscale every used image to max_tex and set culling; returns True if any material needs alpha."""
    used = set()
    alpha = False
    for o in objs:
        for slot in o.material_slots:
            m = slot.material
            if not m:
                continue
            m.use_backface_culling = not double_sided
            alpha = alpha or material_uses_alpha(m)
            if m.node_tree:
                for n in m.node_tree.nodes:
                    if n.type == 'TEX_IMAGE' and n.image:
                        used.add(n.image)
    for im in used:
        w, h = im.size
        if w == 0 or h == 0:
            continue
        s = min(1.0, max_tex / max(w, h))
        if s < 1.0:
            im.scale(max(1, int(round(w * s))), max(1, int(round(h * s))))
    return alpha


def purge_orphans():
    for _ in range(3):
        bpy.ops.outliner.orphans_purge(do_local_ids=True, do_linked_ids=True, do_recursive=True)


# ----------------------------------------------------------------------------- export

def export_glb(path, alpha=False, animations=False, skins=False, quality=82, extra=None):
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    kw = dict(
        filepath=path, export_format='GLB', check_existing=False,
        export_image_format='WEBP' if alpha else 'JPEG',
        export_jpeg_quality=quality, export_image_quality=quality,
        export_yup=True, export_apply=not skins, export_texcoords=True, export_normals=True,
        export_tangents=False, export_materials='EXPORT', export_cameras=False, export_lights=False,
        export_extras=False, export_animations=animations, export_skins=skins,
        export_morph=False, use_selection=False,
    )
    if extra:
        kw.update(extra)
    # write next to the target and rename, so readers (manifest builder, dev server) never see a
    # half-written file
    tmp = os.path.splitext(path)[0] + ".tmp.glb"
    kw["filepath"] = tmp
    bpy.ops.export_scene.gltf(**kw)
    os.replace(tmp, path)
    return os.path.getsize(path)


# ----------------------------------------------------------------------------- geometry helpers

def bbox(v):
    return v.min(0), v.max(0)


def rot_z(deg):
    return Matrix.Rotation(math.radians(deg), 4, 'Z')


def principal_axes(points, weights=None):
    """Eigen-decomposition of the weighted covariance: (eigenvalues desc, eigenvectors as columns)."""
    w = np.ones(len(points)) if weights is None else weights
    c = (points * w[:, None]).sum(0) / w.sum()
    d = points - c
    cov = (d * w[:, None]).T @ d / w.sum()
    ev, evec = np.linalg.eigh(cov)
    order = np.argsort(ev)[::-1]
    return ev[order], evec[:, order], c


def mat_from_cols(x, y, z):
    m = Matrix.Identity(4)
    for i in range(3):
        m[i][0], m[i][1], m[i][2] = x[i], y[i], z[i]
    return m


def intervals(values, bin_w, lo=None, hi=None, min_count=1):
    """Occupied 1-D intervals [(a, b), ...] of `values` on a grid of width bin_w."""
    if len(values) == 0:
        return []
    lo = values.min() if lo is None else lo
    hi = values.max() if hi is None else hi
    nb = max(1, int(math.ceil((hi - lo) / bin_w)))
    idx = np.clip(((values - lo) / bin_w).astype(int), 0, nb - 1)
    cnt = np.bincount(idx, minlength=nb)
    occ = cnt >= min_count
    out = []
    i = 0
    while i < nb:
        if occ[i]:
            j = i
            while j + 1 < nb and occ[j + 1]:
                j += 1
            out.append((lo + i * bin_w, lo + (j + 1) * bin_w))
            i = j + 1
        else:
            i += 1
    return out


def surface_points(obj, n=200000, seed=1):
    """Area-uniform random points on the surface (robust slicing regardless of tessellation)."""
    me = obj.data
    me.calc_loop_triangles()
    nt = len(me.loop_triangles)
    tri = np.empty(nt * 3, dtype=np.int64)
    me.loop_triangles.foreach_get("vertices", tri)
    tri = tri.reshape(-1, 3)
    v = verts_np(obj)
    a, b, c = v[tri[:, 0]], v[tri[:, 1]], v[tri[:, 2]]
    area = 0.5 * np.linalg.norm(np.cross(b - a, c - a), axis=1)
    rng = np.random.default_rng(seed)
    idx = rng.choice(nt, size=n, p=area / area.sum())
    r1 = np.sqrt(rng.random(n)); r2 = rng.random(n)
    w0, w1, w2 = 1 - r1, r1 * (1 - r2), r1 * r2
    return a[idx] * w0[:, None] + b[idx] * w1[:, None] + c[idx] * w2[:, None]
