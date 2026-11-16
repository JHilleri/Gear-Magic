import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { createCharacter, loadCharacterAssets } from '../render/character';
import type { CharacterDraft } from './state';

export interface ViewerStats { bodyKey: string; meshes: number; triangles: number; missing: string[]; clips: string[] }
export interface CharacterViewer {
  setCharacter(draft: CharacterDraft): void;
  play(name: string): void;
  setPaused(paused: boolean): void;
  setTurntable(enabled: boolean): void;
  focus(view: 'full' | 'face' | 'back'): void;
  snapshot(): string;
  dispose(): void;
}

export async function createCharacterViewer(
  canvas: HTMLCanvasElement,
  initial: CharacterDraft,
  onProgress: (fraction: number, label: string) => void,
  onStats: (stats: ViewerStats) => void,
): Promise<CharacterViewer> {
  const assets = await loadCharacterAssets(onProgress);
  const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true, powerPreference: 'low-power', preserveDrawingBuffer: true });
  renderer.setPixelRatio(Math.min(1.5, window.devicePixelRatio));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  const scene = new THREE.Scene();
  const room = new RoomEnvironment();
  const pmrem = new THREE.PMREMGenerator(renderer);
  const environment = pmrem.fromScene(room, 0.05);
  room.dispose();
  pmrem.dispose();
  scene.environment = environment.texture;
  scene.environmentIntensity = 0.6;
  const camera = new THREE.PerspectiveCamera(30, 1, 0.01, 30);
  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.enablePan = false;
  controls.minDistance = 0.36;
  controls.maxDistance = 4;
  controls.minPolarAngle = Math.PI * 0.15;
  controls.maxPolarAngle = Math.PI * 0.65;
  controls.autoRotateSpeed = 0.8;

  scene.add(new THREE.HemisphereLight(0xd9eaff, 0x4b3324, 1.1));
  const key = new THREE.DirectionalLight(0xffdfb2, 3.2);
  key.position.set(-2, 3, 3);
  key.castShadow = true;
  key.shadow.mapSize.set(1024, 1024);
  Object.assign(key.shadow.camera, { left: -1, right: 1, top: 1.4, bottom: -1, near: 0.1, far: 10 });
  key.shadow.normalBias = 0.008;
  key.shadow.bias = -0.0002;
  scene.add(key);
  const rim = new THREE.DirectionalLight(0x8bb8ff, 2.6);
  rim.position.set(1.5, 1.6, -2);
  scene.add(rim);
  const fill = new THREE.DirectionalLight(0xd8e5ff, 0.7);
  fill.position.set(2, 1, 2);
  scene.add(fill);

  const stage = new THREE.Group();
  const stone = new THREE.MeshStandardMaterial({ color: 0x27303b, metalness: 0.2, roughness: 0.66 });
  const trim = new THREE.MeshStandardMaterial({ color: 0x96723e, metalness: 0.7, roughness: 0.42 });
  const pedestal = new THREE.Mesh(new THREE.CylinderGeometry(0.47, 0.50, 0.055, 96), stone);
  pedestal.position.y = -0.031;
  pedestal.receiveShadow = true;
  stage.add(pedestal);
  const edge = new THREE.Mesh(new THREE.TorusGeometry(0.461, 0.0022, 6, 96), trim);
  edge.rotation.x = Math.PI / 2;
  edge.position.y = -0.001;
  stage.add(edge);
  const inner = new THREE.Mesh(new THREE.TorusGeometry(0.36, 0.0009, 4, 96), trim);
  inner.rotation.x = Math.PI / 2;
  inner.position.y = -0.002;
  stage.add(inner);
  scene.add(stage);

  let character = createCharacter(assets, { gender: initial.gender, appearance: initial.look, equipment: initial.equipment });
  scene.add(character.root);
  let clip = 'idle', paused = false, disposed = false, frame = 0, previous = 0;
  const report = () => onStats({ bodyKey: character.bodyKey, ...character.diagnostics, clips: character.clips });
  const resize = () => {
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    renderer.setSize(rect.width, rect.height, false);
    camera.aspect = rect.width / rect.height;
    camera.updateProjectionMatrix();
  };
  const observer = new ResizeObserver(resize);
  observer.observe(canvas);
  const focus = (view: 'full' | 'face' | 'back') => {
    if (view === 'face') {
      controls.target.set(0, 0.87, 0.025);
      camera.position.set(0.18, 0.89, 0.59);
    } else {
      // Leave room beneath the boots for the name and pose controls.
      controls.target.set(0, 0.36, 0);
      camera.position.set(view === 'back' ? -0.85 : 0.85, 0.82, view === 'back' ? -2.8 : 2.8);
    }
    controls.update();
  };
  focus('full');
  resize();
  report();
  const animate = (now: number) => {
    if (disposed) return;
    frame = requestAnimationFrame(animate);
    if (document.hidden) { previous = now; return; }
    if (now - previous < 1000 / 30) return;
    const dt = Math.min(0.08, (now - previous) / 1000);
    previous = now;
    if (!paused) character.update(dt);
    controls.update(dt);
    renderer.render(scene, camera);
  };
  frame = requestAnimationFrame(animate);

  return {
    setCharacter(draft) {
      const next = createCharacter(assets, { gender: draft.gender, appearance: draft.look, equipment: draft.equipment });
      character.root.removeFromParent();
      character.dispose();
      character = next;
      scene.add(character.root);
      character.play(clip, true);
      report();
    },
    play(name) { clip = name; character.play(name, true); },
    setPaused(value) { paused = value; },
    setTurntable(value) { controls.autoRotate = value; },
    focus,
    snapshot() { renderer.render(scene, camera); return canvas.toDataURL('image/png'); },
    dispose() {
      disposed = true;
      cancelAnimationFrame(frame);
      observer.disconnect();
      controls.dispose();
      character.dispose();
      stage.traverse((o) => { if (o instanceof THREE.Mesh) o.geometry.dispose(); });
      stone.dispose(); trim.dispose(); environment.dispose(); renderer.dispose();
    },
  };
}
