"""Front T-pose render of a unified body as a plain green mannequin: the reference an image-edit
model dresses, so generated clothes keep this body's proportions (art/tools/gen.py "refs").

    blender -b -t 2 --factory-startup -P blender/render_mannequin.py -- BODY.glb OUT.png [--size 1024]
"""
import os
import sys
import bpy
from mathutils import Vector

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common as C

a = C.script_args()
size = int(a[a.index('--size') + 1]) if '--size' in a else 1024
C.reset_scene()
bpy.ops.import_scene.gltf(filepath=os.path.abspath(a[0]))
green = bpy.data.materials.new('Mannequin'); green.use_nodes = True
shader = green.node_tree.nodes['Principled BSDF']
shader.inputs['Base Color'].default_value = (.03, .62, .05, 1); shader.inputs['Roughness'].default_value = .55
for obj in list(bpy.context.scene.objects):
    if obj.type == 'ARMATURE': obj.data.pose_position = 'REST'
    if obj.type != 'MESH': continue
    if not obj.vertex_groups or obj.name.lower().startswith('brow'):
        bpy.data.objects.remove(obj, do_unlink=True); continue
    obj.data.materials.clear(); obj.data.materials.append(green)
    for f in obj.data.polygons: f.material_index = 0
sc = bpy.context.scene
sc.render.engine = 'CYCLES'; sc.cycles.device = 'CPU'; sc.cycles.samples = 48; sc.cycles.use_denoising = True
sc.render.resolution_x = sc.render.resolution_y = size
sc.view_settings.view_transform = 'Standard'
world = bpy.data.worlds.new('Studio'); world.use_nodes = True
world.node_tree.nodes['Background'].inputs[0].default_value = (.78, .78, .78, 1)
world.node_tree.nodes['Background'].inputs[1].default_value = 1.0
sc.world = world
for name, loc, power in [('Key', (-1.5, -2.5, 2.2), 160), ('Fill', (1.8, -2.2, 1.0), 90)]:
    data = bpy.data.lights.new(name, 'AREA'); data.energy = power; data.size = 3
    light = bpy.data.objects.new(name, data); sc.collection.objects.link(light); light.location = loc
    light.rotation_euler = (Vector((0, 0, .5)) - light.location).to_track_quat('-Z', 'Y').to_euler()
data = bpy.data.cameras.new('Front'); cam = bpy.data.objects.new('Front', data); sc.collection.objects.link(cam); sc.camera = cam
data.type = 'ORTHO'; data.ortho_scale = 1.3
cam.location = (0, -4, .5); cam.rotation_euler = (Vector((0, 0, .5)) - cam.location).to_track_quat('-Z', 'Y').to_euler()
sc.render.filepath = os.path.abspath(a[1]); bpy.ops.render.render(write_still=True)
