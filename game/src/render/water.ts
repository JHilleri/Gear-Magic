// Animated water: one plane at WATER_LEVEL over the whole board. Depth tint from the terrain
// height texture, scrolling wave normals, fresnel sky reflection, sun glints, shore foam,
// fog-of-war aware (unexplored water is hidden under the mist sheet anyway).
import * as THREE from 'three';
import { FOW_PARS, type FowUniforms } from './fow';
import type { Terrain } from './terrain';
import { WATER_LEVEL } from './terrain';
import { SKY_GLSL, type SkyUniforms } from './sky';

const VERT = /* glsl */`
#include <common>
#include <fog_pars_vertex>
varying vec3 vWorld;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorld = wp.xyz;
  vec4 mvPosition = viewMatrix * wp;
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}
`;

const FRAG = /* glsl */`
#include <common>
#include <fog_pars_fragment>
${FOW_PARS}
${SKY_GLSL}
uniform sampler2D uDepthTex;
uniform vec4 uDepthRect;
uniform sampler2D uWaves;
varying vec3 vWorld;

void main() {
  vec2 xz = vWorld.xz;
  float depth = texture(uDepthTex, (xz - uDepthRect.xy) * uDepthRect.zw).r * 0.45;

  // Two scrolling wave layers + a broad swell.
  vec3 n1 = texture(uWaves, xz * 0.21 + vec2(uTime * 0.018, uTime * 0.011)).xyz * 2.0 - 1.0;
  vec3 n2 = texture(uWaves, xz * 0.37 * mat2(0.8, 0.6, -0.6, 0.8) - vec2(uTime * 0.023, -uTime * 0.015)).xyz * 2.0 - 1.0;
  vec3 n3 = texture(uWaves, xz * 0.071 + vec2(-uTime * 0.006, uTime * 0.004)).xyz * 2.0 - 1.0;
  vec2 slope = (n1.xy + n2.xy) * 0.5 + n3.xy * 0.6;
  float calm = mix(0.45, 1.0, smoothstep(0.0, 0.18, depth));   // flatter in the shallows
  vec3 N = normalize(vec3(slope.x * 0.42 * calm, 1.0, slope.y * 0.42 * calm));

  vec3 V = normalize(cameraPosition - vWorld);
  float NdV = max(dot(N, V), 0.0);
  float fres = 0.02 + 0.98 * pow(1.0 - NdV, 5.0);
  vec3 R = reflect(-V, N);
  R.y = abs(R.y);
  vec3 sky = skyColor(R, false) * 0.9;

  float d = smoothstep(0.0, 0.32, depth);
  vec3 shallow = vec3(0.10, 0.36, 0.34);
  vec3 deep = vec3(0.012, 0.06, 0.11);
  vec3 body = mix(shallow, deep, d);
  float sunL = max(dot(N, uSunDir), 0.0);
  vec3 col = body * (0.35 + 0.65 * sunL) * uSunColor * 0.55 + body * 0.25;
  col = mix(col, sky, fres * 0.85);

  // Sun glints (bloom catches the brightest).
  float sp = max(dot(R, uSunDir), 0.0);
  col += uSunColor * (pow(sp, 420.0) * 9.0 + pow(sp, 60.0) * 0.18);

  // Shore foam: an edge band plus slow waves of foam rolling in.
  float fn = texture(uNoiseTex, xz * 0.9 + vec2(uTime * 0.03, -uTime * 0.02)).a;
  float fn2 = texture(uNoiseTex, xz * 0.35 - vec2(uTime * 0.01, uTime * 0.012)).r;
  float edge = 1.0 - smoothstep(0.0, 0.028 + fn2 * 0.02, depth);
  float band = smoothstep(0.6, 0.95, sin(depth * 70.0 - uTime * 1.6 + fn2 * 6.0) * 0.5 + 0.5) * (1.0 - smoothstep(0.02, 0.09, depth));
  float foam = clamp(edge * (0.55 + 0.45 * fn) + band * fn * 0.7, 0.0, 1.0);
  col = mix(col, vec3(0.82, 0.88, 0.9) * (0.6 + 0.5 * sunL), foam);

  float alpha = mix(0.32, 0.94, smoothstep(0.0, 0.26, depth));
  alpha = max(alpha, foam * 0.9);
  alpha = mix(alpha, 1.0, fres * 0.6);
  alpha *= smoothstep(0.0, 0.006, depth + foam * 0.01);

  // Fog of war: explored-but-hidden water goes grey; unexplored is covered by mist geometry.
  vec4 fw = fowAt(xz);
  float vis = smoothstep(0.15, 0.85, fw.r);
  float lum = dot(col, vec3(0.2126, 0.7152, 0.0722));
  col = mix(mix(vec3(lum), col, 0.28) * vec3(0.40, 0.43, 0.50), col, vis);
  alpha *= smoothstep(0.1, 0.6, fw.g);
  col = mix(col, uFogColor, outsideMap(xz));

  gl_FragColor = vec4(col, alpha);
  #include <fog_fragment>
}
`;

export interface Water { mesh: THREE.Mesh; dispose(): void }

export function buildWater(terrain: Terrain, fow: FowUniforms, sky: SkyUniforms, waves: THREE.Texture): Water {
  const r = terrain.rect;
  const w = r.maxX - r.minX, d = r.maxZ - r.minZ;
  const geo = new THREE.PlaneGeometry(w, d, 1, 1);
  geo.rotateX(-Math.PI / 2);
  geo.translate(r.minX + w / 2, WATER_LEVEL, r.minZ + d / 2);
  const mat = new THREE.ShaderMaterial({
    vertexShader: VERT,
    fragmentShader: FRAG,
    uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog]) as Record<string, THREE.IUniform>,
    transparent: true,
    depthWrite: false,
    fog: true,
  });
  // Share (not copy) the live uniform objects.
  Object.assign(mat.uniforms, fow, sky, {
    uDepthTex: { value: terrain.depthTex },
    uDepthRect: { value: terrain.depthRect },
    uWaves: { value: waves },
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'water';
  mesh.renderOrder = 1;
  mesh.receiveShadow = false;
  mesh.castShadow = false;
  mesh.matrixAutoUpdate = false;
  mesh.updateMatrix();
  return { mesh, dispose() { geo.dispose(); mat.dispose(); } };
}
