"""Fit skinned outfits directly to one continuous body; never ship another body/head.

blender -b -t 2 -P blender/unified_armor.py -- --body BODY.glb --gender m --out DIR

The source rig, inverse binds and weight names are retained. Visible garments
have clean tailored topology and every ornament uses that same armature.
No generated source character, texture or original outfit is modified.
"""
import argparse
import json
import math
import os
import sys

import bpy
import bmesh
import numpy as np
from mathutils import Matrix, Vector
from mathutils.kdtree import KDTree

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common as C


def args():
    p = argparse.ArgumentParser()
    p.add_argument('--body', required=True)
    p.add_argument('--gender', choices=['m', 'f'], required=True)
    p.add_argument('--out', required=True)
    p.add_argument('--styles', default='tunic,leather,plate,robe')
    p.add_argument('--preview', help='Render the final outfit to this PNG (one style per run).')
    return p.parse_args(C.script_args())


def mat(name, color, metal=0, rough=.7, texture=None):
    m = bpy.data.materials.new(name)
    m.diffuse_color = (*color, 1)
    m.use_nodes = True
    bs = m.node_tree.nodes.get('Principled BSDF')
    bs.inputs['Base Color'].default_value = (*color, 1)
    bs.inputs['Metallic'].default_value = metal
    bs.inputs['Roughness'].default_value = rough
    if texture:
        n = m.node_tree.nodes.new('ShaderNodeTexImage')
        n.image = texture
        m.node_tree.links.new(n.outputs['Color'], bs.inputs['Base Color'])
        if 'leather' in name:
            # A real tangent-space texture survives export; shader-only Noise
            # and Bump nodes would disappear in the game.
            rng=np.random.default_rng(821)
            height=rng.random((256,256))
            height=(height+np.roll(height,1,0)+np.roll(height,1,1))/3
            dx=np.roll(height,1,1)-np.roll(height,-1,1)
            dy=np.roll(height,1,0)-np.roll(height,-1,0)
            normal=np.stack((dx*.45,dy*.45,np.ones_like(dx)),axis=-1)
            normal/=np.linalg.norm(normal,axis=-1,keepdims=True)
            pixels=np.ones((256,256,4),dtype=np.float32);pixels[:,:,:3]=normal*.5+.5
            image=bpy.data.images.new(name+' leather normal',256,256,alpha=False)
            image.colorspace_settings.name='Non-Color';image.pixels=pixels.ravel();image.pack()
            tex=m.node_tree.nodes.new('ShaderNodeTexImage');tex.image=image
            nm=m.node_tree.nodes.new('ShaderNodeNormalMap');nm.inputs['Strength'].default_value=.65
            m.node_tree.links.new(tex.outputs['Color'],nm.inputs['Color'])
            m.node_tree.links.new(nm.outputs['Normal'],bs.inputs['Normal'])
    return m


def grain(name, color, seed=16, textile=False):
    """An actual embedded image, so grain survives glTF export without node baking."""
    rng = np.random.default_rng(seed)
    n = 256
    yy, xx = np.mgrid[0:n, 0:n]
    small = rng.normal(0, .03 if textile else .025, (n, n))
    if textile:
        detail = .94 + small + .026*np.sin(xx*math.pi)*np.cos(yy*math.pi)
    else:
        pits = (rng.random((n, n)) > .986) * .17
        detail = .98 + small - pits
    image = bpy.data.images.new(name, n, n, alpha=True)
    pixels = np.ones((n, n, 4), dtype=np.float32)
    pixels[:, :, :3] = np.clip(np.asarray(color)[None,None,:]*detail[:,:,None], 0, 1)
    image.pixels = pixels.ravel()
    image.pack()
    return image


def materials(style):
    # Linear albedos: leather is dark, with a readable satin highlight rather than plastic.
    brass = mat('Armor_antique_brass', (.40,.22,.065), .72, .35)
    dark = mat('Armor_dark_leather', (.045,.025,.016), 0, .68,
               grain('dark hide', (.22,.16,.11)))
    linen = mat('Armor_trouser_linen', (.11,.105,.085), 0, .9,
                grain('woven trouser',(.38,.36,.30), textile=True))
    blue = mat('Armor_royal_blue_cloth', (.025,.065,.17), 0, .91,
               grain('woven blue',(.10,.23,.46), textile=True))
    leather = mat('Armor_cured_chestnut_leather', (.12,.052,.024), 0, .61,
                  grain('chestnut hide',(.27,.14,.067)))
    reinforced = mat('Armor_reinforced_burnished_leather', (.08,.035,.015), 0, .57,
                     grain('burnished hide',(.215,.105,.046),seed=28))
    steel = mat('Armor_forged_steel', (.27,.32,.37), .75, .38)
    seam = mat('Armor_waxed_linen_stitch', (.47,.34,.18), 0, .89)
    return dict(brass=brass, dark=dark, linen=linen, blue=blue, leather=leather,
                reinforced=reinforced, steel=steel, seam=seam)


def armature_bind(obj, arm, bone=None):
    obj.parent = arm
    obj.matrix_parent_inverse = Matrix.Identity(4)
    obj.matrix_world = Matrix.Identity(4)
    for mod in list(obj.modifiers):
        if mod.type == 'ARMATURE': obj.modifiers.remove(mod)
    if bone:
        obj.vertex_groups.clear()
        group = obj.vertex_groups.new(name=bone)
        group.add(list(range(len(obj.data.vertices))), 1, 'REPLACE')
    mod = obj.modifiers.new('Shared body rig', 'ARMATURE')
    mod.object = arm
    return obj


def mesh(name, verts, faces, material, arm, bone='hips'):
    data = bpy.data.meshes.new(name)
    data.from_pydata(verts, [], faces)
    data.update()
    obj = bpy.data.objects.new(name, data)
    bpy.context.scene.collection.objects.link(obj)
    obj.data.materials.append(material)
    for face in obj.data.polygons: face.use_smooth = True
    return armature_bind(obj, arm, bone)


def tube(name, pts, radius, material, arm, bone='chest', sides=5):
    pts = [Vector(p) for p in pts]
    verts, faces = [], []
    for i,p in enumerate(pts):
        t = (pts[min(i+1,len(pts)-1)]-pts[max(0,i-1)]).normalized()
        up = Vector((0,0,1)) if abs(t.z)<.9 else Vector((0,1,0))
        u=t.cross(up).normalized(); v=t.cross(u).normalized()
        for j in range(sides):
            a=2*math.pi*j/sides
            verts.append(tuple(p+radius*(math.cos(a)*u+math.sin(a)*v)))
    for i in range(len(pts)-1):
        for j in range(sides):
            a=i*sides+j; b=i*sides+(j+1)%sides
            faces.append((a,b,b+sides,a+sides))
    return mesh(name,verts,faces,material,arm,bone)


def band(name, center, radii, width, material, arm, bone='hips', axis='z', n=48):
    c=Vector(center); verts=[]; faces=[]
    for step in [-.5,.5]:
        for i in range(n):
            a=2*math.pi*i/n
            q=Vector((radii[0]*math.cos(a),radii[1]*math.sin(a),width*step))
            if axis=='x': q=Vector((q.z,q.x,q.y))
            verts.append(tuple(c+q))
    for i in range(n): faces.append((i,(i+1)%n,(i+1)%n+n,i+n))
    return mesh(name,verts,faces,material,arm,bone)


def box(name, center, size, material, arm, bone='hips', bevel=.001):
    x,y,z=center; a,b,c=[v/2 for v in size]
    verts=[(x+sx*a,y+sy*b,z+sz*c) for sx,sy,sz in [(-1,-1,-1),(-1,-1,1),(-1,1,-1),(-1,1,1),(1,-1,-1),(1,-1,1),(1,1,-1),(1,1,1)]]
    faces=[(0,4,6,2),(1,3,7,5),(0,1,5,4),(2,6,7,3),(0,2,3,1),(4,5,7,6)]
    obj=mesh(name,verts,faces,material,arm,bone)
    if bevel:
        mod=obj.modifiers.new('Rounded forged corners','BEVEL');mod.width=bevel;mod.segments=2
        C._select_only([obj]);bpy.ops.object.modifier_apply(modifier=mod.name)
    return obj


def region(body, polygon):
    name=body.material_slots[polygon.material_index].name.lower()
    if name.startswith('skin_'): return name[5:].split('.')[0]
    p=polygon.center
    if p.z>.852: return 'head'
    if abs(p.x)>.37 and p.z>.70: return 'hands'
    if abs(p.x)>.27 and p.z>.70: return 'forearm'
    if abs(p.x)>.15 and p.z>.70: return 'upperarm'
    if p.z<.22: return 'feet'
    if p.z<.51: return 'legs'
    return 'torso'


def shell(body, arm, style, mats):
    obj=body.copy();obj.data=body.data.copy();obj.name='Concealed trouser gusset'
    bpy.context.scene.collection.objects.link(obj)
    if obj.data.shape_keys: obj.shape_key_clear()
    # A small, concealed crotch gusset closes the gap between the two tailored
    # trouser tubes. No visible anatomy is used as the jacket or boot surface.
    keep={p.index for p in body.data.polygons if .39<p.center.z<.535}
    bm=bmesh.new();bm.from_mesh(obj.data);bm.faces.ensure_lookup_table()
    bmesh.ops.delete(bm,geom=[f for f in bm.faces if f.index not in keep],context='FACES')
    bm.to_mesh(obj.data);bm.free();obj.data.update()
    # One continuous offset surface: boundaries between materials cannot open cracks.
    normals=[v.normal.copy() for v in obj.data.vertices]
    for vertex,n in zip(obj.data.vertices,normals):
        p=vertex.co
        p+=n*.002
    obj.data.update()
    obj.data.materials.clear()
    obj.data.materials.append(mats['dark'])
    for polygon in obj.data.polygons:
        polygon.material_index=0
        polygon.use_smooth=True
    # A tiled grain map uses small UVs independent of source atlas island size.
    for layer in list(obj.data.uv_layers): obj.data.uv_layers.remove(layer)
    uv=obj.data.uv_layers.new(name='Armor grain')
    for face in obj.data.polygons:
        for li in face.loop_indices:
            p=obj.data.vertices[obj.data.loops[li].vertex_index].co
            uv.data[li].uv=(p.x*34,p.z*34)
    obj.data.uv_layers.active=uv
    uv.active_render=True
    for layer in list(obj.data.color_attributes): obj.data.color_attributes.remove(layer)
    C._select_only([obj]);C.recalc_normals(obj)
    # The anatomical shell is only an opaque undergarment. Clean tailored panels
    # below supply the visible silhouette and cover every ragged region boundary.
    C.decimate(obj,2000)
    C.shade(obj,'smooth')
    return armature_bind(obj,arm)


def source_profile(body, z, thickness=.015):
    pts=[v.co for v in body.data.vertices if abs(v.co.z-z)<thickness and abs(v.co.x)<.18]
    if not pts:return (0,-.015,z),(.125,.09)
    lo=np.min(np.array([tuple(p) for p in pts]),axis=0);hi=np.max(np.array([tuple(p) for p in pts]),axis=0)
    return (float((lo[0]+hi[0])/2),float((lo[1]+hi[1])/2),z),(float((hi[0]-lo[0])/2+.006),float((hi[1]-lo[1])/2+.006))


def neck_facing(body,arm,style,mats):
    """Close the small skin-region junction beneath the manufactured neckline.

    The visible head region has an irregular triangular material boundary.
    A narrow, body-weighted lining behind the outer collar makes that hidden
    torso boundary opaque without moving or duplicating the head itself.
    """
    obj=body.copy();obj.data=body.data.copy();obj.name='Fitted inner collar facing'
    bpy.context.scene.collection.objects.link(obj)
    if obj.data.shape_keys:obj.shape_key_clear()
    # Identical coordinates and weights meet the visible neck exactly. These
    # source torso faces are hidden in the base, so no surface is duplicated.
    keep={p.index for p in body.data.polygons
          if .815<p.center.z<.89 and abs(p.center.x)<.090
          and region(body,p) not in ('head','hands')}
    bm=bmesh.new();bm.from_mesh(obj.data);bm.faces.ensure_lookup_table()
    bmesh.ops.delete(bm,geom=[f for f in bm.faces if f.index not in keep],context='FACES')
    bm.to_mesh(obj.data);bm.free();obj.data.update()
    obj.data.materials.clear()
    obj.data.materials.append(mats['leather' if style=='leather' else 'steel' if style=='plate' else 'blue'])
    for p in obj.data.polygons:p.material_index=0;p.use_smooth=True
    for layer in list(obj.data.color_attributes):obj.data.color_attributes.remove(layer)
    C._select_only([obj]);C.recalc_normals(obj);C.shade(obj,'smooth')
    return armature_bind(obj,arm)


class Tailor:
    """Low density garment topology, sized from body sections and weighted to its rig.

    This is deliberately not an offset of anatomy: a leather jacket has its own
    smooth panel envelope, rolled hems and a straight, manufactured neckline.
    """
    def __init__(self, body, arm):
        self.body, self.arm = body, arm
        self.points = np.array([tuple(v.co) for v in body.data.vertices])
        self.tree = KDTree(len(body.data.vertices))
        self.weights = []
        names = {g.index:g.name for g in body.vertex_groups}
        for v in body.data.vertices:
            self.tree.insert(v.co, v.index)
            self.weights.append([(names[g.group], g.weight) for g in v.groups if g.weight>1e-5])
        self.tree.balance()
        self.sections=[]
        for z in [.49,.52,.555,.60,.64,.68,.72,.755,.785,.805,.824,.842,.835]:
            points=self.points[(abs(self.points[:,2]-z)<.010)&(abs(self.points[:,0])<.138)]
            lo,hi=points.min(0),points.max(0)
            rx=max(abs(lo[0]),abs(hi[0]))+.010
            # Above the axilla, the jacket narrows smoothly to the neck. Arms
            # have independent sleeves, overlapping this yoke below the pads.
            if z>=.785:
                rx={.785:.132,.805:.130,.824:.117,.842:.090,.835:.039}[z]
            cy=(lo[1]+hi[1])/2
            ry=(hi[1]-lo[1])/2+.012
            if z>=.824: ry=min(ry,{.824:.065,.842:.048,.835:.036}[z])
            self.sections.append((z,0,float(cy),float(rx),float(ry)))

    def weight(self, obj):
        obj.vertex_groups.clear()
        groups={}
        for vertex in obj.data.vertices:
            totals={}
            hits=self.tree.find_n(vertex.co,3)
            for _,index,distance in hits:
                factor=1/max(distance,.0005)**2
                for name,value in self.weights[index]: totals[name]=totals.get(name,0)+value*factor
            selected=sorted(totals.items(),key=lambda item:-item[1])[:4]
            total=sum(v for _,v in selected) or 1
            for name,value in selected:
                if name not in groups: groups[name]=obj.vertex_groups.new(name=name)
                groups[name].add([vertex.index],value/total,'REPLACE')
        return obj

    def point(self, angle, z, offset=0):
        rows=self.sections
        a,b=rows[0],rows[-1]
        for first,second in zip(rows,rows[1:]):
            if first[0]<=z<=second[0]: a,b=first,second;break
        t=max(0,min(1,(z-a[0])/(b[0]-a[0])))
        _,cx,cy,rx,ry=[x+(y-x)*t for x,y in zip(a,b)]
        c,s=math.cos(angle),math.sin(angle)
        return (cx+(rx+offset)*math.copysign(abs(c)**.78,c),
                cy+(ry+offset)*math.copysign(abs(s)**.78,s),z)

    def front(self,x,z,offset=.002):
        # The manufactured front envelope, rather than source breast/muscle detail.
        first,second=self.sections[0],self.sections[-1]
        for a,b in zip(self.sections,self.sections[1:]):
            if a[0]<=z<=b[0]:first,second=a,b;break
        f=max(0,min(1,(z-first[0])/(second[0]-first[0])))
        rx=first[3]+(second[3]-first[3])*f
        c=min(.99,(abs(x)/rx)**(1/.78))
        angle=-math.acos(c) if x>=0 else -math.pi+math.acos(c)
        return self.point(angle,z,offset)

    def loft(self, name, rows, material, axis='z', n=40):
        verts=[];faces=[]
        for pos,cu,cv,ru,rv in rows:
            for j in range(n):
                a=j*math.tau/n;c,s=math.cos(a),math.sin(a)
                u=cu+ru*math.copysign(abs(c)**.78,c)
                v=cv+rv*math.copysign(abs(s)**.78,s)
                verts.append((u,v,pos) if axis=='z' else (pos,u,v))
        for i in range(len(rows)-1):
            for j in range(n):
                a=i*n+j;b=i*n+(j+1)%n;faces.append((a,b,b+n,a+n))
        obj=mesh(name,verts,faces,material,self.arm,bone=None)
        self.weight(obj)
        uv=obj.data.uv_layers.new(name='Garment grain')
        for face in obj.data.polygons:
            for li in face.loop_indices:
                idx=obj.data.loops[li].vertex_index
                uv.data[li].uv=((idx%n)/n*5,(idx//n)/max(len(rows)-1,1)*5)
        C.recalc_normals(obj)
        return obj

    def trim(self,name,pts,radius,material,bone=None):
        obj=tube(name,pts,radius,material,self.arm,bone=bone,sides=5)
        if bone is None:self.weight(obj)
        return obj

    def ring(self,name,row,radius,material,axis='z',bone=None):
        pos,cu,cv,ru,rv=row;pts=[]
        for j in range(37):
            a=j*math.tau/36;c,s=math.cos(a),math.sin(a)
            u=cu+ru*math.copysign(abs(c)**.78,c)
            v=cv+rv*math.copysign(abs(s)**.78,s)
            pts.append((u,v,pos) if axis=='z' else (pos,u,v))
        return self.trim(name,pts,radius,material,bone)


def tailored(body,arm,style,mats):
    t=Tailor(body,arm)
    fabric=mats['leather' if style=='leather' else 'steel' if style=='plate' else 'blue']
    edging=mats['brass'] if style=='plate' else mats['dark']
    torso=t.loft('Tailored jacket panels',t.sections,fabric,n=48)
    collar_start=(len(t.sections)-1)*48
    for j,vertex in enumerate(torso.data.vertices[collar_start:]):
        # The shoulder yoke slopes into a lower neck opening: front neckline
        # .825, back .845. A high horizontal top ring reads like a rigid box.
        vertex.co.z=.835+.010*math.sin(math.tau*j/48)
    # A jacket yoke follows the torso. Nearest-surface weights at the axilla
    # would drag it down with the upper arms and open the collar/cap junction.
    torso.vertex_groups.clear()
    groups={name:torso.vertex_groups.new(name=name) for name in ('hips','spine','chest','neck')}
    for vertex in torso.data.vertices:
        z=vertex.co.z
        if vertex.index>=collar_start:
            groups['neck'].add([vertex.index],1,'REPLACE');continue
        if z<.59:a,b,f='hips','spine',max(0,min(1,(z-.54)/.05))
        elif z<.73:a,b,f='spine','chest',max(0,min(1,(z-.66)/.07))
        else:a,b,f='chest','neck',max(0,min(1,(z-.86)/.025))
        if f<1:groups[a].add([vertex.index],1-f,'REPLACE')
        if f>0:groups[b].add([vertex.index],f,'REPLACE')
    # A narrow stand collar and rolled hem have complete, regular edge loops.
    collar=[tuple(v.co) for v in torso.data.vertices[collar_start:]]
    t.trim('Rolled collar',collar+[collar[0]],.0023,edging,'neck')
    t.ring('Jacket hem',t.sections[0],.002,edging)
    for sign,side in [(1,'L'),(-1,'R')]:
        sleeve=[]
        for ax in [.104,.126,.155,.185,.215,.245,.275,.305,.335,.365,.375]:
            sample=max(ax,.155)
            p=t.points[(abs(t.points[:,0]-sign*sample)<.009)&(t.points[:,2]>.70)]
            lo,hi=p.min(0),p.max(0)
            sleeve.append((sign*ax,float((lo[1]+hi[1])/2),float((lo[2]+hi[2])/2),float((hi[1]-lo[1])/2+.007),float((hi[2]-lo[2])/2+.006)))
        t.loft('Fitted sleeve '+side,sleeve,mats['dark'] if style=='plate' else fabric,axis='x',n=28)
        t.ring('Rolled wrist cuff '+side,sleeve[-1],.0025,edging,axis='x')
        if style=='plate':
            guard=[(pos,cy,cz,ry+.004,rz+.004) for pos,cy,cz,ry,rz in sleeve if .275<=abs(pos)<=.365]
            t.loft('Steel vambrace '+side,guard,mats['steel'],axis='x',n=28)
            for row in [guard[0],guard[-1]]:t.ring('Vambrace rolled edge '+side,row,.0015,mats['brass'],axis='x')
        # A short articulated shoulder cap overlaps both sleeve and torso, so
        # animation cannot expose the coarse undergarment's region boundary.
        if style!='plate':
            verts=[];faces=[];n=24
            for k,ax in enumerate([.126,.148,.170,.192,.207]):
                row=min(sleeve,key=lambda r:abs(abs(r[0])-ax));_,cy,cz,ry,rz=row
                for j in range(n+1):
                    angle=math.pi*j/n
                    rise=[.002,.005,.005,.003,.001][k]
                    verts.append((sign*ax,cy+(ry+.005+rise)*math.cos(angle),cz+(rz+.005+rise)*math.sin(angle)))
            for k in range(4):
                for j in range(n):
                    a=k*(n+1)+j;faces.append((a,a+1,a+n+2,a+n+1))
            cap=mesh('Layered leather shoulder '+side,verts,faces,mats['leather'] if style=='leather' else mats['dark'],arm,'upperarm.'+side)
            for k in [0,4]:
                pts=verts[k*(n+1):(k+1)*(n+1)]
                t.trim('Shoulder bound edge '+side,pts,.002,edging,'upperarm.'+side)
        # Smooth, independent trousers and knee-high boot shafts. The copied
        # underlayer covers the crotch and retains the source's fitted toe shape.
        for garment,zs in [('trousers',[.475,.445,.41,.375,.34,.305,.275,.245]),('boot',[.305,.285,.26,.23,.20,.17,.14,.11,.08,.055])]:
            if style=='robe' and garment=='trousers':continue
            rows=[]
            for z in zs:
                p=t.points[(abs(t.points[:,2]-z)<.009)&(t.points[:,0]*sign>.005)]
                lo,hi=p.min(0),p.max(0)
                cx=(lo[0]+hi[0])/2;cy=(lo[1]+hi[1])/2
                extra=.012 if garment=='boot' else .006
                rows.append((z,float(cx),float(cy),float((hi[0]-lo[0])/2+extra),float((hi[1]-lo[1])/2+extra)))
            boot=garment=='boot'
            garment_mat=mats['steel'] if boot and style=='plate' else mats['leather' if boot and style=='leather' else 'dark']
            t.loft(garment.capitalize()+' '+side,rows,garment_mat,n=28)
            if boot:
                t.ring('Folded boot cuff '+side,rows[0],.003,edging)
                t.ring('Boot ankle seam '+side,rows[-2],.0015,mats['dark'])
                # Broad leather reinforcing strip, with small antique brass studs.
                for z in [.13,.24]:
                    row=min(rows,key=lambda r:abs(r[0]-z))
                    _,cx,cy,rx,ry=row
                    stud=box('Boot brass fastening '+side,(cx,cy-ry-.002,z),(.011,.003,.004),mats['brass'],arm,'shin.'+side,.0007)
        foot_points=t.points[(t.points[:,2]<.060)&(t.points[:,0]*sign>.02)]
        lo,hi=foot_points.min(0),foot_points.max(0)
        cx=float((lo[0]+hi[0])/2);cy=float((lo[1]+hi[1])/2)
        rx=float((hi[0]-lo[0])/2+.008);ry=float((hi[1]-lo[1])/2+.010)
        ankle=min(rows,key=lambda row:abs(row[0]-.08))
        _,ax,ay,arx,ary=ankle
        foot_rows=[(-.004,cx,cy,rx*.96,ry*.98),(.006,cx,cy,rx,ry),(.025,cx,cy,rx*.98,ry*.96),
                   (.043,cx,cy+.008,rx*.90,ry*.82),(.064,ax,ay,arx,ary),(.085,ax,ay,arx,ary)]
        foot=t.loft('Closed rounded boot foot '+side,foot_rows,mats['leather' if style=='leather' else 'dark'],n=32)
        # A closed sole, rather than the generated foot's sculpted bare toes.
        sole_points=[tuple(v.co) for v in foot.data.vertices[:32]]
        sole=mesh('Closed boot sole '+side,sole_points,[tuple(reversed(range(32)))],mats['dark'],arm,'foot.'+side)
        t.ring('Boot welt '+side,foot_rows[1],.002,mats['dark'])
    # Tailored short overlapping tassets carry the jacket below the belt. Their
    # straight hems are intentionally independent of the anatomical waist mesh.
    if style!='robe':
        base=min(t.sections,key=lambda row:abs(row[0]-.52));_,cx,cy,rx,ry=base
        for panel in range(10):
            center=math.tau*panel/10;verts=[];faces=[];n=6;rows=5
            for k in range(rows):
                f=k/(rows-1);z=.543-.13*f
                for j in range(n):
                    angle=center+(j/(n-1)-.5)*math.tau/10*1.06
                    flare=.012+.022*f;c,s=math.cos(angle),math.sin(angle)
                    verts.append((cx+(rx+flare)*c,cy+(ry+flare)*s,z+.003*abs(j/(n-1)-.5)*f))
            for k in range(rows-1):
                for j in range(n-1):
                    a=k*n+j;faces.append((a,a+1,a+n+1,a+n))
            panel_obj=mesh('Overlapping jacket tasset',verts,faces,fabric,arm,'hips')
            thick=panel_obj.modifiers.new('Panel thickness','SOLIDIFY');thick.thickness=.0025
            C._select_only([panel_obj]);bpy.ops.object.modifier_apply(modifier=thick.name)
            outline=[verts[k*n] for k in range(rows)]+verts[(rows-1)*n+1:rows*n]+[verts[k*n+n-1] for k in range(rows-2,-1,-1)]
            t.trim('Tasset edge binding',outline,.0012,edging,'hips')
    return t


def details(body,arm,style,mats,t):
    beltrow=min(t.sections,key=lambda row:abs(row[0]-.555))
    z,cx,cy,rx,ry=beltrow;rx+=.005;ry+=.005
    t.loft('Wide waist girdle',[(z-.017,cx,cy,rx,ry),(z+.017,cx,cy,rx,ry)],mats['dark'],n=48)
    for height in [-.017,.017]:t.ring('Belt rolled edge',(z+height,cx,cy,rx,ry),.0015,mats['leather'],bone='hips')
    front=cy-ry-.002
    for offset in [-.012,.012]:box('Buckle upright',(cx+offset,front-.001,z),(.003,.006,.027),mats['brass'],arm)
    for offset in [-.012,.012]:box('Buckle crossbar',(cx,front-.001,z+offset),(.026,.006,.003),mats['brass'],arm)
    box('Buckle tongue',(cx+.002,front-.004,z),(.019,.003,.0025),mats['brass'],arm)
    for sign in [-1,1]:
        pts=[t.front(sign*(.055-.010*i/15),.575+.225*i/15,.003) for i in range(16)]
        t.trim('Jacket panel piping',pts,.0013,mats['dark'] if style=='leather' else mats['brass'] if style=='plate' else mats['blue'])
        if style=='leather':
            for i in range(17):
                zz=.58+.21*i/16;xx=sign*(.058-.010*i/16)
                t.trim('Waxed panel stitching',[t.front(xx-.0014,zz-.001,.004),t.front(xx+.0014,zz+.001,.004)],.00035,mats['seam'])
    for z in [.60,.65,.70,.75]:
        point=t.front(0,z,.004)
        obj=box('Jacket antique fastening',point,(.012,.004,.004),mats['brass'],arm,'chest',.0007)
        t.weight(obj)
    if style=='leather':
        # A lapped cuirass yoke gives the upper chest a reinforced armor read.
        # Its shallow V hem follows the same manufactured front envelope.
        verts=[];faces=[];columns=25;rows=4
        for row in range(rows):
            f=row/(rows-1)
            for j in range(columns):
                s=j/(columns-1)*2-1;x=.108*s
                bottom=.756+.025*abs(s);top=.810+.009*abs(s)
                verts.append(t.front(x,bottom+(top-bottom)*f,.0045))
        for row in range(rows-1):
            for j in range(columns-1):
                a=row*columns+j;faces.append((a,a+1,a+columns+1,a+columns))
        panel=mesh('Lapped reinforced cuirass yoke',verts,faces,mats['reinforced'],arm,'chest')
        for row in [0,rows-1]:
            t.trim('Bound cuirass yoke edge',verts[row*columns:(row+1)*columns],.0014,mats['dark'],'chest')
        for sign in [-1,1]:
            for x in [.052,.089]:
                p=t.front(sign*x,.797,.0065)
                box('Yoke brass rivet',p,(.0035,.002,.0035),mats['brass'],arm,'chest',.0006)
    return t

def skirt(body,arm,mats):
    center,r=source_profile(body,.54)
    cx,cy,_=center;n=64;rows=20;verts=[];faces=[]
    for row in range(rows+1):
        t=row/rows;z=.553-.43*t
        rx=r[0]+.024+.055*t;ry=r[1]+.030+.055*t
        for j in range(n):
            a=2*math.pi*j/n;pleat=1+.028*math.sin(a*12)*t
            c,s=math.cos(a),math.sin(a)
            verts.append((cx+rx*math.copysign(abs(c)**.78,c)*pleat,cy+ry*math.copysign(abs(s)**.78,s)*pleat,z+.002*math.cos(a*12)*t))
    for i in range(rows):
        for j in range(n):
            a=i*n+j;faces.append((a,i*n+(j+1)%n,(i+1)*n+(j+1)%n,a+n))
    obj=mesh('Continuous robe skirt',verts,faces,mats['blue'],arm)
    obj.data.materials.append(mats['brass'])
    for i,face in enumerate(obj.data.polygons):
        row=i//n;j=i%n;a=2*math.pi*(j+.5)/n
        if row in [rows-2,rows-1] or abs(math.cos(a))<.08:face.material_index=1
    uv=obj.data.uv_layers.new(name='Robe weave')
    for f in obj.data.polygons:
        for li in f.loop_indices:
            idx=obj.data.loops[li].vertex_index
            uv.data[li].uv=((idx%n)/n*6,(idx//n)/rows*5)
    return obj


def shoulders(arm,gender):
    """Clean rigid steel caps, with manufactured rims rather than generated shards."""
    steel=mat('Armor_blue_tempered_steel',(.10,.18,.24),.78,.39)
    brass=mat('Armor_pauldron_brass_rims',(.40,.22,.065),.72,.35)
    for side,sign in [('L',1),('R',-1)]:
        origin=arm.data.bones['upperarm.'+side].head_local
        size=.94 if gender=='f' else 1.0
        verts=[];faces=[];n=24
        profile=[(.008,.042,.036),(.025,.058,.052),(.060,.061,.056),(.100,.054,.049),(.135,.038,.030)]
        for dx,ry,rz in profile:
            for j in range(n+1):
                a=math.pi*j/n
                verts.append((origin.x+sign*dx*size,origin.y+ry*size*math.cos(a),origin.z+.003+rz*size*math.sin(a)))
        for row in range(len(profile)-1):
            for j in range(n):
                a=row*(n+1)+j;faces.append((a,a+1,a+n+2,a+n+1))
        obj=mesh('Constructed steel pauldron '+side,verts,faces,steel,arm,'upperarm.'+side)
        C.recalc_normals(obj)
        thick=obj.modifiers.new('Forged pauldron thickness','SOLIDIFY');thick.thickness=.003
        C._select_only([obj]);bpy.ops.object.modifier_apply(modifier=thick.name)
        for row in [0,len(profile)-1]:
            pts=verts[row*(n+1):(row+1)*(n+1)]
            tube('Rolled pauldron rim '+side,pts,.002,brass,arm,'upperarm.'+side,sides=5)
        for j in [0,n]:
            pts=[verts[row*(n+1)+j] for row in range(len(profile))]
            tube('Pauldron lower rim '+side,pts,.002,brass,arm,'upperarm.'+side,sides=5)
        ridge=[verts[row*(n+1)+n//2] for row in range(len(profile))]
        tube('Pauldron raised spine '+side,ridge,.0015,brass,arm,'upperarm.'+side,sides=5)


def export(body,arm,path):
    body.hide_render=True
    body.hide_set(True)
    bpy.ops.object.select_all(action='DESELECT')
    arm.select_set(True)
    parts=[]
    for obj in bpy.context.scene.objects:
        if obj.type=='MESH' and obj!=body and any(mod.type=='ARMATURE' and mod.object==arm for mod in obj.modifiers):
            # Joining different UV layer names creates zero-filled UV sets on
            # other parts. Normalize to one actual texture coordinate set first.
            layers=obj.data.uv_layers
            if layers:
                active=next((layer for layer in layers if layer.active_render),layers[0])
                values=[tuple(loop.uv) for loop in active.data]
            else:
                values=[(obj.data.vertices[loop.vertex_index].co.x*34,
                         obj.data.vertices[loop.vertex_index].co.z*34) for loop in obj.data.loops]
            for layer in list(layers):layers.remove(layer)
            uv=layers.new(name='ArmorUV')
            for loop,value in zip(uv.data,values):loop.uv=value
            layers.active=uv;uv.active_render=True
            obj.hide_set(False);obj.select_set(True);parts.append(obj)
    # One SkinnedMesh with material groups reduces calls and retains all bone weights.
    bpy.context.view_layer.objects.active=parts[0]
    if len(parts)>1:bpy.ops.object.join()
    merged=bpy.context.object;merged.name='Fitted armor'
    arm.select_set(True)
    bpy.ops.export_scene.gltf(filepath=path,export_format='GLB',use_selection=True,
        export_animations=False,export_skins=True,export_yup=True,export_apply=False,
        export_morph=False,export_leaf_bone=False,export_def_bones=False,
        export_image_format='JPEG',export_jpeg_quality=91,export_influence_nb=4)
    return C.tri_count(merged)


def preview(body,arm,path):
    """A neutral, reproducible material and silhouette check in the actual rig."""
    body.hide_set(False);body.hide_render=False
    # Preview the same body coverage policy used by the runtime.
    bm=bmesh.new();bm.from_mesh(body.data);bm.faces.ensure_lookup_table()
    keep={p.index for p in body.data.polygons if region(body,p) in ('head','hands')}
    bmesh.ops.delete(bm,geom=[f for f in bm.faces if f.index not in keep],context='FACES')
    bm.to_mesh(body.data);bm.free();body.data.update()
    arm.data.pose_position='POSE'
    bpy.context.view_layer.update()
    for side,angle in [('L',.95),('R',-.95)]:
        pb=arm.pose.bones['upperarm.'+side]
        origin=pb.head.copy()
        pb.matrix=Matrix.Translation(origin)@Matrix.Rotation(angle,4,'Y')@Matrix.Translation(-origin)@pb.matrix
        bpy.context.view_layer.update()
    scene=bpy.context.scene
    scene.render.engine='CYCLES';scene.cycles.device='CPU';scene.cycles.samples=24
    scene.render.threads_mode='FIXED';scene.render.threads=2
    scene.render.resolution_x=850;scene.render.resolution_y=1100;scene.render.resolution_percentage=100
    world=bpy.data.worlds.new('Wardrobe neutral world');scene.world=world
    world.use_nodes=True;world.node_tree.nodes['Background'].inputs[0].default_value=(.13,.14,.16,1)
    world.node_tree.nodes['Background'].inputs[1].default_value=.65
    def area(name,location,power,size):
        data=bpy.data.lights.new(name,'AREA');data.energy=power;data.shape='DISK';data.size=size
        obj=bpy.data.objects.new(name,data);scene.collection.objects.link(obj);obj.location=location
        obj.rotation_euler=(Vector((0,0,.6))-obj.location).to_track_quat('-Z','Y').to_euler()
    area('Soft key',(-1,-1.5,2.1),110,1.4)
    area('Cool fill',(1.5,-.8,1.2),65,1.2)
    area('Rim',(0,1.1,1.7),130,1.1)
    data=bpy.data.cameras.new('Wardrobe camera');camera=bpy.data.objects.new('Wardrobe camera',data)
    scene.collection.objects.link(camera);scene.camera=camera
    camera.location=(1.15,-3,1.15)
    camera.rotation_euler=(Vector((0,0,.50))-camera.location).to_track_quat('-Z','Y').to_euler()
    data.type='ORTHO';data.ortho_scale=1.18
    scene.view_settings.view_transform='AgX'
    scene.render.image_settings.file_format='PNG';scene.render.filepath=os.path.abspath(path)
    bpy.ops.render.render(write_still=True)


def main():
    opt=args();os.makedirs(opt.out,exist_ok=True)
    records={}
    for style in opt.styles.split(','):
        C.reset_scene();bpy.ops.import_scene.gltf(filepath=os.path.abspath(opt.body))
        arm=next(o for o in bpy.context.scene.objects if o.type=='ARMATURE')
        arm.data.pose_position='REST'
        body=max((o for o in bpy.context.scene.objects if o.type=='MESH' and any(m.type=='ARMATURE' for m in o.modifiers)),key=lambda o:len(o.data.vertices))
        # Exclude helpers, eyes and brows; leave the source body for fit/profile measurements only.
        for o in list(bpy.context.scene.objects):
            if o not in (arm,body):bpy.data.objects.remove(o,do_unlink=True)
        mats=materials(style)
        shell(body,arm,style,mats)
        neck_facing(body,arm,style,mats)
        tailor=tailored(body,arm,style,mats)
        details(body,arm,style,mats,tailor)
        if style=='robe':skirt(body,arm,mats)
        if style=='plate':shoulders(arm,opt.gender)
        path=os.path.abspath(os.path.join(opt.out,f'armor_{opt.gender}_{style}.glb'))
        tris=export(body,arm,path)
        records[style]={'file':path,'triangles':tris}
        C.log('Fitted armor exported',style,tris,path)
        if opt.preview:preview(body,arm,opt.preview.format(gender=opt.gender,style=style))
    print(json.dumps(records,indent=2))


if __name__=='__main__':main()
