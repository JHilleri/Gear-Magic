# Unified character verification — 2026-11-16

- TypeScript check and production build: passed.
- Full suite: 525 passed, 3 opt-in tests skipped (35 test files passed).
- Shipped binary assets: 37 checks passed, including connected body/head geometry,
  neck seam normals, neutral morphs, eyelid/globe clearance, armor bind matrices
  and all groom source hashes.
- Final real-WebGL browser matrix: 86 checks passed; no missing assets, shader errors
  or browser exceptions. See `verification.json` for the exact cases.
- Disposable normal new-game session: human map unit and dynamic portrait rendered;
  no observed browser errors. See `game-smoke.json`. This is a rendering smoke check.

The browser matrix covers both bodies, all outfits and their walking poses, face
shapes, hair/beards/colors, skin/eye colors, equipment, animation, save/load and
mobile/desktop overflow. Screenshots are available locally but ignored by Git.

Visual limits remain: generated face/hands, stylized hair-card edges, simple garment
panel topology and no cloth/collision simulation. This evidence does not establish
production AAA art quality. See `CHARACTERS.md` for the reproducible pipeline.
