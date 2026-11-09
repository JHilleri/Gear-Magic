// Headless checks for the world renderer's CPU-side math: heightfield queries vs. the mesh,
// ray-marched picking and the fog-of-war mask (no WebGL needed).
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { makeTestState, at, setTerrain } from './helpers';
import { buildTerrain, marchRay, mapWorldRect, WATER_LEVEL, type Terrain } from '../src/render/terrain';
import { FogOfWar, createFowUniforms } from '../src/render/fow';
import { hexToWorld, tileIndex, worldToHex } from '../src/core/hex';
import type { GameState } from '../src/core/types';
import type { WorldTextures } from '../src/render/textures';

const fakeTextures = {
  albedo: new THREE.DataArrayTexture(), normal: new THREE.DataArrayTexture(),
  noise: new THREE.DataTexture(), waves: new THREE.DataTexture(), dispose() {},
} as unknown as WorldTextures;

function world(): { state: GameState; terrain: Terrain } {
  const state = makeTestState(14, 10, 'grass');
  setTerrain(state, at(5, 5), 'mountain');
  setTerrain(state, at(6, 5), 'mountain');
  setTerrain(state, at(9, 3), 'water');
  setTerrain(state, at(10, 3), 'water');
  setTerrain(state, at(9, 4), 'shallows');
  setTerrain(state, at(2, 7), 'hills');
  setTerrain(state, at(3, 2), 'swamp');
  const terrain = buildTerrain(state, fakeTextures, createFowUniforms());
  return { state, terrain };
}

describe('terrain heightfield', () => {
  const { terrain } = world();
  const chunks = terrain.group.children.filter((c) => c.userData.terrain) as THREE.Mesh[];

  it('heightAt reproduces the mesh vertices exactly', () => {
    for (const m of chunks.slice(0, 4)) {
      const pos = m.geometry.attributes.position;
      for (let i = 0; i < pos.count; i += 37) {
        expect(terrain.heightAt(pos.getX(i), pos.getZ(i))).toBeCloseTo(pos.getY(i), 5);
      }
    }
  });

  it('heightAt matches the rendered triangles between vertices', () => {
    const rc = new THREE.Raycaster();
    const down = new THREE.Vector3(0, -1, 0);
    let checked = 0;
    for (let k = 0; k < 200; k++) {
      const x = 1 + ((k * 7.31) % 20), z = 1 + ((k * 3.77) % 12);
      rc.set(new THREE.Vector3(x, 10, z), down);
      const hit = rc.intersectObjects(chunks, false)[0];
      if (!hit) continue;
      expect(terrain.heightAt(x, z)).toBeCloseTo(hit.point.y, 4);
      checked++;
    }
    expect(checked).toBeGreaterThan(150);
  });

  it('shapes land by terrain type', () => {
    const h = (col: number, row: number) => { const w = hexToWorld(at(col, row)); return terrain.heightAt(w.x, w.z); };
    expect(h(5, 5)).toBeGreaterThan(h(1, 1) + 0.6);     // mountain massif towers over grass
    expect(h(9, 3)).toBeLessThan(WATER_LEVEL - 0.1);    // lake bed well under the water plane
    expect(h(9, 4)).toBeLessThan(WATER_LEVEL);          // ford is submerged
    expect(h(3, 2)).toBeGreaterThan(WATER_LEVEL);       // swamp stays above water (puddles are shaded)
    expect(Math.abs(h(1, 1))).toBeLessThan(0.15);       // grassland is near zero
  });

  it('covers the map plus a margin', () => {
    const m = mapWorldRect(14, 10);
    expect(terrain.rect.minX).toBeLessThan(m.minX);
    expect(terrain.rect.maxZ).toBeGreaterThan(m.maxZ);
    expect(terrain.mapRect).toEqual(m);
  });
});

describe('marchRay picking', () => {
  const { terrain } = world();
  it('hits the hex the ray points at, from oblique camera angles', () => {
    for (const [col, row] of [[1, 1], [5, 5], [9, 3], [2, 7], [12, 8]]) {
      const c = hexToWorld(at(col, row));
      const target = new THREE.Vector3(c.x, Math.max(terrain.heightAt(c.x, c.z), WATER_LEVEL), c.z);
      const origin = new THREE.Vector3(c.x + 6, 14, c.z + 9);
      const dir = target.clone().sub(origin).normalize();
      const hit = marchRay(origin, dir, (x, z) => Math.max(terrain.heightAt(x, z), WATER_LEVEL));
      expect(hit).not.toBeNull();
      const hh = worldToHex(hit!.x, hit!.z);
      // A peak in front can legitimately catch the ray first; otherwise we must land on the hex.
      if (col !== 5) expect(hh).toEqual(at(col, row));
      expect(hit!.distanceTo(origin)).toBeLessThanOrEqual(target.distanceTo(origin) + 0.05);
    }
  });
  it('returns null for rays that never come down', () => {
    expect(marchRay(new THREE.Vector3(0, 10, 0), new THREE.Vector3(0, 1, 0), () => 0)).toBeNull();
  });
});

describe('fog of war mask', () => {
  it('fades between masks and reports the displayed explored factor', () => {
    const { state, terrain } = world();
    const fow = new FogOfWar(createFowUniforms());
    fow.setup(state, terrain.rect);
    const n = state.width * state.height;
    const f = state.factions.valen;
    f.explored = new Array(n).fill(0);
    f.visible = new Array(n).fill(0);
    const home = at(4, 4);
    f.explored[tileIndex(home, state.width)] = 1;
    f.visible[tileIndex(home, state.width)] = 1;
    const owners = new Array(n).fill(null);
    fow.update(state, 'valen', new Uint8Array(n), owners, true);
    const c = hexToWorld(home);
    const far = hexToWorld(at(12, 8));
    expect(fow.exploredAt(c.x, c.z)).toBeGreaterThan(0.6);
    expect(fow.exploredAt(far.x, far.z)).toBeLessThan(0.01);

    // Explore the far tile without `immediate`: starts at the old mask, ends at the new one.
    f.explored[tileIndex(at(12, 8), state.width)] = 1;
    fow.update(state, 'valen', new Uint8Array(n), owners, false);
    expect(fow.exploredAt(far.x, far.z)).toBeLessThan(0.01);
    fow.tick(0.45);
    const mid = fow.exploredAt(far.x, far.z);
    expect(mid).toBeGreaterThan(0.05);
    fow.tick(1);
    expect(fow.exploredAt(far.x, far.z)).toBeGreaterThan(mid);
    expect(fow.exploredAt(c.x, c.z)).toBeGreaterThan(0.6);
    fow.dispose();
  });
});
