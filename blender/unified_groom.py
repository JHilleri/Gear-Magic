"""Build fitted, strand-layered hair directly on a continuous character's skull.

blender -b -t 2 -P blender/unified_groom.py -- --body human_m_base.glb \
    --gender m --out game/public/assets/models/hair [--styles short,curly,beard_short]

Each GLB uses the *body's global bind coordinates*, not the old generic head frame.
The runtime parents it to the head through the inverse bind matrix. `swing_*`
child nodes carry root pivots for the runtime's restrained secondary motion.
No generated wigs or separately generated heads are used.
"""
import argparse
import hashlib
import json
import math
import os
import random
import sys
from pathlib import Path

import bpy
from mathutils import Vector
from mathutils.bvhtree import BVHTree

HAIR = ('short', 'crop', 'swept', 'tail', 'curly', 'long', 'braid', 'bun', 'bob', 'ponytail', 'pixie')
BEARDS = ('beard_short', 'beard_full', 'beard_moustache', 'beard_goatee', 'beard_long')
TAU = math.pi * 2


def mesh(name, vertices, faces, uvs, material, parent=None):
    data = bpy.data.meshes.new(name)
    data.from_pydata(vertices, [], faces)
    data.update()
    obj = bpy.data.objects.new(name, data)
    bpy.context.collection.objects.link(obj)
    obj.data.materials.append(material)
    if parent:
        obj.parent = parent
    uv = data.uv_layers.new(name='UVMap')
    for polygon in data.polygons:
        polygon.use_smooth = True
        for li in polygon.loop_indices:
            uv.data[li].uv = uvs[data.loops[li].vertex_index]
    return obj


def hair_material(shade=1):
    """Exportable neutral PBR with fine longitudinal strands, avoiding plastic clumps."""
    rng = random.Random(5831)
    width, height = 128, 256
    image = bpy.data.images.new('Hair strand albedo', width, height, alpha=False)
    column = [.69 + rng.uniform(-.23, .20) for _ in range(width)]
    pixels = []
    for y in range(height):
        for x in range(width):
            c = max(.38, min(.9, column[x] + .025 * math.sin(y * .15 + x * .31)))
            pixels.extend((c*shade, c*shade, c*shade, 1))
    image.pixels = pixels
    image.pack()
    mat = bpy.data.materials.new('Hair_strands' if shade==1 else 'Hair_roots')
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get('Principled BSDF')
    bsdf.inputs['Base Color'].default_value = (.7, .7, .7, 1)
    bsdf.inputs['Metallic'].default_value = 0
    bsdf.inputs['Roughness'].default_value = .62
    bsdf.inputs['Specular IOR Level'].default_value = .30
    tex = mat.node_tree.nodes.new('ShaderNodeTexImage')
    tex.image = image
    mat.node_tree.links.new(tex.outputs['Color'], bsdf.inputs['Base Color'])
    return mat


class Ribbons:
    """Fine tapered hair cards: two vertices across permit dense overlapping strands."""
    def __init__(self, name, material, parent=None, pivot=None):
        self.name, self.material, self.parent = name, material, parent
        self.pivot = Vector(pivot or (0, 0, 0))
        self.vertices, self.faces, self.uvs = [], [], []

    def add(self, points, width, seed=0, normals=None, ridge=0):
        pts = [Vector(p) for p in points]
        if len(pts) < 2:
            return
        start = len(self.vertices)
        for i, point in enumerate(pts):
            tangent = (pts[min(i + 1, len(pts)-1)] - pts[max(0, i-1)]).normalized()
            normal = Vector(normals[i]) if normals else Vector((0, -1, .12))
            across = tangent.cross(normal).normalized()
            if across.length < .1:
                across = tangent.cross(Vector((1, 0, 0))).normalized()
            outward = across.cross(tangent).normalized()
            if outward.dot(normal) < 0:
                outward.negate()
            t = i / (len(pts)-1)
            taper = max(.035, (1-t)**.45) * min(1, .65+t*4)
            columns = 4 if ridge else 2
            for j in range(columns):
                u = j/(columns-1)
                p = point + across * ((u-.5)*width*taper)
                if ridge:
                    p += outward*(math.sin(u*math.pi)*ridge*math.sin(math.pi*min(.95,t+.08))**.5)
                self.vertices.append(tuple(p-self.pivot))
                # Several fine longitudinal fibres across a lock, independent of its width.
                self.uvs.append(((seed % 79)/79 + u*.125, t))
            if i:
                row = start+(i-1)*columns
                for j in range(columns-1):
                    self.faces.append((row+j,row+j+1,row+j+columns+1,row+j+columns))

    def finish(self):
        if not self.vertices:
            return None
        obj = mesh(self.name, self.vertices, self.faces, self.uvs, self.material, self.parent)
        return obj


class Skull:
    def __init__(self, vertices, faces, head):
        self.head = head
        self.depth = float(head['depth'])
        self.crown = Vector((float(head['x']), -float(head['z']), float(head['y'])))
        self.center = self.crown + Vector((0, -self.depth*.5, -self.depth*.60))
        self.bvh = BVHTree.FromPolygons(vertices, faces, all_triangles=False)
        self.clearances = []

    def theta_max(self, phi):
        # Low at forehead, above ears at the temples, down to the nape behind.
        front = math.cos(phi)
        if front > 0:
            base=1.42 - .43 * front**1.5
        else:
            base=1.42 + .66 * (-front)**1.1
        # A very small irregular edge avoids a perfectly machined helmet rim.
        return base+.016*math.sin(phi*17)+.007*math.sin(phi*39+.7)

    def sample(self, theta, phi, offset=.001):
        direction = Vector((math.sin(theta)*math.sin(phi), -math.sin(theta)*math.cos(phi), math.cos(theta)))
        position, normal, _, distance = self.bvh.ray_cast(self.center, direction, self.depth*2)
        if position is None:
            radii = Vector((self.depth*.42, self.depth*.50, self.depth*.61))
            position = self.center + Vector(tuple(direction[i]*radii[i] for i in range(3)))
            normal = direction
        if normal.dot(direction) < 0:
            normal.negate()
        normal.normalize()
        self.clearances.append(offset)
        return position + normal*offset, normal

    def front(self, x, z, offset=.0007):
        origin = Vector((x, self.center.y-self.depth*1.1, z))
        position, normal, _, _ = self.bvh.ray_cast(origin, Vector((0, 1, 0)), self.depth*2)
        if position is None or normal.y > -.1:
            return None
        self.clearances.append(offset)
        return position + normal.normalized()*offset, normal.normalized()


def cap(skull, style, material, root):
    volume = {'crop': .0008, 'short': .0025, 'swept': .0033, 'pixie': .0018, 'curly': .0040}.get(style, .0020)
    vertices, faces, uvs = [], [], []
    rings, sectors = 12, 40
    for ring in range(rings+1):
        t = max(.001, ring/rings)
        for sector in range(sectors+1):
            phi = sector/sectors*TAU
            theta = skull.theta_max(phi)*t
            p, _ = skull.sample(theta, phi, .0005+volume*(1-t**3))
            vertices.append(tuple(p))
            uvs.append((sector/sectors*8, t))
            if ring and sector:
                n = ring*(sectors+1)+sector
                faces.append((n, n-1, n-sectors-2, n-sectors-1))
    roots=next((mat for mat in bpy.data.materials if mat.name=='Hair_roots'),None) or hair_material(.53)
    mesh('Hair_scalp', vertices, faces, uvs, roots, root)

    rng = random.Random(530 + sum(map(ord, style)))
    locks = Ribbons('Hair_directional_locks', material, root)
    strands = Ribbons('Hair_layered_strands', material, root)
    # A parted, swept surface needs broad directional highlights. Fine random
    # cards alone read as a coloured swimming cap at the game camera distance.
    # Locks grow from a crown part onto the *measured* skull, never a wig shell.
    count = 38 if style in ('long','bob','swept','pixie') else 32
    for i in range(count):
        phi = TAU*i/count+rng.uniform(-.04,.04)
        if phi>math.pi:phi-=TAU
        extent=skull.theta_max(phi)*rng.uniform(.88,1.035)
        origin_phi = .55 if style not in ('tail','ponytail','braid','bun') else math.pi
        origin_theta = .26 if style not in ('tail','ponytail','braid','bun') else .12
        if style in ('long','bob','swept','pixie') and math.cos(phi)>0:
            # Front hair parts near the hairline and sweeps towards the temples;
            # it does not form the straight crown-to-forehead fringe of a crop.
            origin_theta=.77-.39*abs(math.sin(phi))
            origin_phi=.08
            phi=(1 if phi>=0 else -1)*(.46+abs(phi)*.76)
            extent=skull.theta_max(phi)*rng.uniform(.96,1.035)
        # Wider front locks break the forehead silhouette; shorter crop stays
        # close to the scalp and follows local growth rather than a comb-over.
        theta0 = origin_theta if style!='crop' else extent*.55
        origin = Vector((math.sin(theta0)*math.sin(origin_phi),
                         -math.sin(theta0)*math.cos(origin_phi),math.cos(theta0)))
        end = Vector((math.sin(extent)*math.sin(phi),-math.sin(extent)*math.cos(phi),math.cos(extent)))
        points,normals=[],[]
        for j in range(10):
            t=j/9
            direction=origin.lerp(end,t).normalized()
            theta=math.acos(max(-1,min(1,direction.z)))
            angle=math.atan2(direction.x,-direction.y)
            p,n=skull.sample(theta,angle,.0007+volume*(1-t*.65)+
                             (.0010 if style=='crop' else .0032)*math.sin(math.pi*t)**.7)
            if style in ('long','bob','swept','curly'):
                p += Vector((math.cos(angle),math.sin(angle),0))*math.sin(t*TAU+i*.5)*.0015
            points.append(p);normals.append(n)
        if style in ('tail','ponytail','braid','bun') and math.cos(phi)>0:
            points.reverse();normals.reverse()
        width=skull.depth*(.052 if style=='crop' else .075 if style in ('short','pixie','curly') else .088)
        locks.add(points,width*rng.uniform(.82,1.18),i,normals,.0005 if style=='crop' else .0014)
    locks.finish()
    count = 100 if style in ('long','bob','swept') else 135 if style in ('braid','tail','ponytail','bun') else 200 if style=='curly' else 185
    for i in range(count):
        phi = i*2.399963229728653
        theta = skull.theta_max(phi)*math.sqrt((i+.5)/count)*.98
        points, normals = [], []
        for j in range(7):
            t = j/6
            phi_t = phi + .30*t*math.sin(phi-.55)
            theta_t = min(skull.theta_max(phi_t)*1.025, theta + .30*t)
            root_fraction=theta_t/skull.theta_max(phi_t)
            lift = .0012+volume*(1-.55*root_fraction**3)+.0018*math.sin(math.pi*t)
            p, normal = skull.sample(theta_t, phi_t, lift)
            if style == 'curly':
                tangent = Vector((math.cos(phi_t), math.sin(phi_t), 0))
                p += tangent * (math.sin(t*math.pi*4+i)*.0016)
                p += normal * (.0013*(1+math.cos(t*math.pi*4+i)))
            points.append(p); normals.append(normal)
        strands.add(points, rng.uniform(.00055, .0010), i, normals)
    strands.finish()


def swing_group(name, pivot, root):
    obj = bpy.data.objects.new(name, None)
    bpy.context.collection.objects.link(obj)
    obj.parent = root
    obj.location = pivot
    return obj


def bezier(a, b, c, d, t):
    return a*((1-t)**3) + b*(3*t*(1-t)**2) + c*(3*t*t*(1-t)) + d*(t**3)


def bundle(name, points, radii, material, parent, pivot, phase=0):
    """Six-sided closed hair bundle for a legible, rounded braid silhouette."""
    vertices,faces,uvs=[],[],[]
    for i,p in enumerate(points):
        tangent=(points[min(i+1,len(points)-1)]-points[max(0,i-1)]).normalized()
        across=tangent.cross(Vector((0,1,0))).normalized()
        out=across.cross(tangent).normalized()
        for j in range(7):
            angle=TAU*j/6
            v=p+(across*math.cos(angle)+out*math.sin(angle))*radii[i]
            vertices.append(tuple(v-pivot));uvs.append((j/6*.5+phase,i/(len(points)-1)))
            if i and j:
                n=i*7+j
                faces.append((n,n-1,n-8,n-7))
    return mesh(name,vertices,faces,uvs,material,parent)


def hanging(skull, style, material, root):
    depth, center, crown = skull.depth, skull.center, skull.crown
    if style in ('tail', 'ponytail', 'braid'):
        start, normal = skull.sample(1.87 if style=='braid' else .97 if style=='ponytail' else 1.3, math.pi, .002)
        end = start + Vector((0, depth*.27, -depth*(1.48 if style=='braid' else 1.37 if style=='ponytail' else .78)))
        group = swing_group('swing_tail', start, root)
        if style=='braid':
            detail=Ribbons('Hair_braid_fibres',material,group,start)
            for strand in range(3):
                points=[];radii=[];normals=[]
                for j in range(37):
                    t=j/36
                    p=bezier(start,start+Vector((0,depth*.26,-depth*.10)),
                             end+Vector((0,-depth*.06,depth*.3)),end,t)
                    angle=t*TAU*3.5+strand*TAU/3
                    radius=depth*.049*min(1,.35+t*8)*(1-t*.64)
                    p+=Vector((math.sin(angle)*radius,math.sin(angle*2)*radius*.48,0))
                    points.append(p);radii.append(depth*.032*(1-t*.78))
                    normals.append(Vector((math.sin(angle),math.cos(angle),.05)).normalized())
                bundle('Hair_braid_bundle',points,radii,material,group,start,strand*.2)
                for fibre in range(5):
                    angle=TAU*fibre/5
                    offset=Vector((math.cos(angle),math.sin(angle),0))
                    detail.add([p+offset*radii[j]*1.015 for j,p in enumerate(points)],
                               depth*.003,fibre+strand*5,[offset]*len(points))
            detail.finish()
            # A short unplaited tuft makes the final point read as hair.
            tuft=Ribbons('Hair_braid_tip',material,group,start)
            for i in range(12):
                angle=TAU*i/12
                pts=[end+Vector((math.cos(angle)*depth*.014*(1-j/5),
                                  math.sin(angle)*depth*.014*(1-j/5),-depth*.12*j/5)) for j in range(6)]
                tuft.add(pts,depth*.01,i,[Vector((math.cos(angle),math.sin(angle),0))]*6)
            tuft.finish()
            return
        ribbon = Ribbons('Hair_tail_strands', material, group, start)
        n = 30
        for i in range(n):
            angle = TAU*i/n
            radius = depth*.072
            pts, normals = [], []
            for j in range(12):
                t=j/11
                p=bezier(start,start+Vector((0,depth*.27,0)),end+Vector((0,depth*.05,depth*.25)),end,t)
                envelope = (.30+.70*math.sin(math.pi*t))*(1-t*.8)
                p += Vector((math.cos(angle)*radius*envelope+math.sin(t*TAU*1.2+i*.08)*depth*.025*t,
                             math.sin(angle)*radius*envelope,0))
                pts.append(p)
                normals.append(Vector((math.cos(angle),math.sin(angle),.05)).normalized())
            ribbon.add(pts, depth*.020, i, normals,depth*.006)
        ribbon.finish()
    elif style == 'bun':
        start, normal = skull.sample(1.03, math.pi, .0017)
        pivot=start+normal*depth*.07
        group=swing_group('swing_bun',pivot,root)
        ribbon=Ribbons('Hair_coiled_bun',material,group,pivot)
        # A small coil built from overlapping ribbons rather than a head-sized solid blob.
        for i in range(56):
            phi=TAU*i/56
            pts=[];normals=[]
            for j in range(10):
                t=j/9
                theta=.14+t*math.pi*.90
                p=pivot+Vector((math.sin(theta)*math.cos(phi)*depth*.13,
                                math.sin(theta)*math.sin(phi)*depth*.105,
                                math.cos(theta)*depth*.14))
                pts.append(p)
                normals.append((p-pivot).normalized())
            ribbon.add(pts,depth*.019,i,normals)
        ribbon.finish()
    elif style in ('long','bob','swept'):
        # Each hanging lock owns its pivot: rotations leave its own root fixed.
        # The scalp locks overlap these roots and remain static on the skull.
        for side in (-1,1):
            for i in range(9):
                phi=side*(1.09+i/8*2.02)
                start,normal=skull.sample(1.12,phi,.0013)
                group=swing_group(f'swing_layer_{side}_{i}',start,root)
                ribbon=Ribbons('Hair_wavy_layer',material,group,start)
                fine=Ribbons('Hair_layer_fibres',material,group,start)
                target_z=crown.z-depth*(1.30 if style=='bob' else 1.55 if style=='swept' else 2.01)
                target_z+=math.sin(i*2.1+side)*depth*.09
                radial=Vector((math.sin(phi),-math.cos(phi),0))
                end=Vector((center.x+math.sin(phi)*depth*.52,
                            center.y-math.cos(phi)*depth*.70,target_z))
                pts=[];normals=[]
                for j in range(14):
                    t=j/13
                    if t<.32:
                        p,n=skull.sample(1.12+t/.32*.57,phi,.0013+math.sin(t/.32*math.pi)*.0021)
                    else:
                        join,n=skull.sample(1.69,phi,.0024)
                        u=(t-.32)/.68
                        p=bezier(join,join+radial*depth*.11+Vector((0,0,-depth*.30)),
                                 end+Vector((0,0,depth*.29)),end,u)
                        p+=radial*(math.sin(u*TAU*1.35+i*.65)*depth*.083*math.sin(math.pi*u))
                        n=radial
                    pts.append(p);normals.append(n)
                ribbon.add(pts,depth*(.165 if style=='long' else .145),i+side*13,normals,depth*.018)
                for fibre in range(4):
                    across=Vector((math.cos(phi),math.sin(phi),0))
                    shifted=[p+across*depth*(fibre-1.5)*.022+normals[j]*depth*.012 for j,p in enumerate(pts)]
                    fine.add(shifted,depth*.004,i*4+fibre,normals)
                ribbon.finish();fine.finish()
        if style in ('long','bob'):
            for side in (-1,1):
                start,_=skull.sample(.89,side*.85,.0024)
                group=swing_group('swing_left' if side<0 else 'swing_right',start,root)
                ribbon=Ribbons('Hair_face_framing_lock',material,group,start)
                end=Vector((center.x+side*depth*.48,center.y-depth*.58,
                            crown.z-depth*(1.28 if style=='bob' else 1.65)))
                for i in range(3):
                    shift=Vector((side*i*depth*.018,depth*.02*i,depth*.025*i))
                    pts=[];normals=[]
                    for j in range(13):
                        t=j/12
                        p=bezier(start+shift,start+shift+Vector((side*depth*.23,-depth*.02,-depth*.20)),
                                 end+shift+Vector((side*depth*.12,depth*.05,depth*.35)),end+shift,t)
                        p.x+=side*math.sin(t*TAU*1.1)*depth*.065*math.sin(math.pi*t)
                        pts.append(p);normals.append(Vector((side*.55,-.75,.06)).normalized())
                    ribbon.add(pts,depth*.078,i,normals,depth*.012)
                ribbon.finish()


def beard(skull, style, material, root):
    depth,crown,center=skull.depth,skull.crown,skull.center
    ribbon=Ribbons('Hair_facial_strands',material,root)
    mouth_z=crown.z-depth*.91
    chin_z=crown.z-depth*1.10
    rng=random.Random(481+sum(map(ord,style)))

    def coverage(fx,fz):
        """Curved cheek and jaw lines; no rectangular mouth or neck patch."""
        width=abs(fx)
        upper=.945-.235*(min(1,width/.39))**1.35
        lower=1.103-.190*(min(1,width/.39))**1.7
        jaw=min(fz-upper,lower-fz,(.39-width)*.6)
        moustache=min(.225-width,fz-(.848+.035*(width/.225)**1.5),(.912+.018*(width/.225))-fz)
        if style=='beard_moustache':edge=moustache
        elif style=='beard_goatee':edge=max(moustache,min(.145-width,fz-.96,lower-fz))
        else:edge=max(jaw,moustache)
        mouth=(math.sqrt((fx/.165)**2+((fz-.925)/.044)**2)-1)*.044
        return min(edge,mouth)

    # A feathered neutral root texture avoids a sharply painted beard mask.
    rootmat=bpy.data.materials.new('Hair_beard_roots');rootmat.use_nodes=True
    bsdf=rootmat.node_tree.nodes.get('Principled BSDF')
    bsdf.inputs['Roughness'].default_value=.85;bsdf.inputs['Specular IOR Level'].default_value=.18
    image=bpy.data.images.new('Hair beard root falloff',128,128,alpha=True)
    pixels=[]
    texrng=random.Random(937)
    for iz in range(128):
        for ix in range(128):
            edge=coverage((ix/127*2-1)*.4,.70+iz/127*.415)
            alpha=max(0,min(1,edge/.020));alpha=alpha*alpha*(3-2*alpha)
            alpha*=texrng.uniform(.65,.90)
            c=texrng.uniform(.31,.43)
            pixels.extend((c,c,c,alpha))
    image.pixels=pixels;image.pack()
    tex=rootmat.node_tree.nodes.new('ShaderNodeTexImage');tex.image=image
    rootmat.node_tree.links.new(tex.outputs['Color'],bsdf.inputs['Base Color'])
    rootmat.node_tree.links.new(tex.outputs['Alpha'],bsdf.inputs['Alpha'])
    rootmat.surface_render_method='DITHERED'

    def valid_sample(fx,fz,offset):
        sample=skull.front(center.x+fx*depth,crown.z-fz*depth,offset)
        # At the jaw edge a front ray can hit the neck behind the face.
        if sample and fz>1.005 and sample[0].y>center.y-depth*.09:return None
        return sample

    # The fitted root layer gives short beards a continuous soft mass; a grid
    # of isolated opaque cards otherwise looks like dotted face paint.
    vertices,faces,uvs,indices=[],[],[],{}
    nx,nz=44,30
    for iz in range(nz+1):
        fz=.70+iz/nz*.415
        for ix in range(nx+1):
            fx=(ix/nx*2-1)*.4
            if coverage(fx,fz)<=0:continue
            sample=valid_sample(fx,fz,.00045)
            if sample is None:continue
            indices[ix,iz]=len(vertices);vertices.append(tuple(sample[0]));uvs.append((ix/nx,iz/nz))
            if all(key in indices for key in ((ix-1,iz),(ix-1,iz-1),(ix,iz-1))):
                faces.append((indices[ix,iz],indices[ix-1,iz],indices[ix-1,iz-1],indices[ix,iz-1]))
    mesh('Hair_beard_roots',vertices,faces,uvs,rootmat,root)

    count=0
    for iz in range(36):
        for ix in range(66):
            # Stratified random placement hides rows without leaving bald gaps.
            fx=((ix+rng.random())/66*2-1)*.4
            fz=.70+(iz+rng.random())/36*.415
            edge=coverage(fx,fz)
            if edge<=0 or rng.random()>min(1,edge/.016):continue
            x=center.x+fx*depth;z=crown.z-fz*depth
            sample=valid_sample(fx,fz,.00065)
            if sample is None: continue
            start,normal=sample
            moustache=fz<.935 and abs(fx)<.23
            length=depth*({'beard_short':.016,'beard_full':.050,'beard_moustache':.030,'beard_goatee':.06,'beard_long':.15}[style])
            length*=rng.uniform(.65,1.15)
            if style=='beard_long' and z<chin_z+depth*.12: length*=1.8
            pts=[]; normals=[]
            for j in range(4):
                t=j/3
                p=start+Vector((fx*length*.45*t,0,-length*t))+normal*(.0005*math.sin(math.pi*t))
                if moustache:p.x+=(1 if fx>0 else -1)*length*.45*t
                p.x+=math.sin(t*math.pi)*rng.uniform(-.0002,.0002)
                pts.append(p);normals.append(normal)
            ribbon.add(pts,depth*rng.uniform(.003,.0055),count,normals)
            count+=1
    ribbon.finish()


def read_skull(path, meta_path):
    bpy.ops.object.select_all(action='SELECT')
    bpy.ops.object.delete(use_global=False)
    bpy.ops.import_scene.gltf(filepath=str(path))
    for obj in bpy.context.scene.objects:
        if obj.type=='ARMATURE': obj.data.pose_position='REST'
    bpy.context.view_layer.update()
    meta=json.loads(meta_path.read_text()) if meta_path.exists() else {}
    points,faces=[],[]
    for obj in bpy.context.scene.objects:
        if obj.type!='MESH' or obj.name.lower().startswith(('eye','iris','pupil')):continue
        data=obj.data
        offset=len(points)
        points.extend([obj.matrix_world@v.co for v in data.vertices])
        faces.extend([tuple(offset+i for i in face.vertices) for face in data.polygons])
    if not points:raise RuntimeError('No body geometry in input')
    head=meta.get('head')
    if not head:
        top=max(v.z for v in points)
        band=[v for v in points if top-.055<v.z<top-.015 and abs(v.x)<.10]
        back=max(v.y for v in band);front=min(v.y for v in band)
        head={'x':(max(v.x for v in band)+min(v.x for v in band))*.5,'y':top,'z':-back,'depth':back-front}
    depth=float(head['depth']);crown=float(head['y'])
    # Exclude shoulders/hands and keep only polygons wholly in the head region.
    selected=[face for face in faces if all(points[i].z>crown-depth*1.40 and abs(points[i].x-head['x'])<depth*.85 for i in face)]
    skull=Skull(points,selected,head)
    bpy.ops.object.select_all(action='SELECT');bpy.ops.object.delete(use_global=False)
    return skull


def export(path,root,skull,body,style):
    bpy.ops.object.select_all(action='DESELECT')
    root.select_set(True)
    for child in root.children_recursive:child.select_set(True)
    bpy.ops.export_scene.gltf(filepath=str(path),export_format='GLB',use_selection=True,
                             export_yup=True,export_animations=False,export_extras=False,
                             export_image_format='JPEG',export_jpeg_quality=88)
    triangles=sum(len(p.vertices)-2 for obj in root.children_recursive if obj.type=='MESH' for p in obj.data.polygons)
    points=[obj.matrix_world@v.co for obj in root.children_recursive if obj.type=='MESH' for v in obj.data.vertices]
    bounds=[[round(min(p[i] for p in points),6),round(max(p[i] for p in points),6)] for i in range(3)]
    clearance=skull.clearances or [0]
    sidecar={'sourceBody':body.name,'sourceSha256':hashlib.sha256(body.read_bytes()).hexdigest(),
             'space':'model-bind','head':skull.head,'style':style,'triangles':triangles,
             'boundsBlender':bounds,'dynamicNodes':[obj.name for obj in root.children_recursive if obj.name.startswith('swing_')],
             'scalpClearance':{'min':round(min(clearance),6),'max':round(max(clearance),6)}}
    path.with_suffix('.meta.json').write_text(json.dumps(sidecar,indent=1)+'\n')
    print(f'GROOM {path.name}: {triangles} tris, {len(sidecar["dynamicNodes"])} dynamic nodes',flush=True)


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--body',type=Path,required=True)
    parser.add_argument('--meta',type=Path)
    parser.add_argument('--gender',choices=('m','f'),required=True)
    parser.add_argument('--out',type=Path,required=True)
    parser.add_argument('--styles',default='all')
    args=parser.parse_args(sys.argv[sys.argv.index('--')+1:])
    args.out.mkdir(parents=True,exist_ok=True)
    skull=read_skull(args.body,args.meta or args.body.with_suffix('.meta.json'))
    material=hair_material()
    styles=HAIR+(BEARDS if args.gender=='m' else ()) if args.styles=='all' else tuple(args.styles.split(','))
    for style in styles:
        if style not in HAIR+BEARDS:raise ValueError(f'Unknown style {style}')
        root=bpy.data.objects.new('Groom',None);bpy.context.collection.objects.link(root)
        skull.clearances=[]
        if style.startswith('beard_'):beard(skull,style,material,root)
        else:cap(skull,style,material,root);hanging(skull,style,material,root)
        bpy.context.view_layer.update()
        export(args.out/f'unified_{args.gender}_{style}.glb',root,skull,args.body,style)
        for obj in list(root.children_recursive):bpy.data.objects.remove(obj,do_unlink=True)
        bpy.data.objects.remove(root,do_unlink=True)


if __name__=='__main__':
    main()
    # This is an isolated background builder. Blender's optional PulseAudio
    # teardown can wait indefinitely in restricted sessions after files save.
    if bpy.app.background:
        sys.stdout.flush();sys.stderr.flush()
        os._exit(0)
