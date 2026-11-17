// Character assembly shared with the studio: the same rig, face fitting and sockets as map units.
// Source GLBs, their textures and animations stay cached; each character owns its cloned materials
// and skeletons. Switching an outfit never changes the source asset or another character.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clone as skeletonClone } from 'three/addons/utils/SkeletonUtils.js';
import type { Appearance, Gender, Unit } from '../core/types';
import { appearanceError } from '../data/appearance';
import { ITEMS } from '../data/items';
import { assetBase, emptyManifest, parseUnitMeta } from './assets';
import { bodyPaintKey, dressHead, hairPieceKeys, headModelKey, patchBodyShader } from './appearance';
import type { AssetLibrary, AssetManifest, SkinnedAsset } from './types';
import { firstAvailable, unitBodyKeys } from './units';
import { attachCharacterRegalia, createCharacterTrinket } from './character-regalia';
import { availableUnifiedBody, isUnifiedBody, dressUnifiedCharacter, updateUnifiedHair, disposeUnifiedCharacter } from './unified-character';

type Section = 'units' | 'heads' | 'hair' | 'items';
export interface CharacterSpec {
  gender: Gender;
  appearance?: Appearance;
  /** Alias for callers using the simulation's field name. */
  look?: Appearance;
  equipment: Unit['equipment'];
  /** No everyday clothes on an unarmored body: the bare model, for checking it in the Forge. */
  bare?: boolean;
}
export interface CharacterInstance {
  root: THREE.Group;
  bodyKey: string;
  clips: string[];
  missingAssets: string[];
  diagnostics: { meshes: number; triangles: number; missing: string[] };
  /** Delta in seconds. The caller may throttle rendering without changing animation speed. */
  update(dt: number): void;
  play(name: string, loop?: boolean): boolean;
  dispose(): void;
}

/** A small asset library for character views: no terrain, buildings, sounds or world textures. */
export async function loadCharacterAssets(onProgress: (fraction: number, label: string) => void = () => {}): Promise<AssetLibrary> {
  const base = assetBase();
  const response = await fetch(`${base}manifest.json`);
  if (!response.ok) throw new Error(`Character manifest could not be loaded (${response.status})`);
  const source = await response.json() as AssetManifest;
  const manifest = emptyManifest();
  const cache = new Map<string, SkinnedAsset>();
  const loader = new GLTFLoader();
  const jobs: { section: Section; key: string; file: string }[] = [];
  const unified = new Set(['m', 'f'].filter((g) => isUnifiedBody(source.units?.[`human_${g}_base`])));
  for (const section of ['units', 'heads', 'hair', 'items'] as const) {
    for (const [key, entry] of Object.entries(source[section] ?? {})) {
      if (section === 'units') {
        const match = /^human_([mf])_(base|commoner|padded|light|heavy|robe)$/.exec(key);
        if (!match || (unified.has(match[1]) ? match[2] !== 'base' : match[2] === 'base')) continue;
      }
      if (section === 'heads' && /^head_([mf])/.test(key) && unified.has(key[5])) continue;
      if (section === 'hair') {
        const match = /^unified_([mf])_/.exec(key);
        if (match ? !unified.has(match[1]) : unified.size === 2) continue;
      }
      if (section === 'items' && key.startsWith('shield_') && key !== 'shield_human') continue;
      if (!entry || typeof entry.file !== 'string') continue;
      (manifest[section] as Record<string, unknown>)[key] = { ...entry };
      jobs.push({ section, key, file: entry.file });
    }
  }
  manifest.icons = source.icons ?? {};
  let next = 0, done = 0;
  onProgress(0, 'Loading character models');
  // Two decodes at once keeps this view considerate of other work on the machine.
  await Promise.all(Array.from({ length: Math.min(2, jobs.length) }, async () => {
    while (next < jobs.length) {
      const job = jobs[next++];
      try {
        const gltf = await loader.loadAsync(base + job.file);
        gltf.scene.traverse((node) => {
          const mesh = node as THREE.Mesh;
          if (!mesh.isMesh) return;
          mesh.castShadow = true;
          mesh.receiveShadow = true;
          for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
            for (const value of Object.values(material)) {
              if (value && (value as THREE.Texture).isTexture) (value as THREE.Texture).anisotropy = 4;
            }
          }
        });
        cache.set(`${job.section}/${job.key}`, { scene: gltf.scene, animations: gltf.animations });
        if (job.section === 'units') Object.assign(manifest.units[job.key], parseUnitMeta(manifest.units[job.key]));
      } catch (error) {
        console.warn(`[characters] Missing ${job.file}`, error);
        delete manifest[job.section][job.key];
      }
      onProgress(++done / jobs.length, job.key.replaceAll('_', ' '));
    }
  }));
  if (!jobs.length) throw new Error('The asset manifest contains no character models');
  return {
    manifest,
    skinned(key) { return cache.get(`units/${key}`) ?? null; },
    model(kind, key) {
      const asset = cache.get(`${kind}/${key}`);
      return asset ? skeletonClone(asset.scene) : null;
    },
    texture: () => null,
    iconUrl(key) {
      const file = manifest.icons[key] ?? manifest.icons[key.replace(/\.png$/, '')];
      return file ? base + file : null;
    },
    portraitUrl: () => null,
  };
}

/** Exact GLTFLoader spelling and the source Blender spelling are both accepted. */
export function characterSocket(model: THREE.Object3D, name: string): THREE.Object3D | null {
  return model.getObjectByName(name) ?? model.getObjectByName(THREE.PropertyBinding.sanitizeNodeName(name)) ?? null;
}

/** Follows the game rule: a bow occupies the left palm; a shield rides the left forearm. */
export function equipmentSocket(item: string, slot: 'main' | 'off' | 'trinket'): string {
  if (slot === 'off') return 'grip.L';
  if (slot === 'trinket') return item === 'ring' ? 'grip.R' : 'chest_socket';
  return item === 'bow' ? 'hold.L' : 'grip.R';
}


export function createCharacter(assets: AssetLibrary, spec: CharacterSpec): CharacterInstance {
  const look = spec.appearance ?? spec.look;
  if (!look) throw new Error('A character appearance is required');
  const invalid = appearanceError(spec.gender, look);
  if (invalid) throw new Error(invalid);
  const bodyItem = spec.equipment.body;
  const body = (bodyItem && ITEMS[bodyItem]?.body) || 'commoner';
  const unifiedKey = availableUnifiedBody(assets, spec.gender);
  const keys = unifiedKey ? [unifiedKey] : unitBodyKeys('human', body, bodyItem, spec.gender);
  const bodyKey = firstAvailable(keys, (key) => !!assets.skinned(key));
  if (!bodyKey) throw new Error(`Missing character body: ${keys[0]}`);
  const source = assets.skinned(bodyKey)!;
  const entry = assets.manifest.units[bodyKey];
  const model = skeletonClone(source.scene);
  if (!isUnifiedBody(entry)) attachCharacterRegalia(assets, model, bodyItem, spec.gender);
  const root = new THREE.Group();
  root.name = 'character';
  root.add(model);
  root.scale.setScalar(1 / (entry.height || 1));
  const materials = new Set<THREE.Material>();
  const geometries = new Set<THREE.BufferGeometry>();
  const missing: string[] = bodyKey === keys[0] ? [] : [keys[0]];
  const own = (piece: THREE.Object3D): THREE.Material[] => {
    const out: THREE.Material[] = [];
    piece.traverse((node) => {
      const mesh = node as THREE.Mesh;
      if (!mesh.isMesh) return;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.frustumCulled = false;
      const clone = (original: THREE.Material) => {
        const material = original.clone();
        materials.add(material); out.push(material);
        const standard = material as THREE.MeshStandardMaterial;
        if (standard.isMeshStandardMaterial) {
          standard.envMapIntensity = 0.65;
          // Generated source maps have deeply shaded metals; the studio key still needs a diffuse response.
          standard.metalness = Math.min(0.7, standard.metalness);
          standard.roughness = Math.max(0.34, standard.roughness);
        }
        return material;
      };
      mesh.material = Array.isArray(mesh.material) ? mesh.material.map(clone) : clone(mesh.material);
    });
    return out;
  };
  const bodyMaterials = own(model);
  if (isUnifiedBody(entry)) {
    missing.push(...dressUnifiedCharacter(assets, model, entry, spec.gender, look, bodyItem, (piece) => { own(piece); }, spec.bare));
  } else {
    const faceKey = headModelKey(spec.gender, look);
    for (const [section, key] of [['heads', faceKey], ...hairPieceKeys(look).map((key) => ['hair', key])] as ['heads' | 'hair', string][]) {
      // Presence checks should not allocate orphaned clones from AssetLibrary.model().
      if (!assets.manifest[section]?.[key]) missing.push(key);
    }
    const paint = dressHead(assets, model, entry, spec.gender, look, (piece) => { own(piece); });
    if (paint) for (const material of bodyMaterials) {
      material.onBeforeCompile = (shader) => patchBodyShader(shader, paint);
      material.customProgramCacheKey = () => `character-${bodyPaintKey(paint)}`;
      if (paint.hide) material.side = THREE.DoubleSide;
    }
  }

  for (const slot of ['main', 'off', 'trinket'] as const) {
    const item = spec.equipment[slot];
    if (!item) continue;
    if (slot === 'off' && spec.equipment.main && ITEMS[spec.equipment.main].twoHanded) continue;
    const socketName = equipmentSocket(item, slot);
    const socket = characterSocket(model, socketName);
    if (!socket) { missing.push(`socket:${socketName}`); continue; }
    const generated = item === 'ring' || item === 'amulet';
    const piece = generated ? createCharacterTrinket(item) : assets.model('items', item === 'shield' ? 'shield_human' : item);
    if (!piece) { missing.push(`item:${item}`); continue; }
    if (generated) piece.traverse((node) => {
      const mesh = node as THREE.Mesh;
      if (!mesh.isMesh) return;
      geometries.add(mesh.geometry);
      for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) materials.add(material);
    });
    else own(piece);
    piece.name = `equipment_${item}`;
    socket.add(piece);
  }
  root.updateMatrixWorld(true);
  const mixer = new THREE.AnimationMixer(model);
  const clips = source.animations.map((clip) => clip.name);
  let active: THREE.AnimationAction | null = null;
  let disposed = false;
  const play = (name: string, loop = /^(idle|walk|run|work|ride_idle)$/.test(name)): boolean => {
    if (disposed) return false;
    const clip = source.animations.find((candidate) => candidate.name === name);
    if (!clip) return false;
    const next = mixer.clipAction(clip);
    const previous = active;
    next.reset().setEffectiveWeight(1).setEffectiveTimeScale(1);
    next.setLoop(loop ? THREE.LoopRepeat : THREE.LoopOnce, loop ? Infinity : 1);
    next.clampWhenFinished = true;
    next.play();
    if (previous && previous !== next) next.crossFadeFrom(previous, 0.15, false);
    active = next;
    return true;
  };
  mixer.addEventListener('finished', (event) => {
    if (event.action === active && active.getClip().name !== 'death') play('idle');
  });
  play('idle');
  mixer.update(0);
  let meshes = 0, triangles = 0;
  root.traverse((node) => {
    const mesh = node as THREE.Mesh;
    if (!mesh.isMesh) return;
    meshes++;
    triangles += (mesh.geometry.index?.count ?? mesh.geometry.getAttribute('position')?.count ?? 0) / 3;
  });
  return {
    root, bodyKey, clips, missingAssets: missing,
    diagnostics: { meshes, triangles: Math.round(triangles), missing },
    play,
    update(dt) {
      if (disposed || !Number.isFinite(dt) || dt < 0) return;
      mixer.update(Math.min(dt, 0.1));
      updateUnifiedHair(model, dt);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      mixer.stopAllAction();
      mixer.uncacheRoot(model);
      disposeUnifiedCharacter(model);
      root.removeFromParent();
      root.traverse((node) => { const skeleton = (node as THREE.SkinnedMesh).skeleton; if (skeleton) skeleton.dispose(); });
      for (const material of materials) material.dispose();
      for (const geometry of geometries) geometry.dispose();
      root.clear();
    },
  };
}
