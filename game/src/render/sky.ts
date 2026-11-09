// Sky dome (gradient, sun glow, soft drifting clouds), sun + hemisphere lights, the PMREM
// environment derived from the sky, and the fog colour matched to the horizon.
import * as THREE from 'three';

export interface SkyUniforms {
  uSunDir: { value: THREE.Vector3 };
  uSunColor: { value: THREE.Color };
  uSkyZenith: { value: THREE.Color };
  uSkyHorizon: { value: THREE.Color };
  uSkyGround: { value: THREE.Color };
  [k: string]: { value: unknown };
}

/** Shared sky function (declares the sky uniforms). Requires `#include <common>` before it. */
export const SKY_GLSL = /* glsl */`
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uSkyZenith;
uniform vec3 uSkyHorizon;
uniform vec3 uSkyGround;
vec3 skyColor(vec3 d, bool withSun) {
  float h = d.y;
  vec3 col = mix(uSkyHorizon, uSkyZenith, pow(smoothstep(-0.02, 0.75, h), 0.55));
  col = mix(col, uSkyGround, smoothstep(0.0, -0.25, h));
  float sd = max(dot(d, uSunDir), 0.0);
  // warm scattering around the sun, stronger near the horizon
  col += uSunColor * (pow(sd, 6.0) * 0.16 + pow(sd, 48.0) * 0.32) * (1.0 + (1.0 - abs(h)) * 0.4);
  if (withSun) col += uSunColor * smoothstep(0.99935, 0.99975, sd) * 14.0;
  return col;
}
`;

const DOME_VERT = /* glsl */`
varying vec3 vDir;
void main() {
  vDir = position;
  vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  gl_Position = p.xyww; // always on the far plane
}
`;

const DOME_FRAG = /* glsl */`
#include <common>
${SKY_GLSL}
uniform sampler2D uNoiseTex;
uniform float uTime;
uniform float uClouds;
varying vec3 vDir;
void main() {
  vec3 d = normalize(vDir);
  vec3 col = skyColor(d, true);
  if (uClouds > 0.0 && d.y > 0.0) {
    vec2 uv = d.xz / (d.y + 0.18);
    float c = texture(uNoiseTex, uv * 0.11 + vec2(uTime * 0.0016, uTime * 0.0009)).r * 0.62
            + texture(uNoiseTex, uv * 0.29 - vec2(uTime * 0.0021, -uTime * 0.0012)).g * 0.38;
    float cov = smoothstep(0.48, 0.78, c) * smoothstep(0.0, 0.22, d.y);
    float sd = max(dot(d, uSunDir), 0.0);
    vec3 cc = mix(vec3(0.78, 0.8, 0.86), vec3(1.15, 1.05, 0.92), pow(sd, 3.0)) * (0.75 + 0.35 * c);
    col = mix(col, cc, cov * 0.75 * uClouds);
  }
  gl_FragColor = vec4(col, 1.0);
}
`;

export interface Sky {
  dome: THREE.Mesh;
  sun: THREE.DirectionalLight;
  hemi: THREE.HemisphereLight;
  uniforms: SkyUniforms;
  fogColor: THREE.Color;
  /** Keep the dome centred on the camera. */
  update(camera: THREE.Camera): void;
  /** Build a prefiltered environment map from the sky (call once). */
  environment(renderer: THREE.WebGLRenderer): THREE.Texture;
  dispose(): void;
}

export function createSky(noise: THREE.Texture, time: { value: number }): Sky {
  const sunDir = new THREE.Vector3(-0.52, 0.72, 0.46).normalize();
  const uniforms: SkyUniforms = {
    uSunDir: { value: sunDir },
    uSunColor: { value: new THREE.Color(1.0, 0.9, 0.76) },
    uSkyZenith: { value: new THREE.Color(0.13, 0.27, 0.58) },
    uSkyHorizon: { value: new THREE.Color(0.6, 0.66, 0.74) },
    uSkyGround: { value: new THREE.Color(0.26, 0.28, 0.31) },
  };
  const mat = new THREE.ShaderMaterial({
    vertexShader: DOME_VERT,
    fragmentShader: DOME_FRAG,
    uniforms: { ...uniforms, uNoiseTex: { value: noise }, uTime: time, uClouds: { value: 1 } },
    side: THREE.BackSide,
    depthWrite: false,
    depthTest: true,
    fog: false,
  });
  const dome = new THREE.Mesh(new THREE.SphereGeometry(900, 48, 24), mat);
  dome.name = 'sky';
  dome.frustumCulled = false;
  dome.renderOrder = -10;

  const sun = new THREE.DirectionalLight(0xfff0dc, 3.1);
  sun.name = 'sun';
  sun.castShadow = true;
  sun.shadow.mapSize.set(4096, 4096);
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.025;
  sun.shadow.radius = 2.5;
  const cam = sun.shadow.camera;
  cam.near = 1;
  cam.far = 160;

  const hemi = new THREE.HemisphereLight(new THREE.Color(0.62, 0.72, 0.92), new THREE.Color(0.42, 0.36, 0.27), 1.05);
  const fogColor = new THREE.Color(0.47, 0.53, 0.61);

  return {
    dome, sun, hemi, uniforms, fogColor,
    update(camera) { dome.position.copy(camera.position); dome.updateMatrixWorld(); },
    environment(renderer) {
      const envScene = new THREE.Scene();
      const envMat = mat.clone();
      envMat.uniforms = { ...uniforms, uNoiseTex: { value: noise }, uTime: { value: 0 }, uClouds: { value: 0.6 } };
      envMat.side = THREE.BackSide;
      const envDome = new THREE.Mesh(new THREE.SphereGeometry(10, 32, 16), envMat);
      envScene.add(envDome);
      const pmrem = new THREE.PMREMGenerator(renderer);
      const rt = pmrem.fromScene(envScene, 0.02, 0.1, 100);
      pmrem.dispose();
      envMat.dispose();
      envDome.geometry.dispose();
      return rt.texture;
    },
    dispose() { dome.geometry.dispose(); mat.dispose(); },
  };
}
