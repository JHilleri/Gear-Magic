# Blender asset pipeline (headless)

Turns TRELLIS.2 / Pixal3D image-to-3D outputs (`art/outputs/3d/<category>/<id>.glb`, ~20k–60k tris,
2048² PBR textures, Y-up glTF) into the game-ready GLBs listed in `game/public/assets/manifest.json`.
Everything is fully automatic; the only per-asset knobs are the documented tables in
`process_static.py` (sizes, grip points) and an optional `--yaw` override.

Blender 5.2 (`/snap/bin/blender`), run with `blender -b -P <script> -- <args>`. Previews use Cycles on
the CPU. No add-ons or extra Python packages are needed (Blender's bundled numpy is used).

| file | role |
|---|---|
| `batch.py` | **plain python3** driver: processes every model in `art/outputs/3d/**`, then rebuilds the manifest |
| `rig_humanoid.py` | auto-rig + skin + animate a T-pose humanoid → `models/units/<id>.glb` |
| `rig_anim.py` | pose solver (2-bone IK, item aiming) and the procedural clips (imported by `rig_humanoid.py`) |
| `rig_preview.py` | contact sheet of a rigged GLB (rest pose, bone x-ray, key frames of every clip, front/side) |
| `process_static.py` | normalise / clean / decimate buildings, props, items, mounts, monsters |
| `preview.py` | turntable of a static GLB with hex outline, front arrow, origin marker, 1.0-tall reference |
| `common.py` | shared helpers (import + join, floater removal, decimation, textures, atomic GLB export) |
| `../art/tools/build_manifest.py` | plain python3: scans `game/public/assets` and writes `manifest.json` |

## Quick start

```bash
cd /home/jeanh/projects/magic-4x
python3 blender/batch.py                 # everything new or out of date (4 parallel Blender jobs)
python3 blender/batch.py --force --only human_heavy,sword
python3 blender/batch.py --cats items,props --no-preview
python3 art/tools/build_manifest.py --check   # rebuild manifest + list what is still missing
```

`batch.py` skips outputs that are newer than both their source and the scripts. Items run first so unit
previews can show the real weapons. Logs and previews go to `art/outputs/processed/<category>/<id>.{log,png}`.

## rig_humanoid.py

```bash
blender -b -P blender/rig_humanoid.py -- in.glb out.glb [--preview sheet.png] [--tris 9000] [--tex 1024] \
        [--quality 82] [--voxel 0.008] [--items DIR] [--no-anim]
```

1. **Import / clean**: all meshes joined with transforms applied, near-duplicate verts merged, loose floaters
   removed (tiny islands, small far-away islands).
2. **Orientation**: glTF Y-up is trusted unless the vertical extent is clearly not the long axis; upside-down
   is detected (two feet blobs vs one head blob); the arm span is put on X. **Facing** is decided by the toes
   (the lowest vertices reach in front of the ankles) plus a weaker face/skull cue; the model is turned to face
   Blender −Y = glTF **+Z**.
3. **Normalise**: height 1.0, lowest point on z=0, x centred on the torso, y centred on the ankles.
4. **Landmarks** on a dense area-uniform surface sample (robust to tessellation): arm tips, thickness and centre
   line from the pure-arm region; torso edge from the front half of the chest just below the armpit (capes wrap
   the back); wrist = narrowest point with a 73 % proportion prior; neck = deepest front recession under the chin;
   crotch = where the two leg cores merge (scan restricted to the leg depth band so tabards / capes do not close
   the gap; sparse hem bins ignored; robes fall back to proportions); knees, ankles, toes from the leg clusters.
5. **Armature** with exactly the ASSETS.md bones and hierarchy (`root` is non-deforming), consistent rolls
   (local Z forward for spine/limbs, up for feet).
6. **Skinning**: bone-heat weights on the full-resolution source mesh, else on a cleaned voxel remesh
   (watertight proxy), else on the render mesh, else distance weights; transferred to the decimated render
   mesh with a Data Transfer (nearest face, interpolated). Anatomical masks: hard left/right leg split below
   the crotch, no arm weights on the torso below the armpit or on anything hanging under the T-pose arm (capes)
   except a band along the forearm (wide sleeves), no torso weights on the outer arm, head/neck limits.
   Cloth well outside both leg axes below the hips (robes, capes, tabards) blends to the pelvis instead of
   tearing between the thighs. Max 4 influences, crumbs < 0.02 dropped, normalised.
7. **Sockets** (empties exported as glTF nodes, Blender local +Z → node +Y, local −Y → node +Z):
   * `grip.R` — right palm; item **+Y along the thumb**, item **+Z along the knuckles** (the cutting edge).
   * `hold.L` — same convention in the left palm (**the bow is held here**, see attack_ranged).
   * `grip.L` — back of the left forearm for shields: shield +Y toward the elbow, shield face (+Z) outward
     (back of the hand). With the arm hanging the shield is upright at the side, face out.
   * `chest_socket` — front of the chest (trinkets), +Z forward.
8. **Clips** (30 fps, one glTF animation per action): `idle` (2.0 s loop, breathing, arms down),
   `walk` (0.8 s loop, IK-planted feet), `attack_melee` (1.0 s overhead diagonal swing, right hand),
   `attack_ranged` (1.1 s bow draw: left arm aims forward, right hand to the cheek, release), `cast` (1.0 s),
   `hit` (0.5 s), `death` (1.2 s, falls backward, last frame lies on the ground — clamp it), `work` (0.9 s
   loop, hammering), `ride_idle` (2.0 s loop), `ride_attack` (1.0 s). Held items are aimed automatically
   (forearm twist + wrist deviation) so a sword points forward-up in idle, follows the swing arc, a bow
   and a staff stay upright.
9. **Export**: decimated to `--tris`, textures downscaled to `--tex` and stored as JPEG (WebP when alpha is
   needed), skins with 4 influences. The default node pose in the file is **idle frame 0** (the T-pose
   is only the bind pose), so a unit never shows a T-pose even before an animation starts.
10. Sidecar `out.meta.json`: height, clip durations, `walk_speed`, `seat`, landmarks.

### Facts the renderer relies on

* Unit height 1.0 at the feet origin, front +Z. Scale to `UNIT_HEIGHT`.
* three.js `GLTFLoader` strips dots from node names: `grip.R` → `gripR`, `hold.L` → `holdL`, `grip.L` → `gripL`,
  `chest_socket` stays, bones `upperarm.L` → `upperarmL` etc. (animation tracks are renamed consistently).
* **walk**: in-place cycle whose planted feet move at `walk_speed` model heights per second (≈ 0.55–0.6, see the
  sidecar). For a ground speed `v` (world units/s): `action.timeScale = v / (walk_speed * UNIT_HEIGHT)`.
* **ride_idle / ride_attack** lower the root so the **seat (crotch) is at the origin**: place the unit's origin
  at the mount's `saddle` point (manifest) and play the ride clip.
* **death** ends lying on the back, 1.2 s long; use `clampWhenFinished`.
* Bows go in `hold.L` (left hand), every other main-hand item in `grip.R`, shields on `grip.L`.

## process_static.py

```bash
blender -b -P blender/process_static.py -- in.glb out.glb --kind building|prop|item|mount|monster \
        [--id name] [--tris N] [--tex N] [--quality 82] [--yaw DEG] [--preview out.png]
```

| kind | normalisation | default tris / tex |
|---|---|---|
| building | walls snapped to the axes (smallest turn, so the camera-facing side stays front), ground = area-weighted 0.4th percentile height at z=0, centred, footprint radius 0.82 | 14000 / 1024 |
| prop | ground at z=0, centred on its base, height and max radius from `PROPS` (pine 0.75, oak 0.7, deadtree 0.62, rock 0.3, peak 1.2, crystal 0.5, bush 0.28, ruin 0.45, reeds 0.4) | 1500 / 512 |
| item | long axis vertical; edge/face toward −Y (glTF +Z): blades by the blade's width axis, axes/hammers by the head's offset, bows with the string toward +Y; origin at the grip from `ITEMS` (sword 12 % of 0.55, spear 38 % of 1.0, axe 22 % of 0.5, bow 50 % of 0.65, staff 40 % of 0.9, wand 25 % of 0.25, tools/hammer 18 % of 0.35); shields 0.4 tall, origin at the centre of the back, face −Y | 2500 / 512 |
| mount | long axis on Y, head toward −Y (camera prior + head-height cue), withers height from `MOUNTS` (horse/nightmare 0.6, wolf 0.5); saddle point printed as JSON and stored in `<out>.meta.json` as glTF `[x, y, z]` | 6000 / 1024 |
| monster | quadrupeds oriented like mounts, bipeds keep the image front; height from `MONSTERS` (golem 1.1, elemental 1.0, spider 0.45, wolf 0.45) | 6000 / 1024 |

All kinds: floaters removed, normals recalculated, collapse decimation (UVs kept), shading smooth or by
angle (buildings/items/rocks), sidecar `<out>.meta.json` with the glTF bounding box.

## Previews

```bash
blender -b -P blender/rig_preview.py -- unit.glb sheet.png [--items DIR] [--cell 200] \
        [--rows "idle@0,1;walk@0.2"] [--views front,side,back,three]
blender -b -P blender/preview.py -- model.glb out.png [views] --kind building
```

## Notes / limits

* TRELLIS meshes are single closed shells: cloth that hides the crotch (robes) uses proportional leg
  placement; long capes are weighted to the pelvis/spine and may clip the calves slightly in a walk.
* Hands are rigid (no finger bones); held items pass through the open-hand mesh at the palm.
* Any new T-pose humanoid works as long as both arms are roughly horizontal (±25°) and the feet are on the
  ground; A-poses are not supported.
