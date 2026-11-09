// Pure render helpers behind picking, unit placement, movement pacing and camera clamping
// (no WebGL / DOM needed).
import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { rayCylinder, raycastMeshes } from '../src/render/pick';
import { chooseStandSpot, cornerDir, cornerSector, mountedTopY, standDir } from '../src/render/units';
import { disposeSkeletons, trapezoidProfile } from '../src/render/anim';
import { UNIT_HEIGHT } from '../src/render/types';
import { playEventSequence, takeSnapshot, type PlaybackHost } from '../src/render/playback';
import type { RenderContext } from '../src/render/types';
import { makeTestState, makeTestUnit, at } from './helpers';

const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

describe('rayCylinder', () => {
  const base = V(0, 1, 0);
  it('hits the top cap of a vertical ray', () => {
    expect(rayCylinder(V(0.1, 10, 0), V(0, -1, 0), base, 0.5, 2)).toBeCloseTo(7, 6);
  });
  it('hits the side of a horizontal ray', () => {
    expect(rayCylinder(V(-5, 1.5, 0), V(1, 0, 0), base, 0.5, 2)).toBeCloseTo(4.5, 6);
  });
  it('hits the cap of an oblique ray coming down onto it', () => {
    const d = V(1, -1, 0).normalize();
    const t = rayCylinder(V(-2, 5, 0), d, base, 0.5, 2)!;
    const p = V(-2, 5, 0).addScaledVector(d, t);
    expect(p.y).toBeCloseTo(3, 6);
    expect(Math.abs(p.x)).toBeLessThanOrEqual(0.5 + 1e-9);
  });
  it('misses beside, above and behind', () => {
    expect(rayCylinder(V(2, 10, 0), V(0, -1, 0), base, 0.5, 2)).toBeNull();
    expect(rayCylinder(V(-5, 3.5, 0), V(1, 0, 0), base, 0.5, 2)).toBeNull();
    expect(rayCylinder(V(5, 1.5, 0), V(1, 0, 0), base, 0.5, 2)).toBeNull();
  });
});

describe('raycastMeshes', () => {
  it('finds the nearest visible mesh triangle and ignores hidden meshes and x-ray twins', () => {
    const root = new THREE.Group();
    const near = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
    near.position.set(0, 0, 2);
    const far = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
    far.position.set(0, 0, -2);
    root.add(near, far);
    root.updateMatrixWorld(true);
    const rc = new THREE.Raycaster(V(0, 0, 10), V(0, 0, -1));
    expect(raycastMeshes(rc, root)).toBeCloseTo(7.5, 6);
    near.visible = false;
    expect(raycastMeshes(rc, root)).toBeCloseTo(11.5, 6);
    far.userData.xray = true;
    expect(raycastMeshes(rc, root)).toBeNull();
  });
});

describe('units on building hexes', () => {
  it('stand clear of the building front on the camera side, inside the hex', () => {
    const all = (r: number | null) => () => r;
    expect(chooseStandSpot(all(null), 2, 0.14)).toEqual({ dir: 4, d: expect.closeTo(0.6, 6) }); // unmeasured
    expect(chooseStandSpot(all(0.1), 2, 0.14)).toEqual({ dir: 4, d: expect.closeTo(0.42, 6) }); // never closer than before
    expect(chooseStandSpot(all(0.55), 2, 0.14)).toEqual({ dir: 4, d: expect.closeTo(0.73, 6) });
    // fills the hex everywhere: the camera corner, capped (the corner is at 1.0)
    expect(chooseStandSpot(all(0.95), 2, 0.32)).toEqual({ dir: 4, d: 0.78 });
  });
  it('step round a building that fills its hex toward the camera', () => {
    // gate towers reach 0.9 toward the camera corner (dir 4) and the edges beside it; the side corner is clear
    const castle = (j: number) => (j === 4 || j === 3 || j === 5 ? 0.9 : j === 6 ? 0.5 : 0.85);
    const s = chooseStandSpot(castle, 2, 0.14);
    expect(s.dir).toBe(6);
    expect(s.d).toBeCloseTo(0.68, 6);
    // corner and edge directions: corners match cornerDir, edges are between them
    expect(standDir(4).z).toBeCloseTo(cornerDir(2).z, 9);
    expect(standDir(3).x).toBeCloseTo(Math.cos(Math.PI / 3), 9);
  });
  it('face the camera through the nearest hex corner', () => {
    expect(cornerSector(0, 1)).toBe(2);                 // default camera sits at +Z
    for (let k = 0; k < 6; k++) {
      const d = cornerDir(k);
      expect(cornerSector(d.x, d.z)).toBe(k);
      expect(Math.hypot(d.x, d.z)).toBeCloseTo(1, 9);
    }
    expect(cornerDir(2).z).toBeCloseTo(1, 9);
  });
});

describe('mounted status bar', () => {
  it('sits above the seated rider, not a standing one', () => {
    // GLB knight on a horse: rider origin 0.69 (unit space), ride clip lowers the hips by 0.485
    const seated = mountedTopY(0.69, 0.485, 1.1);
    expect(seated).toBeCloseTo((0.69 - 0.485 + 1.02) * UNIT_HEIGHT + 0.08, 9);
    expect(seated).toBeLessThan(mountedTopY(0.69, 0, 1.1) - 0.3);
    // a tall mount still wins over a low rider
    expect(mountedTopY(0.3, 0.485, 1.6)).toBeCloseTo(1.6 * UNIT_HEIGHT + 0.08, 9);
  });
});

describe('move profile', () => {
  it('starts and stops at rest, keeps the duration and covers the path', () => {
    const dur = 3, len = 5, ta = 0.22, td = 0.42;
    expect(trapezoidProfile(0, dur, len, ta, td)).toEqual({ s: 0, v: 0 });
    const end = trapezoidProfile(dur, dur, len, ta, td);
    expect(end.s).toBeCloseTo(len, 9);
    expect(end.v).toBeCloseTo(0, 9);
    let prev = trapezoidProfile(0, dur, len, ta, td);
    const n = 3000;
    let maxJump = 0;
    for (let i = 1; i <= n; i++) {
      const p = trapezoidProfile((i / n) * dur, dur, len, ta, td);
      expect(p.s).toBeGreaterThanOrEqual(prev.s - 1e-12);
      // ds/dt matches v (the gait is driven from v)
      expect((p.s - prev.s) / (dur / n)).toBeCloseTo((p.v + prev.v) / 2, 2);
      maxJump = Math.max(maxJump, Math.abs(p.v - prev.v));
      prev = p;
    }
    expect(maxJump).toBeLessThan(0.02); // continuous speed: no dead stop in one frame
    // cruise only a little above the average speed
    expect(trapezoidProfile(dur / 2, dur, len, ta, td).v / (len / dur)).toBeLessThan(1.15);
  });
  it('fits short moves', () => {
    const p = trapezoidProfile(0.25, 0.5, 1, 1, 1);
    expect(p.s).toBeCloseTo(0.5, 6);
    expect(trapezoidProfile(0.5, 0.5, 1, 1, 1).s).toBeCloseTo(1, 9);
  });
});

describe('skeleton disposal', () => {
  it('frees every bone texture of a unit view once', () => {
    const bones = [new THREE.Bone(), new THREE.Bone()];
    bones[0].add(bones[1]);
    const sk = new THREE.Skeleton(bones);
    sk.computeBoneTexture();
    const geo = new THREE.BufferGeometry();
    const a = new THREE.SkinnedMesh(geo, new THREE.MeshBasicMaterial());
    const b = new THREE.SkinnedMesh(geo, new THREE.MeshBasicMaterial());
    a.add(bones[0]);
    a.bind(sk);
    b.bind(sk);
    const root = new THREE.Group();
    root.add(a, b);
    const spy = vi.spyOn(sk, 'dispose');
    disposeSkeletons(root);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(sk.boneTexture).toBeNull();
    disposeSkeletons(root); // harmless twice
  });
});

describe('Healing Light VFX', () => {
  it('plays the heavy effect only on the allies it healed', async () => {
    const s = makeTestState();
    const caster = makeTestUnit(s, 'valen', at(4, 4));
    const ally = makeTestUnit(s, 'valen', at(5, 4));
    makeTestUnit(s, 'thorn', at(5, 5));
    const fx = { projectile: vi.fn(async () => {}), damageNumber: vi.fn(), burst: vi.fn(), spell: vi.fn(async () => {}), levelUp: vi.fn(), hitSpark: vi.fn(), update() {}, dispose() {} };
    const units = {
      sync: vi.fn(), update() {}, dispose() {}, animateMove: vi.fn(async () => {}), animateCombat: vi.fn(async () => {}), animateDeath: vi.fn(async () => {}),
      animateSpawn: vi.fn(async () => {}), playClip: vi.fn(async () => {}), unitAnchor: () => null, refreshUnit: vi.fn(),
    };
    const buildings = { sync: vi.fn(), update() {}, dispose() {}, animateConstructed: vi.fn(async () => {}), animateDestroyed: vi.fn(async () => {}) };
    const ctx = { viewer: 'valen', hexCenter: () => new THREE.Vector3(), heightAt: () => 0, shake: vi.fn(), factionColor: () => new THREE.Color() } as unknown as RenderContext;
    const host: PlaybackHost = { ctx, layers: { units, buildings, fx }, refreshFog: vi.fn(), reportError: vi.fn() };
    const ev = { type: 'spellCast', faction: 'valen', spell: 'heal', from: caster.pos, target: ally.pos, affected: [ally.id] } as const;
    await playEventSequence(host, s, takeSnapshot(s), [ev as never], 50);
    expect(fx.spell).toHaveBeenCalledTimes(1);
    const targets = (fx.spell.mock.calls[0] as unknown[])[5] as THREE.Vector3[];
    expect(targets).toHaveLength(1);
  });
});

describe('camera clamp follows the zoom', () => {
  it('keeps the view on the map, and centres a map smaller than the view', async () => {
    const g = globalThis as Record<string, unknown>;
    const hadWindow = 'window' in g, hadDocument = 'document' in g;
    if (!hadWindow) g.window = new EventTarget();
    if (!hadDocument) g.document = Object.assign(new EventTarget(), { hasFocus: () => true });
    try {
      const { RtsCamera } = await import('../src/render/camera');
      const { mapWorldRect } = await import('../src/render/terrain');
      const canvas = Object.assign(new EventTarget(), { getBoundingClientRect: () => ({ left: 0, top: 0, right: 1600, bottom: 900, width: 1600, height: 900 }) }) as unknown as HTMLCanvasElement;
      const cam = new THREE.PerspectiveCamera(38, 16 / 9, 0.3, 2500);
      const rts = new RtsCamera({ camera: cam, canvas, heightAt: () => 0 });
      const map = mapWorldRect(26, 20); // small map ≈ 46 × 30.5
      const slack = 2.5;
      rts.setBounds(map, { slack });
      const keys = new Set<string>();
      const drive = (k: string[], secs: number) => { keys.clear(); for (const x of k) keys.add(x); for (let t = 0; t < secs; t += 1 / 30) rts.update(1 / 30, keys); keys.clear(); };
      // zoomed far out: wider than the map on both axes → pinned to the centre whatever the keys say
      rts.focusOn(0, 0, true, 46);
      drive(['a', 'w'], 3);
      expect(rts.target.x).toBeCloseTo((map.minX + map.maxX) / 2, 0);
      // zoomed in: the target can get near the edge, but the edge-midpoint footprint stays on the map (+ slack)
      rts.focusOn(0, 0, true, 9);
      drive(['a', 'w'], 4);
      const o = rts.viewOffsets();
      expect(rts.target.x + o.oxMin).toBeGreaterThanOrEqual(map.minX - slack - 1e-6);
      expect(rts.target.z + o.ozMin).toBeGreaterThanOrEqual(map.minZ - slack - 1e-6);
      expect(rts.target.x).toBeLessThan(map.minX + 12);
      rts.dispose();
    } finally {
      if (!hadWindow) delete g.window;
      if (!hadDocument) delete g.document;
    }
  });
});
