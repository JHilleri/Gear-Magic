// Continuous human mesh + fitted layers. No head replacement, neck discard or painted iris shaders.
import * as THREE from 'three';
import type { Appearance, Gender, ItemId } from '../core/types';
import { eyeColorDef, hairColorDef, skinToneDef } from '../data/appearance';
import type { AssetLibrary, AssetManifest, UnifiedBodyMeta } from './types';

type UnitEntry = AssetManifest['units'][string];
type Adopt = (piece: THREE.Object3D) => void;
interface Spring {
  node: THREE.Object3D; rest: THREE.Quaternion; angle: THREE.Vector2; velocity: THREE.Vector2;
  phase: number;
}
interface UnifiedState {
  geometries: Set<THREE.BufferGeometry>; materials: Set<THREE.Material>; textures: Set<THREE.Texture>;
  skeletons: Set<THREE.Skeleton>; springs: Spring[]; previousHead: THREE.Quaternion;
  head: THREE.Bone; time: number;
  attachments: THREE.Object3D[];
}
const states = new WeakMap<THREE.Object3D, UnifiedState>();
const canonicalName = (name: string) => THREE.PropertyBinding.sanitizeNodeName(name);

export function unifiedBodyKey(gender: Gender): string { return `human_${gender === 'female' ? 'f' : 'm'}_base`; }
export function isUnifiedBody(entry: UnitEntry | undefined): boolean { return entry?.unified?.version === 2; }

/** Prefer an intact base only when the loader has both its metadata and its actual GLB. */
export function availableUnifiedBody(assets: AssetLibrary, gender: Gender | undefined): string | null {
  if (!gender) return null;
  const key = unifiedBodyKey(gender);
  return isUnifiedBody(assets.manifest.units[key]) && assets.skinned(key) ? key : null;
}

function bodySkin(model: THREE.Object3D): THREE.SkinnedMesh | null {
  let found: THREE.SkinnedMesh | null = null;
  model.traverse((node) => {
    if (found || !(node as THREE.SkinnedMesh).isSkinnedMesh) return;
    const mesh = node as THREE.SkinnedMesh;
    if (mesh.skeleton.bones.some((b) => b.name === 'head')) found = mesh;
  });
  return found;
}

/** Places globally authored attachment geometry in a bone's bind frame, without fitting guesses. */
export function attachInBindSpace(model: THREE.Object3D, piece: THREE.Object3D, name = 'head'): THREE.Group | null {
  const skin = bodySkin(model);
  if (!skin) return null;
  const index = skin.skeleton.bones.findIndex((b) => canonicalName(b.name) === canonicalName(name));
  if (index < 0) return null;
  const holder = new THREE.Group();
  holder.name = `unified_attachment_${piece.name || name}`;
  skin.skeleton.boneInverses[index].clone().multiply(skin.bindMatrix).decompose(holder.position, holder.quaternion, holder.scale);
  holder.add(piece);
  skin.skeleton.bones[index].add(holder);
  return holder;
}

/** Copies only mesh instances, rebinding every index to this body's bones by canonical name. */
export function attachFittedArmor(model: THREE.Object3D, armor: THREE.Object3D): { meshes: THREE.SkinnedMesh[]; skeletons: THREE.Skeleton[]; missing: string[] } {
  const base = bodySkin(model);
  if (!base) return { meshes: [], skeletons: [], missing: ['body-skeleton'] };
  const byName = new Map(base.skeleton.bones.map((bone) => [canonicalName(bone.name), bone]));
  const candidates: THREE.SkinnedMesh[] = [];
  armor.updateMatrixWorld(true);
  armor.traverse((node) => { if ((node as THREE.SkinnedMesh).isSkinnedMesh) candidates.push(node as THREE.SkinnedMesh); });
  const missing: string[] = [];
  for (const mesh of candidates) for (const bone of mesh.skeleton.bones) {
    if (!byName.has(canonicalName(bone.name))) missing.push(bone.name);
  }
  if (missing.length) return { meshes: [], skeletons: [], missing: [...new Set(missing)] };
  const skeletons: THREE.Skeleton[] = [];
  const oldSkeletons = new Set<THREE.Skeleton>();
  const inverseRoot = armor.matrixWorld.clone().invert();
  for (const mesh of candidates) {
    const matrix = inverseRoot.clone().multiply(mesh.matrixWorld);
    const old = mesh.skeleton;
    oldSkeletons.add(old);
    const skeleton = new THREE.Skeleton(old.bones.map((bone) => byName.get(canonicalName(bone.name))!), old.boneInverses.map((matrix) => matrix.clone()));
    skeletons.push(skeleton);
    const bind = mesh.bindMatrix.clone();
    mesh.removeFromParent();
    matrix.decompose(mesh.position, mesh.quaternion, mesh.scale);
    model.add(mesh);
    mesh.bind(skeleton, bind);
    mesh.frustumCulled = false;
  }
  // The attachment library returns private skeleton clones. Their bones never render after rebind.
  for (const skeleton of oldSkeletons) skeleton.dispose();
  return { meshes: candidates, skeletons, missing: candidates.length ? [] : ['armor-skin'] };
}

function irisTexture(color: THREE.Color): THREE.DataTexture {
  const width = 256, height = 32;
  const data = new Uint8Array(width * height * 4);
  const srgb = color.clone().convertLinearToSRGB();
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const radial = y / (height - 1);
    const angle = x / width * Math.PI * 2;
    const fibers = Math.sin(angle * 51 + Math.sin(angle * 13) * 2 + radial * 3) * .10
      + Math.sin(angle * 113 - radial * 8) * .055;
    const edge = .42 + .43 * Math.sin(Math.PI * radial);
    const shade = Math.max(.23, Math.min(.95, edge + fibers));
    const i = (y * width + x) * 4;
    data[i] = Math.round(srgb.r * shade * 255);
    data[i + 1] = Math.round(srgb.g * shade * 255);
    data[i + 2] = Math.round(srgb.b * shade * 255);
    data[i + 3] = 255;
  }
  const texture = new THREE.DataTexture(data, width, height, THREE.RGBAFormat);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.needsUpdate = true;
  return texture;
}

/** Real globes, curved iris caps and pupils. Ordinary PBR lighting; body eyelids occlude them. */
function makeEyes(meta: UnifiedBodyMeta, look: Appearance, state: UnifiedState): THREE.Group {
  const group = new THREE.Group(); group.name = 'physical_eyes';
  const white = new THREE.MeshStandardMaterial({ name: 'Eye_sclera', color: '#c8bdb2', roughness: .48, metalness: 0, envMapIntensity: .18 });
  const eyeColor = new THREE.Color(eyeColorDef(look.eyes)?.color ?? '#6b4423').lerp(new THREE.Color('#564b39'), .23);
  const texture = irisTexture(eyeColor); state.textures.add(texture);
  const iris = new THREE.MeshStandardMaterial({ name: 'Eye_iris', map: texture, roughness: .63, metalness: 0, envMapIntensity: .14 });
  const pupil = new THREE.MeshStandardMaterial({ name: 'Eye_pupil', color: '#080705', roughness: .5, metalness: 0, envMapIntensity: .1 });
  for (const material of [white, iris, pupil]) state.materials.add(material);
  meta.eyes.forEach((eye, index) => {
    const radius = eye.radius;
    if (!Number.isFinite(radius) || radius <= 0 || radius > .08 || eye.center.some((v) => !Number.isFinite(v))) return;
    const irisRadius = Math.min(radius * .65, eye.irisRadius ?? radius * .43);
    const eyeGroup = new THREE.Group(); eyeGroup.name = `eye_${index === 0 ? 'L' : 'R'}`;
    eyeGroup.position.fromArray(eye.center);
    const globeGeometry = new THREE.SphereGeometry(radius, 32, 20);
    const irisGeometry = new THREE.SphereGeometry(radius * 1.001, 40, 10, 0, Math.PI * 2, 0, Math.asin(irisRadius / radius));
    const pupilGeometry = new THREE.SphereGeometry(radius * 1.002, 32, 8, 0, Math.PI * 2, 0, Math.asin(irisRadius * .37 / radius));
    for (const geometry of [globeGeometry, irisGeometry, pupilGeometry]) state.geometries.add(geometry);
    const globe = new THREE.Mesh(globeGeometry, white);
    const colored = new THREE.Mesh(irisGeometry, iris); colored.rotation.x = Math.PI / 2;
    const dark = new THREE.Mesh(pupilGeometry, pupil); dark.rotation.x = Math.PI / 2;
    eyeGroup.add(globe, colored, dark); group.add(eyeGroup);
  });
  // In particular, neither these meshes nor their materials use depthTest=false or renderOrder overlays.
  group.traverse((node) => { if ((node as THREE.Mesh).isMesh) { node.castShadow = false; node.receiveShadow = true; } });
  return group;
}

function eachMaterial(model: THREE.Object3D, visit: (material: THREE.MeshStandardMaterial) => void): void {
  model.traverse((node) => {
    const mesh = node as THREE.Mesh;
    if (!mesh.isMesh) return;
    for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) visit(material as THREE.MeshStandardMaterial);
  });
}

/** Materials must already be adopted/cloned by the caller. Returns missing attachment keys. */
export function dressUnifiedCharacter(
  assets: AssetLibrary, model: THREE.Object3D, entry: UnitEntry, gender: Gender, look: Appearance,
  bodyItem: ItemId | null | undefined, adopt: Adopt,
): string[] {
  const meta = entry.unified;
  const skin = bodySkin(model);
  const head = skin?.skeleton.bones.find((bone) => bone.name === 'head');
  if (!meta || meta.version !== 2 || !skin || !head) return ['unified-body-metadata'];
  disposeUnifiedCharacter(model);
  const state: UnifiedState = {
    geometries: new Set(), materials: new Set(), textures: new Set(), skeletons: new Set(), springs: [],
    previousHead: new THREE.Quaternion(), head, time: 0, attachments: [],
  };
  states.set(model, state);
  const missing: string[] = [];
  const g = gender === 'female' ? 'f' : 'm';
  const armorId = bodyItem && ['tunic', 'leather', 'plate', 'robe'].includes(bodyItem) ? bodyItem as 'tunic' | 'leather' | 'plate' | 'robe' : null;
  let fittedArmor = false;
  if (armorId) {
    const key = `armor_${g}_${armorId}`;
    const armor = assets.model('items', key);
    if (!armor) missing.push(key);
    else {
      adopt(armor);
      const attached = attachFittedArmor(model, armor);
      if (attached.missing.length) missing.push(...attached.missing.map((bone) => `${key}:${bone}`));
      else fittedArmor = true;
      for (const skeleton of attached.skeletons) state.skeletons.add(skeleton);
      state.attachments.push(...attached.meshes);
    }
  }
  const covered = new Set(fittedArmor && armorId
    ? meta.coveredRegions?.[armorId] ?? ['torso', 'upperarm', 'forearm', 'legs', 'feet'] : []);
  const target = new THREE.Color(skinToneDef(look.skin)?.color ?? '#b58d75');
  const hairColor = new THREE.Color(hairColorDef(look.hairColor)?.color ?? '#7a5233');
  // An omitted unified.skin explicitly means neutral modulation; legacy cheek
  // metadata on the entry must not be interpreted as this new material's albedo.
  const source = meta.skin;
  eachMaterial(model, (material) => {
    if (/^brows?(?:[_\.]|$)/i.test(material.name)) {
      material.color?.copy(hairColor).multiplyScalar(.55);
      material.roughness = .85; material.metalness = 0;
      material.emissive?.set(0); material.emissiveIntensity = 0;
      return;
    }
    if (!/^skin[_\.]/i.test(material.name)) return;
    const region = material.name.toLowerCase().replace(/^skin[_\.]/, '').replace(/\.\d+$/, '');
    material.visible = !covered.has(region);
    if (material.color) {
      if (source) {
        const neutral = new THREE.Color().setRGB(...source, THREE.SRGBColorSpace);
        material.color.setRGB(target.r / Math.max(neutral.r, .03), target.g / Math.max(neutral.g, .03), target.b / Math.max(neutral.b, .03));
      } else material.color.copy(target);
    }
    material.metalness = 0; material.roughness = .73; material.envMapIntensity = .25;
    material.emissive?.set(0); material.emissiveIntensity = 0;
  });
  model.traverse((node) => {
    const mesh = node as THREE.Mesh;
    if (!mesh.isMesh || !mesh.morphTargetDictionary || !mesh.morphTargetInfluences) return;
    for (const [name, index] of Object.entries(mesh.morphTargetDictionary)) {
      if (/^face_[12]$/.test(name)) mesh.morphTargetInfluences[index] = Number(name === `face_${look.face}`);
    }
  });
  const eyes = makeEyes(meta, look, state);
  const eyeHolder = attachInBindSpace(model, eyes);
  if (eyeHolder) state.attachments.push(eyeHolder);
  const hairKeys = look.hair === 'bald' ? [] : [`${meta.hairPrefix ?? `unified_${g}_`}${look.hair}`];
  if (look.beard !== 'none') hairKeys.push(`unified_${g}_beard_${look.beard}`);
  for (const key of hairKeys) {
    const hair = assets.model('hair', key);
    if (!hair) { missing.push(key); continue; }
    adopt(hair);
    eachMaterial(hair, (material) => {
      material.color?.multiply(hairColor);
      material.metalness = 0; material.roughness = .76; material.envMapIntensity = .25;
      material.emissive?.set(0); material.emissiveIntensity = 0;
    });
    hair.name = key;
    const holder = attachInBindSpace(model, hair);
    if (holder) state.attachments.push(holder);
    hair.traverse((node) => {
      if (/^swing_/i.test(node.name)) state.springs.push({ node, rest: node.quaternion.clone(), angle: new THREE.Vector2(), velocity: new THREE.Vector2(), phase: state.springs.length * 1.7 });
    });
  }
  model.updateMatrixWorld(true);
  head.getWorldQuaternion(state.previousHead);
  return missing;
}

/** Small damped secondary motion: roots stay fixed to the skull; only authored loose groups swing. */
export function updateUnifiedHair(model: THREE.Object3D, dt: number): void {
  const state = states.get(model);
  if (!state || !state.springs.length || !(dt > 0)) return;
  dt = Math.min(dt, .05); state.time += dt;
  const current = state.head.getWorldQuaternion(new THREE.Quaternion());
  const delta = state.previousHead.clone().invert().multiply(current);
  const rotation = new THREE.Euler().setFromQuaternion(delta);
  state.previousHead.copy(current);
  for (const spring of state.springs) {
    const targetX = THREE.MathUtils.clamp(-rotation.x * .4 + Math.sin(state.time * 1.8 + spring.phase) * .012, -.1, .1);
    const targetZ = THREE.MathUtils.clamp(-rotation.y * .32 + Math.sin(state.time * 1.3 + spring.phase) * .009, -.1, .1);
    spring.velocity.x += ((targetX - spring.angle.x) * 42 - spring.velocity.x * 9) * dt;
    spring.velocity.y += ((targetZ - spring.angle.y) * 42 - spring.velocity.y * 9) * dt;
    spring.angle.addScaledVector(spring.velocity, dt);
    spring.angle.clampScalar(-.13, .13);
    spring.node.quaternion.copy(spring.rest).multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(spring.angle.x, 0, spring.angle.y)));
  }
}

export function disposeUnifiedCharacter(model: THREE.Object3D): void {
  const state = states.get(model);
  if (!state) return;
  states.delete(model);
  for (const attachment of state.attachments) attachment.removeFromParent();
  for (const geometry of state.geometries) geometry.dispose();
  for (const material of state.materials) material.dispose();
  for (const texture of state.textures) texture.dispose();
  for (const skeleton of state.skeletons) skeleton.dispose();
}
