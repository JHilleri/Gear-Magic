// Live portraits: a bust of the unit's own model — its gendered body, face, hair, beard and eyes —
// rendered once into a small off-screen target and cached as a data URL for the UI. Only bodies
// with a head frame (the bald, gendered ones) get one; every other unit keeps its painted portrait.
import * as THREE from 'three';
import { clone as skeletonClone } from 'three/addons/utils/SkeletonUtils.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import type { BodyVariant, Unit } from '../core/types';
import { bodyPaintKey, dressHead, patchBodyShader } from './appearance';
import type { AssetLibrary, PortraitOpts } from './types';
import { firstAvailable, unitBodyKeys } from './units';
import { attachCharacterRegalia } from './character-regalia';
import { availableUnifiedBody, isUnifiedBody, dressUnifiedCharacter, disposeUnifiedCharacter } from './unified-character';

const W = 320, H = 400;
/** Cached portraits (data URLs): the customisation screen walks through many looks. */
const CACHE_MAX = 240;

interface Rig {
  scene: THREE.Scene; camera: THREE.PerspectiveCamera; canvas: HTMLCanvasElement;
  targets: Map<number, THREE.WebGLRenderTarget>;
}

export function createPortraitRenderer(renderer: THREE.WebGLRenderer, assets: AssetLibrary): (u: Unit, body: BodyVariant, opts?: PortraitOpts) => string | null {
  const cache = new Map<string, string | null>();
  let rig: Rig | null = null;

  function setup(): Rig {
    const scene = new THREE.Scene();
    const pmrem = new THREE.PMREMGenerator(renderer);
    scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    scene.environmentIntensity = 0.5;
    pmrem.dispose();
    scene.add(new THREE.HemisphereLight(0xdfe8ff, 0x4a3c2c, 0.75));
    // key from the front-left above, a cool rim from behind: the lights stay with the camera
    const camera = new THREE.PerspectiveCamera(20, W / H, 0.05, 20);
    const key = new THREE.DirectionalLight(0xfff1dc, 2.4);
    key.position.set(-0.9, 1.1, 1.2);
    const fill = new THREE.DirectionalLight(0xcfe0ff, 0.5);
    fill.position.set(1.2, 0.2, 0.8);
    const rim = new THREE.DirectionalLight(0x9cc0ff, 1.5);
    rim.position.set(1.2, 0.9, -2.2);
    camera.add(key, key.target, fill, fill.target, rim, rim.target);
    for (const l of [key, fill, rim]) l.target.position.set(0, 0, -1);
    scene.add(camera);
    return { scene, camera, canvas: document.createElement('canvas'), targets: new Map() };
  }

  function targetFor(r: Rig, scale: number): THREE.WebGLRenderTarget {
    let t = r.targets.get(scale);
    if (!t) {
      t = new THREE.WebGLRenderTarget(W * scale, H * scale, { samples: 4, type: THREE.UnsignedByteType });
      t.texture.colorSpace = THREE.SRGBColorSpace;
      r.targets.set(scale, t);
    }
    return t;
  }

  function render(key: string, u: Unit, opts: PortraitOpts): string | null {
    const entry = assets.manifest.units[key];
    const sk = assets.skinned(key);
    if (!entry?.head || !sk || !u.look) return null;
    rig ??= setup();
    const { scene, camera, canvas } = rig;
    const scale = opts.large ? 2 : 1;
    const w = W * scale, h = H * scale;
    const target = targetFor(rig, scale);
    const model = skeletonClone(sk.scene);
    if (u.race === 'human' && !isUnifiedBody(entry)) attachCharacterRegalia(assets, model, u.equipment.body, u.gender);
    const mats: THREE.Material[] = [];
    const own = (root: THREE.Object3D): THREE.Material[] => {
      const out: THREE.Material[] = [];
      root.traverse((o) => {
        const m = o as THREE.Mesh;
        if (!m.isMesh) return;
        m.frustumCulled = false;
        const conv = (mat: THREE.Material) => { const c = mat.clone(); mats.push(c); out.push(c); return c; };
        m.material = Array.isArray(m.material) ? m.material.map(conv) : conv(m.material);
      });
      return out;
    };
    const bodyMats = own(model);
    if (isUnifiedBody(entry) && u.gender) {
      dressUnifiedCharacter(assets, model, entry, u.gender, u.look, u.equipment.body, (piece) => { own(piece); });
    } else {
      const paint = dressHead(assets, model, entry, u.gender, u.look, (piece) => { own(piece); });
      if (paint) {
        for (const m of bodyMats) {
          m.onBeforeCompile = (sh) => patchBodyShader(sh, paint);
          m.customProgramCacheKey = () => `portrait-${bodyPaintKey(paint)}`;
          if (paint.hide) m.side = THREE.DoubleSide;
        }
      }
    }
    scene.add(model);
    // Head and shoulders, turned a little: the frame is the crown at the occiput, one skull deep.
    const d = entry.head.depth;
    const look = new THREE.Vector3(entry.head.x, entry.head.y - 0.98 * d, entry.head.z + 0.45 * d);
    const yaw = THREE.MathUtils.degToRad(-23 + (opts.yaw ?? 0));
    camera.position.copy(look).add(new THREE.Vector3(Math.sin(yaw), 0.1, Math.cos(yaw)).normalize().multiplyScalar(7.9 * d));
    camera.lookAt(look);
    scene.updateMatrixWorld(true);

    const prevTarget = renderer.getRenderTarget();
    const prevColor = renderer.getClearColor(new THREE.Color());
    const prevAlpha = renderer.getClearAlpha();
    const prevAuto = renderer.autoClear;
    let url: string | null = null;
    try {
      renderer.setRenderTarget(target);
      renderer.setClearColor(0x000000, 0);
      renderer.autoClear = true;
      renderer.clear();
      renderer.render(scene, camera);
      const buf = new Uint8Array(w * h * 4);
      renderer.readRenderTargetPixels(target, 0, 0, w, h, buf);
      canvas.width = w; canvas.height = h;
      const g = canvas.getContext('2d');
      if (g) {
        const img = g.createImageData(w, h);
        for (let y = 0; y < h; y++) img.data.set(buf.subarray((h - 1 - y) * w * 4, (h - y) * w * 4), y * w * 4);
        g.putImageData(img, 0, 0);
        url = canvas.toDataURL('image/png');
      }
    } catch (e) {
      console.warn('[portrait] render failed', e);
    } finally {
      renderer.setRenderTarget(prevTarget);
      renderer.setClearColor(prevColor, prevAlpha);
      renderer.autoClear = prevAuto;
      scene.remove(model);
      disposeUnifiedCharacter(model);
      for (const m of mats) m.dispose();
      model.traverse((o) => { const s = (o as THREE.SkinnedMesh).skeleton; if (s) s.dispose(); });
    }
    return url;
  }

  return (u, body, opts = {}) => {
    if (u.monster || !u.look || !u.gender) return null;
    const unifiedKey = u.race === 'human' ? availableUnifiedBody(assets, u.gender) : null;
    const keys = unifiedKey ? [unifiedKey] : unitBodyKeys(u.race, body, u.equipment?.body, u.gender);
    const key = firstAvailable(keys, (k) => !!assets.skinned(k));
    if (!key) return null;
    const l = u.look;
    const id = `${key}|${u.equipment?.body ?? ''}|${l.hair}|${l.hairColor}|${l.eyes}|${l.beard}|${l.face}|${l.skin ?? ''}|${l.shape ? JSON.stringify(l.shape) : ''}|${opts.large ? 2 : 1}|${Math.round(opts.yaw ?? 0)}`;
    let url = cache.get(id);
    if (url === undefined) {
      url = render(key, u, opts);
      if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value as string);
      cache.set(id, url);
    }
    return url;
  };
}
