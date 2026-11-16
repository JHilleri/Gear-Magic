# Unified fitted armor

`unified_armor.py` generates eight standalone skinned outfits against the final
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
