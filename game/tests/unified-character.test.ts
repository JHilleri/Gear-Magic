import * as THREE from 'three';
import { clone as skeletonClone } from 'three/addons/utils/SkeletonUtils.js';
import { describe, expect, it, vi } from 'vitest';
import type { Appearance, Equipment } from '../src/core/types';
import { SKIN_TONES } from '../src/data/appearance';
import { emptyManifest } from '../src/render/assets';
import { createCharacter } from '../src/render/character';
import { attachFittedArmor, availableUnifiedBody, dressUnifiedCharacter, disposeUnifiedCharacter, updateUnifiedHair } from '../src/render/unified-character';
import type { AssetLibrary, AssetManifest } from '../src/render/types';

const look: Appearance = { hair: 'tail', hairColor: 'brown', eyes: 'blue', beard: 'none', face: 2, skin: 'warm' };
const equipment: Equipment = { main: null, off: null, body: 'leather', trinket: null, mount: null };

function rig(name: string, regions: boolean) {
  const scene = new THREE.Group();
  const hips = new THREE.Bone(); hips.name = 'hips'; hips.position.y = .5;
  const head = new THREE.Bone(); head.name = 'head'; head.position.y = .43;
  const arm = new THREE.Bone(); arm.name = 'upperarmL'; arm.position.set(.12, .29, 0);
  hips.add(head, arm); scene.add(hips);
  const geometry = new THREE.BoxGeometry(.1, .8, .1);
  const count = geometry.getAttribute('position').count;
  geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(new Uint16Array(count * 4), 4));
  const weights = new Float32Array(count * 4); for (let i = 0; i < count; i++) weights[i * 4] = 1;
  geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute(weights, 4));
  geometry.morphTargetsRelative = true;
  geometry.morphAttributes.position = [1, 2].map((n) => {
    const attribute = new THREE.Float32BufferAttribute(new Float32Array(count * 3).fill(n * .001), 3);
    attribute.name = `face_${n}`; return attribute;
  });
  const material = regions
    ? ['head', 'torso', 'upperarm', 'forearm', 'hands', 'legs', 'feet'].map((region) => new THREE.MeshStandardMaterial({ name: `Skin_${region}`, color: '#ffffff' }))
    : [new THREE.MeshStandardMaterial({ name: 'Leather', color: '#613c25' })];
  const mesh = new THREE.SkinnedMesh(geometry, material); mesh.name = name;
  scene.add(mesh); scene.updateMatrixWorld(true);
  mesh.bind(new THREE.Skeleton([hips, head, arm]));
  return { scene, mesh, material, geometry, hips, head, arm };
}

function fixture() {
  const body = rig('Body', true), armor = rig('Armor', false);
  const hair = new THREE.Group();
  const swing = new THREE.Group(); swing.name = 'swing_tail'; swing.position.set(0, .95, -.05);
  const hairMaterial = new THREE.MeshStandardMaterial({ name: 'Hair_strands', color: '#ffffff' });
  const hairGeometry = new THREE.CylinderGeometry(.01, .005, .1, 8);
  swing.add(new THREE.Mesh(hairGeometry, hairMaterial)); hair.add(swing);
  const manifest = emptyManifest();
  const entry: AssetManifest['units'][string] = {
    file: 'base.glb', height: 1, head: { x: 0, y: 1, z: -.04, depth: .1 },
    unified: { version: 2, eyes: [{ center: [-.02, .94, .045], radius: .007 }, { center: [.02, .94, .045], radius: .007 }] },
  };
  manifest.units.human_m_base = entry;
  manifest.items.armor_m_leather = { file: 'armor.glb' };
  manifest.hair.unified_m_tail = { file: 'hair.glb' };
  const assets: AssetLibrary = {
    manifest,
    skinned: (key) => key === 'human_m_base' ? { scene: body.scene, animations: [new THREE.AnimationClip('idle', 1, [])] } : null,
    model(kind, key) {
      if (kind === 'items' && key === 'armor_m_leather') return skeletonClone(armor.scene);
      if (kind === 'hair' && key === 'unified_m_tail') return skeletonClone(hair);
      return null;
    },
    texture: () => null, iconUrl: () => null, portraitUrl: () => null,
  };
  return { assets, body, armor, entry, hairMaterial, hairGeometry };
}

describe('continuous human assembly', () => {
  it('uses one body/head for every outfit, with fitted armor and no legacy head replacement', () => {
    const { assets } = fixture();
    const armored = createCharacter(assets, { gender: 'male', look, equipment });
    const bare = createCharacter(assets, { gender: 'male', look, equipment: { ...equipment, body: null } });
    expect(armored.bodyKey).toBe('human_m_base');
    expect(bare.bodyKey).toBe(armored.bodyKey);
    expect(armored.root.getObjectByName('Armor')).toBeDefined();
    expect(bare.root.getObjectByName('Armor')).toBeUndefined();
    expect(armored.root.getObjectByName('face')).toBeUndefined();
    expect(armored.root.getObjectByName('hair_tail')).toBeUndefined();
    const mesh = armored.root.getObjectByName('Body') as THREE.SkinnedMesh;
    expect(mesh.morphTargetInfluences![mesh.morphTargetDictionary!.face_2]).toBe(1);
    expect(mesh.morphTargetInfluences![mesh.morphTargetDictionary!.face_1]).toBe(0);
    const mats = mesh.material as THREE.MeshStandardMaterial[];
    expect(mats.find((m) => m.name === 'Skin_head')!.visible).toBe(true);
    expect(mats.find((m) => m.name === 'Skin_hands')!.visible).toBe(true);
    expect(mats.find((m) => m.name === 'Skin_torso')!.visible).toBe(false);
    expect(mats[0].color.getHexString()).toBe(SKIN_TONES.find((t) => t.id === look.skin)!.color.slice(1));
    expect(armored.missingAssets).toEqual([]);
    armored.dispose(); bare.dispose();
  });

  it('keeps uncovered body geometry visible if fitted armor is absent, reporting the missing asset', () => {
    const { assets } = fixture();
    const character = createCharacter(assets, { gender: 'male', look, equipment: { ...equipment, body: 'plate' } });
    expect(character.missingAssets).toContain('armor_m_plate');
    const mats = (character.root.getObjectByName('Body') as THREE.Mesh).material as THREE.Material[];
    expect(mats.every((m) => m.visible)).toBe(true);
    character.dispose();
  });

  it('uses real depth-tested eye geometry without emissive materials or painted-iris shader patches', () => {
    const { assets } = fixture();
    const character = createCharacter(assets, { gender: 'male', look, equipment });
    const eyes = character.root.getObjectByName('physical_eyes')!;
    expect(eyes).toBeDefined();
    const meshes: THREE.Mesh[] = [];
    eyes.traverse((node) => { if ((node as THREE.Mesh).isMesh) meshes.push(node as THREE.Mesh); });
    expect(meshes).toHaveLength(6);
    for (const mesh of meshes) {
      const material = mesh.material as THREE.MeshStandardMaterial;
      expect(material.depthTest).toBe(true);
      expect(material.depthWrite).toBe(true);
      expect(material.emissive.getHex()).toBe(0);
      expect(mesh.renderOrder).toBe(0);
    }
    expect(meshes.filter((mesh) => (mesh.material as THREE.Material).name === 'Eye_iris')).toHaveLength(2);
    character.dispose();
  });

  it('faces iris and pupil caps forward and lets a fitted upper lid occlude them', () => {
    const { assets, entry } = fixture();
    const character = createCharacter(assets, { gender: 'male', look, equipment });
    const eye = character.root.getObjectByName('eye_L')!;
    const radius = entry.unified!.eyes[0].radius;
    // A shallow lid opening overlaps the top of the iris, as an authored relaxed lid should.
    const skin = new THREE.Shape();
    skin.moveTo(-radius * 2, -radius * 2);
    skin.lineTo(radius * 2, -radius * 2); skin.lineTo(radius * 2, radius * 2);
    skin.lineTo(-radius * 2, radius * 2); skin.closePath();
    const opening = new THREE.Path();
    opening.absellipse(0, 0, radius * .9, radius * .24, 0, Math.PI * 2, true);
    skin.holes.push(opening);
    const lidGeometry = new THREE.ShapeGeometry(skin, 32);
    const lidMaterial = new THREE.MeshStandardMaterial();
    const lid = new THREE.Mesh(lidGeometry, lidMaterial); lid.name = 'fitted_lid';
    lid.position.z = radius * 1.01; eye.add(lid);
    character.root.updateMatrixWorld(true);
    const raycast = (y: number) => {
      const origin = eye.localToWorld(new THREE.Vector3(0, y, radius * 3));
      const direction = new THREE.Vector3(0, 0, -1).transformDirection(eye.matrixWorld);
      return new THREE.Raycaster(origin, direction).intersectObject(eye, true)[0].object as THREE.Mesh;
    };
    expect((raycast(0).material as THREE.Material).name).toBe('Eye_pupil');
    // This ray crosses the colored cap, but hits the skin lid first.
    expect(raycast(radius * .32)).toBe(lid);
    lid.removeFromParent(); lidGeometry.dispose(); lidMaterial.dispose();
    character.dispose();
  });

  it('maps attachment skeleton indices by name and follows the original body bones', () => {
    const { body, armor } = fixture();
    const source = armor.mesh.skeleton;
    armor.mesh.bind(new THREE.Skeleton([source.bones[2], source.bones[0], source.bones[1]],
      [source.boneInverses[2], source.boneInverses[0], source.boneInverses[1]]));
    const { meshes, skeletons, missing } = attachFittedArmor(body.scene, armor.scene);
    expect(missing).toEqual([]);
    expect(meshes).toHaveLength(1);
    expect(skeletons[0].bones).toEqual([body.arm, body.hips, body.head]);
    expect(meshes[0].geometry).toBe(armor.geometry);
    body.arm.rotation.z = .4; body.scene.updateMatrixWorld(true); skeletons[0].update();
    expect(skeletons[0].bones[0].rotation.z).toBe(.4);
    skeletons[0].dispose();
  });

  it('keeps source materials and geometry shared safely while releasing generated resources once', () => {
    const { assets, body, hairMaterial, hairGeometry } = fixture();
    const sourceMaterialDispose = vi.spyOn(body.material[0], 'dispose');
    const sourceGeometryDispose = vi.spyOn(body.geometry, 'dispose');
    const hairGeometryDispose = vi.spyOn(hairGeometry, 'dispose');
    const a = createCharacter(assets, { gender: 'male', look, equipment });
    const b = createCharacter(assets, { gender: 'male', look: { ...look, skin: 'deep', eyes: 'green' }, equipment });
    const eye = a.root.getObjectByName('eye_L')!.children[0] as THREE.Mesh;
    const disposeEye = vi.spyOn(eye.geometry, 'dispose');
    a.dispose(); a.dispose();
    expect(disposeEye).toHaveBeenCalledTimes(1);
    expect(sourceMaterialDispose).not.toHaveBeenCalled();
    expect(sourceGeometryDispose).not.toHaveBeenCalled();
    expect(hairGeometryDispose).not.toHaveBeenCalled();
    expect(hairMaterial.color.getHex()).toBe(0xffffff);
    expect(body.material.every((m) => m.visible)).toBe(true);
    expect(body.mesh.morphTargetInfluences).toEqual([0, 0]);
    expect(b.root.getObjectByName('physical_eyes')).toBeDefined();
    b.dispose();
  });

  it('anchors hair to the head frame and limits secondary motion to authored loose groups', () => {
    const { assets, body, entry } = fixture();
    const model = skeletonClone(body.scene);
    const own = (root: THREE.Object3D) => root.traverse((node) => {
      const mesh = node as THREE.Mesh;
      if (mesh.isMesh) mesh.material = Array.isArray(mesh.material) ? mesh.material.map((m) => m.clone()) : mesh.material.clone();
    });
    own(model);
    dressUnifiedCharacter(assets, model, entry, 'male', look, null, own);
    const hair = model.getObjectByName('unified_m_tail')!;
    const swing = hair.getObjectByName('swing_tail')!;
    expect(hair.parent!.parent!.name).toBe('head');
    const fixed = hair.parent!.matrix.clone();
    const head = model.getObjectByName('head')!;
    head.rotation.y = .4;
    for (let i = 0; i < 15; i++) updateUnifiedHair(model, 1 / 30);
    expect(swing.quaternion.angleTo(new THREE.Quaternion())).toBeGreaterThan(0);
    expect(swing.quaternion.angleTo(new THREE.Quaternion())).toBeLessThan(.2);
    hair.parent!.updateMatrix();
    expect(hair.parent!.matrix.equals(fixed)).toBe(true);
    disposeUnifiedCharacter(model);
  });

  it('requires both unified metadata and a loaded base before changing the legacy route', () => {
    const { assets, entry } = fixture();
    expect(availableUnifiedBody(assets, 'male')).toBe('human_m_base');
    expect(availableUnifiedBody(assets, 'female')).toBeNull();
    delete entry.unified;
    expect(availableUnifiedBody(assets, 'male')).toBeNull();
  });

  it('does not divide neutral unified skin by inherited legacy cheek metadata', () => {
    const { assets, entry } = fixture();
    entry.skin = [.12, .08, .06];
    const character = createCharacter(assets, { gender: 'male', look, equipment: { ...equipment, body: null } });
    const material = ((character.root.getObjectByName('Body') as THREE.Mesh).material as THREE.MeshStandardMaterial[])[0];
    expect(material.color.getHexString()).toBe(SKIN_TONES.find((tone) => tone.id === look.skin)!.color.slice(1));
    character.dispose();
  });
});
