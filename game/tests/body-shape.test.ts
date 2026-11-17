import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { applyBodyShape, boneScale } from '../src/render/body-shape';
import { SHAPE_KEYS, appearanceError, cleanShape, rollShape } from '../src/data/appearance';
import type { Appearance } from '../src/core/types';

/** A stick figure: root → hips → (spine → head, thigh.L → shin.L → foot.L), bones along +Y like the shipped rig. */
function rig() {
  const make = (name: string, y: number, parent?: THREE.Bone, x = 0) => {
    const bone = new THREE.Bone(); bone.name = name; bone.position.set(x, y, 0); parent?.add(bone); return bone;
  };
  const root = make('root', 0), hips = make('hips', .5, root), spine = make('spine', .1, hips), head = make('head', .3, spine);
  const thigh = make('thigh.L', 0, hips, .05); thigh.rotation.z = Math.PI;   // points down
  const shin = make('shin.L', .25, thigh), foot = make('foot.L', .22, shin);
  const bones = [root, hips, spine, head, thigh, shin, foot];
  const armature = new THREE.Group(); armature.add(root);
  const model = new THREE.Group(); model.add(armature);
  model.updateMatrixWorld(true);
  const geometry = new THREE.BufferGeometry();
  // One vertex at the knee, bound to the thigh; one on the sole, bound to the foot.
  geometry.setAttribute('position', new THREE.Float32BufferAttribute([.05, .25, 0, .05, 0, 0, 0, 1, 0], 3));
  geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute([4, 0, 0, 0, 6, 0, 0, 0, 3, 0, 0, 0], 4));
  geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0], 4));
  const mesh = new THREE.SkinnedMesh(geometry, new THREE.MeshBasicMaterial());
  armature.add(mesh);
  mesh.bind(new THREE.Skeleton(bones));
  return { model, mesh, bones, shin, foot };
}
function skinned(mesh: THREE.SkinnedMesh, vertex: number): THREE.Vector3 {
  mesh.updateMatrixWorld(true); mesh.skeleton.update();
  return mesh.applyBoneTransform(vertex, new THREE.Vector3().fromBufferAttribute(mesh.geometry.getAttribute('position'), vertex));
}

describe('body shape', () => {
  it('leaves an untouched rig alone for a neutral shape', () => {
    const { model, mesh, shin } = rig();
    const inverses = mesh.skeleton.boneInverses;
    applyBodyShape(model, undefined); applyBodyShape(model, {});
    expect(mesh.skeleton.boneInverses).toBe(inverses);
    expect(shin.parent!.name).toBe('thigh.L');
  });

  it('lengthens the legs upward: soles stay on the ground, the head rises', () => {
    const { model, mesh } = rig();
    const sole = skinned(mesh, 1).clone(), crown = skinned(mesh, 2).clone(), knee = skinned(mesh, 0).clone();
    const shared = mesh.skeleton.boneInverses;
    applyBodyShape(model, { legs: 1 });
    expect(mesh.skeleton.boneInverses).not.toBe(shared);       // clones of one asset share the source array
    expect(skinned(mesh, 1).y).toBeCloseTo(sole.y, 5);
    const gain = (.25 + .22) * .12;
    expect(skinned(mesh, 2).y).toBeCloseTo(crown.y + gain, 5);
    expect(skinned(mesh, 0).y).toBeCloseTo(knee.y + .22 * .12, 5);
    // the lower leg alone moves the sole's bone, not the knee, and still keeps the feet grounded
    applyBodyShape(model, { shins: 1 });
    expect(skinned(mesh, 1).y).toBeCloseTo(sole.y, 5);
    expect(skinned(mesh, 0).y).toBeCloseTo(knee.y + .22 * .25, 5);
    expect(skinned(mesh, 2).y).toBeCloseTo(crown.y + .22 * .25, 5);
    // …and back again from the stored originals
    applyBodyShape(model, undefined);
    expect(skinned(mesh, 2).y).toBeCloseTo(crown.y, 5);
    expect(skinned(mesh, 1).y).toBeCloseTo(sole.y, 5);
  });

  it('survives animation writing bone transforms', () => {
    const { model, mesh, shin } = rig();
    applyBodyShape(model, { legs: 1 });
    const before = skinned(mesh, 1).clone();
    shin.position.set(0, .25, 0);                              // what a clip's constant translation track writes
    expect(skinned(mesh, 1).distanceTo(before)).toBeLessThan(1e-6);
  });

  it('applies the same deformation to a second layer bound to the same bones', () => {
    const { model, mesh, bones } = rig();
    const armor = new THREE.SkinnedMesh(mesh.geometry, mesh.material);
    model.add(armor);
    armor.bind(new THREE.Skeleton(bones, mesh.skeleton.boneInverses.map((m) => m.clone())));
    applyBodyShape(model, { legs: .5, hips: 1, head: -1 });
    for (const v of [0, 1, 2]) expect(skinned(armor, v).distanceTo(skinned(mesh, v))).toBeLessThan(1e-6);
  });

  it('maps sliders to mirrored bones and clamps', () => {
    expect(boneScale({ legs: 5 }, 'thigh.R').y).toBeCloseTo(1.12);
    expect(boneScale({ legs: 1 }, 'thighL').y).toBeCloseTo(1.12);
    expect(boneScale({ head: -1 }, 'head').toArray()).toEqual([.92, .92, .92]);
    expect(boneScale({ legs: 1 }, 'spine').toArray()).toEqual([1, 1, 1]);
    // the lower leg alone: the shin lengthens, the thigh does not
    expect(boneScale({ shins: -1 }, 'shin.L').y).toBeCloseTo(.75);
    expect(boneScale({ shins: -1 }, 'thigh.L').y).toBe(1);
    expect(boneScale({ legs: 1, shins: 1 }, 'shin.R').y).toBeCloseTo(1.12 * 1.25);
  });

  it('validates, cleans and rolls shapes', () => {
    const look: Appearance = { hair: 'braid', hairColor: 'auburn', eyes: 'green', beard: 'none', face: 0 };
    expect(appearanceError('female', { ...look, shape: { legs: .5 } })).toBeNull();
    expect(appearanceError('female', { ...look, shape: { legs: 2 } })).toMatch(/-1 to 1/);
    expect(appearanceError('female', { ...look, shape: { tail: 1 } as never })).toMatch(/proportion/);
    expect(cleanShape({ legs: 0, hips: .333, bogus: 1 } as never)).toEqual({ hips: .33 });
    expect(cleanShape({})).toBeUndefined();
    let seed = 1; const next = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    for (let i = 0; i < 50; i++) {
      const shape = rollShape(next) ?? {};
      for (const key of SHAPE_KEYS) expect(Math.abs(shape[key] ?? 0)).toBeLessThanOrEqual(.6);
    }
  });
});
