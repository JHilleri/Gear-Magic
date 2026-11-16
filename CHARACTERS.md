# Character system

The `codex/character-studio` branch adds a Warcraft-inspired character workshop and shares its
appearance, fitted bodies, equipment sockets and armor modules with the game and its portraits.
Run `cd game && npm run dev`, then open `/characters.html`. This worktree's preview runs on
`http://127.0.0.1:5197/characters.html` independently of the main checkout.

## Included

- Male and female body meshes, each fitted for travel clothes, padded tunic, leather, plate and robe.
- Three face meshes per body type; eleven hair meshes plus bald, five beards plus clean-shaven,
  eight hair colors, six eye colors, and six skin tones.
- Seven visible main-hand items, shield, hand-worn ring and chest-worn amulet. Two-handed weapons
  clear the offhand. New blue-steel/gold plate pauldrons follow the arm bones on both body types.
- Full-body/portrait/back cameras, orbit/zoom, idle/walk/combat/cast/work/hit/death previews,
  turntable, pause, PNG capture, four loadout presets, local save/load and validated JSON exchange.
- Title/pause-menu entry. The unit Appearance dialog can load a saved Forge appearance. Applying
  it changes name/body type/look through the existing simulation action without granting equipment.
- Gendered human leaders retain their face and display their actual equipped armor.

Skin is optional in saved appearances. Old saves retain their original painted skin; new units get
a deterministic tone from their private appearance RNG, without advancing gameplay randomness.
Skin tint preserves texture variation and eye whites. Clothing keeps its authored color.

## Code and assets

`game/src/render/character.ts` provides `loadCharacterAssets()` and `createCharacter()`. Its loader
decodes only character assets, two at a time. Instances clone materials and skeletons; shared source
geometry/textures stay cached. `dispose()` releases instance-owned resources.

`game/src/render/character-regalia.ts` supplies bone-mounted plate shoulders and visible jewelry.
The same helpers run in the studio, map and portrait renderer. `render/appearance.ts` fits faces,
hair and beards to the selected body/head, and handles color shaders.

The studio caps rendering at 30 fps and DPR 1.5, and skips rendering while hidden. It does not start
ComfyUI or a local image model. The new shoulder module was authored in Blender; existing character
GLBs and animations are reused. Original character GLBs are preserved.

Rebuild the new assets from the repository root:

```bash
blender -b -t 2 --factory-startup -P blender/character_regalia.py -- --out game/public/assets/models/characters
python3 blender/repair_robe_weights.py
python3 art/tools/build_manifest.py --check
```

`blender/regalia-source.blend` keeps the editable shoulder parts and modifiers. The exported GLB
merges parts into four material groups. It is centered on a shoulder, +X outward/+Y up/+Z forward,
with dimensions relative to a 1.0-high human. The female fit scales the module to 85%; the opposite
shoulder mirrors X.

The female robe's original skirt weights crossed both legs, shins and feet, pulling its dark
inner faces through the front in idle. `repair_robe_weights.py` writes a sibling `human_f_robe_v2.glb`
that binds the continuous skirt to the pelvis and blends at the waist. Boots retain leg weights.
The same recipe repairs the hanging front tabard in `human_f_heavy_v2.glb`, leaving metal legs
and side plates articulated.
Only joint/weight buffer bytes change; geometry, textures, skeleton and animations are identical.
The manifest builder keeps the canonical `human_f_robe` key and points it at this repair.

## Verification

```bash
cd game
npm run typecheck
npm test -- --maxWorkers=2
npm run build
cd ..
python3 blender/validate_characters.py
python3 blender/repair_robe_weights.py --check
```

The Python checks inspect 41 actual GLBs for geometry, skins, clips and sockets, and reproduce the
cloth repairs byte-for-byte. Tests cover appearance/save compatibility, material/resource isolation,
equipment attachment rules, mirrored armor modules and JSON validation.

With a separate CDP browser and the dev server running:

```bash
cd game
CDP_PORT=19479 node tools/verify-characters.mjs http://127.0.0.1:5197/characters.html ../playtest/characters
```

This runs 85 browser checks over the real rendered models: both bodies in all outfits and their walks, all faces,
hair/beards/colors/skin tones, weapons, animations, UI save/load and two-handed equipment changes.
It checks missing assets, browser exceptions and desktop/mobile overflow. Screenshots and
`verification.json` go into `playtest/characters/`. Visual checks remain necessary: counts alone
cannot establish that a hairstyle or armor fits well.

Verified on 2026-11-16: the complete simulation/UI/renderer suite passed **516 tests** (3 opt-in
tests skipped); after the final cloth/leader changes, **32 focused tests** and the production build
passed again. The final browser matrix passed **85 checks** with no missing assets, shader errors
or exceptions. The packaged production page loaded the fitted female plate model successfully.
An actual new-game session also loaded a saved Forge appearance through the Appearance dialog,
applied it, and retained identical equipment and base stats. Evidence is in `playtest/characters/`.

## Art quality boundary

This is a functioning, stylized character system and an inspectable art iteration environment.
The inherited generated meshes still have coarse hands, rigid fingers, some hair/neck seams and
baked surface irregularities visible in extreme close-ups. The robe uses a pelvis-driven skirt,
without cloth simulation. Hair is mesh-based. There is no facial animation or expression system.
Those areas need authored retopology, textures and animation work before claiming AAA character
quality. The full-body strategy-game view is the current strongest presentation.
