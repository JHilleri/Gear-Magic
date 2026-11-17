"""Continuous human base: shared skin, real eye apertures, face morphs, and no neck splice.

blender -b -t 2 -P blender/unified_body.py -- --input art/outputs/unified/male-rigged.glb --gender m

Inputs are newly reconstructed full-body T-poses, already rigged by rig_humanoid.py.
Output geometry is one connected body/head surface, with material regions for hiding
skin underneath attachments. Smooth, non-detailed anatomy is retained at the pelvis.
No old separate head meshes, shader irises, or armor-body replacements are used.
"""
import argparse
import json
import math
import os
import sys
from pathlib import Path

import bpy
import bmesh
import numpy as np
from mathutils import Vector
from mathutils.bvhtree import BVHTree

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common as C
import head_frame as HF

ROOT = Path(__file__).resolve().parents[1]


def material(name, color=(1, 1, 1), rough=.7, vertices=False):
    mat = bpy.data.materials.new(name)
    mat.diffuse_color = (*color, 1)
    mat.use_nodes = True
    shader = mat.node_tree.nodes.get('Principled BSDF')
    shader.inputs['Base Color'].default_value = (*color, 1)
    shader.inputs['Roughness'].default_value = rough
    if vertices:
        node = mat.node_tree.nodes.new('ShaderNodeVertexColor')
        node.layer_name = 'SkinDetail'
        mat.node_tree.links.new(node.outputs['Color'], shader.inputs['Base Color'])
    return mat


def skin_region(p):
    x, _, z = p
    if z > .89 or (z > .85 and abs(x) < .07) or (z > .82 and abs(x) < .060): return 'head'
    if z > .68 and abs(x) > .135:
        if abs(x) > .365: return 'hands'
        return 'forearm' if abs(x) > .265 else 'upperarm'
    if z < .22: return 'feet'
    if z < .51: return 'legs'
    return 'torso'


def eye_apertures(obj, head, gender, drop=None):
    """Cut actual almond openings and fit globe centres behind the intact face surface."""
    depth = head['depth']
    top = head['y']
    cx = head['x']
    # Source front renders show the eyes at roughly .60 skull depths under the crown.
    eye_z = top - depth * (drop if drop is not None else .60 if gender == 'm' else .58)
    half_spacing = depth * .165
    width, height = depth * .061, depth * .020
    radius = depth * .10
    bm = bmesh.new(); bm.from_mesh(obj.data)
    bm.verts.ensure_lookup_table(); bm.faces.ensure_lookup_table()
    tree = BVHTree.FromBMesh(bm)
    positions = []
    for side in [-1, 1]:
        x = cx + side * half_spacing
        hit = tree.ray_cast(Vector((x, -1, eye_z)), Vector((0, 1, 0)))
        if hit[0] is None: raise RuntimeError('Could not locate eye surface')
        positions.append((x, hit[0].y, eye_z))
    # More geometry only around the apertures, so the lid contour can be continuous.
    selected = []
    for edge in bm.edges:
        p = (edge.verts[0].co + edge.verts[1].co) * .5
        if any(abs(p.x-x)<width*1.65 and abs(p.z-z)<height*2.4 and abs(p.y-y)<.014 for x,y,z in positions):
            selected.append(edge)
    bmesh.ops.subdivide_edges(bm, edges=selected, cuts=3, use_grid_fill=True)
    remove = []
    for face in bm.faces:
        p = face.calc_center_median()
        for x,y,z in positions:
            if abs(p.y-y)<.012 and ((p.x-x)/width)**2 + ((p.z-z)/height)**2 < .88:
                remove.append(face); break
    bmesh.ops.delete(bm, geom=remove, context='FACES')
    # Project the newly opened rim onto a smooth oval. It remains part of the full body.
    for vert in bm.verts:
        if not vert.is_boundary: continue
        p=vert.co
        for x,y,z in positions:
            q=Vector(((p.x-x)/width, (p.z-z)/height))
            if abs(p.y-y)<.014 and .45 < q.length < 1.65:
                q.normalize()
                p.x=x+q.x*width
                p.z=z+q.y*height
                # Preserve the original depth/curvature of the actual upper/lower lid.
                break
    eyes=[]
    for x,y,z in positions:
        # Fit the globe behind the complete lid, not just one centre ray. The
        # reconstructed socket can be several millimetres deeper at one corner.
        rim=[v for v in bm.verts if v.is_boundary and abs(v.co.y-y)<.018 and abs(v.co.x-x)<width*1.05 and abs(v.co.z-z)<height*1.05]
        globe_z=z+depth*.0035
        behind=lambda verts,r:max((v.co.y+math.sqrt(max(0,r*r-(v.co.x-x)**2-(v.co.z-globe_z)**2)) for v in verts),default=y+r)
        # The globe must also stay under the skin around the opening. Where the cheek or brow is
        # flatter than a full-size globe, the white would show through below the eye: use a
        # smaller globe there, never one pushed far behind the lids.
        for scale in (.10,.09,.08,.07,.06,.05):
            radius=depth*scale
            skin=[v for v in bm.verts if not v.is_boundary and abs(v.co.y-y)<.03 and (v.co.x-x)**2+(v.co.z-globe_z)**2<radius*radius]
            center_y=behind(rim,radius)
            if behind(skin,radius)-center_y<.0004:break
        center_y=max(center_y,behind(skin,radius))+.00025
        eyes.append({'center':[round(x,6),round(globe_z,6),round(-center_y,6)],
                     'radius':round(radius,6),'irisRadius':round(width*.43,6),
                     'aperture':[round(width,6),round(height,6)]})
    bmesh.ops.recalc_face_normals(bm, faces=list(bm.faces))
    bm.to_mesh(obj.data); bm.free(); obj.data.update()
    return eyes


def refine_face(obj, head, passes=12):
    """Relax reconstruction noise locally, keeping the scalp, neck and equipment fit fixed."""
    bm=bmesh.new();bm.from_mesh(obj.data)
    front=head['depth']*.40-head['z']
    edges=[e for e in bm.edges if all(v.co.z>.878 and v.co.z<head['y']-.012 and v.co.y<-front for v in e.verts)]
    bmesh.ops.subdivide_edges(bm,edges=edges,cuts=1,use_grid_fill=True)
    verts=[v for v in bm.verts if .884<v.co.z<head['y']-.019 and v.co.y<-front-.002]
    # Preserve the central nose/lip profile while softening planar cheek and brow noise.
    central=[v for v in verts if abs(v.co.x-head['x'])<.012 and v.co.z<head['y']-head['depth']*.55]
    soft=[v for v in verts if v not in central]
    for _ in range(passes):
        bmesh.ops.smooth_vert(bm,verts=soft,factor=.37,use_axis_x=True,use_axis_y=True,use_axis_z=True)
        bmesh.ops.smooth_vert(bm,verts=central,factor=.12,use_axis_x=True,use_axis_y=True,use_axis_z=True)
    bmesh.ops.recalc_face_normals(bm,faces=list(bm.faces))
    bm.to_mesh(obj.data);bm.free();obj.data.update()


def brow_mesh(arm, body, head, eyes):
    verts=[]; faces=[]
    depth=head['depth']
    tree=BVHTree.FromPolygons([v.co for v in body.data.vertices], [list(p.vertices) for p in body.data.polygons])
    for eye in eyes:
        x,z,forward = eye['center']
        for strand in range(3):
            for i in range(19):
                t=i/18
                xx=x+(t-.5)*depth*.16
                zz=z+depth*.080+math.sin(math.pi*t)*depth*.019+strand*.00035
                hit=tree.ray_cast(Vector((xx,-1,zz)),Vector((0,1,0)))[0]
                yy=(hit.y if hit else -forward-eye['radius'])-.0007
                radius=.00025*(math.sin(math.pi*t)*.75+.25)
                for j in range(4):
                    angle=2*math.pi*j/4
                    verts.append((xx,yy+math.cos(angle)*radius,zz+math.sin(angle)*radius))
            start=len(verts)-19*4
            for i in range(18):
                for j in range(4):
                    a=start+i*4+j; b=start+i*4+(j+1)%4
                    faces.append((a,b,b+4,a+4))
    mesh=bpy.data.meshes.new('Natural brows');mesh.from_pydata(verts,[],faces);mesh.update()
    obj=bpy.data.objects.new('Brows',mesh);bpy.context.scene.collection.objects.link(obj)
    obj.data.materials.append(material('Brows',(.065,.035,.018),.82))
    group=obj.vertex_groups.new(name='head');group.add(list(range(len(verts))),1,'REPLACE')
    mod=obj.modifiers.new('Shared character rig','ARMATURE');mod.object=arm
    obj.parent=arm
    for face in mesh.polygons: face.use_smooth=True
    return obj


def prepare_skin(obj, head):
    """Normalize the reference's skin/suit color into a single material response."""
    colors=C.vertex_texture_colors(obj)
    positions=C.verts_np(obj)
    obj.data.materials.clear()
    regions=['head','torso','upperarm','forearm','hands','legs','feet']
    for name in regions:obj.data.materials.append(material('Skin_'+name,vertices=True))
    for face in obj.data.polygons:
        p=np.mean(positions[list(face.vertices)],axis=0)
        face.material_index=regions.index(skin_region(p))
        face.use_smooth=True
    attr=obj.data.color_attributes.new(name='SkinDetail',type='FLOAT_COLOR',domain='POINT')
    cheek=(positions[:,2]>head['y']-head['depth']*1.05)&(positions[:,2]<head['y']-head['depth']*.78)&(np.abs(positions[:,0])>.017)&(np.abs(positions[:,0])<.036)&(positions[:,1]<-.025)
    reference=np.maximum(np.median(colors[cheek],axis=0),.04) if colors is not None and cheek.any() else np.array([.6,.45,.35])
    for i,p in enumerate(positions):
        detail=np.ones(3)
        if colors is not None and p[2] > .87:
            c=np.maximum(colors[i], .025)
            # Preserve lip/nasal color detail while using the same tint on face and body.
            detail=np.clip((c/reference)**.85,.25,1.04)
            fade=np.clip((p[2]-.87)/.025,0,1)
            detail=1+(detail-1)*fade
            # Painted source brows become fitted geometry, colored with the selected hair.
            if abs(p[2]-(head['y']-.50*head['depth']))<.010 and abs(p[0])<.046:
                detail=np.ones(3)*.98
        attr.data[i].color=(*detail,1)


def face_morphs(obj, head):
    obj.shape_key_add(name='Basis',from_mix=False)
    top,depth=head['y'],head['depth']
    for name,kind in [('face_1',1),('face_2',2)]:
        key=obj.shape_key_add(name=name,from_mix=False)
        key.value=0
        for base,vert in zip(obj.data.vertices,key.data):
            p=base.co
            h=(top-p.z)/depth
            if not .45<h<1.32 or p.y > -.02:continue
            # Jaw/cheek changes fade out well above the continuous neck and around the fixed eyes.
            jaw=math.exp(-((h-1.0)/.24)**2)
            side=abs(p.x)/max(.01,depth*.4)
            factor=1.0+(.07 if kind==1 else -.07)*jaw
            vert.co.x=p.x*factor
            vert.co.z=p.z+(-.0018 if kind==2 else .0006)*jaw*(1-min(1,side))
            vert.co.y=p.y+(.001 if kind==1 else -.001)*jaw


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--input',required=True)
    parser.add_argument('--gender',choices=['m','f'],required=True)
    parser.add_argument('--out')
    parser.add_argument('--eye-drop',type=float,help='eye line, in skull depths under the crown (default .60 m / .58 f)')
    parser.add_argument('--face-relax',type=int,default=12,help='face smoothing passes; lower for an already smooth source')
    a=parser.parse_args(sys.argv[sys.argv.index('--')+1:])
    src=Path(a.input).resolve()
    dst=Path(a.out or ROOT/f'game/public/assets/models/units/human_{a.gender}_base.glb').resolve()
    C.reset_scene()
    bpy.ops.import_scene.gltf(filepath=str(src))
    arm=next(o for o in bpy.context.scene.objects if o.type=='ARMATURE')
    obj=max((o for o in bpy.context.scene.objects if o.type=='MESH' and o.material_slots),key=lambda o:len(o.data.vertices))
    for o in list(bpy.context.scene.objects):
        if o.type=='MESH' and o!=obj:bpy.data.objects.remove(o,do_unlink=True)
    bpy.context.view_layer.update()
    obj.name='Body';obj.data.name='Continuous body and head'
    # Imported glTF corner normals must not survive topology edits. Blender can
    # otherwise associate them with different loops after the eye apertures are cut.
    C.shade(obj, 'smooth')
    arm.data.pose_position='REST';bpy.context.view_layer.update()
    meta=json.loads(src.with_suffix('.meta.json').read_text())
    positions=C.verts_np(obj)
    cx,top,back,depth,hh=HF.frame(positions,meta['landmarks'].get('zn',.86))
    head={'x':float(cx),'y':float(top),'z':float(-back),'depth':float(depth)}
    # glTF duplicates vertices at UV seams. Weld coincident geometry before any
    # smoothing, preserving per-loop UVs. Otherwise seam vertices move apart and
    # imported split normals become visible as cracks/facets after a topology edit.
    bm=bmesh.new();bm.from_mesh(obj.data)
    bmesh.ops.remove_doubles(bm,verts=list(bm.verts),dist=.00001)
    collar=[v for v in bm.verts if .845<v.co.z<.884 and abs(v.co.x)<.075]
    for _ in range(4):bmesh.ops.smooth_vert(bm,verts=collar,factor=.45,use_axis_x=True,use_axis_y=True,use_axis_z=True)
    bm.to_mesh(obj.data);bm.free()
    refine_face(obj,head,a.face_relax)
    eyes=eye_apertures(obj,head,a.gender,a.eye_drop)
    prepare_skin(obj,head)
    C.shade(obj, 'smooth')
    face_morphs(obj,head)
    brow_mesh(arm,obj,head,eyes)
    arm.data.pose_position='POSE'
    C.purge_orphans()
    C.export_glb(str(dst),animations=True,skins=True,quality=92,
                 extra=dict(export_animation_mode='ACTIONS',export_rest_position_armature=False,
                            export_force_sampling=True,export_def_bones=False,export_leaf_bone=False,
                            export_morph=True,export_morph_normal=True,export_morph_animation=False))
    meta['head']=head
    meta['unified']={'version':2,'eyes':eyes,'hairPrefix':f'unified_{a.gender}_'}
    meta['continuous_body']=True
    meta['source_reference']=f'art/assets/unified/{"male" if a.gender=="m" else "female"}-reference.png'
    dst.with_suffix('.meta.json').write_text(json.dumps(meta,indent=1)+'\n')
    print('UNIFIED_BODY',dst,json.dumps(meta['unified']))


if __name__=='__main__':main()
