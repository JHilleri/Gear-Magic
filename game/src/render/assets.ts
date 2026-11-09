// Manifest-driven asset loading with caching; missing files resolve to null (callers fall back to procedural art).
import * as THREE from 'three';
import { GLTFLoader, type GLTF } from 'three/addons/loaders/GLTFLoader.js';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
import type { AssetLibrary, AssetManifest, SkinnedAsset } from './types';

type ModelKind = 'items' | 'mounts' | 'buildings' | 'props' | 'monsters';
const MODEL_KINDS: ModelKind[] = ['items', 'mounts', 'buildings', 'props', 'monsters'];

/** Base URL of the asset folder (honours Vite's `base`). */
export function assetBase(): string {
  let base = '/';
  try { base = (import.meta as any).env?.BASE_URL ?? '/'; } catch { /* non-vite env */ }
  if (!base.endsWith('/')) base += '/';
  return `${base}assets/`;
}

export function emptyManifest(): AssetManifest {
  return { units: {}, items: {}, mounts: {}, buildings: {}, props: {}, monsters: {}, textures: {}, icons: {}, portraits: {} };
}

/** Fill missing sections and drop malformed entries so the rest of the code can trust the shape. */
function normalizeManifest(raw: unknown): AssetManifest {
  const m = emptyManifest();
  if (!raw || typeof raw !== 'object') return m;
  const r = raw as Record<string, unknown>;
  const fileSections = ['units', 'items', 'mounts', 'buildings', 'props', 'monsters'] as const;
  for (const s of fileSections) {
    const sec = r[s];
    if (!sec || typeof sec !== 'object') continue;
    for (const [k, v] of Object.entries(sec as Record<string, unknown>)) {
      if (typeof v === 'string') (m[s] as Record<string, { file: string }>)[k] = { file: v };
      else if (v && typeof v === 'object' && typeof (v as { file?: unknown }).file === 'string') (m[s] as Record<string, unknown>)[k] = v;
    }
  }
  for (const s of ['textures', 'icons', 'portraits'] as const) {
    const sec = r[s];
    if (!sec || typeof sec !== 'object') continue;
    for (const [k, v] of Object.entries(sec as Record<string, unknown>)) if (typeof v === 'string') m[s][k] = v;
  }
  return m;
}

async function fetchManifest(base: string): Promise<AssetManifest> {
  try {
    const res = await fetch(`${base}manifest.json`, { cache: 'no-cache' });
    if (!res.ok) return emptyManifest();
    const text = await res.text();
    // Dev servers may answer unknown paths with index.html.
    if (text.trimStart().startsWith('<')) return emptyManifest();
    return normalizeManifest(JSON.parse(text));
  } catch {
    return emptyManifest();
  }
}

/** The fields of a unit sidecar (`<model>.meta.json`, blender/README) the renderer uses. */
export function parseUnitMeta(raw: unknown): { walkSpeed?: number; runSpeed?: number } {
  if (!raw || typeof raw !== 'object') return {};
  const r = raw as Record<string, unknown>;
  const pos = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x) && x > 0;
  const out: { walkSpeed?: number; runSpeed?: number } = {};
  const ws = r.walk_speed ?? r.walkSpeed;
  const rs = r.run_speed ?? r.runSpeed;
  if (pos(ws)) out.walkSpeed = ws;
  if (pos(rs)) out.runSpeed = rs;
  return out;
}

/** Fill `entry.walkSpeed` / `runSpeed` from the manifest entry itself or the model's sidecar; leaves them unset on failure. */
async function loadUnitMeta(base: string, entry: AssetManifest['units'][string]): Promise<void> {
  const given = parseUnitMeta(entry);
  if (given.walkSpeed) {
    entry.walkSpeed = given.walkSpeed;
    if (given.runSpeed) entry.runSpeed = given.runSpeed; else delete entry.runSpeed;
    return;
  }
  delete entry.walkSpeed;
  delete entry.runSpeed;
  if (!/\.(glb|gltf)$/i.test(entry.file)) return;
  try {
    const res = await fetch(base + entry.file.replace(/\.(glb|gltf)$/i, '.meta.json'));
    if (!res.ok) return;
    const text = await res.text();
    if (text.trimStart().startsWith('<')) return; // dev server fallback page
    const meta = parseUnitMeta(JSON.parse(text));
    if (meta.walkSpeed) entry.walkSpeed = meta.walkSpeed;
    if (meta.runSpeed) entry.runSpeed = meta.runSpeed;
  } catch {
    /* no sidecar: the default walk speed applies */
  }
}

/** Run `tasks` with bounded concurrency. */
async function runLimited(tasks: (() => Promise<void>)[], limit: number): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < tasks.length) {
      const t = tasks[next++];
      await t();
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
}

function isNormalLikeKey(key: string): boolean {
  return /(_n|_normal|_nrm|_rough|_roughness|_ao|_height|_disp|_orm|_mask)$/i.test(key);
}

/** Shadow flags + texture quality on a loaded glTF scene. */
function prepareScene(root: THREE.Object3D): void {
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const m of mats) {
      if (!m) continue;
      for (const v of Object.values(m)) {
        if (v && (v as THREE.Texture).isTexture) (v as THREE.Texture).anisotropy = 8;
      }
    }
  });
}

export async function loadAssets(onProgress: (fraction: number, label: string) => void): Promise<AssetLibrary> {
  const base = assetBase();
  onProgress(0, 'Reading asset manifest');
  const manifest = await fetchManifest(base);

  const gltfs = new Map<string, GLTF>();       // `${kind}/${key}` → gltf
  const textures = new Map<string, THREE.Texture>();
  const loader = new GLTFLoader();
  const texLoader = new THREE.TextureLoader();

  const tasks: { label: string; run: () => Promise<void> }[] = [];
  const kinds: (ModelKind | 'units')[] = ['units', ...MODEL_KINDS];
  for (const kind of kinds) {
    for (const [key, entry] of Object.entries(manifest[kind] as Record<string, { file: string }>)) {
      tasks.push({
        label: `${kind}/${key}`,
        run: async () => {
          const meta = kind === 'units' ? loadUnitMeta(base, entry) : null;
          try {
            const g = await loader.loadAsync(base + entry.file);
            prepareScene(g.scene);
            gltfs.set(`${kind}/${key}`, g);
          } catch (e) {
            console.warn(`[assets] could not load ${entry.file} — using procedural fallback`, e);
          }
          await meta;
        },
      });
    }
  }
  for (const [key, file] of Object.entries(manifest.textures)) {
    tasks.push({
      label: `textures/${key}`,
      run: async () => {
        try {
          const t = await texLoader.loadAsync(base + file);
          t.colorSpace = isNormalLikeKey(key) ? THREE.NoColorSpace : THREE.SRGBColorSpace;
          t.wrapS = t.wrapT = THREE.RepeatWrapping;
          t.anisotropy = 8;
          t.generateMipmaps = true;
          t.minFilter = THREE.LinearMipmapLinearFilter;
          t.magFilter = THREE.LinearFilter;
          t.needsUpdate = true;
          textures.set(key, t);
        } catch (e) {
          console.warn(`[assets] could not load texture ${file}`, e);
        }
      },
    });
  }

  let done = 0;
  const total = tasks.length;
  if (total === 0) onProgress(1, 'No external assets — using procedural art');
  await runLimited(tasks.map((t) => async () => {
    await t.run();
    done++;
    onProgress(done / total, t.label);
  }), 6);

  const lookupIcon = (section: Record<string, string>, key: string): string | null => {
    const k = key.replace(/^\/+/, '');
    const hit = section[k] ?? section[k.replace(/\.(png|jpg|jpeg|webp)$/i, '')];
    return hit ? base + hit.replace(/^\/+/, '') : null;
  };

  const library: AssetLibrary = {
    manifest,
    model(kind, key) {
      const g = gltfs.get(`${kind}/${key}`);
      if (!g) return null;
      const clone = SkeletonUtils.clone(g.scene);
      clone.animations = g.animations;
      return clone;
    },
    skinned(key) {
      const g = gltfs.get(`units/${key}`) ?? gltfs.get(`monsters/${key}`) ?? gltfs.get(`mounts/${key}`);
      if (!g) return null;
      const s: SkinnedAsset = { scene: g.scene, animations: g.animations };
      return s;
    },
    texture(key) { return textures.get(key) ?? null; },
    iconUrl(key) { return lookupIcon(manifest.icons, key); },
    portraitUrl(key) { return lookupIcon(manifest.portraits, key); },
  };
  return library;
}
