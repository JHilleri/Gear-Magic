import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { SKIN_TONES, appearanceError, fitAppearance, rollAppearance } from '../src/data/appearance';
import { appearanceRng, assignAppearance, createUnit } from '../src/sim/units';
import { applyAction } from '../src/sim/actions';
import { deserialize, serialize } from '../src/sim/state';
import { attachHead, bodyPaintFor, skinTintFor } from '../src/render/appearance';
import type { Appearance } from '../src/core/types';
import type { AssetManifest } from '../src/render/types';
import { at, makeTestState } from './helpers';
import shippedFace from '../public/assets/models/heads/head_f1.meta.json';

const look: Appearance = { hair: 'short', hairColor: 'brown', eyes: 'green', beard: 'none', face: 0 };
const body: AssetManifest['units'][string] = {
  file: 'body.glb', head: { x: 0, y: 1, z: 0, depth: 0.11, neck: -1.2 },
  skin: [0.72, 0.48, 0.36],
};

describe('skin customization', () => {
  it('keeps gameplay dice independent and covers every skin tone deterministically', () => {
    const seen = new Set<string>();
    for (let id = 0; id < 200; id++) {
      const a = rollAppearance('female', appearanceRng(17, id));
      const b = rollAppearance('female', appearanceRng(17, id));
      expect(a).toEqual(b);
      seen.add(a.skin!);
      expect(appearanceError('female', a)).toBeNull();
    }
    expect([...seen].sort()).toEqual(SKIN_TONES.map((s) => s.id).sort());
    const state = makeTestState();
    const rng = state.rngState;
    const unit = createUnit(state, { faction: 'valen', pos: at(2, 2), name: 'Ada', gender: 'female' });
    expect(unit.look!.skin).toBeDefined();
    expect(state.rngState).toBe(rng);
  });

  it('persists an explicit skin change through customization, body type changes and save reload', () => {
    const state = makeTestState();
    const unit = createUnit(state, { faction: 'valen', pos: at(2, 2), name: 'Test', gender: 'male' });
    const rng = state.rngState;
    const changed: Appearance = { ...look, skin: 'deep' };
    expect(applyAction(state, { type: 'customize', unit: unit.id, look: changed }).ok).toBe(true);
    expect(unit.look).toEqual(changed);
    expect(unit.look).not.toBe(changed);
    const female = fitAppearance('female', changed);
    expect(female.skin).toBe('deep');
    expect(applyAction(state, { type: 'customize', unit: unit.id, gender: 'female', look: female }).ok).toBe(true);
    expect(state.rngState).toBe(rng);
    expect(deserialize(serialize(state)).units[unit.id].look).toEqual(female);
    expect(appearanceError('male', { ...look, skin: 'invalid' as never })).toBe('Unknown skin tone');
  });

  it('leaves older saved skin colours unchanged, including when a missing face is migrated', () => {
    const state = makeTestState();
    const unit = createUnit(state, { faction: 'valen', pos: at(2, 2), name: 'Test', gender: 'male' });
    unit.look = { ...look };
    expect(appearanceError('male', unit.look)).toBeNull();
    expect(deserialize(serialize(state)).units[unit.id].look).toEqual(look);
    delete (unit.look as Partial<Appearance>).face;
    assignAppearance(state.settings.seed, unit);
    expect(unit.look.skin).toBeUndefined();
    expect(Number.isInteger(unit.look.face)).toBe(true);
    expect(bodyPaintFor(body, unit.look, true)!.skinOn).toBe(false);
  });
});

describe('skin material isolation', () => {
  it('uses sRGB metadata from the shipped byte texture, and calibrates the neck separately', () => {
    // Verified against head_f1.glb JPEG bytes and Blender Image.pixels: BYTE images expose
    // sRGB values here, unlike float images. Treating .5294 as linear makes the source too bright.
    const source = shippedFace.skin as [number, number, number];
    const neck = shippedFace.neck_ring.skin as [number, number, number];
    const paint = bodyPaintFor({ ...body, skin: source, neckRing: { cx: 0, cz: 0.3, rx: 0.3, rz: 0.3, skin: neck } }, { ...look, skin: 'porcelain' }, true)!;
    expect(paint.skinSource.r).toBeCloseTo(0.2423, 4);
    expect(paint.skinSource.r).not.toBeCloseTo(source[0], 2);
    expect(paint.neckSkinSource.r).toBeCloseTo(new THREE.Color().setRGB(...neck, THREE.SRGBColorSpace).r, 6);
    expect(paint.neckSkinSource.r).not.toBe(paint.skinSource.r);
    expect(paint.skinTarget.getHexString()).toBe(SKIN_TONES.find((tone) => tone.id === 'porcelain')!.color.slice(1));
  });

  it('maps the source albedo to the requested tone in linear colour space', () => {
    for (const tone of SKIN_TONES) {
      const source = new THREE.Color().setRGB(...body.skin!, THREE.SRGBColorSpace);
      source.multiply(skinTintFor(body.skin, tone.id));
      const target = new THREE.Color(tone.color);
      expect(source.r).toBeCloseTo(target.r, 6);
      expect(source.g).toBeCloseTo(target.g, 6);
      expect(source.b).toBeCloseTo(target.b, 6);
    }
    for (const source of [undefined, [0, 0.3, 0.2], [NaN, 0.3, 0.2]]) {
      expect(skinTintFor(source, 'deep').toArray()).toEqual([1, 1, 1]);
    }
    expect(skinTintFor(body.skin, undefined).toArray()).toEqual([1, 1, 1]);
  });

  it('keeps a shared face material untouched when two units choose different tones', () => {
    const shared = new THREE.MeshStandardMaterial({ color: '#ffffff' });
    const faceGeometry = new THREE.BoxGeometry(0.6, 1, 0.7);
    const assemble = (skin: Appearance['skin']) => {
      const root = new THREE.Group();
      const head = new THREE.Bone(); head.name = 'head';
      const mesh = new THREE.SkinnedMesh(new THREE.BufferGeometry(), new THREE.MeshStandardMaterial());
      mesh.add(head); mesh.bind(new THREE.Skeleton([head])); root.add(mesh);
      const face = new THREE.Mesh(faceGeometry, shared);
      attachHead(root, face, body, { file: 'face.glb', skin: [0.78, 0.52, 0.41] }, { ...look, skin });
      return face.material;
    };
    const pale = assemble('porcelain');
    const deep = assemble('deep');
    expect(pale).not.toBe(shared);
    expect(deep).not.toBe(shared);
    expect(pale).not.toBe(deep);
    expect(shared.color.getHex()).toBe(0xffffff);
    type Shader = Parameters<THREE.Material['onBeforeCompile']>[0];
    const shader = (): Shader => ({ uniforms: {}, vertexShader: '#include <common>\n#include <begin_vertex>', fragmentShader: '#include <common>\n#include <map_fragment>' }) as Shader;
    const p = shader(), d = shader();
    pale.onBeforeCompile(p, null as never); deep.onBeforeCompile(d, null as never);
    expect(p.uniforms.uFaceSkinTint.value.r).toBeGreaterThan(d.uniforms.uFaceSkinTint.value.r);
    expect(p.uniforms.uFaceSkinTint).not.toBe(d.uniforms.uFaceSkinTint);
    expect(pale.customProgramCacheKey()).toBe(deep.customProgramCacheKey());
    pale.dispose(); deep.dispose(); shared.dispose(); faceGeometry.dispose();
  });
});
