# Gear & Magic

A 3D turn-based fantasy 4X on a regional hex map, built from [`concept.md`](concept.md).
Units start as commoners and become what you equip them with — tools, swords, spears,
bows, staves, armor, trinkets and mounts are all visible on the 3D models — and they grow
through level-up choices shaped by how they earned their experience.

* Rules & architecture: [`DESIGN.md`](DESIGN.md)
* Asset conventions: [`ASSETS.md`](ASSETS.md)

## Play

```bash
cd game && npm install && npm run dev
```

Then open http://127.0.0.1:5180.

## Layout

| path | what |
|---|---|
| `game/` | the game (Vite + TypeScript + Three.js + Preact) |
| `game/src/sim` | deterministic rules engine + AI (no rendering) |
| `game/src/render` | Three.js world: terrain, units, buildings, effects |
| `game/src/ui` | Preact HUD, panels and modals |
| `game/public/assets` | generated models, textures, icons, portraits |
| `art/` | ComfyUI asset generation (Qwen-Image 2.1, BiRefNet, TRELLIS.2) — prompts in `art/tools/make_manifests.py` |
| `blender/` | headless Blender scripts: auto-rigging, animation, model processing |

## Regenerating art

```bash
cd art
python3 tools/make_manifests.py                 # prompts → manifests/*.json
python3 tools/gen.py manifests/src3d.json       # source images (needs local ComfyUI on :8188)
python3 tools/i2m.py src_units src_items ...    # image → 3D (TRELLIS.2)
python3 tools/export2d.py                       # icons, portraits, textures, key art → game/public/assets
```
Then see `blender/README.md` to rig and process the models (`python3 blender/batch.py <categories> --jobs 1`).

Extra manifests added later: `manifests/extra3d.json` (elemental, reeds), `manifests/extra3d_b.json`
(orc/undead houses and farms, the undead commoner, padded-tunic bodies), `manifests/portraits_b.json`.

Notes from production:
* `gen.py` submits one image at a time and retries blank results: this ComfyUI build produced flat grey
  canvases when prompts were queued back to back.
* If TRELLIS fails with "coords can't be empty" or bakes a noise/black texture, free ComfyUI's models
  (`curl -X POST 127.0.0.1:8188/free -d '{"unload_models":true,"free_memory":true}'`) and re-run that id with
  `i2m.py ... --only <id> --force --reseed <n>`.
* Run heavy jobs one at a time (GPU generation, Blender, software-rendered browsers): this PC has switched
  off under combined full CPU + GPU load. `blender/batch.py` defaults to one job on 4 threads at low priority.

## Checks

```bash
cd game
npx tsc --noEmit
npx vitest run                      # 448 tests (+2 skipped) incl. AI-vs-AI games
AI_METRICS=1 npx vitest run tests/ai-metrics.test.ts   # optional: AI behaviour numbers over many seeds
npm run build
```

## Headless playtesting

`game/tools/cdp.mjs` drives a headless Brave over the DevTools protocol, rendering on the real GPU
(`CDP_GL=swiftshader` for software rendering, which is very slow). With the dev server running:

```bash
cd game
CDP_PORT=9341 node tools/cdp.mjs launch
CDP_PORT=9341 node tools/cdp.mjs run '[["goto","http://127.0.0.1:5180"],["wait",3000],["shot","/abs/path/title.png"]]'
CDP_PORT=9341 node tools/cdp.mjs kill
```

In dev builds `window.__aether.controller` and `window.__aether.renderer` expose the game for scripted setups;
`renderer.debugInfo()` reports draw calls and triangles.
