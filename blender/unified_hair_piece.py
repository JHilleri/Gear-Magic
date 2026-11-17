"""Fit a generated wig (fit_hair.py output, in the shared head frame) to a unified body.

    blender -b -t 2 --factory-startup -P blender/unified_hair_piece.py -- \
        --piece art/outputs/unified/qwen/hair_wavy_headframe.glb --style wavy \
        --body game/public/assets/models/units/human_f_base.glb --gender f \
        --out game/public/assets/models/hair [--scale 1.0] [--up 0] [--forward 0] [--clear 0.0015]

unified_groom.py builds haircuts from mesh cards. This is the other route: a sculpted wig from
image-to-3D (art/tools/gen.py + i2m.py, a blonde wig on a green mannequin), keyed and greyed by
fit_hair.py. The head frame (origin at the crown above the occiput, unit = skull depth) is mapped
onto this body's measured skull, then every vertex that ends up inside the body, or closer to it
than --clear, is moved out along the body's normal. Output is in global body bind coordinates
with the same sidecar as the card grooms, so the runtime treats both alike. Refit after any
rebuild of the body: the sidecar records the body's hash.
"""
import argparse
import hashlib
import json
import os
import sys
from pathlib import Path

import bpy
import numpy as np
from mathutils import Vector
from mathutils.bvhtree import BVHTree

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common as C


def body_surface(path):
    bpy.ops.import_scene.gltf(filepath=str(path))
    for obj in bpy.context.scene.objects:
        if obj.type == 'ARMATURE': obj.data.pose_position = 'REST'
    bpy.context.view_layer.update()
    points, faces = [], []
    for obj in bpy.context.scene.objects:
        # skinned surfaces only: the importer also adds a unit icosphere as the bones' display shape
        if obj.type != 'MESH' or not obj.vertex_groups or obj.name.lower().startswith(('brow', 'eye')): continue
        offset = len(points)
        points.extend([obj.matrix_world @ v.co for v in obj.data.vertices])
        faces.extend([tuple(offset + i for i in face.vertices) for face in obj.data.polygons])
    return BVHTree.FromPolygons(points, faces)


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--piece', type=Path, required=True); p.add_argument('--style', required=True)
    p.add_argument('--body', type=Path, required=True); p.add_argument('--gender', choices=('m', 'f'), required=True)
    p.add_argument('--out', type=Path, required=True)
    p.add_argument('--scale', type=float, default=1.0, help='wig size, in skull depths per head-frame unit')
    p.add_argument('--up', type=float, default=0.0, help='raise, in skull depths')
    p.add_argument('--forward', type=float, default=0.0, help='move forward, in skull depths')
    p.add_argument('--clear', type=float, default=.003, help='least distance kept from the body')
    a = p.parse_args(sys.argv[sys.argv.index('--') + 1:])
    head = json.loads(a.body.with_suffix('.meta.json').read_text())['head']
    depth = float(head['depth'])
    C.reset_scene()
    tree = body_surface(a.body)
    for obj in list(bpy.context.scene.objects): bpy.data.objects.remove(obj, do_unlink=True)
    hair = C.import_joined_mesh(str(a.piece.resolve()), name=f'Hair_{a.style}')
    v = C.verts_np(hair)
    # Head frame after import: x across, -y forward, z up, origin at the crown above the occiput.
    origin = np.array([head['x'], -head['z'] - a.forward * depth, head['y'] + a.up * depth])
    v = origin + v * depth * a.scale
    # Below the jaw the wig hangs over a body it was not modelled on. Projecting those vertices
    # onto the skin would plaster the locks flat, so each lock is slid instead: what hangs behind
    # the body moves back until it clears the back, what hangs in front moves forward, and the
    # amount varies smoothly across the piece so the waves keep their shape.
    jaw = head['y'] - depth * 1.25
    # Side and front locks that would end inside the shoulders are cut where they meet the body:
    # hair rests on a shoulder, it does not pass through it. What hangs behind is kept and slid.
    neck_y = tree.ray_cast(Vector((head['x'], 1, jaw)), Vector((0, -1, 0)))[0].y - depth * .25
    sunk = np.zeros(len(v), bool)
    for i, co in enumerate(v):
        if co[2] > jaw or co[1] > neck_y: continue
        loc, normal, _, dist = tree.find_nearest(Vector(co))
        sunk[i] = loc is not None and (Vector(co) - loc).dot(normal) < a.clear * 3
    if sunk.any():
        import bmesh
        C.set_verts_np(hair, v)
        bm = bmesh.new(); bm.from_mesh(hair.data); bm.verts.ensure_lookup_table()
        bmesh.ops.delete(bm, geom=[f for f in bm.faces if any(sunk[w.index] for w in f.verts)], context='FACES')
        bmesh.ops.delete(bm, geom=[w for w in bm.verts if not w.link_faces], context='VERTS')
        bm.to_mesh(hair.data); bm.free(); hair.data.update()
        v = C.verts_np(hair)
    cell = .004
    xs = np.arange(-.12, .1201, cell); zs = np.arange(jaw - .32, jaw + .03, cell)
    back = np.full((len(xs), len(zs)), np.nan); front = np.full((len(xs), len(zs)), np.nan)
    for i, x in enumerate(xs):
        for j, z in enumerate(zs):
            hit = tree.ray_cast(Vector((x, 1, z)), Vector((0, -1, 0)))[0]
            if hit is not None:
                back[i, j] = hit.y
                front[i, j] = tree.ray_cast(Vector((x, -1, z)), Vector((0, 1, 0)))[0].y
    ci = np.clip(np.round((v[:, 0] - xs[0]) / cell).astype(int), 0, len(xs) - 1)
    cj = np.clip(np.round((v[:, 2] - zs[0]) / cell).astype(int), 0, len(zs) - 1)
    low = (v[:, 2] < jaw + .03) & (v[:, 2] > zs[0])
    mid = (back + front) / 2
    behind = low & ~np.isnan(mid[ci, cj]) & (v[:, 1] > mid[ci, cj])
    ahead = low & ~np.isnan(mid[ci, cj]) & ~behind
    need_back = np.zeros(back.shape); need_front = np.zeros(back.shape)
    for k in np.where(behind)[0]:
        need_back[ci[k], cj[k]] = max(need_back[ci[k], cj[k]], back[ci[k], cj[k]] + a.clear * 2 - v[k, 1])
    for k in np.where(ahead)[0]:
        need_front[ci[k], cj[k]] = max(need_front[ci[k], cj[k]], v[k, 1] - (front[ci[k], cj[k]] - a.clear * 2))

    def spread(field, rounds=6):
        """Grow each need over its neighbourhood, then soften: a lock moves as one piece."""
        for _ in range(rounds):
            padded = np.pad(field, 1, mode='edge')
            field = np.maximum.reduce([padded[1:-1, 1:-1], padded[:-2, 1:-1] * .9, padded[2:, 1:-1] * .9, padded[1:-1, :-2] * .9, padded[1:-1, 2:] * .9])
        for _ in range(4):
            padded = np.pad(field, 1, mode='edge')
            field = (padded[1:-1, 1:-1] * 2 + padded[:-2, 1:-1] + padded[2:, 1:-1] + padded[1:-1, :-2] + padded[1:-1, 2:]) / 6
        return field
    need_back = spread(need_back); need_front = spread(need_front)
    # Which side a vertex slides to must not flip inside a lock: decide by the side of the neck line.
    side_back = v[:, 1] > np.nanmedian(mid[:, -8:])
    fade = np.clip((jaw + .03 - v[:, 2]) / .03, 0, 1) * low
    # (front locks were cut at the shoulder above: only the back is slid)
    shift = np.where(side_back, need_back[ci, cj], 0) * fade
    v[:, 1] += shift
    slid = int((shift > 1e-4).sum())
    # On the skull itself the wig is seated on the scalp: closest point, along the normal.
    moved = 0; flat = np.zeros(len(v), bool)
    for _ in range(3):
        for i, co in enumerate(v):
            loc, normal, _, dist = tree.find_nearest(Vector(co))
            if loc is None or abs(loc.x) > .095: continue          # the T-pose arms are not where arms rest
            signed = (Vector(co) - loc).dot(normal)
            if signed < a.clear and (co[2] > jaw or signed < 0):
                v[i] = np.array(loc + normal * a.clear); moved += 1
                flat[i] = co[2] <= jaw
    # Vertices clear of the scalp do not make their triangles clear of it: a flat triangle can cut
    # across the curve of the skull between them. Lift any triangle whose middle is too close.
    C.set_verts_np(hair, v)
    for _ in range(4):
        lifted = 0
        for face in hair.data.polygons:
            ids = list(face.vertices)
            mid = Vector(v[ids].mean(0))
            if mid.z <= jaw: continue
            loc, normal, _, dist = tree.find_nearest(mid)
            if loc is None: continue
            short = a.clear - (mid - loc).dot(normal)
            if short > 0:
                v[ids] += np.array(normal) * (short + .0005); lifted += 1
        if not lifted: break
    # Whatever still had to be pressed onto the skin below the jaw is a flattened shard: drop it.
    if flat.any():
        import bmesh
        C.set_verts_np(hair, v)
        bm = bmesh.new(); bm.from_mesh(hair.data); bm.verts.ensure_lookup_table()
        bmesh.ops.delete(bm, geom=[f for f in bm.faces if sum(flat[w.index] for w in f.verts) >= 1], context='FACES')
        bmesh.ops.delete(bm, geom=[w for w in bm.verts if not w.link_faces], context='VERTS')
        bm.to_mesh(hair.data); bm.free(); hair.data.update()
        v = C.verts_np(hair)
    C.set_verts_np(hair, v)
    # Loose crumbs left by the cuts.
    import bmesh
    C.set_verts_np(hair, v)
    bm = bmesh.new(); bm.from_mesh(hair.data); bm.faces.ensure_lookup_table()
    seen = set(); crumbs = []
    for f in bm.faces:
        if f.index in seen: continue
        stack = [f]; seen.add(f.index); island = []
        while stack:
            g = stack.pop(); island.append(g)
            for e in g.edges:
                for h in e.link_faces:
                    if h.index not in seen: seen.add(h.index); stack.append(h)
        if len(island) < 60 and max(w.co.z for g in island for w in g.verts) < jaw: crumbs.extend(island)
    bmesh.ops.delete(bm, geom=crumbs, context='FACES')
    bmesh.ops.delete(bm, geom=[w for w in bm.verts if not w.link_faces], context='VERTS')
    bm.to_mesh(hair.data); bm.free(); hair.data.update()
    v = C.verts_np(hair)
    clearance = []
    for co in v:
        loc, normal, _, dist = tree.find_nearest(Vector(co))
        if loc is not None and abs(loc.x) <= .095 and dist < .02: clearance.append((Vector(co) - loc).dot(normal))
    C.shade(hair, 'smooth')
    for slot in hair.material_slots:
        slot.material.name = 'Hair_generated'
        slot.material.use_backface_culling = False
        shader = slot.material.node_tree.nodes.get('Principled BSDF')
        if shader: shader.inputs['Roughness'].default_value = .78; shader.inputs['Metallic'].default_value = 0
    root = bpy.data.objects.new('Groom', None); bpy.context.collection.objects.link(root)
    hair.parent = root
    bpy.context.view_layer.update()
    a.out.mkdir(parents=True, exist_ok=True)
    path = a.out / f'unified_{a.gender}_{a.style}.glb'
    bpy.ops.object.select_all(action='DESELECT'); root.select_set(True); hair.select_set(True)
    bpy.ops.export_scene.gltf(filepath=str(path), export_format='GLB', use_selection=True, export_yup=True,
                             export_animations=False, export_extras=False, export_image_format='JPEG', export_jpeg_quality=88)
    sidecar = {'sourceBody': a.body.name, 'sourceSha256': hashlib.sha256(a.body.read_bytes()).hexdigest(),
               'space': 'model-bind', 'head': head, 'style': a.style, 'triangles': C.tri_count(hair),
               'boundsBlender': [[round(float(v[:, i].min()), 6), round(float(v[:, i].max()), 6)] for i in range(3)],
               'dynamicNodes': [], 'generated': {'piece': a.piece.name, 'scale': a.scale, 'up': a.up, 'forward': a.forward, 'moved': moved, 'slid': slid},
               'scalpClearance': {'min': round(float(min(clearance)), 6), 'max': round(float(max(clearance)), 6)}}
    path.with_suffix('.meta.json').write_text(json.dumps(sidecar, indent=1) + '\n')
    print('HAIR_PIECE', path, json.dumps(sidecar['generated']), sidecar['scalpClearance'], flush=True)


if __name__ == '__main__':
    main()
    if bpy.app.background:
        sys.stdout.flush(); sys.stderr.flush(); os._exit(0)
