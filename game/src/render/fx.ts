// Particles, projectiles, floating damage numbers, spell effects.
// Pooled GPU systems: additive glow points, alpha smoke points, camera-facing streaks
// (sparks, wind, rays, lightning) and instanced rubble; plus a tiny light pool for flashes.
import * as THREE from 'three';
import type { AttackKind, SpellId } from '../core/types';
import { spiral, worldToHex } from '../core/hex';
import type { CreateFxLayer, FxLayerApi, RenderContext } from './types';
import {
  Scheduler, GLSL_OUTPUT, clamp01, easeInOutSine, easeOutBack, easeOutCubic, easeOutQuad, lerp, makeCanvas, makeRand, normSpeed,
  smoothstep, DISPLAY_FONT,
} from './anim';
import { flareTexture, ringTexture, smokeTexture, softDotTexture } from './procedural';

/** Extra effects exposed by this implementation (feature-detected by the other entity layers). */
export interface FxExtras {
  dust(at: THREE.Vector3, scale?: number, color?: string): void;
  shockwave(at: THREE.Vector3, color: string, radius: number, duration?: number): void;
  flash(at: THREE.Vector3, color: string, size: number, duration?: number): void;
  sparkles(at: THREE.Vector3, color: string, count?: number, radius?: number, rise?: number): void;
  wisps(at: THREE.Vector3, color: string, count?: number): void;
  rubble(at: THREE.Vector3, count?: number, power?: number): void;
  smokePuff(at: THREE.Vector3, color?: string, size?: number, count?: number): void;
  summonCircle(at: THREE.Vector3, color: string, duration?: number): void;
  light(at: THREE.Vector3, color: string, intensity: number, duration: number): void;
  fireProjectile(from: THREE.Vector3, to: THREE.Vector3, speed: number): Promise<void>;
}
export type FxLayer = FxLayerApi & FxExtras;
export function hasFxExtras(fx: FxLayerApi): fx is FxLayer {
  return typeof (fx as Partial<FxExtras>).dust === 'function';
}

const _c = new THREE.Color();
const _v = new THREE.Vector3();
const _size = new THREE.Vector2();
const UP = new THREE.Vector3(0, 1, 0);

// ───────────────────────────── point particles ─────────────────────────────
interface EmitOpts {
  pos: THREE.Vector3;
  vel?: THREE.Vector3;
  life: number;
  size: number;
  size1?: number;          // end size (default = size)
  color: THREE.ColorRepresentation;
  color1?: THREE.ColorRepresentation;
  alpha?: number;
  gravity?: number;        // m/s² (negative = rises)
  drag?: number;           // per second
  rot?: number;
  spin?: number;
  fadeIn?: number;         // fraction of life
}

class PointPool {
  readonly points: THREE.Points;
  private max: number;
  private n = 0;
  private P: Float32Array; private V: Float32Array; private L: Float32Array; // life, maxLife
  private S: Float32Array; private C0: Float32Array; private C1: Float32Array;
  private A: Float32Array; private G: Float32Array; private R: Float32Array; private F: Float32Array;
  private aPos: THREE.BufferAttribute; private aCol: THREE.BufferAttribute; private aSize: THREE.BufferAttribute; private aRot: THREE.BufferAttribute;
  readonly uniforms: { uScale: { value: number }; uTex: { value: THREE.Texture } };

  constructor(max: number, tex: THREE.Texture, blending: THREE.Blending, renderOrder: number) {
    this.max = max;
    this.P = new Float32Array(max * 3); this.V = new Float32Array(max * 3); this.L = new Float32Array(max * 2);
    this.S = new Float32Array(max * 2); this.C0 = new Float32Array(max * 3); this.C1 = new Float32Array(max * 3);
    this.A = new Float32Array(max * 2); this.G = new Float32Array(max * 2); this.R = new Float32Array(max * 2); this.F = new Float32Array(max);
    const geo = new THREE.BufferGeometry();
    this.aPos = new THREE.BufferAttribute(new Float32Array(max * 3), 3).setUsage(THREE.DynamicDrawUsage);
    this.aCol = new THREE.BufferAttribute(new Float32Array(max * 4), 4).setUsage(THREE.DynamicDrawUsage);
    this.aSize = new THREE.BufferAttribute(new Float32Array(max), 1).setUsage(THREE.DynamicDrawUsage);
    this.aRot = new THREE.BufferAttribute(new Float32Array(max), 1).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('position', this.aPos);
    geo.setAttribute('aColor', this.aCol);
    geo.setAttribute('aSize', this.aSize);
    geo.setAttribute('aRot', this.aRot);
    geo.setDrawRange(0, 0);
    this.uniforms = { uScale: { value: 600 }, uTex: { value: tex } };
    const mat = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: `
        attribute vec4 aColor; attribute float aSize; attribute float aRot;
        uniform float uScale;
        varying vec4 vColor; varying float vRot;
        void main() {
          vColor = aColor; vRot = aRot;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = aSize * uScale / max(0.05, -mv.z);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: `
        uniform sampler2D uTex;
        varying vec4 vColor; varying float vRot;
        void main() {
          vec2 c = gl_PointCoord - 0.5;
          float s = sin(vRot), co = cos(vRot);
          c = mat2(co, -s, s, co) * c;
          vec4 t = texture2D(uTex, c + 0.5);
          gl_FragColor = vec4(vColor.rgb * t.rgb, vColor.a * t.a);
          ${GLSL_OUTPUT}
        }`,
      transparent: true, depthWrite: false, depthTest: true, blending,
    });
    this.points = new THREE.Points(geo, mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = renderOrder;
  }

  emit(o: EmitOpts): void {
    if (this.n >= this.max) return; // pool exhausted: drop (never stalls)
    const i = this.n++;
    this.P.set([o.pos.x, o.pos.y, o.pos.z], i * 3);
    const v = o.vel;
    this.V.set(v ? [v.x, v.y, v.z] : [0, 0, 0], i * 3);
    this.L[i * 2] = 0; this.L[i * 2 + 1] = Math.max(0.01, o.life);
    this.S[i * 2] = o.size; this.S[i * 2 + 1] = o.size1 ?? o.size;
    _c.set(o.color); this.C0.set([_c.r, _c.g, _c.b], i * 3);
    _c.set(o.color1 ?? o.color); this.C1.set([_c.r, _c.g, _c.b], i * 3);
    this.A[i * 2] = o.alpha ?? 1; this.A[i * 2 + 1] = o.fadeIn ?? 0.08;
    this.G[i * 2] = o.gravity ?? 0; this.G[i * 2 + 1] = o.drag ?? 0;
    this.R[i * 2] = o.rot ?? Math.random() * Math.PI * 2; this.R[i * 2 + 1] = o.spin ?? 0;
  }

  update(dt: number): void {
    let i = 0;
    while (i < this.n) {
      const life = (this.L[i * 2] += dt);
      if (life >= this.L[i * 2 + 1]) { this.kill(i); continue; }
      const drag = Math.exp(-this.G[i * 2 + 1] * dt);
      const o = i * 3;
      this.V[o] *= drag; this.V[o + 2] *= drag;
      this.V[o + 1] = this.V[o + 1] * drag - this.G[i * 2] * dt;
      this.P[o] += this.V[o] * dt; this.P[o + 1] += this.V[o + 1] * dt; this.P[o + 2] += this.V[o + 2] * dt;
      this.R[i * 2] += this.R[i * 2 + 1] * dt;
      i++;
    }
    const pos = this.aPos.array as Float32Array, col = this.aCol.array as Float32Array;
    const size = this.aSize.array as Float32Array, rot = this.aRot.array as Float32Array;
    for (let k = 0; k < this.n; k++) {
      const t = this.L[k * 2] / this.L[k * 2 + 1];
      const fi = this.A[k * 2 + 1];
      const a = this.A[k * 2] * (fi > 0 ? smoothstep(0, fi, t) : 1) * (1 - smoothstep(0.45, 1, t));
      pos[k * 3] = this.P[k * 3]; pos[k * 3 + 1] = this.P[k * 3 + 1]; pos[k * 3 + 2] = this.P[k * 3 + 2];
      col[k * 4] = lerp(this.C0[k * 3], this.C1[k * 3], t);
      col[k * 4 + 1] = lerp(this.C0[k * 3 + 1], this.C1[k * 3 + 1], t);
      col[k * 4 + 2] = lerp(this.C0[k * 3 + 2], this.C1[k * 3 + 2], t);
      col[k * 4 + 3] = a;
      size[k] = lerp(this.S[k * 2], this.S[k * 2 + 1], t);
      rot[k] = this.R[k * 2];
    }
    this.points.geometry.setDrawRange(0, this.n);
    if (this.n > 0) {
      this.aPos.needsUpdate = true; this.aCol.needsUpdate = true; this.aSize.needsUpdate = true; this.aRot.needsUpdate = true;
      this.aPos.clearUpdateRanges(); this.aPos.addUpdateRange(0, this.n * 3);
      this.aCol.clearUpdateRanges(); this.aCol.addUpdateRange(0, this.n * 4);
      this.aSize.clearUpdateRanges(); this.aSize.addUpdateRange(0, this.n);
      this.aRot.clearUpdateRanges(); this.aRot.addUpdateRange(0, this.n);
    }
  }

  /** Swap-remove particle i with the last live one. */
  private kill(i: number): void {
    const last = --this.n;
    if (i === last) return;
    const mv = (arr: Float32Array, w: number) => arr.copyWithin(i * w, last * w, last * w + w);
    mv(this.P, 3); mv(this.V, 3); mv(this.L, 2); mv(this.S, 2); mv(this.C0, 3); mv(this.C1, 3);
    mv(this.A, 2); mv(this.G, 2); mv(this.R, 2); mv(this.F, 1);
  }

  clear(): void { this.n = 0; this.points.geometry.setDrawRange(0, 0); }
  get count(): number { return this.n; }
  dispose(): void { this.points.geometry.dispose(); (this.points.material as THREE.Material).dispose(); }
}

// ───────────────────────────── streaks (camera-facing ribbons) ─────────────────────────────
interface StreakOpts {
  pos: THREE.Vector3;       // head
  vel?: THREE.Vector3;
  tail?: THREE.Vector3;     // fixed tail (static streak, e.g. lightning / ray); else tail = head − vel·len
  len?: number;             // seconds of velocity used as length (moving streaks)
  width: number;
  life: number;
  color: THREE.ColorRepresentation;
  alpha?: number;
  gravity?: number;
  drag?: number;
  fade?: number;            // 1 = fade toward the tail, 0 = uniform
  fadeIn?: number;
  swirl?: { center: THREE.Vector3; rate: number; rise: number; radius: number; angle: number }; // orbiting streak (haste)
}
class StreakPool {
  readonly mesh: THREE.Mesh;
  private max: number;
  private n = 0;
  private st: StreakOpts[] = [];
  private age: number[] = [];
  private head: THREE.Vector3[] = [];
  private vel: THREE.Vector3[] = [];
  private iStart: THREE.InstancedBufferAttribute; private iEnd: THREE.InstancedBufferAttribute;
  private iColor: THREE.InstancedBufferAttribute; private iWidth: THREE.InstancedBufferAttribute;
  private geo: THREE.InstancedBufferGeometry;

  constructor(max: number) {
    this.max = max;
    const g = new THREE.InstancedBufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute([0, -1, 0, 1, -1, 0, 1, 1, 0, 0, 1, 0], 3));
    g.setIndex([0, 1, 2, 0, 2, 3]);
    this.iStart = new THREE.InstancedBufferAttribute(new Float32Array(max * 3), 3).setUsage(THREE.DynamicDrawUsage);
    this.iEnd = new THREE.InstancedBufferAttribute(new Float32Array(max * 3), 3).setUsage(THREE.DynamicDrawUsage);
    this.iColor = new THREE.InstancedBufferAttribute(new Float32Array(max * 4), 4).setUsage(THREE.DynamicDrawUsage);
    this.iWidth = new THREE.InstancedBufferAttribute(new Float32Array(max * 2), 2).setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('iStart', this.iStart);
    g.setAttribute('iEnd', this.iEnd);
    g.setAttribute('iColor', this.iColor);
    g.setAttribute('iWidth', this.iWidth);
    g.instanceCount = 0;
    this.geo = g;
    const mat = new THREE.ShaderMaterial({
      vertexShader: `
        attribute vec3 iStart; attribute vec3 iEnd; attribute vec4 iColor; attribute vec2 iWidth;
        varying vec2 vUv; varying vec4 vColor; varying float vFade;
        void main() {
          vec4 a = modelViewMatrix * vec4(iStart, 1.0);
          vec4 b = modelViewMatrix * vec4(iEnd, 1.0);
          vec3 p = mix(a.xyz, b.xyz, position.x);
          vec3 d = b.xyz - a.xyz;
          float dl = length(d);
          d = dl > 1e-5 ? d / dl : vec3(0.0, 1.0, 0.0);
          vec3 side = normalize(cross(d, normalize(-p) + vec3(1e-4)));
          p += side * iWidth.x * position.y;
          vUv = position.xy; vColor = iColor; vFade = iWidth.y;
          gl_Position = projectionMatrix * vec4(p, 1.0);
        }`,
      fragmentShader: `
        varying vec2 vUv; varying vec4 vColor; varying float vFade;
        void main() {
          float across = 1.0 - vUv.y * vUv.y;
          float along = mix(1.0, smoothstep(0.0, 1.0, vUv.x), vFade);
          float a = vColor.a * across * across * along;
          gl_FragColor = vec4(vColor.rgb, a);
          ${GLSL_OUTPUT}
        }`,
      transparent: true, depthWrite: false, depthTest: true, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    });
    this.mesh = new THREE.Mesh(g, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 21;
  }

  emit(o: StreakOpts): void {
    if (this.n >= this.max) return;
    this.st[this.n] = o;
    this.age[this.n] = 0;
    this.head[this.n] = o.pos.clone();
    this.vel[this.n] = o.vel ? o.vel.clone() : new THREE.Vector3();
    this.n++;
  }

  update(dt: number): void {
    let i = 0;
    while (i < this.n) {
      const o = this.st[i];
      this.age[i] += dt;
      if (this.age[i] >= o.life) {
        const last = --this.n;
        this.st[i] = this.st[last]; this.age[i] = this.age[last]; this.head[i] = this.head[last]; this.vel[i] = this.vel[last];
        continue;
      }
      const v = this.vel[i];
      if (o.swirl) {
        const s = o.swirl;
        s.angle += s.rate * dt;
        s.center.y += s.rise * dt;
        this.head[i].set(s.center.x + Math.cos(s.angle) * s.radius, s.center.y, s.center.z + Math.sin(s.angle) * s.radius);
        // velocity tangent for the tail
        v.set(-Math.sin(s.angle) * s.radius * s.rate, s.rise, Math.cos(s.angle) * s.radius * s.rate);
      } else {
        const drag = Math.exp(-(o.drag ?? 0) * dt);
        v.x *= drag; v.z *= drag;
        v.y = v.y * drag - (o.gravity ?? 0) * dt;
        this.head[i].addScaledVector(v, dt);
      }
      i++;
    }
    const S = this.iStart.array as Float32Array, E = this.iEnd.array as Float32Array;
    const C = this.iColor.array as Float32Array, W = this.iWidth.array as Float32Array;
    for (let k = 0; k < this.n; k++) {
      const o = this.st[k];
      const t = this.age[k] / o.life;
      const h = this.head[k];
      let tx: number, ty: number, tz: number;
      if (o.tail) { tx = o.tail.x; ty = o.tail.y; tz = o.tail.z; }
      else { const l = o.len ?? 0.05; tx = h.x - this.vel[k].x * l; ty = h.y - this.vel[k].y * l; tz = h.z - this.vel[k].z * l; }
      S.set([tx, ty, tz], k * 3);
      E.set([h.x, h.y, h.z], k * 3);
      _c.set(o.color);
      const fi = o.fadeIn ?? 0;
      const a = (o.alpha ?? 1) * (fi > 0 ? smoothstep(0, fi, t) : 1) * (1 - smoothstep(0.5, 1, t));
      C.set([_c.r, _c.g, _c.b, a], k * 4);
      W[k * 2] = o.width; W[k * 2 + 1] = o.fade ?? 1;
    }
    this.geo.instanceCount = this.n;
    if (this.n > 0) { this.iStart.needsUpdate = true; this.iEnd.needsUpdate = true; this.iColor.needsUpdate = true; this.iWidth.needsUpdate = true; }
  }
  clear(): void { this.n = 0; this.geo.instanceCount = 0; }
  dispose(): void { this.geo.dispose(); (this.mesh.material as THREE.Material).dispose(); }
}

// ───────────────────────────── rubble (instanced rocks) ─────────────────────────────
class RubblePool {
  readonly mesh: THREE.InstancedMesh;
  private items: { p: THREE.Vector3; v: THREE.Vector3; r: THREE.Euler; w: THREE.Vector3; s: number; age: number; life: number; rest: boolean }[] = [];
  private max: number;
  private m = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  constructor(max: number, private heightAt: (x: number, z: number) => number) {
    this.max = max;
    const g = new THREE.DodecahedronGeometry(1, 0); // polyhedra are already non-indexed
    g.computeVertexNormals();
    const mat = new THREE.MeshStandardMaterial({ color: 0x8a8378, roughness: 0.95, flatShading: true });
    this.mesh = new THREE.InstancedMesh(g, mat, max);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.count = 0;
    this.mesh.castShadow = true;
    this.mesh.frustumCulled = false;
  }
  emit(p: THREE.Vector3, v: THREE.Vector3, size: number, life: number): void {
    if (this.items.length >= this.max) this.items.shift();
    this.items.push({ p: p.clone(), v: v.clone(), r: new THREE.Euler(Math.random() * 6, Math.random() * 6, 0), w: new THREE.Vector3((Math.random() - 0.5) * 12, (Math.random() - 0.5) * 12, 0), s: size, age: 0, life, rest: false });
  }
  update(dt: number): void {
    this.items = this.items.filter((it) => (it.age += dt) < it.life);
    let k = 0;
    for (const it of this.items) {
      if (!it.rest) {
        it.v.y -= 9.0 * dt;
        it.p.addScaledVector(it.v, dt);
        it.r.x += it.w.x * dt; it.r.y += it.w.y * dt;
        const gy = this.heightAt(it.p.x, it.p.z) + it.s * 0.6;
        if (it.p.y < gy) {
          it.p.y = gy;
          if (Math.abs(it.v.y) < 1.0) { it.rest = true; }
          it.v.set(it.v.x * 0.45, -it.v.y * 0.32, it.v.z * 0.45);
          it.w.multiplyScalar(0.5);
        }
      }
      const shrink = 1 - smoothstep(0.7, 1, it.age / it.life);
      this.q.setFromEuler(it.r);
      this.m.compose(it.p, this.q, _v.setScalar(it.s * shrink));
      this.mesh.setMatrixAt(k++, this.m);
    }
    this.mesh.count = k;
    if (k > 0) this.mesh.instanceMatrix.needsUpdate = true;
  }
  clear(): void { this.items = []; this.mesh.count = 0; }
  dispose(): void { this.mesh.geometry.dispose(); (this.mesh.material as THREE.Material).dispose(); this.mesh.dispose(); }
}

// ───────────────────────────── shared assets ─────────────────────────────
function numberTexture(text: string, color: string): { tex: THREE.CanvasTexture; aspect: number } {
  const miss = /[a-z]/i.test(text);
  const c = makeCanvas(256, 112);
  const g = c.getContext('2d')!;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.font = `${miss ? 'italic 700 54px' : '900 74px'} ${DISPLAY_FONT}`;
  g.lineJoin = 'round';
  g.lineWidth = 12;
  g.strokeStyle = 'rgba(8,6,4,0.92)';
  g.strokeText(text, 128, 58);
  const grad = g.createLinearGradient(0, 22, 0, 92);
  const base = new THREE.Color(color);
  const light = base.clone().lerp(new THREE.Color('#ffffff'), 0.55);
  grad.addColorStop(0, `#${light.getHexString()}`);
  grad.addColorStop(0.55, color);
  grad.addColorStop(1, `#${base.clone().multiplyScalar(0.7).getHexString()}`);
  g.fillStyle = grad;
  g.fillText(text, 128, 58);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return { tex, aspect: 256 / 112 };
}

function eyeTexture(): THREE.Texture {
  const c = makeCanvas(256, 128);
  const g = c.getContext('2d')!;
  g.translate(128, 64);
  g.shadowColor = '#bff6ff';
  g.shadowBlur = 18;
  g.strokeStyle = '#e8fdff';
  g.lineWidth = 7;
  g.beginPath();
  g.moveTo(-110, 0); g.quadraticCurveTo(0, -78, 110, 0); g.quadraticCurveTo(0, 78, -110, 0);
  g.stroke();
  const gr = g.createRadialGradient(0, 0, 4, 0, 0, 38);
  gr.addColorStop(0, '#ffffff'); gr.addColorStop(0.35, '#8ff0ff'); gr.addColorStop(1, 'rgba(60,170,255,0.2)');
  g.fillStyle = gr;
  g.beginPath(); g.arc(0, 0, 36, 0, Math.PI * 2); g.fill();
  g.fillStyle = '#06222c';
  g.beginPath(); g.ellipse(0, 0, 9, 22, 0, 0, Math.PI * 2); g.fill();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function runeCircleTexture(): THREE.Texture {
  const s = 512;
  const c = makeCanvas(s, s);
  const g = c.getContext('2d')!;
  g.translate(s / 2, s / 2);
  g.strokeStyle = '#ffffff';
  g.shadowColor = '#ffffff';
  g.shadowBlur = 10;
  const circle = (r: number, w: number) => { g.lineWidth = w; g.beginPath(); g.arc(0, 0, r, 0, Math.PI * 2); g.stroke(); };
  circle(240, 6); circle(222, 3); circle(150, 4); circle(70, 3);
  g.lineWidth = 4;
  for (let k = 0; k < 2; k++) {
    g.beginPath();
    for (let i = 0; i <= 3; i++) {
      const a = (i / 3) * Math.PI * 2 + k * Math.PI / 3 - Math.PI / 2;
      const x = Math.cos(a) * 222, y = Math.sin(a) * 222;
      if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
    }
    g.stroke();
  }
  g.font = `bold 30px ${DISPLAY_FONT}`;
  g.fillStyle = '#ffffff';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  const runes = 'ᚠᚢᚦᚨᚱᚲᚷᚹᚺᚾᛁᛃᛇᛈᛉᛊᛏᛒᛖᛗᛚᛜᛞᛟ';
  for (let i = 0; i < 24; i++) {
    const a = (i / 24) * Math.PI * 2;
    g.save();
    g.rotate(a);
    g.fillText(runes[i % runes.length], 0, -186);
    g.restore();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function scorchTexture(): THREE.Texture {
  const s = 128;
  const c = makeCanvas(s, s);
  const g = c.getContext('2d')!;
  const gr = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  gr.addColorStop(0, 'rgba(10,6,4,0.85)'); gr.addColorStop(0.5, 'rgba(20,12,8,0.6)'); gr.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = gr;
  g.fillRect(0, 0, s, s);
  const t = new THREE.CanvasTexture(c);
  return t;
}

/** Additive glowing tube: bright soft rim, vertical falloff and rising streaks. */
function beamMaterial(color: THREE.ColorRepresentation): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { uColor: { value: new THREE.Color(color) }, uTime: { value: 0 }, uAlpha: { value: 1 } },
    vertexShader: `
      varying vec2 vUv; varying vec3 vN; varying vec3 vV;
      void main(){
        vUv = uv;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vN = normalize(normalMatrix * normal);
        vV = normalize(-mv.xyz);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: `
      uniform vec3 uColor; uniform float uTime; uniform float uAlpha;
      varying vec2 vUv; varying vec3 vN; varying vec3 vV;
      void main(){
        float v = vUv.y;
        float fall = pow(1.0 - v, 1.4) * smoothstep(0.0, 0.08, v);
        float rim = pow(1.0 - abs(dot(normalize(vN), normalize(vV))), 1.6);
        float streak = 0.55 + 0.45 * sin(vUv.x * 6.2831 * 7.0 + sin(vUv.x * 6.2831 * 3.0) * 2.0) * (0.5 + 0.5 * sin(v * 14.0 - uTime * 6.0 + vUv.x * 30.0));
        float a = fall * (0.18 + 0.82 * rim) * streak * uAlpha * 0.55;
        gl_FragColor = vec4(uColor * (0.8 + (1.0 - v) * 0.6), a);
        ${GLSL_OUTPUT}
      }`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
  });
}

const SPELL_COLOR: Record<SpellId, string> = {
  heal: '#7dff9a', bless: '#ffd76a', fireball: '#ff8a3c', haste: '#6cc8ff', farsight: '#8fe9ff', summon: '#ffb347', storm: '#b39bff',
};

interface Effect { update(dt: number): boolean; dispose(): void }

export const createFxLayer: CreateFxLayer = (ctx: RenderContext): FxLayer => {
  const root = new THREE.Group();
  root.name = 'fx';
  ctx.scene.add(root);
  const sched = new Scheduler();
  const glow = new PointPool(4000, softDotTexture(), THREE.AdditiveBlending, 22);
  const smoke = new PointPool(1500, smokeTexture(), THREE.NormalBlending, 20);
  const streaks = new StreakPool(1500);
  const rubblePool = new RubblePool(96, ctx.heightAt);
  root.add(smoke.points, glow.points, streaks.mesh, rubblePool.mesh);
  const effects: Effect[] = [];
  const rand = makeRand(0x5eed);
  const rnd = (a = 0, b = 1) => a + (b - a) * rand();
  const groundY = (x: number, z: number) => ctx.heightAt(x, z);

  // light pool (created once so the light count — and every lit shader — stays stable)
  const lights = [0, 1].map(() => {
    const l = new THREE.PointLight(0xffffff, 0, 5, 2);
    l.castShadow = false;
    root.add(l);
    return { l, t: 0, dur: 1, peak: 0, last: 0 };
  });
  let lightTick = 0;

  // shared resources
  const flareMat = () => new THREE.SpriteMaterial({ map: flareTexture(), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, fog: false });
  const dotMat = () => new THREE.SpriteMaterial({ map: softDotTexture(), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, fog: false });
  const flatGeo = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
  const cylGeo = new THREE.CylinderGeometry(1, 1, 1, 24, 1, true).translate(0, 0.5, 0);
  const numberCache = new Map<string, { tex: THREE.CanvasTexture; aspect: number }>();
  let eyeTex: THREE.Texture | null = null;
  let runeTex: THREE.Texture | null = null;
  let scorchTex: THREE.Texture | null = null;
  const recentNumbers: { pos: THREE.Vector3; t: number }[] = [];

  // arrow model
  const arrowGeo = (() => {
    const parts: THREE.BufferGeometry[] = [];
    const shaft = new THREE.CylinderGeometry(0.006, 0.006, 0.3, 5).rotateX(Math.PI / 2);
    const head = new THREE.ConeGeometry(0.016, 0.05, 4).rotateX(Math.PI / 2).translate(0, 0, 0.17);
    const f1 = new THREE.PlaneGeometry(0.03, 0.07).rotateY(Math.PI / 2).rotateX(Math.PI / 2).translate(0, 0, -0.12);
    parts.push(shaft, head, f1);
    return parts;
  })();
  const arrowMats = [
    new THREE.MeshStandardMaterial({ color: 0x8a6a45, roughness: 0.8 }),
    new THREE.MeshStandardMaterial({ color: 0xb8bec6, roughness: 0.35, metalness: 0.9 }),
    new THREE.MeshStandardMaterial({ color: 0xf2ede2, roughness: 0.9, side: THREE.DoubleSide }),
  ];
  const makeArrow = () => {
    const g = new THREE.Group();
    arrowGeo.forEach((geo, i) => { const m = new THREE.Mesh(geo, arrowMats[i]); m.castShadow = true; g.add(m); });
    return g;
  };

  const addEffect = (e: Effect) => { effects.push(e); };

  // ───────────── primitives ─────────────
  function flash(at: THREE.Vector3, color: string, size: number, duration = 0.3): void {
    const mat = flareMat();
    mat.color.set(color);
    const s = new THREE.Sprite(mat);
    s.position.copy(at);
    s.renderOrder = 23;
    root.add(s);
    let t = 0;
    addEffect({
      update(dt) {
        t += dt;
        const u = t / duration;
        const k = u < 0.18 ? easeOutQuad(u / 0.18) : 1 - easeOutQuad((u - 0.18) / 0.82);
        s.scale.setScalar(size * (0.5 + 0.7 * Math.min(1, u * 3)));
        mat.opacity = Math.max(0, k);
        mat.rotation += dt * 0.8;
        return u < 1;
      },
      dispose() { root.remove(s); mat.dispose(); },
    });
  }

  function light(at: THREE.Vector3, color: string, intensity: number, duration: number): void {
    // reuse the light that is least bright right now
    const L = lights.reduce((a, b) => (a.l.intensity <= b.l.intensity ? a : b));
    L.l.position.copy(at);
    L.l.color.set(color);
    L.t = 0; L.dur = Math.max(0.05, duration); L.peak = intensity; L.last = ++lightTick;
    L.l.intensity = intensity;
  }

  function groundDecal(at: THREE.Vector3, tex: THREE.Texture, color: string, size: number, blending: THREE.Blending, opacity: number): THREE.Mesh {
    const mat = new THREE.MeshBasicMaterial({
      map: tex, color, transparent: true, opacity, depthWrite: false, blending, fog: false,
      polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4,
    });
    const m = new THREE.Mesh(flatGeo, mat);
    m.position.set(at.x, groundY(at.x, at.z) + 0.04, at.z);
    m.scale.set(size, 1, size);
    m.renderOrder = 6;
    root.add(m);
    return m;
  }

  function shockwave(at: THREE.Vector3, color: string, radius: number, duration = 0.5): void {
    const m = groundDecal(at, ringTexture(), color, 0.1, THREE.AdditiveBlending, 1);
    const mat = m.material as THREE.MeshBasicMaterial;
    let t = 0;
    addEffect({
      update(dt) {
        t += dt;
        const u = clamp01(t / duration);
        const s = 0.1 + radius * 2 * easeOutCubic(u);
        m.scale.set(s, 1, s);
        mat.opacity = (1 - u) * 1.2;
        return u < 1;
      },
      dispose() { root.remove(m); mat.dispose(); },
    });
  }

  function sparkles(at: THREE.Vector3, color: string, count = 24, radius = 0.4, rise = 0.6): void {
    for (let i = 0; i < count; i++) {
      const a = rnd(0, Math.PI * 2), r = Math.sqrt(rand()) * radius;
      glow.emit({
        pos: _v.set(at.x + Math.cos(a) * r, at.y + rnd(-0.1, 0.3), at.z + Math.sin(a) * r).clone(),
        vel: new THREE.Vector3(rnd(-0.1, 0.1), rise * rnd(0.5, 1.4), rnd(-0.1, 0.1)),
        life: rnd(0.6, 1.2), size: rnd(0.04, 0.09), size1: 0.01, color: '#ffffff', color1: color, drag: 1.2, fadeIn: 0.15,
      });
    }
  }

  function dust(at: THREE.Vector3, scale = 1, color = '#b8a68a'): void {
    const gy = groundY(at.x, at.z);
    const n = Math.round(6 * scale + 2);
    for (let i = 0; i < n; i++) {
      const a = rnd(0, Math.PI * 2);
      const sp = rnd(0.25, 0.7) * scale;
      smoke.emit({
        pos: new THREE.Vector3(at.x + Math.cos(a) * 0.08, gy + 0.05, at.z + Math.sin(a) * 0.08),
        vel: new THREE.Vector3(Math.cos(a) * sp, rnd(0.08, 0.3), Math.sin(a) * sp),
        life: rnd(0.6, 1.1), size: 0.14 * scale, size1: 0.42 * scale, color, alpha: 0.55, drag: 2.6, gravity: -0.05, spin: rnd(-1, 1), fadeIn: 0.1,
      });
    }
  }

  function smokePuff(at: THREE.Vector3, color = '#3a3530', size = 0.4, count = 10): void {
    for (let i = 0; i < count; i++) {
      smoke.emit({
        pos: new THREE.Vector3(at.x + rnd(-0.15, 0.15), at.y + rnd(-0.05, 0.15), at.z + rnd(-0.15, 0.15)),
        vel: new THREE.Vector3(rnd(-0.2, 0.2), rnd(0.3, 0.8), rnd(-0.2, 0.2)),
        life: rnd(1.0, 1.8), size: size * 0.5, size1: size * 1.6, color, alpha: 0.42, drag: 1.4, gravity: -0.1, spin: rnd(-0.8, 0.8), fadeIn: 0.15,
      });
    }
  }

  function wisps(at: THREE.Vector3, color: string, count = 14): void {
    for (let i = 0; i < count; i++) {
      const a = rnd(0, Math.PI * 2);
      glow.emit({
        pos: new THREE.Vector3(at.x + Math.cos(a) * rnd(0, 0.2), at.y + rnd(-0.2, 0.2), at.z + Math.sin(a) * rnd(0, 0.2)),
        vel: new THREE.Vector3(Math.cos(a) * 0.12, rnd(0.4, 0.9), Math.sin(a) * 0.12),
        life: rnd(0.9, 1.6), size: rnd(0.07, 0.14), size1: 0.02, color, color1: '#ffffff', drag: 0.6, gravity: -0.2, fadeIn: 0.2, alpha: 0.85,
      });
    }
  }

  function rubble(at: THREE.Vector3, count = 12, power = 1): void {
    for (let i = 0; i < count; i++) {
      const a = rnd(0, Math.PI * 2);
      const sp = rnd(0.6, 1.6) * power;
      rubblePool.emit(
        new THREE.Vector3(at.x + Math.cos(a) * 0.1, at.y + 0.05, at.z + Math.sin(a) * 0.1),
        new THREE.Vector3(Math.cos(a) * sp, rnd(1.6, 3.2) * power, Math.sin(a) * sp),
        rnd(0.025, 0.06) * Math.sqrt(power), rnd(1.6, 2.4),
      );
    }
  }

  function burst(at: THREE.Vector3, color: string, count = 24): void {
    for (let i = 0; i < count; i++) {
      const d = new THREE.Vector3(rnd(-1, 1), rnd(-0.2, 1), rnd(-1, 1)).normalize();
      glow.emit({ pos: at.clone(), vel: d.multiplyScalar(rnd(0.8, 2.2)), life: rnd(0.35, 0.8), size: rnd(0.05, 0.11), size1: 0.01, color: '#ffffff', color1: color, drag: 3.5, gravity: 1.2 });
    }
    for (let i = 0; i < Math.ceil(count / 3); i++) {
      const d = new THREE.Vector3(rnd(-1, 1), rnd(0, 1), rnd(-1, 1)).normalize();
      streaks.emit({ pos: at.clone(), vel: d.multiplyScalar(rnd(2, 4)), len: 0.05, width: 0.012, life: rnd(0.25, 0.45), color, drag: 4, gravity: 2 });
    }
    flash(at, color, 0.7, 0.3);
  }

  function summonCircle(at: THREE.Vector3, color: string, duration = 1.4): void {
    runeTex ??= runeCircleTexture();
    const m = groundDecal(at, runeTex, color, 0.2, THREE.AdditiveBlending, 0);
    const mat = m.material as THREE.MeshBasicMaterial;
    let t = 0;
    addEffect({
      update(dt) {
        t += dt;
        const u = clamp01(t / duration);
        const s = 1.4 * easeOutBack(Math.min(1, u * 2.5));
        m.scale.set(Math.max(0.01, s), 1, Math.max(0.01, s));
        m.rotation.y += dt * 0.9;
        mat.opacity = Math.min(1, u * 5) * (1 - smoothstep(0.7, 1, u)) * 1.3;
        return u < 1;
      },
      dispose() { root.remove(m); mat.dispose(); },
    });
  }

  function beam(at: THREE.Vector3, color: string, radius: number, height: number, duration: number, grow = 0.25): void {
    const mat = beamMaterial(color);
    const m = new THREE.Mesh(cylGeo, mat);
    const gy = groundY(at.x, at.z);
    m.position.set(at.x, gy, at.z);
    m.renderOrder = 22;
    root.add(m);
    let t = 0;
    addEffect({
      update(dt) {
        t += dt;
        const u = clamp01(t / duration);
        const h = height * easeOutCubic(Math.min(1, u / grow));
        const r = radius * (0.6 + 0.4 * easeOutBack(Math.min(1, u / grow))) * (1 - 0.3 * smoothstep(0.6, 1, u));
        m.scale.set(r, Math.max(0.01, h), r);
        mat.uniforms.uTime.value += dt;
        mat.uniforms.uAlpha.value = Math.min(1, u / 0.1) * (1 - smoothstep(0.55, 1, u));
        return u < 1;
      },
      dispose() { root.remove(m); mat.dispose(); },
    });
  }

  function lightning(top: THREE.Vector3, bottom: THREE.Vector3, life = 0.28): void {
    const segs = 11;
    const pts: THREE.Vector3[] = [];
    for (let i = 0; i <= segs; i++) {
      const t = i / segs;
      const p = top.clone().lerp(bottom, t);
      if (i > 0 && i < segs) { const j = 0.22 * Math.sin(t * Math.PI); p.x += rnd(-j, j); p.z += rnd(-j, j); }
      pts.push(p);
    }
    const emitPath = (path: THREE.Vector3[], w: number, a: number) => {
      for (let i = 0; i < path.length - 1; i++) {
        streaks.emit({ pos: path[i + 1].clone(), tail: path[i].clone(), width: w * 3.2, life, color: '#7f8dff', alpha: a * 0.5, fade: 0 });
        streaks.emit({ pos: path[i + 1].clone(), tail: path[i].clone(), width: w, life, color: '#f2f4ff', alpha: a * 1.6, fade: 0 });
      }
    };
    emitPath(pts, 0.035, 1);
    // branches
    for (let b = 0; b < 3; b++) {
      const k = 2 + Math.floor(rnd(0, segs - 4));
      const branch: THREE.Vector3[] = [pts[k].clone()];
      const dir = new THREE.Vector3(rnd(-1, 1), -1.2, rnd(-1, 1)).normalize();
      for (let i = 1; i <= 4; i++) branch.push(branch[i - 1].clone().addScaledVector(dir, 0.22).add(new THREE.Vector3(rnd(-0.08, 0.08), 0, rnd(-0.08, 0.08))));
      emitPath(branch, 0.018, 0.7);
    }
  }

  // ───────────── projectiles ─────────────
  function arcPoint(from: THREE.Vector3, to: THREE.Vector3, h: number, t: number, out: THREE.Vector3): THREE.Vector3 {
    out.lerpVectors(from, to, t);
    out.y += Math.sin(t * Math.PI) * h;
    return out;
  }

  function projectile(from: THREE.Vector3, to: THREE.Vector3, kind: AttackKind, speed: number): Promise<void> {
    const sp = normSpeed(speed);
    if (kind === 'melee') return Promise.resolve();
    const d = from.distanceTo(to);
    if (kind === 'ranged') {
      const arrow = makeArrow();
      root.add(arrow);
      const h = 0.12 + d * 0.13;
      const dur = (0.24 + d * 0.085) / sp;
      const p = new THREE.Vector3(), q = new THREE.Vector3();
      let trailT = 0;
      return sched.tween(dur, (_t, raw) => {
        arcPoint(from, to, h, raw, p);
        arcPoint(from, to, h, Math.min(1, raw + 0.02), q);
        arrow.position.copy(p);
        if (q.distanceToSquared(p) > 1e-8) arrow.lookAt(q);
        trailT += 1;
        if (trailT % 2 === 0) glow.emit({ pos: p.clone(), life: 0.25, size: 0.025, size1: 0.005, color: '#fff6dc', alpha: 0.35 });
      }).then(() => { root.remove(arrow); });
    }
    // magic orb
    const core = new THREE.Sprite(dotMat());
    const halo = new THREE.Sprite(dotMat());
    (core.material as THREE.SpriteMaterial).color.set('#ffffff');
    (halo.material as THREE.SpriteMaterial).color.set('#8f9cff');
    core.scale.setScalar(0.14);
    halo.scale.setScalar(0.42);
    core.renderOrder = 24; halo.renderOrder = 23;
    root.add(core, halo);
    const h = 0.08 + d * 0.06;
    const dur = (0.2 + d * 0.075) / sp;
    const p = new THREE.Vector3();
    const last = from.clone();
    const wob = rnd(0, 6);
    flash(from, '#9fb0ff', 0.45, 0.22);
    return sched.tween(dur, (_t, raw) => {
      arcPoint(from, to, h, raw, p);
      p.x += Math.sin(raw * 9 + wob) * 0.03 * Math.sin(raw * Math.PI);
      core.position.copy(p);
      halo.position.copy(p);
      halo.scale.setScalar(0.38 + 0.08 * Math.sin(raw * 40));
      const seg = p.clone().sub(last);
      const n = Math.min(10, 2 + Math.ceil(seg.length() / 0.03));
      for (let i = 0; i < n; i++) {
        glow.emit({ pos: last.clone().addScaledVector(seg, rand()).add(new THREE.Vector3(rnd(-0.03, 0.03), rnd(-0.03, 0.03), rnd(-0.03, 0.03))), vel: new THREE.Vector3(rnd(-0.2, 0.2), rnd(-0.1, 0.3), rnd(-0.2, 0.2)), life: rnd(0.2, 0.45), size: rnd(0.05, 0.09), size1: 0.01, color: '#c9b8ff', color1: '#5c6cff', alpha: 0.6 });
      }
      last.copy(p);
    }).then(() => {
      root.remove(core, halo);
      (core.material as THREE.Material).dispose();
      (halo.material as THREE.Material).dispose();
      flash(to, '#a8b4ff', 0.5, 0.22);
    });
  }

  function fireProjectile(from: THREE.Vector3, to: THREE.Vector3, speed: number): Promise<void> {
    const sp = normSpeed(speed);
    const d = from.distanceTo(to);
    const core = new THREE.Sprite(dotMat());
    const halo = new THREE.Sprite(dotMat());
    (core.material as THREE.SpriteMaterial).color.set('#fff1c4');
    (halo.material as THREE.SpriteMaterial).color.set('#ff7a22');
    core.renderOrder = 24; halo.renderOrder = 23;
    root.add(core, halo);
    const h = 1.2 + d * 0.12;
    const dur = Math.min(0.85, 0.35 + d * 0.05) / sp;
    const p = new THREE.Vector3();
    const prev = from.clone();
    return sched.tween(dur, (t) => {
      arcPoint(from, to, h, t, p);
      core.position.copy(p); halo.position.copy(p);
      core.scale.setScalar(0.22 + 0.04 * Math.sin(t * 50));
      halo.scale.setScalar(0.75 + 0.1 * Math.sin(t * 33));
      const seg = p.clone().sub(prev);
      const vel = seg.clone().multiplyScalar(-2);
      // emit along the whole frame segment so the trail stays continuous at any speed
      const n = Math.min(14, 3 + Math.ceil(seg.length() / 0.03));
      for (let i = 0; i < n; i++) {
        const q = prev.clone().addScaledVector(seg, rand()).add(new THREE.Vector3(rnd(-0.05, 0.05), rnd(-0.05, 0.05), rnd(-0.05, 0.05)));
        glow.emit({ pos: q, vel: vel.clone().multiplyScalar(rnd(0.1, 0.6)).add(new THREE.Vector3(0, rnd(0.15, 0.5), 0)), life: rnd(0.25, 0.55), size: rnd(0.14, 0.26), size1: 0.03, color: '#ffc45a', color1: '#ff3008', alpha: 0.55, drag: 1.5 });
      }
      if (rand() < 0.6) smoke.emit({ pos: p.clone(), vel: new THREE.Vector3(rnd(-0.1, 0.1), rnd(0.2, 0.4), rnd(-0.1, 0.1)), life: rnd(0.6, 1.0), size: 0.15, size1: 0.45, color: '#4a3f38', alpha: 0.3, spin: rnd(-1, 1), fadeIn: 0.2 });
      prev.copy(p);
      if (rand() < 0.5) streaks.emit({ pos: p.clone(), vel: new THREE.Vector3(rnd(-1, 1), rnd(-0.5, 1), rnd(-1, 1)), len: 0.06, width: 0.01, life: 0.4, color: '#ffb347', gravity: 3 });
    }).then(() => {
      root.remove(core, halo);
      (core.material as THREE.Material).dispose();
      (halo.material as THREE.Material).dispose();
    });
  }

  // ───────────── public api ─────────────
  function damageNumber(at: THREE.Vector3, text: string, color: string): void {
    const key = `${text}|${color}`;
    let entry = numberCache.get(key);
    if (!entry) {
      entry = numberTexture(text, color);
      numberCache.set(key, entry);
      if (numberCache.size > 96) {
        const first = numberCache.keys().next().value as string;
        numberCache.get(first)?.tex.dispose();
        numberCache.delete(first);
      }
    }
    const mat = new THREE.SpriteMaterial({ map: entry.tex, transparent: true, depthTest: false, depthWrite: false, fog: false });
    const s = new THREE.Sprite(mat);
    s.renderOrder = 1000;
    // stack numbers that pop at the same place in quick succession
    const now = ctx.time;
    let stack = 0;
    for (const r of recentNumbers) if (now - r.t < 0.45 && r.pos.distanceToSquared(at) < 0.16) stack++;
    recentNumbers.push({ pos: at.clone(), t: now });
    while (recentNumbers.length > 24) recentNumbers.shift();
    const start = at.clone().add(new THREE.Vector3(rnd(-0.06, 0.06), 0.12 + stack * 0.16, 0));
    s.position.copy(start);
    root.add(s);
    const H = /[a-z]/i.test(text) ? 0.2 : 0.28;
    let t = 0;
    const dur = 1.15;
    addEffect({
      update(dt) {
        t += dt;
        const u = t / dur;
        const pop = u < 0.12 ? easeOutBack(u / 0.12) * 1.25 : 1.25 - 0.25 * Math.min(1, (u - 0.12) / 0.12);
        s.scale.set(H * entry!.aspect * pop, H * pop, 1);
        s.position.set(start.x, start.y + 0.55 * easeOutCubic(u), start.z);
        mat.opacity = 1 - smoothstep(0.65, 1, u);
        return u < 1;
      },
      dispose() { root.remove(s); mat.dispose(); },
    });
  }

  function hitSpark(at: THREE.Vector3, kind: AttackKind): void {
    if (kind === 'melee') {
      for (let i = 0; i < 14; i++) {
        const d = new THREE.Vector3(rnd(-1, 1), rnd(-0.3, 1), rnd(-1, 1)).normalize();
        streaks.emit({ pos: at.clone(), vel: d.multiplyScalar(rnd(2.2, 4.5)), len: 0.035, width: 0.014, life: rnd(0.2, 0.42), color: i % 3 ? '#ffd27a' : '#ffffff', drag: 3, gravity: 6, alpha: 1.4 });
      }
      flash(at, '#fff2cf', 0.55, 0.16);
      glow.emit({ pos: at.clone(), life: 0.18, size: 0.35, size1: 0.6, color: '#ffffff', color1: '#ff9a3a', alpha: 0.6 });
    } else if (kind === 'ranged') {
      for (let i = 0; i < 8; i++) {
        const d = new THREE.Vector3(rnd(-1, 1), rnd(0, 1), rnd(-1, 1)).normalize();
        streaks.emit({ pos: at.clone(), vel: d.multiplyScalar(rnd(1.5, 3)), len: 0.03, width: 0.01, life: rnd(0.2, 0.35), color: '#e8d2a6', drag: 3, gravity: 5 });
      }
      flash(at, '#fff0d8', 0.4, 0.14);
    } else {
      for (let i = 0; i < 22; i++) {
        const d = new THREE.Vector3(rnd(-1, 1), rnd(-1, 1), rnd(-1, 1)).normalize();
        glow.emit({ pos: at.clone(), vel: d.multiplyScalar(rnd(0.6, 1.8)), life: rnd(0.3, 0.6), size: rnd(0.06, 0.12), size1: 0.01, color: '#ffffff', color1: '#7a6bff', drag: 3 });
      }
      flash(at, '#b3a6ff', 0.75, 0.26);
      light(at, '#8f8cff', 2.5, 0.3);
    }
  }

  function levelUp(at: THREE.Vector3): void {
    const gy = groundY(at.x, at.z);
    const base = new THREE.Vector3(at.x, gy, at.z);
    beam(base, '#ffcf5a', 0.36, 2.4, 1.6, 0.2);
    shockwave(base, '#ffd76a', 0.9, 0.7);
    scheduleLater(0.18, () => shockwave(base, '#fff2b8', 0.6, 0.6));
    light(base.clone().add(new THREE.Vector3(0, 0.8, 0)), '#ffd27a', 4, 1.0);
    for (let i = 0; i < 46; i++) {
      const a = rnd(0, Math.PI * 2), r = rnd(0.05, 0.4);
      glow.emit({
        pos: new THREE.Vector3(base.x + Math.cos(a) * r, gy + rnd(0, 0.5), base.z + Math.sin(a) * r),
        vel: new THREE.Vector3(Math.cos(a) * 0.1, rnd(0.8, 2.0), Math.sin(a) * 0.1),
        life: rnd(0.8, 1.5), size: rnd(0.04, 0.09), size1: 0.01, color: '#fff7d6', color1: '#ffb400', drag: 0.8, fadeIn: 0.1,
      });
    }
    flash(new THREE.Vector3(base.x, gy + 1.1, base.z), '#ffe08a', 1.1, 0.6);
  }

  function scheduleLater(sec: number, fn: () => void): void {
    sched.wait(sec).then(fn).catch(() => undefined);
  }

  // ───────────── spells ─────────────
  function castFlare(from: THREE.Vector3, color: string): void {
    flash(from, color, 1.1, 0.5);
    light(from, color, 3, 0.5);
    for (let i = 0; i < 24; i++) {
      const a = (i / 24) * Math.PI * 2;
      streaks.emit({ pos: from.clone(), swirl: { center: from.clone().add(new THREE.Vector3(0, -0.3, 0)), rate: 6, rise: 1.1, radius: 0.25, angle: a }, len: 0.04, width: 0.016, life: rnd(0.4, 0.6), color });
    }
  }

  /** A faint glow over every hex of an area: where an ally-only spell reached, without claiming it hit anyone there. */
  function areaCue(hexes: THREE.Vector3[], color: string, sp: number): void {
    for (const h of hexes) {
      const g = groundDecal(h, softDotTexture(), color, 1.5, THREE.AdditiveBlending, 0);
      let t = 0;
      addEffect({
        update(dt) { t += dt * sp; (g.material as THREE.MeshBasicMaterial).opacity = Math.sin(clamp01(t / 1.1) * Math.PI) * 0.17; return t < 1.1; },
        dispose() { root.remove(g); (g.material as THREE.Material).dispose(); },
      });
    }
  }

  async function spell(id: SpellId, from: THREE.Vector3, center: THREE.Vector3, radius: number, speed: number, targets?: THREE.Vector3[]): Promise<void> {
    const sp = normSpeed(speed);
    const color = SPELL_COLOR[id];
    // `from` is the casting point (the world passes the tower top)
    const src = from.clone();
    const centerHex = worldToHex(center.x, center.z);
    const hexes = spiral(centerHex, Math.max(0, Math.round(radius))).map((h) => ctx.hexCenter(h));
    const W = (s: number) => sched.wait(s / sp);
    castFlare(src, color);
    switch (id) {
      case 'fireball': {
        await W(0.22);
        await fireProjectile(src, center.clone().add(new THREE.Vector3(0, 0.15, 0)), sp);
        const c = center.clone().add(new THREE.Vector3(0, 0.15, 0));
        flash(c, '#fff0c0', 1.5, 0.35);
        flash(c, '#ff7a22', 2.8, 0.65);
        light(c.clone().add(new THREE.Vector3(0, 0.6, 0)), '#ff8a3c', 9, 0.7);
        ctx.shake(0.55);
        shockwave(center, '#ffb36a', 1.9, 0.55);
        scorchTex ??= scorchTexture();
        const sc = groundDecal(center, scorchTex, '#ffffff', 2.3, THREE.NormalBlending, 0.85);
        let st = 0;
        addEffect({
          update(dt) { st += dt; (sc.material as THREE.MeshBasicMaterial).opacity = 0.85 * (1 - smoothstep(1.2, 3.2, st)); return st < 3.2; },
          dispose() { root.remove(sc); (sc.material as THREE.Material).dispose(); },
        });
        for (let i = 0; i < 90; i++) {
          const d = new THREE.Vector3(rnd(-1, 1), rnd(0.1, 1.2), rnd(-1, 1)).normalize();
          glow.emit({ pos: c.clone().addScaledVector(d, 0.1), vel: d.multiplyScalar(rnd(0.8, 2.6)), life: rnd(0.4, 0.9), size: rnd(0.2, 0.42), size1: 0.08, color: i % 4 ? '#ffae45' : '#ffe39a', color1: '#d81e04', drag: 3.2, gravity: -0.8, alpha: 0.5 });
        }
        for (let i = 0; i < 46; i++) {
          const d = new THREE.Vector3(rnd(-1, 1), rnd(0.3, 1.4), rnd(-1, 1)).normalize();
          streaks.emit({ pos: c.clone(), vel: d.multiplyScalar(rnd(2.5, 5.5)), len: 0.04, width: 0.014, life: rnd(0.5, 1.1), color: '#ffb347', drag: 1.6, gravity: 5.5, alpha: 1.4 });
        }
        smokePuff(c.clone().add(new THREE.Vector3(0, 0.25, 0)), '#4d4440', 0.6, 14);
        rubble(center, 6, 0.7);
        for (const h of hexes.slice(1)) {
          scheduleLater(0.08 / sp + rnd(0, 0.12) / sp, () => {
            const p = h.clone().add(new THREE.Vector3(0, 0.12, 0));
            flash(p, '#ff8a3c', 1.0, 0.35);
            for (let i = 0; i < 16; i++) {
              const d = new THREE.Vector3(rnd(-1, 1), rnd(0.2, 1), rnd(-1, 1)).normalize();
              glow.emit({ pos: p.clone(), vel: d.multiplyScalar(rnd(0.4, 1.2)), life: rnd(0.4, 0.8), size: rnd(0.12, 0.25), size1: 0.04, color: '#ffd36a', color1: '#ff3a0a', drag: 2.5, gravity: -0.6 });
            }
          });
        }
        await W(0.5);
        break;
      }
      case 'heal': {
        await W(0.15);
        // only the allies actually healed get the column of light; the area itself just glows faintly
        areaCue(hexes, '#7dff9a', sp);
        for (const h of targets ?? hexes) {
          beam(h, '#7dff9a', 0.3, 1.25, 1.15, 0.25);
          const g = groundDecal(h, softDotTexture(), '#7dff9a', 1.3, THREE.AdditiveBlending, 0);
          let t = 0;
          addEffect({
            update(dt) { t += dt * sp; (g.material as THREE.MeshBasicMaterial).opacity = Math.sin(clamp01(t / 1.2) * Math.PI) * 0.55; return t < 1.2; },
            dispose() { root.remove(g); (g.material as THREE.Material).dispose(); },
          });
          for (let i = 0; i < 22; i++) {
            const a0 = (i / 22) * Math.PI * 2;
            streaks.emit({ pos: h.clone(), swirl: { center: h.clone().add(new THREE.Vector3(0, rnd(0, 0.2), 0)), rate: 3.2 * sp, rise: rnd(0.6, 1.1) * sp, radius: rnd(0.25, 0.4), angle: a0 }, len: 0.07, width: 0.02, life: rnd(0.8, 1.2) / sp, color: i % 3 ? '#8dff9f' : '#ffe58a', alpha: 1.1 });
          }
          sparkles(h.clone().add(new THREE.Vector3(0, 0.2, 0)), '#b8ffc0', 14, 0.35, 0.8);
        }
        await W(1.15);
        break;
      }
      case 'bless': {
        await W(0.15);
        areaCue(hexes, '#ffe38a', sp);
        for (const h of targets ?? hexes) {
          const top = h.clone().add(new THREE.Vector3(rnd(-0.3, 0.3), 3.2, rnd(-0.3, 0.3)));
          for (let k = 0; k < 3; k++) {
            const off = new THREE.Vector3(rnd(-0.2, 0.2), 0, rnd(-0.2, 0.2));
            streaks.emit({ pos: h.clone().add(off), tail: top.clone().add(off), width: 0.16 + k * 0.06, life: 1.1 / sp, color: '#ffd76a', alpha: 0.45, fade: 0.8, fadeIn: 0.25 });
          }
          shockwave(h, '#ffe38a', 0.75, 0.9 / sp);
          for (let i = 0; i < 18; i++) {
            glow.emit({ pos: h.clone().add(new THREE.Vector3(rnd(-0.4, 0.4), rnd(0.8, 2.0), rnd(-0.4, 0.4))), vel: new THREE.Vector3(0, -rnd(0.4, 0.9), 0), life: rnd(0.8, 1.3), size: rnd(0.04, 0.08), size1: 0.01, color: '#fff7d6', color1: '#ffbf2e', fadeIn: 0.2 });
          }
        }
        light(center.clone().add(new THREE.Vector3(0, 1, 0)), '#ffd76a', 4, 1.0);
        await W(1.15);
        break;
      }
      case 'haste': {
        await W(0.12);
        const c = hexes[0] ?? center;
        for (let i = 0; i < 34; i++) {
          streaks.emit({ pos: c.clone(), swirl: { center: c.clone().add(new THREE.Vector3(0, rnd(0.02, 0.3), 0)), rate: rnd(7, 10) * sp, rise: rnd(0.4, 0.9) * sp, radius: rnd(0.22, 0.5), angle: rnd(0, Math.PI * 2) }, len: 0.05, width: 0.02, life: rnd(0.5, 0.9) / sp, color: i % 4 ? '#7fd2ff' : '#ffffff', alpha: 1.2, fadeIn: 0.1 });
        }
        for (let i = 0; i < 12; i++) {
          const dir = new THREE.Vector3(rnd(-1, 1), 0, rnd(-1, 1)).normalize();
          const p = c.clone().add(new THREE.Vector3(0, rnd(0.15, 0.6), 0)).addScaledVector(dir, 0.6);
          streaks.emit({ pos: p, vel: dir.clone().multiplyScalar(-2.6 * sp), len: 0.12, width: 0.015, life: 0.35 / sp, color: '#bfe9ff', alpha: 0.9 });
        }
        shockwave(c, '#7fd2ff', 0.7, 0.5 / sp);
        await W(0.9);
        break;
      }
      case 'farsight': {
        eyeTex ??= eyeTexture();
        const mat = new THREE.SpriteMaterial({ map: eyeTex, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false, fog: false });
        const eye = new THREE.Sprite(mat);
        eye.renderOrder = 30;
        eye.position.copy(center).add(new THREE.Vector3(0, 1.3, 0));
        root.add(eye);
        let t = 0;
        addEffect({
          update(dt) {
            t += dt * sp;
            const u = clamp01(t / 1.5);
            const open = u < 0.25 ? easeOutBack(u / 0.25) : 1;
            eye.scale.set(1.1, 0.55 * Math.max(0.02, open), 1);
            mat.opacity = Math.min(1, u * 5) * (1 - smoothstep(0.7, 1, u));
            eye.position.y = center.y + 1.3 + u * 0.3;
            return u < 1;
          },
          dispose() { root.remove(eye); mat.dispose(); },
        });
        const R = (Math.max(1, radius) + 0.5) * Math.sqrt(3);
        shockwave(center, '#8fe9ff', R, 1.2 / sp);
        scheduleLater(0.15 / sp, () => shockwave(center, '#d6fbff', R * 0.8, 1.1 / sp));
        sparkles(center.clone().add(new THREE.Vector3(0, 1.2, 0)), '#8fe9ff', 26, 0.5, 0.3);
        await W(1.5);
        break;
      }
      case 'summon': {
        const c = hexes[0] ?? center;
        summonCircle(c, '#ffb347', 1.6 / sp);
        await W(0.55);
        flash(c.clone().add(new THREE.Vector3(0, 0.25, 0)), '#ffcf7a', 1.6, 0.4);
        light(c.clone().add(new THREE.Vector3(0, 0.6, 0)), '#ffb347', 5, 0.6);
        rubble(c, 16, 1.1);
        dust(c, 2.2, '#9a8466');
        ctx.shake(0.3);
        beam(c, '#ffb347', 0.5, 1.6, 0.8, 0.15);
        await W(0.6);
        break;
      }
      case 'storm': {
        const cloudY = center.y + 3.0;
        const R = (Math.max(1, radius) + 0.5) * 1.5;
        for (let i = 0; i < 46; i++) {
          const a = rnd(0, Math.PI * 2), r = Math.sqrt(rand()) * R;
          smoke.emit({ pos: new THREE.Vector3(center.x + Math.cos(a) * r, cloudY + rnd(-0.2, 0.3), center.z + Math.sin(a) * r), vel: new THREE.Vector3(rnd(-0.1, 0.1), rnd(-0.05, 0.05), rnd(-0.1, 0.1)), life: 2.2 / sp, size: rnd(0.8, 1.4), size1: rnd(1.6, 2.2), color: i % 3 ? '#26232e' : '#3b3548', alpha: 0.85, spin: rnd(-0.3, 0.3), fadeIn: 0.25 });
        }
        await W(0.35);
        const targets = [...hexes].sort(() => rand() - 0.5);
        for (let b = 0; b < 4; b++) {
          const tgt = (targets[b % Math.max(1, targets.length)] ?? center).clone();
          tgt.x += rnd(-0.2, 0.2); tgt.z += rnd(-0.2, 0.2);
          const top = new THREE.Vector3(tgt.x + rnd(-0.5, 0.5), cloudY, tgt.z + rnd(-0.5, 0.5));
          lightning(top, tgt.clone().add(new THREE.Vector3(0, 0.05, 0)), 0.28 / sp);
          flash(tgt.clone().add(new THREE.Vector3(0, 0.2, 0)), '#dfe4ff', 1.0, 0.28);
          flash(top, '#b9c2ff', 1.6, 0.35);
          light(tgt.clone().add(new THREE.Vector3(0, 1.0, 0)), '#c6ccff', 5, 0.3);
          shockwave(tgt, '#a9b4ff', 0.6, 0.35);
          for (let i = 0; i < 14; i++) {
            const d = new THREE.Vector3(rnd(-1, 1), rnd(0.2, 1), rnd(-1, 1)).normalize();
            streaks.emit({ pos: tgt.clone(), vel: d.multiplyScalar(rnd(2, 4)), len: 0.04, width: 0.012, life: rnd(0.2, 0.4), color: '#dfe4ff', drag: 3, gravity: 6, alpha: 1.4 });
          }
          ctx.shake(0.32);
          await W(0.24);
        }
        await W(0.3);
        break;
      }
    }
  }

  function update(dt: number): void {
    if (!(dt > 0)) dt = 0;
    dt = Math.min(dt, 0.1);
    // world-space point size: pixels per world unit at distance 1
    const h = ctx.renderer.getDrawingBufferSize(_size).y || ctx.renderer.domElement.height || 800;
    const scale = h / (2 * Math.tan((ctx.camera.fov * Math.PI) / 360));
    glow.uniforms.uScale.value = scale;
    smoke.uniforms.uScale.value = scale;
    sched.update(dt);
    glow.update(dt);
    smoke.update(dt);
    streaks.update(dt);
    rubblePool.update(dt);
    for (let i = effects.length - 1; i >= 0; i--) {
      let alive = false;
      try { alive = effects[i].update(dt); } catch (err) { console.error('[fx] effect failed', err); }
      if (!alive) { effects[i].dispose(); effects.splice(i, 1); }
    }
    for (const L of lights) {
      if (L.l.intensity <= 0) continue;
      L.t += dt;
      const u = clamp01(L.t / L.dur);
      L.l.intensity = u >= 1 ? 0 : L.peak * (1 - easeInOutSine(u));
    }
  }

  function dispose(): void {
    sched.clear();
    for (const e of effects) e.dispose();
    effects.length = 0;
    glow.dispose(); smoke.dispose(); streaks.dispose(); rubblePool.dispose();
    for (const { tex } of numberCache.values()) tex.dispose();
    numberCache.clear();
    eyeTex?.dispose(); runeTex?.dispose(); scorchTex?.dispose();
    flatGeo.dispose(); cylGeo.dispose();
    arrowGeo.forEach((g) => g.dispose());
    arrowMats.forEach((m) => m.dispose());
    ctx.scene.remove(root);
  }

  return {
    projectile, damageNumber, burst, spell, levelUp, hitSpark, update, dispose,
    dust, shockwave, flash, sparkles, wisps, rubble, smokePuff, summonCircle, light, fireProjectile,
  };
};
