// Artist-authored armor modules follow the same skeleton as every fitted body.
// Kept separate from the studio so map units and portraits use identical attachments.
import * as THREE from 'three';
import type { Gender, ItemId } from '../core/types';
import type { AssetLibrary } from './types';

/**
 * Attach the modeled plate shoulders in bind space, then let the upper arm bones animate them.
 * Call before material adoption: callers own cloned materials, while geometry/textures stay shared.
 */
export function attachCharacterRegalia(
  assets: AssetLibrary, model: THREE.Object3D, bodyItem: ItemId | null | undefined, gender?: Gender,
): THREE.Object3D[] {
  if (bodyItem !== 'plate' || !gender) return [];
  let mesh: THREE.SkinnedMesh | undefined;
  model.traverse((node) => { if (!mesh && (node as THREE.SkinnedMesh).isSkinnedMesh) mesh = node as THREE.SkinnedMesh; });
  if (!mesh) return [];
  const skinned = mesh as THREE.SkinnedMesh;
  const attached: THREE.Object3D[] = [];
  for (const [side, sign] of [['L', 1], ['R', -1]] as const) {
    const index = skinned.skeleton.bones.findIndex((bone) => bone.name === `upperarm.${side}` || bone.name === `upperarm${side}`);
    if (index < 0) continue;
    const piece = assets.model('items', 'pauldron_plate');
    if (!piece) continue;
    const toBone = skinned.skeleton.boneInverses[index].clone().multiply(skinned.bindMatrix);
    const shoulder = new THREE.Vector3().setFromMatrixPosition(toBone.clone().invert());
    const size = gender === 'female' ? 0.85 : 1;
    // One authored plate mirrors across X. The smaller cut clears the female neck/collar.
    shoulder.add(new THREE.Vector3(sign * 0.018 * size, 0.025 * size, 0));
    const frame = new THREE.Matrix4().compose(shoulder, new THREE.Quaternion(), new THREE.Vector3(sign * size, size, size));
    const holder = new THREE.Group();
    holder.name = `armor_pauldron_${side}`;
    toBone.multiply(frame).decompose(holder.position, holder.quaternion, holder.scale);
    holder.add(piece);
    skinned.skeleton.bones[index].add(holder);
    attached.push(holder);
  }
  return attached;
}

/** A proper setting and metal band make small trinkets visible without replacing them by UI glows. */
export function createCharacterTrinket(item: 'ring' | 'amulet'): THREE.Group {
  const group = new THREE.Group();
  group.name = `equipment_${item}`;
  const metal = new THREE.MeshStandardMaterial({ color: '#d3a252', metalness: 0.78, roughness: 0.28 });
  const gemMat = new THREE.MeshStandardMaterial({ color: item === 'ring' ? '#48a7df' : '#b92d45',
    emissive: item === 'ring' ? '#266ba1' : '#711b29', emissiveIntensity: 0.35, metalness: 0.18, roughness: 0.17 });
  if (item === 'amulet') {
    const bezel = new THREE.Mesh(new THREE.TorusGeometry(0.017, 0.0035, 8, 28), metal);
    bezel.scale.set(1, 1.3, 1);
    const gem = new THREE.Mesh(new THREE.OctahedronGeometry(0.014, 0), gemMat);
    gem.scale.set(1, 1.3, 0.48);
    gem.position.z = 0.003;
    const chain = new THREE.Mesh(new THREE.TorusGeometry(0.047, 0.0016, 6, 40, Math.PI), metal);
    chain.rotation.z = Math.PI;
    chain.position.set(0, 0.052, -0.004);
    chain.scale.y = 1.1;
    group.add(bezel, gem, chain);
    group.position.z = 0.004;
  } else {
    const band = new THREE.Mesh(new THREE.TorusGeometry(0.009, 0.0025, 8, 20), metal);
    const gem = new THREE.Mesh(new THREE.OctahedronGeometry(0.0065), gemMat);
    gem.position.set(0, 0.008, 0.002);
    gem.scale.set(0.8, 1, 0.6);
    group.add(band, gem);
    group.position.set(0.009, 0.004, 0.006);
  }
  group.traverse((node) => { if ((node as THREE.Mesh).isMesh) node.castShadow = true; });
  return group;
}
