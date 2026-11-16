# Character system

The `codex/unified-characters` worktree rebuilds human assembly around an intact body and head.
Run `cd game && npm run dev`, then open `/characters.html`. This worktree's independent preview
uses `http://127.0.0.1:5197/characters.html`.

## Assembly

- `human_m_base.glb` and `human_f_base.glb` contain a continuous bald body/head surface, a standard
  20-bone rig, face-shape morphs and animation clips. There is no runtime head/neck splice.
- Skin material regions permit coverage underneath equipment. The mesh shares positions and smooth
  normals across those region borders. Bare skin uses one tint response, including the neck.
- Four outfits per body are separate skinned attachments: padded tunic, leather, plate and robe.
  They rebind to the base skeleton by bone name and retain the exact inverse bind matrices.
  Equipping armor never selects a different body or head. Missing armor is reported and leaves
  the base visible rather than hiding it.
- Leather has tailored panels, sleeves, a belt, layered hip protection and closed boots. Plate
  includes its own shoulders. The old shoulder module is not added again on unified bodies.
- Two real eyeballs, curved iris caps and pupils sit inside openings in the face. They use ordinary
  depth-tested, nonemissive PBR materials. Globe depth is fitted against the complete eyelid rim;
  the upper lid covers part of the iris. There is no painted-iris overlay on the unified route.
- Hair is fitted against each base's actual scalp. Neutral strand textures take the chosen hair
  color; authored loose groups have restrained spring motion while the scalp roots stay fixed.
  See [blender/UNIFIED_GROOM.md](blender/UNIFIED_GROOM.md).
- Three face shapes, bald/hair/beard options, eight hair colors, six eye colors and six skin tones
  are available in the Forge. Weapons, shields, rings and amulets remain visible attachments.

`game/src/render/unified-character.ts` owns shared assembly for the Forge, map and portraits.
`character.ts` loads character assets and creates instances. Instances own their materials,
procedural eye geometry and skeleton clones; source geometry/textures stay cached. Nonhuman and
older assets retain their existing assembly path.

The Forge supports orbit/zoom, full-body/portrait/back views, animation previews, pause, turntable,
PNG capture, presets, local save/load and validated JSON exchange. Loading a saved Forge design
through a unit's Appearance dialog changes its name/body/look through the normal simulation
action; equipment continues to follow the game's armory rules.

## Rebuilding

The modeling references are in `art/assets/unified/`. They are bald T-poses with neutral close-fitting
reference clothing; processing replaces that surface coloring with skin. The base has smooth,
non-detailed anatomy. Local ComfyUI/TRELLIS.2 produced the complete meshes. The user's Hunyuan3D
example was inspected from front/side/back as a comparison; it is not a shipped runtime dependency.
The user's leather concept guided the revised tailored silhouette.

Comfy blueprints remain editable source; compiled workflows and raw meshes are ignored outputs:

```bash
cd art
comfy --json assets push
comfy --json workflow compose blueprints/unified/male.yaml --lib fragments --out outputs/unified/male.compiled.json
comfy --json workflow validate --workflow outputs/unified/male.compiled.json
# Run locally, collect its GLB as outputs/unified/male-source.glb; repeat female.yaml.
```

From the repository root, for each `male/m` or `female/f` pair:

```bash
blender -b -t 2 --factory-startup -P blender/rig_humanoid.py -- \
  art/outputs/unified/male-source.glb art/outputs/unified/male-rigged.glb \
  --tris 30000 --tex 2048 --quality 92 --voxel 0.006
blender -b -t 2 --factory-startup -P blender/unified_body.py -- \
  --input art/outputs/unified/male-rigged.glb --gender m
blender -b -t 2 --factory-startup -P blender/unified_armor.py -- \
  --body game/public/assets/models/units/human_m_base.glb --gender m --out game/public/assets/models/items
blender -b -t 2 --factory-startup -P blender/unified_groom.py -- \
  --body game/public/assets/models/units/human_m_base.glb --gender m --out game/public/assets/models/hair
python3 art/tools/build_manifest.py
```

The body builder welds imported UV seam duplicates before editing topology, clears imported split
normals, relaxes reconstruction noise locally on the face, cuts eyelid apertures, preserves facial
color detail as neutral skin modulation, adds fitted brows and exports two face morphs at zero.
Original source assets and the previous head/body generation remain available.

For a raw reconstruction whose proportions look compressed, `blender/body_proportions.py` creates
a separate unrigged study with independent leg/torso factors before fitting any equipment. The
provided comparison uses `--legs 1.14 --torso 1.05`, keeping the head and feet dimensions before
normalizing height. This study is not substituted into the shipped body without a new rig/refit.

## Verification

```bash
cd game
npm run typecheck
npm test -- --maxWorkers=2
npm run build
node tools/verify-unified-assets.mjs
CDP_PORT=19479 node tools/verify-characters.mjs http://127.0.0.1:5197/characters.html ../playtest/unified-characters
```

The binary check verifies connected body/head geometry, matching seam normals, normalized skin
weights, neutral face morphs, eyelid/globe clearance, groom source hashes and compatible armor inverse binds in shipped
GLBs. Runtime tests cover attachment remapping, material/resource ownership, coverage fallback,
eye orientation/physical lid occlusion and fixed-root hair motion. The browser matrix loads real
assets and exercises both bodies, outfits/walks, face/hair/color choices, equipment, animation,
save/load and desktop/mobile layout. Screenshots require visual review as well as automated checks.

## Current art limits

This is an integrated stylized character rebuild, not finished AAA character art. Generated facial
forms and hands still need authored retopology and texture polish for close portraits. Face choices
are restrained shape variants; there is no expression rig. Hair uses textured mesh locks/cards and
limited secondary motion, not strand simulation. Robes and hip panels follow bones rather than
simulated cloth. The strategy camera remains the strongest presentation.
