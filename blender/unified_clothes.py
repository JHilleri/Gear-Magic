"""Fit generated clothes (image-to-3D of this body's own mannequin, dressed) to a unified body.

    blender -b -t 2 --factory-startup -P blender/unified_clothes.py -- \
        --clothes art/outputs/3d/clothes/commoner_f3.glb --style commoner \
        --body game/public/assets/models/units/human_f_base.glb --gender f \
        --out game/public/assets/models/items [--tris 16000] [--tex 1024] [--preview out.png]

unified_armor.py tailors outfits procedurally. This is the other route. The source is made in
three steps: render_mannequin.py renders the body as a green T-pose mannequin, an image-edit
model dresses that picture (art/tools/gen.py with "refs"), and image-to-3D turns the result into
a textured mesh (art/tools/i2m.py). Because the picture started from this body, the mesh already
has its pose and proportions; here it is only registered (height, arm line, span), the green
mannequin is keyed out, and what is left is skinned to the body's rig with the body's own
weights. The runtime hides the skin under an outfit, so a strip of the body's chest and neck is
added back as a `Skin_` patch that fills the neckline in the character's own skin colour.
Output: armor_<gender>_<style>.glb, the same kind of file unified_armor.py writes.
"""
import argparse
import os
import sys

import bmesh
import bpy
import numpy as np
from mathutils import Vector
from mathutils.bvhtree import BVHTree

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common as C
import rig_humanoid as RH
import unified_armor as UA


def arm_line(v):
    arm = v[np.abs(v[:, 0]) > .25]
    return float(np.median(arm[:, 2])), float(np.abs(v[:, 0]).max())


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--clothes', required=True); p.add_argument('--style', required=True)
    p.add_argument('--body', required=True); p.add_argument('--gender', choices=['m', 'f'], required=True)
    p.add_argument('--out', required=True)
    p.add_argument('--tris', type=int, default=16000); p.add_argument('--tex', type=int, default=1024)
    p.add_argument('--undersuit', help='R,G,B (sRGB 0..1): paint mannequin showing between armor pieces as an arming garment of this colour')
    p.add_argument('--collar', type=float, default=0, help='0..1: draw a loose collar in onto the neck and shoulders, and even out its cut edge')
    p.add_argument('--skirt', type=float, default=0, help='0..1: how much a long skirt below the hips hangs from the hips instead of following each leg')
    p.add_argument('--preview')
    a = p.parse_args(C.script_args())
    C.reset_scene()
    cloth = C.import_joined_mesh(os.path.abspath(a.clothes), name='Generated clothes')
    RH.orient_upright(cloth); RH.orient_facing(cloth); RH.normalize(cloth)
    C.decimate(cloth, a.tris)
    C.prepare_materials([cloth], a.tex, double_sided=True)

    bpy.ops.import_scene.gltf(filepath=os.path.abspath(a.body))
    arm = next(o for o in bpy.context.scene.objects if o.type == 'ARMATURE')
    arm.data.pose_position = 'REST'
    body = max((o for o in bpy.context.scene.objects if o.type == 'MESH' and any(m.type == 'ARMATURE' for m in o.modifiers)),
               key=lambda o: len(o.data.vertices))
    for o in list(bpy.context.scene.objects):
        if o not in (arm, body, cloth): bpy.data.objects.remove(o, do_unlink=True)
    bpy.context.view_layer.update()
    bv = np.array([tuple(body.matrix_world @ w.co) for w in body.data.vertices])

    # Register: same floor and crown, then the arm line, the span and the spine's depth.
    v = C.verts_np(cloth)
    (cz, cspan), (bz, bspan) = arm_line(v), arm_line(bv)
    # A loose sleeve hangs below the arm, so its middle is lower than the arm's: matching middles
    # would lift the whole garment off the shoulders. Match the tops instead, cloth just above skin.
    top = lambda pts: float(np.percentile(pts[(np.abs(pts[:, 0]) > .2) & (np.abs(pts[:, 0]) < .3) & (pts[:, 2] > .6)][:, 2], 97))
    v[:, 2] = np.interp(v[:, 2], [0, top(v), 1], [0, top(bv) + .004, bv[:, 2].max()])
    v[:, 0] *= bspan / cspan
    chest = lambda pts: pts[(np.abs(pts[:, 0]) < .05) & (np.abs(pts[:, 2] - (bz - .08)) < .02)]
    v[:, 1] += (chest(bv)[:, 1].max() - chest(v)[:, 1].max())            # backs together
    C.set_verts_np(cloth, v)

    # Key out the mannequin: its green is far from linen, olive wool and leather.
    colors = C.vertex_texture_colors(cloth)
    ratio = lambda k: (colors[:, 1] > .25) & (colors[:, 1] > colors[:, 0] * k) & (colors[:, 1] > colors[:, 2] * k)
    v = C.verts_np(cloth)
    # The mannequin is cut away where the body's own skin shows: the head and neck with whatever
    # chest the collar leaves open, and the hands with the wrist inside a cuff. Those are the green
    # areas connected to the head or to a hand. Green elsewhere (an armpit, a gap under a pauldron)
    # lies over skin the game hides: with --undersuit it is painted, otherwise cut as well.
    # Below the belt everything is clothing, and olive wool must not be mistaken for mannequin.
    candidate = ratio(1.22) & ((v[:, 2] > .56) | (np.abs(v[:, 0]) > .2))
    bm = bmesh.new(); bm.from_mesh(cloth.data); bm.verts.ensure_lookup_table(); bm.faces.ensure_lookup_table()
    green_faces = [f for f in bm.faces if any(candidate[w.index] for w in f.verts)]
    marked = {f.index for f in green_faces}; seen = set(); green = np.zeros(len(v), bool)
    for f in green_faces:
        if f.index in seen: continue
        stack = [f]; seen.add(f.index); island = []
        while stack:
            g = stack.pop(); island.append(g)
            for e in g.edges:
                for h in e.link_faces:
                    if h.index in marked and h.index not in seen: seen.add(h.index); stack.append(h)
        ids = {w.index for g in island for w in g.verts}
        pts = v[list(ids)]
        skin = (pts[:, 2] > bz + .05).any() or (np.abs(pts[:, 0]) > .40).any()
        legacy = not a.undersuit and ((pts[:, 2] > bz - .075) & (np.abs(pts[:, 0]) < .11)).any()
        if skin or legacy: green[[i for i in ids if candidate[i]]] = True
    bm.free()
    if a.undersuit:
        # Armor leaves gaps (armpits, elbows, hips) where the picture shows mannequin over skin the
        # game hides. Cutting them would open holes: paint them as the garment worn under armor.
        tint = np.array([float(x) for x in a.undersuit.split(',')], np.float32)
        for slot in cloth.material_slots:
            for node in slot.material.node_tree.nodes:
                if node.type != 'TEX_IMAGE' or not node.image: continue
                img = node.image; w, h = img.size
                px = np.array(img.pixels[:], np.float32).reshape(h, w, 4)
                mask = (px[..., 1] > .22) & (px[..., 1] > px[..., 0] * 1.45) & (px[..., 1] > px[..., 2] * 1.45)
                for _ in range(2):                                     # cover the blended fringe
                    grown = mask.copy()
                    grown[1:] |= mask[:-1]; grown[:-1] |= mask[1:]; grown[:, 1:] |= mask[:, :-1]; grown[:, :-1] |= mask[:, 1:]
                    mask = grown
                shade = np.clip(px[..., 1:2] / .7, .45, 1.15)
                px[..., :3] = np.where(mask[..., None], tint * shade, px[..., :3])
                img.pixels[:] = px.ravel(); img.update()
    # Where the mannequin's chest and neck showed is exactly where skin must be put back.
    opening = v[green & (v[:, 2] > bz - .09) & (v[:, 2] < bz + .06) & (np.abs(v[:, 0]) < .13)]
    bm = bmesh.new(); bm.from_mesh(cloth.data); bm.verts.ensure_lookup_table()
    bmesh.ops.delete(bm, geom=[f for f in bm.faces if any(green[w.index] for w in f.verts)], context='FACES')
    # Small tears the reconstruction left in the cloth (not the collar, cuffs or hems: those are long).
    bmesh.ops.holes_fill(bm, edges=[e for e in bm.edges if e.is_boundary], sides=10)
    bmesh.ops.delete(bm, geom=[w for w in bm.verts if not w.link_faces], context='VERTS')
    # ...and the crumbs the key leaves behind (fingers, an ear).
    bm.faces.ensure_lookup_table(); seen = set(); islands = []
    for f in bm.faces:
        if f.index in seen: continue
        stack = [f]; seen.add(f.index); island = []
        while stack:
            g = stack.pop(); island.append(g)
            for e in g.edges:
                for h in e.link_faces:
                    if h.index not in seen: seen.add(h.index); stack.append(h)
        islands.append(island)
    biggest = max(len(i) for i in islands)
    bmesh.ops.delete(bm, geom=[f for i in islands if len(i) < biggest * .01 for f in i], context='FACES')
    bmesh.ops.delete(bm, geom=[w for w in bm.verts if not w.link_faces], context='VERTS')
    bm.to_mesh(cloth.data); bm.free(); cloth.data.update()

    # Around the neck the cloth must sit outside the skin patch added below.
    tree = BVHTree.FromPolygons([Vector(q) for q in bv], [tuple(f.vertices) for f in body.data.polygons])
    v = C.verts_np(cloth); pushed = 0
    for i, co in enumerate(v):
        # ...and around the wrists outside the hand that comes out of the cuff.
        clear = .005 if (co[2] > bz - .14 and abs(co[0]) < .15) else .004 if abs(co[0]) > .30 else 0
        if not clear: continue
        loc, normal, _, dist = tree.find_nearest(Vector(co))
        if loc is not None and (Vector(co) - loc).dot(normal) < clear:
            v[i] = np.array(loc + normal * clear); pushed += 1
    C.set_verts_np(cloth, v)
    if a.collar > 0:
        # A scooped collar stands off the neck, and its rim is where the mannequin was cut away, so
        # it is jagged. Lay a band along the rim down onto the skin, most at the rim itself, and
        # relax the rim along its own length.
        bm = bmesh.new(); bm.from_mesh(cloth.data); bm.verts.ensure_lookup_table()
        zone = lambda co: co.z > bz - .09 and abs(co.x) < .13
        rim = [w for w in bm.verts if w.is_boundary and zone(w.co)]
        if rim:
            from mathutils.kdtree import KDTree as KD2
            edge = KD2(len(rim))
            for i, w in enumerate(rim): edge.insert(w.co, i)
            edge.balance()
            for _ in range(6):
                moved = {}
                for w in rim:
                    along = [e.other_vert(w).co for e in w.link_edges if e.is_boundary]
                    if len(along) == 2: moved[w] = w.co.lerp((along[0] + along[1]) / 2, .5)
                for w, co in moved.items(): w.co = co
            band = .035
            for w in bm.verts:
                if not zone(w.co): continue
                d = edge.find(w.co)[2]
                if d > band: continue
                loc, normal, _, dist = tree.find_nearest(w.co)
                if loc is None: continue
                k = a.collar * (1 - d / band) ** 1.5
                w.co = w.co.lerp(loc + normal * .004, k)
        bm.to_mesh(cloth.data); bm.free(); cloth.data.update()
    C.shade(cloth, 'smooth')

    tailor = UA.Tailor(body, arm)
    # Weights come from the nearest skin, except along the arms: a wide sleeve hangs closer to the
    # ribs or the hip than to the arm it belongs to, and would stay behind when the arm comes down.
    # Beyond the shoulder only the arm's own skin is consulted.
    from mathutils.kdtree import KDTree
    meta_path = os.path.splitext(os.path.abspath(a.body))[0] + '.meta.json'
    shoulder = .08
    if os.path.exists(meta_path):
        import json
        shoulder = float(json.load(open(meta_path)).get('landmarks', {}).get('xs', shoulder))
    arms = [i for i, q in enumerate(tailor.points) if abs(q[0]) > shoulder - .01 and q[2] > bz - .07]
    arm_tree = KDTree(len(arms))
    for i in arms: arm_tree.insert(Vector(tailor.points[i]), i)
    arm_tree.balance()

    def totals(tree, co):
        out = {}
        for _, index, distance in tree.find_n(co, 3):
            factor = 1 / max(distance, .0005) ** 2
            for name, value in tailor.weights[index]: out[name] = out.get(name, 0) + value * factor
        total = sum(out.values()) or 1
        return {k: x / total for k, x in out.items()}
    # ...but a skirt flaring wider than the shoulders is not a sleeve: the rule holds only above
    # the hips and outside the torso's own outline at that height.
    column = tailor.points[np.abs(tailor.points[:, 0]) < .16]
    hip_z = float(np.percentile(tailor.points[np.abs(tailor.points[:, 0]) < .012][:, 2], 2)) + .04
    def outline(z):
        ring = column[(np.abs(column[:, 2] - z) < .012) & (column[:, 2] < bz - .05)]
        return float(np.abs(ring[:, 0]).max()) if len(ring) else shoulder
    cloth.vertex_groups.clear(); groups = {}
    for w in cloth.data.vertices:
        t = min(1, max(0, (abs(w.co.x) - shoulder) / .04))
        if w.co.z < bz - .05:
            t = min(t, max(0, (abs(w.co.x) - outline(w.co.z) - .015) / .03), max(0, (w.co.z - hip_z) / .04))
        mix = {}
        if t < 1:
            for k, x in totals(tailor.tree, w.co).items(): mix[k] = mix.get(k, 0) + x * (1 - t)
        if t > 0:
            for k, x in totals(arm_tree, Vector((w.co.x, w.co.y, max(w.co.z, bz - .05)))).items(): mix[k] = mix.get(k, 0) + x * t
        best = sorted(mix.items(), key=lambda item: -item[1])[:4]
        total = sum(x for _, x in best) or 1
        for k, x in best:
            if k not in groups: groups[k] = cloth.vertex_groups.new(name=k)
            groups[k].add([w.index], x / total, 'REPLACE')
    if a.skirt > 0:
        # A robe's skirt weighted to the nearest leg splits like trousers; hung only from the hips
        # it would glide. Mix the two, more hips toward the middle where the legs would tear it.
        hips = cloth.vertex_groups.get('hips') or cloth.vertex_groups.new(name='hips')
        legs = [g.index for g in cloth.vertex_groups if g.name.split('.')[0] in ('thigh', 'shin', 'foot')]
        crotch = float(np.percentile(bv[np.abs(bv[:, 0]) < .012][:, 2], 2)) if (np.abs(bv[:, 0]) < .012).any() else .5
        for w in cloth.data.vertices:
            if w.co.z > crotch + .05: continue
            k = a.skirt * min(1, (crotch + .05 - w.co.z) / .08) * (1 - .5 * min(1, abs(w.co.x) / .08))
            moved = 0
            for g in w.groups:
                if g.group in legs: moved += g.weight * k; g.weight *= 1 - k
            if moved: hips.add([w.index], moved + next((g.weight for g in w.groups if g.group == hips.index), 0), 'REPLACE')
    UA.armature_bind(cloth, arm)

    # The neckline: the body's own upper chest, shoulders and nape, in the character's skin.
    patch = body.copy(); patch.data = body.data.copy(); patch.name = 'Neckline skin'
    bpy.context.scene.collection.objects.link(patch)
    if patch.data.shape_keys: patch.shape_key_clear()
    keep = {f.index for f in body.data.polygons
            if f.center.z > bz - .075 and abs(f.center.x) < .11 and UA.region(body, f) not in ('head', 'hands')}
    bm = bmesh.new(); bm.from_mesh(patch.data); bm.faces.ensure_lookup_table()
    bmesh.ops.delete(bm, geom=[f for f in bm.faces if f.index not in keep], context='FACES')
    bmesh.ops.delete(bm, geom=[w for w in bm.verts if not w.link_faces], context='VERTS')
    # Only where the collar is actually open (where mannequin showed), plus a margin: skin kept
    # under cloth would poke through it in motion, the two being weighted from different neighbours.
    from mathutils.kdtree import KDTree as KD
    gap = KD(max(1, len(opening)))
    for i, q in enumerate(opening): gap.insert(Vector(q), i)
    gap.balance()
    bm.faces.ensure_lookup_table()
    covered = [f for f in bm.faces if not len(opening) or gap.find(f.calc_center_median())[2] > .014]
    bmesh.ops.delete(bm, geom=covered, context='FACES')
    bmesh.ops.delete(bm, geom=[w for w in bm.verts if not w.link_faces], context='VERTS')
    bm.normal_update()
    for w in bm.verts: w.co -= w.normal * .0015
    bm.to_mesh(patch.data); bm.free(); patch.data.update()
    skin = bpy.data.materials.new('Skin_neckline'); skin.use_nodes = True
    skin.node_tree.nodes['Principled BSDF'].inputs['Roughness'].default_value = .73
    patch.data.materials.clear(); patch.data.materials.append(skin)
    for f in patch.data.polygons: f.material_index = 0; f.use_smooth = True
    for layer in list(patch.data.color_attributes): patch.data.color_attributes.remove(layer)
    UA.armature_bind(patch, arm)

    # A lining: the hidden skin itself, drawn in a little and coloured like the cloth nearest to it.
    # The reconstruction only models what the picture showed, so a garment is open under a
    # pauldron, inside a collar or where it tore; without this one would look into a hollow figure.
    lining = body.copy(); lining.data = body.data.copy(); lining.name = 'Lining'
    bpy.context.scene.collection.objects.link(lining)
    if lining.data.shape_keys: lining.shape_key_clear()
    hidden = {f.index for f in body.data.polygons if UA.region(body, f) not in ('head', 'hands')}
    bm = bmesh.new(); bm.from_mesh(lining.data); bm.faces.ensure_lookup_table()
    bmesh.ops.delete(bm, geom=[f for f in bm.faces if f.index not in hidden], context='FACES')
    bmesh.ops.delete(bm, geom=[w for w in bm.verts if not w.link_faces], context='VERTS')
    bm.normal_update()
    for w in bm.verts: w.co -= w.normal * .003
    bm.to_mesh(lining.data); bm.free(); lining.data.update()
    for mod in list(lining.modifiers): lining.modifiers.remove(mod)
    C.decimate(lining, 5000)
    for layer in list(lining.data.color_attributes): lining.data.color_attributes.remove(layer)
    shades = C.vertex_texture_colors(cloth)
    near = KDTree(len(cloth.data.vertices))
    for w in cloth.data.vertices: near.insert(w.co, w.index)
    near.balance()
    attr = lining.data.color_attributes.new(name='Lining', type='FLOAT_COLOR', domain='POINT')
    for w in lining.data.vertices:
        c = np.clip(shades[near.find(w.co)[1]], 0, 1) ** 2.2 * .7           # sRGB texel -> linear, in shade
        attr.data[w.index].color = (*c, 1)
    inner = bpy.data.materials.new('Armor_lining'); inner.use_nodes = True
    shader = inner.node_tree.nodes['Principled BSDF']; shader.inputs['Roughness'].default_value = .9
    node = inner.node_tree.nodes.new('ShaderNodeVertexColor'); node.layer_name = 'Lining'
    inner.node_tree.links.new(node.outputs['Color'], shader.inputs['Base Color'])
    lining.data.materials.clear(); lining.data.materials.append(inner)
    for f in lining.data.polygons: f.material_index = 0; f.use_smooth = True
    UA.armature_bind(lining, arm)

    os.makedirs(a.out, exist_ok=True)
    path = os.path.abspath(os.path.join(a.out, f'armor_{a.gender}_{a.style}.glb'))
    tris = UA.export(body, arm, path)
    C.log('Generated clothes fitted', a.style, tris, 'tris,', pushed, 'vertices cleared of the neck,', path)
    if a.preview: UA.preview(body, arm, a.preview)


if __name__ == '__main__': main()
