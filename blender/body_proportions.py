"""Reversible height-proportion study on a raw body, before rigging and fitting equipment.

Elongates legs and torso independently, retaining the head and feet dimensions.
The source file is never overwritten. Output is normalized to one unit of height.
"""
import argparse
import json
import sys
from pathlib import Path
import bpy
import numpy as np

sys.path.insert(0,str(Path(__file__).resolve().parent))
import common as C
import rig_humanoid as RH


def main():
    p=argparse.ArgumentParser()
    p.add_argument('source');p.add_argument('out')
    p.add_argument('--legs',type=float,default=1.14)
    p.add_argument('--torso',type=float,default=1.05)
    a=p.parse_args(C.script_args())
    src=Path(a.source).resolve();out=Path(a.out).resolve()
    if src==out: raise ValueError('Write a separate study, preserving the source')
    if not .8<=a.legs<=1.3 or not .8<=a.torso<=1.3: raise ValueError('Proportion factors must be within .8–1.3')
    C.reset_scene();obj=C.import_joined_mesh(str(src))
    RH.orient_upright(obj);RH.orient_facing(obj);RH.normalize(obj)
    v=C.verts_np(obj)
    # Foot, leg, torso, head. A height-normalized preview exposes relative changes.
    anchors=np.array([0,.08,.49,.84,1.])
    distances=np.diff(anchors)*np.array([1,a.legs,a.torso,1])
    mapped=np.r_[0,np.cumsum(distances)]
    v[:,2]=np.interp(v[:,2],anchors,mapped)
    v/=mapped[-1]
    C.set_verts_np(obj,v);C.shade(obj,'smooth')
    C.export_glb(str(out),animations=False,skins=False)
    record={'source':str(src),'legs':a.legs,'torso':a.torso,'height_before_normalization':float(mapped[-1]),
            'anchors_in':anchors.tolist(),'anchors_out':(mapped/mapped[-1]).tolist(),
            'note':'Unrigged proportion study. Rig this output and refit attachments before game use.'}
    out.with_suffix('.proportions.json').write_text(json.dumps(record,indent=2)+'\n')
    print(json.dumps(record),flush=True)


if __name__=='__main__': main()
