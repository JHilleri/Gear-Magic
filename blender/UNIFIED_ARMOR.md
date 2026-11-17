# Unified fitted armor

`unified_armor.py` generates ten standalone skinned outfits (five styles: `commoner`, `tunic`,
`leather`, `plate`, `robe`) against the final
continuous human base bodies. It uses no additional ComfyUI jobs.

```sh
/snap/blender/current/blender -b -t 2 --factory-startup \
  -P blender/unified_armor.py -- \
  --body game/public/assets/models/units/human_m_base.glb \
  --gender m --out game/public/assets/models/items
```

Repeat with `human_f_base.glb` and `--gender f` for the female fit. `--styles
leather` limits the build. `--preview '/tmp/armor-{gender}-{style}.png'` renders
posed CPU previews, using two threads. Preview head and hand materials are the
source's untinted white; game skin color and eyes are handled by the runtime.

## Construction

The visible jacket, sleeves, trousers and boots have regular garment topology.
They are sized from measured body cross sections, with a smooth tailored
front envelope rather than a duplicate of sculpted muscles. A concealed crotch
gusset closes the junction between independent trouser tubes. The body/head is
not included as an extra character mesh.

Leather has a lapped chest reinforcement, shoulder caps, bound panel edges,
small stitches, brass fittings, a wide belt and overlapping short tassets.
Tunic uses blue cloth; plate uses steel with clean constructed pauldrons,
vambraces and greaves; robe adds a continuous skirt. Toe geometry is replaced by closed rounded boots
with a welt and sole. Leather grain and tangent-space normal textures are
embedded, and every joined part shares one populated UV set.

Every garment and ornament is skinned to the source's 20-bone rest rig. The
jacket yoke follows the chest/spine instead of nearest-arm weights, preventing
arm lowering from pulling the neckline apart. Sleeves and boots use interpolated
source weights. Tassets and the continuous robe skirt follow the hips.

## Verification, 2026-11-16

Built against the final base exports with the exposed-neck skin mask. All eight
GLBs contain one skinned mesh and one skin, with all 20 matching joint names, valid UVs,
finite geometry and normalized weights. Maximum weight-sum error is 1.2e-7.
Maximum inverse-bind re-export difference is 1.47e-6 for male and 3.94e-6 for
female. No animation clips are duplicated in the attachments.

| Outfit | Male triangles | Female triangles |
| --- | ---: | ---: |
| Tunic | 17,284 | 17,278 |
| Leather | 18,680 | 18,674 |
| Plate | 19,908 | 19,902 |
| Robe | 16,600 | 16,594 |

The collar follows the neck, dips to .825 at the front and .845 at the back,
and intentionally overlaps the body skin slightly. A narrow collar-facing
attachment uses the exact hidden torso surface and weights beside the visible
neck to close the material-mask junction without raising the collar.

The files are approximately 0.66–0.77 MB each. Male and female leather have
been rendered with upper arms lowered by 0.95 radians. The final plate and
robe also receive posed render checks. Runtime animation/camera checks remain
part of integration validation.

## Practical limits

These are authored procedural stylized outfits, not production AAA scanned or
sculpted garments. They have no cloth simulation, collision solver or cloth
blend shapes. The robe omits concealed trouser geometry so it cannot poke
through the skirt. The short tassets and long robe skirt follow the hips; extreme
leg poses can intersect these layers. Close portrait cameras can reveal the
simple panel topology and should be reviewed separately from gameplay scale.

The final posed female preview is `art/outputs/unified/armor-qa/female-leather-posed.png`.
The collar-facing junction is closed; close views can still reveal the simple
neckline topology and triangular skin/material boundary.

## Generated outfits (all five shipped styles)

The shipped `armor_<gender>_<style>.glb` files are no longer tailored by this script. Each is a
textured mesh from image-to-3D, fitted by `unified_clothes.py`. The tailor above remains as a
fallback: running it overwrites the generated file of the same style.

```bash
blender -b -t 2 --factory-startup -P blender/render_mannequin.py -- \
  game/public/assets/models/units/human_f_base.glb art/outputs/unified/clothes/mannequin_f.png   # and _m
cd art
python3 tools/gen.py manifests/clothes.json    # Qwen Image 2.1 edit dresses the mannequin ("refs"), ~1.5 min each
python3 tools/i2m.py src_clothes               # TRELLIS.2, ~1 min each
cd ..
blender/fit_clothes.sh [preview-dir]           # unified_clothes.py for every style and both bodies
```

The picture the edit model dresses is a render of the body itself, so the generated mesh comes
back in the body's pose and proportions and only needs registering (floor, top of the arms, span).
`unified_clothes.py` then:

- cuts away the green mannequin connected to the head or a hand (neck, open collar, wrists);
- with `--undersuit R,G,B`, paints mannequin left between armor pieces (armpits, elbows, a robe's
  slit) as an under-garment, since the game hides the skin there and a cut would be a hole;
- weights the garment from the body's skin: nearest skin, except that beyond the shoulder and
  outside the torso's outline only the arm is consulted, so wide sleeves follow the arm;
- with `--skirt K`, hangs a long skirt partly from the hips so it does not split like trousers;
- adds a lining: the hidden skin drawn in 3 mm, decimated, and coloured per vertex like the
  nearest cloth, so a gap under a pauldron, inside a collar or at a tear never shows a hollow figure;
- adds a `Skin_neckline` patch of the body's chest and neck exactly where mannequin showed in the
  collar, which the runtime tints to the character's skin.

Free ComfyUI's memory (`POST /free`) before the edit step: with other models loaded it returned
noise. Very wide hanging sleeves do not rig well; ask for sleeves that do not hang. Refit after a
body rebuild (`fit_clothes.sh`).
