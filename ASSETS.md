# Asset contract (game/public/assets)

The renderer loads everything listed in `game/public/assets/manifest.json`; any entry that
is missing falls back to procedural geometry, so the game is always playable.

## Conventions (all GLB, glTF 2.0, Y-up, meters ≈ world units, hex radius = 1.0)

| kind | path | origin | facing | size |
|---|---|---|---|---|
| unit body (rigged) | `models/units/{race}_{body}.glb` race ∈ human/orc/undead, body ∈ commoner/light/heavy/robe/leader | feet center | +Z | height ≈ 1.0 (renderer scales to `UNIT_HEIGHT`) |
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

### manifest.json
```json
{
  "units":    { "human_commoner": { "file": "models/units/human_commoner.glb", "height": 1.0 } },
  "items":    { "sword": { "file": "models/items/sword.glb" } },
  "mounts":   { "horse": { "file": "models/mounts/horse.glb", "saddle": [0, 0.62, -0.02] } },
  "buildings":{ "castle_valen": { "file": "models/buildings/castle_valen.glb" } },
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
