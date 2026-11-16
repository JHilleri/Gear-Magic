"""Repair female robe skinning without re-exporting its geometry, textures or clips.

python3 blender/repair_robe_weights.py [--check]

The original skirt mixed weights across both legs, shins and feet. In idle this
pulled its dark inner faces through the front fabric. Bind the continuous skirt
to the pelvis, tapering into the original weights at the waist. Boots keep their
leg weights. The sibling GLB differs only in joint/weight accessor bytes.
"""
import hashlib
import json
import struct
import sys
from pathlib import Path

ASSETS = Path(__file__).resolve().parents[1] / 'game' / 'public' / 'assets'
SOURCE = ASSETS / 'models/units/human_f_robe.glb'
TARGET = SOURCE.with_name('human_f_robe_v2.glb')


def repair(source, tabard=False):
    data = bytearray(source)
    json_length = struct.unpack_from('<I', data, 12)[0]
    document = json.loads(data[20:20 + json_length])
    binary_start = 28 + json_length
    formats = {5121: 'B', 5123: 'H', 5125: 'I', 5126: 'f'}
    components = {'SCALAR': 1, 'VEC2': 2, 'VEC3': 3, 'VEC4': 4}

    def accessor(index):
        a = document['accessors'][index]
        view = document['bufferViews'][a['bufferView']]
        assert not a.get('normalized'), 'Expected float weights/non-normalized joints'
        fmt = '<' + formats[a['componentType']] * components[a['type']]
        return (a['count'], binary_start + view.get('byteOffset', 0) + a.get('byteOffset', 0),
                view.get('byteStride', struct.calcsize(fmt)), fmt)

    joints = document['skins'][0]['joints']
    hips = next(i for i, node in enumerate(joints) if document['nodes'][node]['name'] == 'hips')
    changed = 0
    for mesh in document['meshes']:
        for primitive in mesh['primitives']:
            a = primitive['attributes']
            count, po, ps, pf = accessor(a['POSITION'])
            _, jo, js, jf = accessor(a['JOINTS_0'])
            _, wo, ws, wf = accessor(a['WEIGHTS_0'])
            for i in range(count):
                x, y, z = struct.unpack_from(pf, data, po + i * ps)
                if not .075 < y < .56:
                    continue
                # Include the low hem outside the boots' envelope, otherwise the
                # remaining shin weights tear it at the bottom during a walk.
                if not tabard and y < .16 and abs(x) < .125 and abs(z) < .085:
                    continue
                # The plate body's hanging front tabard has the same crossed-leg
                # weights. Keep the metal legs and side plates articulated.
                if tabard and not (.2 < y and abs(x) < .08 and z > .07):
                    continue
                blend = min(1, max(0, (.56 - y) / .07))
                before_joints = struct.unpack_from(jf, data, jo + i * js)
                before_weights = struct.unpack_from(wf, data, wo + i * ws)
                weights = {}
                for joint, weight in zip(before_joints, before_weights):
                    weights[joint] = weights.get(joint, 0) + weight * (1 - blend)
                weights[hips] = weights.get(hips, 0) + blend
                selected = sorted(weights.items(), key=lambda item: item[1], reverse=True)[:4]
                selected += [(0, 0)] * (4 - len(selected))
                total = sum(weight for _, weight in selected)
                struct.pack_into(jf, data, jo + i * js, *(joint for joint, _ in selected))
                struct.pack_into(wf, data, wo + i * ws, *(weight / total for _, weight in selected))
                changed += 1
    assert changed > 100, 'No robe skirt found'
    return bytes(data), changed


def main():
    for stem, tabard in [('human_f_robe', False), ('human_f_heavy', True)]:
        src = SOURCE.with_name(stem + '.glb')
        dst = src.with_name(stem + '_v2.glb')
        source = src.read_bytes()
        repaired, count = repair(source, tabard)
        meta = json.loads(src.with_suffix('.meta.json').read_text())
        meta['repair'] = {'source': src.name, 'source_sha256': hashlib.sha256(source).hexdigest(),
                          'script': 'blender/repair_robe_weights.py', 'vertices': count}
        if '--check' in sys.argv:
            assert dst.read_bytes() == repaired, 'Repaired model differs from the reproducible recipe'
            assert json.loads(dst.with_suffix('.meta.json').read_text()) == meta
            print(f'{stem} repair verified: {count} vertices; source, geometry, textures and clips preserved.')
        else:
            dst.write_bytes(repaired)
            dst.with_suffix('.meta.json').write_text(json.dumps(meta, indent=1) + '\n')
            print(f'Wrote {dst}: {count} cloth vertices repaired.')


if __name__ == '__main__':
    main()
