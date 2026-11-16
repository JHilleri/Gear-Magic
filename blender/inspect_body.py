"""Render orthographic front/side/back geometry checks without changing the source GLB."""
import argparse
import json
import math
import sys
from pathlib import Path

import bpy
import numpy as np
from mathutils import Vector

sys.path.insert(0, str(Path(__file__).resolve().parent))
import common as C
import rig_humanoid as RH


def main():
    p = argparse.ArgumentParser()
    p.add_argument('source')
    p.add_argument('out')
    p.add_argument('--views', default='front,side,back')
    a = p.parse_args(C.script_args())
    out = Path(a.out); out.mkdir(parents=True, exist_ok=True)
    C.reset_scene()
    body = C.import_joined_mesh(str(Path(a.source).resolve()))
    RH.orient_upright(body); RH.orient_facing(body)
    v = C.verts_np(body)
    height = np.ptp(v[:, 2])
    lo, hi = v.min(0), v.max(0)
    v -= np.array([(lo[0]+hi[0])/2, (lo[1]+hi[1])/2, lo[2]])
    v /= height
    for vert, co in zip(body.data.vertices, v): vert.co = co
    slices = {}
    for name, z, half in [('chest', .73, .025), ('waist', .59, .025), ('hips', .49, .025), ('head', .94, .025)]:
        pts = v[(abs(v[:, 2]-z)<half) & (abs(v[:, 0])<.15)]
        if len(pts):
            ext = np.ptp(pts, axis=0)
            slices[name] = {'width': round(float(ext[0]), 4), 'depth': round(float(ext[1]), 4), 'depth_width': round(float(ext[1]/ext[0]), 3)}
    metrics = {'source': a.source, 'vertices': len(v), 'triangles': C.tri_count(body), 'normalized_slices': slices}
    (out/'metrics.json').write_text(json.dumps(metrics, indent=2)+'\n')
    print(json.dumps(metrics))
    body.data.materials.clear()
    m = bpy.data.materials.new('Neutral inspection clay'); m.diffuse_color = (.43,.47,.49,1); m.use_nodes=True
    m.node_tree.nodes.get('Principled BSDF').inputs['Base Color'].default_value=(.43,.47,.49,1)
    m.node_tree.nodes.get('Principled BSDF').inputs['Roughness'].default_value=.72
    body.data.materials.append(m)
    for face in body.data.polygons: face.material_index=0; face.use_smooth=True
    sc=bpy.context.scene; sc.render.engine='CYCLES'; sc.cycles.device='CPU'; sc.cycles.samples=16; sc.cycles.use_denoising=True
    sc.render.resolution_x=700; sc.render.resolution_y=700; sc.render.resolution_percentage=100
    sc.world=bpy.data.worlds.new('Inspection studio');sc.world.color=(.15,.15,.15)
    sc.view_settings.view_transform='AgX'
    for name, loc, power, size in [('Key',(-1.2,-1.5,2),110,2),('Fill',(1,-.2,1.3),55,1.8),('Rim',(0,1,1.6),80,1.4)]:
        data=bpy.data.lights.new(name,'AREA'); data.energy=power; data.shape='DISK';data.size=size
        light=bpy.data.objects.new(name,data);sc.collection.objects.link(light);light.location=loc;light.rotation_euler=(Vector((0,0,.65))-light.location).to_track_quat('-Z','Y').to_euler()
    data=bpy.data.cameras.new('Inspection');camera=bpy.data.objects.new('Inspection',data);sc.collection.objects.link(camera);sc.camera=camera
    data.type='ORTHO';data.ortho_scale=1.16
    for name, loc in [('front',(0,-3,.5)),('side',(3,0,.5)),('back',(0,3,.5))]:
        if name not in a.views.split(','): continue
        camera.location=loc;camera.rotation_euler=(Vector((0,0,.5))-camera.location).to_track_quat('-Z','Y').to_euler()
        sc.render.filepath=str(out/(name+'.png'));bpy.ops.render.render(write_still=True)


if __name__=='__main__': main()
