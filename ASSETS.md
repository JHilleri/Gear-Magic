# Asset contract (game/public/assets)

The renderer loads everything listed in `game/public/assets/manifest.json`; any entry that
is missing falls back to procedural geometry, so the game is always playable.

## Conventions (all GLB, glTF 2.0, Y-up, meters ≈ world units, hex radius = 1.0)

| kind | path | origin | facing | size |
|---|---|---|---|---|
| unit body (rigged) | `models/units/{race}_{body}.glb` race ∈ human/orc/undead, body ∈ commoner/light/heavy/robe/leader | feet center | +Z | height ≈ 1.0 (renderer scales to `UNIT_HEIGHT`) |
| unit body, gendered (rigged, **bald**) | `models/units/{race}_{m\|f}_{body}.glb` body ∈ commoner/padded/light/heavy/robe (humans) | as above | +Z | as above; used before `{race}_{body}` for a unit with a gender |
| hair / beard piece | `models/hair/hair_{style}.glb`, `models/hair/beard_{style}.glb` | **head frame**: crown of the skull, on the centre line, at the occiput | +Z (forehead at z = 1) | unit = skull depth, forehead to occiput; light grey texture (tinted in game) |
| face | `models/heads/head_{m\|f}{n}.glb` (n = 1…3) | head frame, as hair | +Z | a bald head with its neck as a short tapered plug under the throat line; pale grey irises (tinted in game) |
| item | `models/items/{item}.glb` + `models/items/shield_{race}.glb` | grip point (center of the hand) | long axis along **+Y** (blade/shaft up), edge/face toward +Z | real proportions relative to a 1.0-tall unit (sword ≈ 0.45 long) |
| mount | `models/mounts/{horse,wolf,nightmare}.glb` | ground center | +Z | horse height ≈ 0.75 (withers) |
| building | `models/buildings/{id}.glb`, castles: `castle_{faction}.glb` | ground center | +Z (front) | footprint radius ≈ 0.85 |
| prop | `models/props/{pine,oak,deadtree,rock,peak,crystal,bush,ruin,reeds}.glb` | ground center | any | tree height ≈ 0.6–0.9 |
| monster | `models/monsters/{wolf,spider,golem,elemental}.glb` | ground center | +Z | |

### Humanoid rig (every `models/units/*.glb`)
Bones (exact names): `root, hips, spine, chest, neck, head,
shoulder.L, upperarm.L, forearm.L, hand.L, shoulder.R, upperarm.R, forearm.R, hand.R,
thigh.L, shin.L, foot.L, thigh.R, shin.R, foot.R`. (glTF export keeps the dots.)
Rest pose: T-pose. Attachment points are **empties parented to the hands**:
`grip.R` (main hand item; item +Y = along the fist's thumb direction) and `grip.L`
(shield / off hand), plus `chest_socket` (trinket) — exported as nodes.

Animation clips (exact names): `idle, walk, attack_melee, attack_ranged, cast, hit, death,
work, ride_idle, ride_attack`. `death` ends lying on the ground (clamp last frame).

### Looks (gendered bodies)
A gendered body is bald and clean-shaven. Its manifest entry carries `head: {x, y, z, depth, neck}`
— the head frame in bind space and its throat line, where the neck begins under the chin
(`blender/head_frame.py`) — `neckRing` (the neck just under that line as an ellipse, with `skin`
when it is bare), `skin` (colour of its cheeks) and `eyes` + `eyeR` (its own iris centres).
Everything a look adds rides the `head` bone (`render/appearance.ts`):

* the **face** (`heads`, picked by gender and `look.face`): the body's own head is cut away above
  its throat line. The face is scaled until its throat is level with the body's (a body's head is
  taller for its skull than a face model's), its short neck is shaped onto the body's `neckRing`
  and graded to its colour when that neck is bare (else drawn inside the collar), it is tinted from
  its `skin` toward the body's, and its irises (`eyes`, `eyeR`, head-frame units) are drawn in the
  eye colour;
* the **hair** and **beard** pieces (`hair`), multiplied by the hair colour and **conformed** to the
  face: each vertex carries, in a second UV set (`TEXCOORD_1` = distance of the surface it was
  modelled on, weight), what it needs to move by the difference between that surface and the face's
  own, so one piece fits every face. Under a hair cut the scalp is painted in the hair colour (not
  the ears), so a gap in a piece never shows skin.

A missing face leaves the body's own head (eyes painted on it, hair placed rigidly); a style with no
file (and `bald` / no beard) simply shows the bare head.

### manifest.json
```json
{
  "units":    { "human_commoner": { "file": "models/units/human_commoner.glb", "height": 1.0 } },
  "items":    { "sword": { "file": "models/items/sword.glb" } },
  "mounts":   { "horse": { "file": "models/mounts/horse.glb", "saddle": [0, 0.62, -0.02] } },
  "buildings":{ "castle_valen": { "file": "models/buildings/castle_valen.glb" } },
  "hair":     { "hair_long": { "file": "models/hair/hair_long.glb" }, "beard_full": { "file": "models/hair/beard_full.glb" } },
  "heads":    { "head_f1": { "file": "models/heads/head_f1.glb", "eyes": [[-0.13, -0.59, 0.94], [0.14, -0.59, 0.94]], "eyeR": 0.034, "neck": -1.08, "skin": [0.61, 0.43, 0.38],
                             "neckRing": { "cx": 0.0, "cz": 0.36, "rx": 0.26, "rz": 0.26, "skin": [0.75, 0.55, 0.45] } } },
  "props":    { "pine": { "file": "models/props/pine.glb" } },
  "monsters": { "golem": { "file": "models/monsters/golem.glb" } },
  "textures": { "grass": "textures/terrain/grass.jpg" },
  "icons":    { "items/sword": "icons/items/sword.png" },
  "portraits":{ "human_commoner": "portraits/human_commoner.png" }
}
```
Icon/portrait keys are the paths used in `data/*.ts` (`icon: 'items/sword.png'` → file
`icons/items/sword.png`). Missing icons fall back to a generated glyph.

## 2D
* Terrain textures: 1024², seamless, top-down: `grass, plains, forest, hills, rock, swamp,
  sand, crystal, snow, dirt` (`.jpg`).
* Icons: 256² PNG, painted RPG-icon style, centered object, dark vignette background.
* Portraits: 512×640 PNG bust portraits per `{race}_{body}`, plus `{race}_leader`.
* UI: `ui/menu_bg.jpg` (1920×1080 key art), `ui/parchment.jpg` (tileable), emblems 256².

## Audio (`game/public/assets/audio`, optional)
`audio.json` lists Ogg Opus files: `{"sfx": {"clash": ["sfx/clash_0.ogg", …]}, "music": {"title": […], "game": […], "tension": […]}}`.
SFX keys are the `SfxName`s in `src/audio/sfx.ts`; each listed file is one variant (one is picked at random per
play), already trimmed and levelled per sound. Music files are full tracks, levelled to one target, played as
per-mood playlists. Any sound or mood without files keeps its procedural version.
