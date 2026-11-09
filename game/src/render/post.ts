// Post-processing chain: Render → (GTAO, high) → Bloom → Output (ACES + sRGB) → grade/vignette → SMAA.
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';
import { patchFow, type FowUniforms } from './fow';

const GradeShader = {
  name: 'GradeShader',
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    uVignette: { value: 0.32 },
    uSaturation: { value: 1.1 },
    uAspect: { value: 1.6 },
    uTime: { value: 0 },
  },
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
  `,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse;
    uniform float uVignette;
    uniform float uSaturation;
    uniform float uAspect;
    uniform float uTime;
    varying vec2 vUv;
    void main() {
      vec3 c = texture2D(tDiffuse, vUv).rgb;
      float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
      // split toning: cool shadows, warm highlights
      c += mix(vec3(-0.012, -0.002, 0.018), vec3(0.022, 0.008, -0.022), smoothstep(0.15, 0.85, l));
      c = mix(vec3(l), c, uSaturation);
      // gentle S-curve contrast
      c = mix(c, c * c * (3.0 - 2.0 * c), 0.18);
      vec2 d = (vUv - 0.5) * vec2(uAspect, 1.0);
      float v = smoothstep(1.05, 0.35, length(d));
      c *= mix(1.0 - uVignette, 1.0, v);
      // ordered noise against banding in the dark mist gradients
      float n = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233)) + uTime) * 43758.5453);
      c += (n - 0.5) / 255.0;
      gl_FragColor = vec4(c, 1.0);
    }
  `,
};

export interface PostChain {
  composer: EffectComposer;
  /** The AO pre-pass override material (for shader warm-up). */
  aoMaterial: THREE.Material | null;
  setSize(w: number, h: number, pixelRatio: number): void;
  setQuality(q: 'low' | 'high'): void;
  render(dt: number, time: number): void;
  dispose(): void;
}

export function createPost(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.PerspectiveCamera, fow: FowUniforms): PostChain {
  const rt = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: 0 });
  const composer = new EffectComposer(renderer, rt);
  const renderPass = new RenderPass(scene, camera);
  composer.addPass(renderPass);

  const gtao = new GTAOPass(scene, camera, 1, 1);
  gtao.output = GTAOPass.OUTPUT.Default;
  gtao.blendIntensity = 0.85;
  gtao.updateGtaoMaterial({ radius: 0.45, distanceExponent: 1.4, thickness: 1.2, scale: 1.0, samples: 12, distanceFallOff: 1.0, screenSpaceRadius: false });
  gtao.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 6, rings: 2, samples: 12 });
  // The AO normal/depth pre-pass must see the same fogged world as the colour pass (terrain
  // flattened into the mist, unexplored decorations shrunk away — never pressed flat into it, or
  // their footprints show as dark specks through the fog), and should ignore transparent /
  // overlay meshes (water, range tints, effects, x-ray silhouettes).
  patchFow((gtao as any).normalMaterial as THREE.Material, fow, { mode: 'flatten', ao: true }, undefined, 'ao');
  const origOverride = (gtao as any)._overrideVisibility.bind(gtao);
  (gtao as any)._overrideVisibility = function (this: any) {
    origOverride();
    const cache: THREE.Object3D[] = this._visibilityCache;
    this.scene.traverse((o: THREE.Object3D) => {
      if (!o.visible) return;
      const m = (o as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
      const mat = Array.isArray(m) ? m[0] : m;
      const skip = (o as THREE.Sprite).isSprite || o.userData.noAO || (mat && (mat.transparent || !mat.depthWrite || (mat as THREE.ShaderMaterial).isShaderMaterial));
      if (skip && ((o as THREE.Mesh).isMesh || (o as THREE.Sprite).isSprite)) { o.visible = false; cache.push(o); }
    });
  };
  composer.addPass(gtao);

  const bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.42, 0.55, 1.6);
  composer.addPass(bloom);
  composer.addPass(new OutputPass());
  const grade = new ShaderPass(GradeShader);
  composer.addPass(grade);
  const smaa = new SMAAPass();
  composer.addPass(smaa);

  let quality: 'low' | 'high' = 'high';
  const apply = () => {
    gtao.enabled = quality === 'high';
    bloom.enabled = true;
    bloom.strength = quality === 'high' ? 0.42 : 0;
    bloom.enabled = quality === 'high';
  };
  apply();

  return {
    composer,
    aoMaterial: (gtao as any).normalMaterial as THREE.Material,
    setSize(w, h, pr) {
      composer.setPixelRatio(pr);
      composer.setSize(w, h);
      // AO at reduced resolution is plenty and halves its cost.
      if (quality === 'high') gtao.setSize(Math.max(1, Math.floor(w * pr * 0.75)), Math.max(1, Math.floor(h * pr * 0.75)));
      grade.uniforms.uAspect.value = w / Math.max(1, h);
    },
    setQuality(q) { quality = q; apply(); },
    render(dt, time) {
      grade.uniforms.uTime.value = time % 100;
      composer.render(dt);
    },
    dispose() {
      composer.dispose();
      gtao.dispose();
      bloom.dispose();
      smaa.dispose();
      rt.dispose();
    },
  };
}
