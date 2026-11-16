import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import type { Appearance, Unit } from '../src/core/types';
import { emptyManifest } from '../src/render/assets';
import { characterSocket, createCharacter, equipmentSocket } from '../src/render/character';
import { attachCharacterRegalia } from '../src/render/character-regalia';
import type { AssetLibrary } from '../src/render/types';

const appearance: Appearance = { hair: 'short', hairColor: 'brown', eyes: 'blue', beard: 'none', face: 0 };
const equipment: Unit['equipment'] = { main: 'sword', off: 'shield', body: 'plate', trinket: 'amulet', mount: null };

function fixture(): { assets: AssetLibrary; geometry: THREE.BufferGeometry; material: THREE.Material } {
  const scene = new THREE.Group();
  const geometry = new THREE.BoxGeometry(0.2, 0.8, 0.1);
  const material = new THREE.MeshStandardMaterial({ color: '#806050' });
  const body = new THREE.Mesh(geometry, material);
  body.name = 'body';
  scene.add(body);
  for (const name of ['gripR', 'gripL', 'holdL', 'chest_socket']) {
    const socket = new THREE.Object3D(); socket.name = name; scene.add(socket);
  }
  const manifest = emptyManifest();
  manifest.units.human_m_heavy = { file: 'test.glb', height: 1 };
  manifest.heads.head_m1 = { file: 'test.glb' };
  manifest.hair.hair_short = { file: 'test.glb' };
  const animations = ['idle', 'walk', 'attack_melee', 'death'].map((name) => new THREE.AnimationClip(name, 1, [
    new THREE.NumberKeyframeTrack('.rotation[y]', [0, 1], [0, 0.2]),
  ]));
  const assets: AssetLibrary = {
    manifest,
    skinned: (key) => key === 'human_m_heavy' ? { scene, animations } : null,
    model: (kind, key) => {
      if (kind !== 'items' || !['sword', 'bow', 'shield_human'].includes(key)) return null;
      const mesh = new THREE.Mesh(geometry, material); mesh.name = key; return mesh;
    },
    texture: () => null, iconUrl: () => null, portraitUrl: () => null,
  };
  return { assets, geometry, material };
}

describe('character assembly', () => {
  it('attaches weapons and jewelry to the animated source sockets', () => {
    const { assets } = fixture();
    const character = createCharacter(assets, { gender: 'male', appearance, equipment });
    expect(character.bodyKey).toBe('human_m_heavy');
    expect(character.root.getObjectByName('equipment_sword')?.parent?.name).toBe('gripR');
    expect(character.root.getObjectByName('equipment_shield')?.parent?.name).toBe('gripL');
    expect(character.root.getObjectByName('equipment_amulet')?.parent?.name).toBe('chest_socket');
    expect(character.diagnostics.triangles).toBeGreaterThan(0);
    expect(character.missingAssets).toEqual([]);
    expect(character.play('walk')).toBe(true);
    expect(character.play('not-a-clip')).toBe(false);
    character.update(0.1);
    character.dispose();
  });

  it('holds a two-handed bow in the left palm, omits its shield, and puts a ring on a hand', () => {
    const { assets } = fixture();
    const character = createCharacter(assets, { gender: 'male', appearance,
      equipment: { ...equipment, main: 'bow', trinket: 'ring' } });
    expect(character.root.getObjectByName('equipment_bow')?.parent?.name).toBe('holdL');
    expect(character.root.getObjectByName('equipment_shield')).toBeUndefined();
    expect(character.root.getObjectByName('equipment_ring')?.parent?.name).toBe('gripR');
    expect(characterSocket(character.root, 'grip.R')?.name).toBe('gripR');
    expect(equipmentSocket('staff', 'main')).toBe('grip.R');
    character.dispose();
  });

  it('owns per-instance materials and disposes only its own resources', () => {
    const { assets, material, geometry } = fixture();
    const originalDispose = vi.spyOn(material, 'dispose');
    const geometryDispose = vi.spyOn(geometry, 'dispose');
    const a = createCharacter(assets, { gender: 'male', appearance, equipment });
    const b = createCharacter(assets, { gender: 'male', appearance, equipment });
    const am = (a.root.getObjectByName('body') as THREE.Mesh).material as THREE.MeshStandardMaterial;
    const bm = (b.root.getObjectByName('body') as THREE.Mesh).material as THREE.MeshStandardMaterial;
    expect(am).not.toBe(bm);
    expect(am).not.toBe(material);
    const ownDispose = vi.spyOn(am, 'dispose');
    a.dispose(); a.dispose();
    expect(ownDispose).toHaveBeenCalledTimes(1);
    expect(originalDispose).not.toHaveBeenCalled();
    expect(geometryDispose).not.toHaveBeenCalled();
    expect(b.play('idle')).toBe(true);
    expect(a.play('idle')).toBe(false);
    b.dispose();
  });

  it('fails visibly for an absent body and reports missing equipment', () => {
    const { assets } = fixture();
    expect(() => createCharacter(assets, { gender: 'female', appearance: { ...appearance, hair: 'braid' }, equipment })).toThrow('Missing character body');
    const character = createCharacter(assets, { gender: 'male', appearance, equipment: { ...equipment, main: 'axe' } });
    expect(character.missingAssets).toContain('item:axe');
    character.dispose();
  });

  it('fits mirrored plate modules to the animated bones without modifying their source asset', () => {
    const { assets } = fixture();
    const model = new THREE.Group();
    const left = new THREE.Bone(); left.name = 'upperarmL'; left.position.set(0.1, 0.8, 0);
    const right = new THREE.Bone(); right.name = 'upperarmR'; right.position.set(-0.1, 0.8, 0);
    model.add(left, right);
    model.updateMatrixWorld(true);
    const skin = new THREE.SkinnedMesh(new THREE.BufferGeometry(), new THREE.MeshStandardMaterial());
    skin.bind(new THREE.Skeleton([left, right]));
    model.add(skin);
    const moduleGeometry = new THREE.BoxGeometry(0.2, 0.1, 0.15);
    const moduleMaterial = new THREE.MeshStandardMaterial();
    assets.model = (kind, key) => kind === 'items' && key === 'pauldron_plate' ? new THREE.Mesh(moduleGeometry, moduleMaterial) : null;
    expect(attachCharacterRegalia(assets, model, 'leather', 'female')).toEqual([]);
    const modules = attachCharacterRegalia(assets, model, 'plate', 'female');
    expect(modules).toHaveLength(2);
    expect(modules[0].parent).toBe(left);
    expect(modules[1].parent).toBe(right);
    model.updateMatrixWorld(true);
    const l = modules[0].getWorldPosition(new THREE.Vector3());
    const r = modules[1].getWorldPosition(new THREE.Vector3());
    expect(l.x).toBeCloseTo(-r.x);
    expect(l.y).toBeCloseTo(r.y);
    expect(l.y).toBeGreaterThan(0.8);
    expect(modules[0].matrixWorld.determinant()).toBeGreaterThan(0);
    expect(modules[1].matrixWorld.determinant()).toBeLessThan(0);
    const before = l.clone();
    left.rotation.z = 0.4;
    model.updateMatrixWorld(true);
    expect(modules[0].getWorldPosition(new THREE.Vector3()).distanceTo(before)).toBeGreaterThan(0.001);
    expect((modules[0].children[0] as THREE.Mesh).geometry).toBe(moduleGeometry);
    skin.geometry.dispose(); (skin.material as THREE.Material).dispose();
    skin.skeleton.dispose(); moduleGeometry.dispose(); moduleMaterial.dispose();
  });
});
