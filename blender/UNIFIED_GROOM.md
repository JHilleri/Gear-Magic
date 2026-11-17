# Fitted unified-body grooms

```bash
blender -b -t 2 --factory-startup -P blender/unified_groom.py -- \
  --body game/public/assets/models/units/human_m_base.glb \
  --gender m --out game/public/assets/models/hair
blender -b -t 2 --factory-startup -P blender/unified_groom.py -- \
  --body game/public/assets/models/units/human_f_base.glb \
  --gender f --out game/public/assets/models/hair
```

`--styles short,curly,beard_short` limits an iteration. `--meta FILE` overrides the
default body `.meta.json` sidecar. A measured `head: {x,y,z,depth}` is preferred;
without it the script estimates the skull frame from the bind-pose mesh.

The builder reads the continuous body's skull geometry in its bind pose. It
casts rays from inside that skull, then places a dark root cap, rounded swept
locks and fine layered strand cards directly above the measured surface. The forehead/temple/nape
hairline follows the head; ears and shoulders are not used to scale a wig. Card
offsets range from sub-millimeter cropped hair to a few millimeters for curls,
relative to a 1.0-high character. There are no separately generated heads.
Long hair has a front part, overlapping wavy layers and face-framing locks.
Braids contain three interlacing rounded bundles and an unplaited end tuft.
Beards follow curved cheek and jaw boundaries, with a fitted root layer and
stratified random fibres instead of visible rows or a square mouth cutout. A
packed PNG alpha falloff feathers that root layer into the face, and fibre
density decreases near its edges. Lower-jaw rays reject neck hits.

Outputs use **global body bind coordinates**, not the old generic head frame:

- `unified_m_<style>.glb` and `unified_f_<style>.glb`: eleven haircuts each.
- `unified_m_beard_<style>.glb`: short, full, moustache, goatee and long.
- `.meta.json`: source SHA-256, fit frame, bounds, triangle count, scalp clearance
  and dynamic-node names.

Materials begin `Hair_`, use an embedded neutral strand texture, and are matte,
nonmetallic and nonemissive. The runtime multiplies their color per character.
Hair scenes should be parented through the head's inverse bind transform.
`swing_*` groups have pivots at their roots. Long, bob and swept hair use one
pivot for each hanging layer, so every lock keeps its own root fixed. Runtime
spring rotations can move the ends while leaving the fitted scalp anchored.

Each style uses fewer than 8,000 triangles. These are layered mesh-card grooms,
with restrained secondary motion. They are not per-strand physics or salon-grade
hair simulation. Face/jaw morphs that substantially alter the scalp or beard
surface need corresponding groom morphs or a refit.

## Generated wigs

`unified_f_wavy` is not built from cards. It is a sculpted wig from image-to-3D, fitted to the
body by `unified_hair_piece.py`:

```bash
cd art
python3 tools/gen.py manifests/hair_wavy.json            # blonde wig on a green mannequin (Qwen Image)
python3 tools/i2m.py src_hair --only hair_wavy1           # TRELLIS.2, about 8 minutes
cd ..
blender -b -t 2 --factory-startup -P blender/fit_hair.py -- art/outputs/3d/hair/hair_wavy1.glb \
  art/outputs/unified/qwen/hair_wavy_headframe.glb --kind hair --maps <processed heads dir> \
  --zmin -2.7 --tris 9000 --tex 1024 --low-x 0.68
blender -b -t 2 --factory-startup -P blender/unified_hair_piece.py -- \
  --piece art/outputs/unified/qwen/hair_wavy_headframe.glb --style wavy \
  --body game/public/assets/models/units/human_f_base.glb --gender f --out game/public/assets/models/hair
```

`fit_hair.py` keys out the mannequin and greys the texture (the game tints it). The piece script
maps the head frame onto this body's skull, seats the wig on the scalp, cuts side locks where they
meet the shoulders and slides what hangs behind the neck clear of the back. The piece is rigid on
the head bone (no swing groups) and must be refitted after a body rebuild; `unified_groom.py`
does not regenerate it. A new style also needs an entry in `HAIR_STYLES` and the `HairStyle` type.
