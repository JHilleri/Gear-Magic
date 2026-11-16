"""Author the stylized character regalia. No input assets are changed.

blender -b -t 2 --factory-startup -P blender/character_regalia.py -- --out game/public/assets/models/characters

The pauldron is centred on a shoulder: glTF +X points outward, +Y up,
+Z forward. Mirror X for the opposite shoulder. All distances are relative
to the game's 1.0-high human. The original .blend is retained for artists.
"""
import argparse
import math
import os
import sys

import bpy
from mathutils import Vector


def material(name, colour, metal=0.0, rough=0.4):
    m = bpy.data.materials.new(name)
    m.diffuse_color = (*colour, 1)
    m.use_nodes = True
    p = m.node_tree.nodes.get('Principled BSDF')
    p.inputs['Base Color'].default_value = (*colour, 1)
    p.inputs['Metallic'].default_value = metal
    p.inputs['Roughness'].default_value = rough
    return m


def mesh(name, verts, faces, mat, bevel=0):
    data = bpy.data.meshes.new(name)
    # Authors use the game's XYZ convention, convert to Blender XYZ for glTF export.
    data.from_pydata([(x, -z, y) for x, y, z in verts], [], faces)
    data.update()
    obj = bpy.data.objects.new(name, data)
    bpy.context.collection.objects.link(obj)
    obj.data.materials.append(mat)
    if bevel:
        mod = obj.modifiers.new('Forged edge radius', 'BEVEL')
        mod.width = bevel
        mod.segments = 3
        mod.affect = 'EDGES'
        mod2 = obj.modifiers.new('Weighted face normals', 'WEIGHTED_NORMAL')
        mod2.keep_sharp = True
    return obj


def tube(name, points, radius, mat, sides=8):
    pts = [Vector(p) for p in points]
    verts, faces = [], []
    for i, p in enumerate(pts):
        tangent = (pts[min(i + 1, len(pts) - 1)] - pts[max(0, i - 1)]).normalized()
        reference = Vector((0, 1, 0)) if abs(tangent.y) < .9 else Vector((0, 0, 1))
        u = tangent.cross(reference).normalized()
        v = tangent.cross(u).normalized()
        for j in range(sides):
            a = 2 * math.pi * j / sides
            verts.append(tuple(p + radius * (math.cos(a) * u + math.sin(a) * v)))
    for i in range(len(pts) - 1):
        for j in range(sides):
            a, b = i * sides + j, i * sides + (j + 1) % sides
            faces.append((a, b, b + sides, a + sides))
    faces.extend([tuple(reversed(range(sides))), tuple((len(pts)-1)*sides+j for j in range(sides))])
    obj = mesh(name, verts, faces, mat)
    for face in obj.data.polygons:
        face.use_smooth = True
    return obj


def rivet(name, point, radius, mat):
    x, y, z = point
    bpy.ops.mesh.primitive_uv_sphere_add(segments=12, ring_count=8, radius=radius, location=(x, -z, y))
    obj = bpy.context.object
    obj.name = name
    obj.data.materials.append(mat)
    for face in obj.data.polygons:
        face.use_smooth = True
    return obj


def shell(name, centre, radii, start, end, mat, trim, rings=12, sectors=32):
    """Open-backed forged shell, with a real rolled lip and thickness."""
    cx, cy, cz = centre
    rx, ry, rz = radii
    verts, faces = [], []
    for i in range(rings + 1):
        theta = start + (end - start) * i / rings
        for j in range(sectors + 1):
            phi = 2 * math.pi * j / sectors
            verts.append((cx + rx * math.sin(theta)*math.cos(phi), cy + ry*math.cos(theta), cz + rz*math.sin(theta)*math.sin(phi)))
    for i in range(rings):
        for j in range(sectors):
            a = i * (sectors+1) + j
            faces.append((a, a+sectors+1, a+sectors+2, a+1))
    obj = mesh(name, verts, faces, mat)
    for face in obj.data.polygons:
        face.use_smooth = True
    solid = obj.modifiers.new('Plate thickness', 'SOLIDIFY')
    solid.thickness = .003
    bevel = obj.modifiers.new('Soft forged edge', 'BEVEL')
    bevel.width = .001
    bevel.segments = 2
    for angle, label in [(start, 'upper'), (end, 'lower')]:
        points = [(cx+rx*math.sin(angle)*math.cos(2*math.pi*j/sectors), cy+ry*math.cos(angle), cz+rz*math.sin(angle)*math.sin(2*math.pi*j/sectors)) for j in range(sectors+1)]
        tube(f'{name} {label} gold welt', points, .0022, trim)
    return obj


def shield_gem(name, centre, size, gold, gem):
    x, y, z = centre
    w, h, depth = size
    outline = [(-.56, .45), (0, .68), (.56, .45), (.47, -.2), (0, -.72), (-.47, -.2)]
    verts = [(x+u*w, y+v*h, z) for u,v in outline]
    verts.append((x, y, z+depth))
    mesh(name+' gold setting', verts, [(i, (i+1)%6, 6) for i in range(6)], gold, .001)
    verts = [(x+u*w*.75, y+v*h*.75, z+depth*.4) for u,v in outline]
    verts.append((x, y, z+depth*1.5))
    mesh(name+' cut sapphire', verts, [(i,(i+1)%6,6) for i in range(6)], gem)


def pauldron(gold, steel, dark, gem):
    # Three independently articulated-looking lames: strong crown, tapered lower edge.
    shell('Crown', (.016, .017, 0), (.102,.070,.090), .10, 1.43, steel, gold)
    shell('Middle lame', (.025, -.012, 0), (.095,.056,.083), .55, 1.52, dark, gold)
    shell('Lower lame', (.032, -.037, 0), (.079,.039,.072), .55, 1.56, steel, gold)
    # Crest ridge shaped like a stylized eagle feather, with a thick gold border.
    outline = [(-.055,.085),(-.013,.100),(.032,.085),(.085,.044),(.067,.038),(.019,.071),(-.018,.082)]
    verts = [(x,y,z) for z in [-.008,.008] for x,y in outline]
    n=len(outline)
    faces=[tuple(reversed(range(n))),tuple(range(n,n*2))]+[(i,(i+1)%n,(i+1)%n+n,i+n) for i in range(n)]
    mesh('Raised crest',verts,faces,gold,.0017)
    shield_gem('House sapphire', (.018,.025,.086), (.058,.061,.006),gold,gem)
    # Swept relief branches on both faces, hand-authored curves rather than a flat decal.
    for front in [-1,1]:
        for sign in [-1,1]:
            points=[]
            for i in range(17):
                t=i/16
                points.append((.016+sign*(.02+.040*t),.035+.017*math.sin(t*math.pi),front*(.084-.014*t)))
            tube('Relief scroll',points,.0016,gold)
            for j in range(3):
                x=.016+sign*(.033+j*.01)
                tube('Relief feather',[(x,.043,front*.08),(x+sign*.004,.052,front*.074),(x+sign*.007,.053,front*.072)],.0012,gold)
    for x in [-.057,.071]:
        for z in [-.051,.051]:
            rivet('Domed brass rivet',(x,.039,z),.0038,gold)


def export_asset(out, name):
    bpy.ops.object.select_all(action='DESELECT')
    depsgraph = bpy.context.evaluated_depsgraph_get()
    for obj in bpy.context.scene.objects:
        if obj.type!='MESH': continue
        if obj.modifiers:
            obj.data = bpy.data.meshes.new_from_object(obj.evaluated_get(depsgraph))
            obj.modifiers.clear()
        obj.select_set(True)
        bpy.context.view_layer.objects.active = obj
    # Merge by material at export: four draw calls instead of one for every rivet/scroll.
    bpy.ops.object.join()
    bpy.context.object.name = name
    bpy.ops.export_scene.gltf(filepath=os.path.join(out,name+'.glb'),export_format='GLB',use_selection=True,export_apply=True,export_animations=False,export_yup=True)


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--out', required=True)
    parser.add_argument('--source', default=os.path.join(os.path.dirname(__file__), 'regalia-source.blend'))
    args=parser.parse_args(sys.argv[sys.argv.index('--')+1:])
    out=os.path.abspath(args.out)
    os.makedirs(out,exist_ok=True)
    bpy.ops.object.select_all(action='SELECT')
    bpy.ops.object.delete(use_global=False)
    gold=material('Antique brass · warm edge',(.63,.34,.095),.78,.31)
    steel=material('Blue steel · enamel',(.065,.14,.245),.72,.32)
    dark=material('Midnight steel · recessed',(.025,.052,.088),.65,.39)
    gem=material('Sapphire · faceted',(.025,.29,.65),.4,.19)
    pauldron(gold,steel,dark,gem)
    bpy.context.scene['asset_contract']='Shoulder centre; glTF +X outward +Y up +Z forward; height 1 human; mirror X for right shoulder.'
    bpy.ops.wm.save_as_mainfile(filepath=os.path.abspath(args.source))
    export_asset(out,'pauldron_plate')
    print('REGALIA_EXPORTED',out)


if __name__=='__main__': main()
