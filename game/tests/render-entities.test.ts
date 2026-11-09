// Node-safe checks for the entity render helpers (no WebGL / DOM needed).
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { Scheduler, dampAngle, wrapAngle } from '../src/render/anim';
import {
  BONE_NAMES, CLIP_NAMES, createHumanoid, createMonster, createQuadruped, humanoidClips, humanoidGeometry, itemModel, PAL_SIZE, unitPalette,
} from '../src/render/procedural';
import { buildingModel, buildingPalette } from '../src/render/procedural-buildings';
import type { BodyVariant, BuildingId, ItemId, MonsterKind, RaceId } from '../src/core/types';

const RACES: RaceId[] = ['human', 'orc', 'undead'];
const BODIES: BodyVariant[] = ['commoner', 'light', 'heavy', 'robe', 'leader'];

describe('procedural humanoid', () => {
  it('uses exactly the ASSETS.md bone names, plus grip / chest sockets', () => {
    expect([...BONE_NAMES].sort()).toEqual([
      'root', 'hips', 'spine', 'chest', 'neck', 'head', 'shoulder.L', 'upperarm.L', 'forearm.L', 'hand.L',
      'shoulder.R', 'upperarm.R', 'forearm.R', 'hand.R', 'thigh.L', 'shin.L', 'foot.L', 'thigh.R', 'shin.R', 'foot.R',
    ].sort());
    const h = createHumanoid('human', 'heavy', 3, new THREE.MeshStandardMaterial());
    for (const n of [...BONE_NAMES, 'grip.R', 'grip.L', 'chest_socket']) expect(h.root.getObjectByName(n), n).toBeTruthy();
    expect(h.mesh.skeleton.bones.length).toBe(BONE_NAMES.length);
  });

  it('builds every race × body with valid skin weights', () => {
    for (const r of RACES) for (const b of BODIES) {
      const g = humanoidGeometry(r, b, 1);
      const w = g.getAttribute('skinWeight');
      const idx = g.getAttribute('skinIndex');
      expect(w.count).toBe(g.getAttribute('position').count);
      for (let i = 0; i < w.count; i += 7) {
        const sum = w.getX(i) + w.getY(i) + w.getZ(i) + w.getW(i);
        expect(Math.abs(sum - 1)).toBeLessThan(1e-4);
        expect(idx.getX(i)).toBeLessThan(BONE_NAMES.length);
      }
      g.computeBoundingBox();
      // ≈1 unit tall (orcs slightly taller), feet on the ground
      expect(g.boundingBox!.min.y).toBeGreaterThan(-0.02);
      expect(g.boundingBox!.max.y).toBeGreaterThan(0.9);
      expect(g.boundingBox!.max.y).toBeLessThan(1.25);
    }
  });

  it('generates all ten clips for every stance, death ends lying down', () => {
    const clips = humanoidClips({ race: 'orc', hold: 'weapon', shield: true, melee: 'swing', mounted: false });
    expect(clips.map((c) => c.name).sort()).toEqual([...CLIP_NAMES].sort());
    for (const c of clips) {
      expect(c.duration).toBeGreaterThan(0.3);
      expect(c.tracks.length).toBe(BONE_NAMES.length + 1);
      expect(c.validate()).toBe(true);
    }
    const death = clips.find((c) => c.name === 'death')!;
    const hipsPos = death.tracks.find((t) => t.name === 'hips.position')!;
    const lastY = hipsPos.values[hipsPos.values.length - 2];
    expect(lastY).toBeLessThan(0.12);
    const mounted = humanoidClips({ race: 'human', hold: 'none', shield: false, melee: 'punch', mounted: true });
    expect(mounted.length).toBe(CLIP_NAMES.length);
  });
});

describe('procedural equipment, mounts, monsters, buildings', () => {
  it('has a model with a tip for every equippable visible item', () => {
    const items: ItemId[] = ['tools', 'sword', 'spear', 'axe', 'bow', 'staff', 'wand', 'shield'];
    for (const r of RACES) for (const it of items) {
      const m = itemModel(it, r);
      expect(m.geometry.getAttribute('position').count, `${r}/${it}`).toBeGreaterThan(20);
      expect(Number.isFinite(m.tip.y)).toBe(true);
    }
    expect(itemModel('staff', 'human').glow).toBeTruthy();
  });

  it('rigs mounts and monsters with animatable parts', () => {
    const mat = new THREE.MeshStandardMaterial();
    for (const k of ['horse', 'wolf', 'nightmare'] as const) {
      const q = createQuadruped(k, mat, true);
      expect(q.legs.length).toBe(4);
      expect(q.saddle.y).toBeGreaterThan(0.5);
    }
    for (const k of ['wolf', 'spider', 'golem', 'elemental'] as MonsterKind[]) {
      const m = createMonster(k, mat);
      expect(m.group.children.length).toBeGreaterThan(0);
    }
  });

  it('models every building type within the footprint with a banner anchor', () => {
    const types: BuildingId[] = ['castle', 'house', 'farm', 'lumber', 'quarry', 'forge', 'training', 'mine', 'crystalmine', 'library', 'magetower', 'wall', 'watchtower', 'shrine'];
    for (const t of types) for (const lvl of [1, 3]) {
      const m = buildingModel(t, lvl);
      const pos = m.geometry.getAttribute('position');
      let r = 0;
      for (let i = 0; i < pos.count; i++) r = Math.max(r, Math.hypot(pos.getX(i), pos.getZ(i)));
      expect(r, t).toBeLessThan(0.9);
      expect(m.height, t).toBeGreaterThan(0.2);
      expect(Number.isFinite(m.banner.y)).toBe(true);
    }
    expect(buildingPalette('valen').length).toBe(PAL_SIZE);
    expect(buildingPalette(null).length).toBe(PAL_SIZE);
    expect(unitPalette('undead', 'ashen', 5).length).toBe(PAL_SIZE);
  });
});

describe('anim scheduler', () => {
  it('runs tweens and waits on update() and resolves on clear()', async () => {
    const s = new Scheduler();
    const seen: number[] = [];
    let done = false;
    const p = s.tween(1, (t) => seen.push(t)).then(() => { done = true; });
    for (let i = 0; i < 10; i++) s.update(0.1);
    await p;
    expect(done).toBe(true);
    expect(seen[0]).toBe(0);
    expect(seen[seen.length - 1]).toBe(1);
    let waited = false;
    const w = s.wait(100).then(() => { waited = true; });
    s.clear();
    await w;
    expect(waited).toBe(true);
    // zero / non-finite durations complete immediately
    let instant = false;
    await s.tween(0, () => { instant = true; });
    expect(instant).toBe(true);
  });

  it('turns along the shortest arc', () => {
    const w = wrapAngle(Math.PI * 3 + 0.25);
    expect(Math.abs(w - (-Math.PI + 0.25))).toBeLessThan(1e-9);
    const a = dampAngle(3.0, -3.0, 1000, 1);
    expect(Math.abs(wrapAngle(a - -3.0))).toBeLessThan(1e-6);
  });
});
