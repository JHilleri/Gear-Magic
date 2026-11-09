// Animation helpers shared by the entity layers: easing, angle math, a dt-driven
// scheduler (tweens/waits that resolve as promises), canvas utilities and terrain draping.
import * as THREE from 'three';

// ───────────────────────────── math & easing ─────────────────────────────
export const clamp = (v: number, a: number, b: number): number => (v < a ? a : v > b ? b : v);
export const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
export const smoothstep = (a: number, b: number, v: number): number => {
  const t = clamp01((v - a) / (b - a));
  return t * t * (3 - 2 * t);
};
export const easeInQuad = (t: number): number => t * t;
export const easeOutQuad = (t: number): number => 1 - (1 - t) * (1 - t);
export const easeInOutQuad = (t: number): number => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);
export const easeInCubic = (t: number): number => t * t * t;
export const easeOutCubic = (t: number): number => 1 - Math.pow(1 - t, 3);
export const easeInOutCubic = (t: number): number => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
export const easeInOutSine = (t: number): number => -(Math.cos(Math.PI * t) - 1) / 2;
export const easeOutBack = (t: number): number => {
  const c1 = 1.70158, c3 = c1 + 1;
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
};
export const easeOutElastic = (t: number): number => {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  return Math.pow(2, -10 * t) * Math.sin((t * 10 - 0.75) * ((2 * Math.PI) / 3)) + 1;
};
/** 0 → 1 → 0 bump over t ∈ [0,1]. */
export const bump = (t: number): number => Math.sin(clamp01(t) * Math.PI);

/**
 * Arc length `s` and speed `v` at time `t` of a move covering `len` in exactly `dur`: a cosine
 * ramp up over `ta`, a constant cruise, and a cosine ramp down over `td` (speed 0 at both ends,
 * continuous everywhere). ta + td is capped at 0.6·dur so short moves still fit.
 */
export function trapezoidProfile(t: number, dur: number, len: number, ta: number, td: number): { s: number; v: number } {
  if (!(dur > 0) || !(len > 0)) return { s: Math.max(0, len) * (t >= dur ? 1 : 0), v: 0 };
  ta = Math.max(0, ta); td = Math.max(0, td);
  const cap = 0.6 * dur;
  if (ta + td > cap) { const k = cap / (ta + td); ta *= k; td *= k; }
  const vc = len / (dur - (ta + td) / 2);
  const tc = clamp(t, 0, dur);
  if (ta > 0 && tc < ta) {
    return { s: (vc / 2) * (tc - (ta / Math.PI) * Math.sin((Math.PI * tc) / ta)), v: (vc / 2) * (1 - Math.cos((Math.PI * tc) / ta)) };
  }
  const rem = dur - tc;
  if (td > 0 && rem < td) {
    return { s: len - (vc / 2) * (rem - (td / Math.PI) * Math.sin((Math.PI * rem) / td)), v: (vc / 2) * (1 - Math.cos((Math.PI * rem) / td)) };
  }
  return { s: (vc * ta) / 2 + vc * (tc - ta), v: vc };
}

/** Wrap an angle to [-π, π). */
export function wrapAngle(a: number): number {
  a = (a + Math.PI) % (Math.PI * 2);
  if (a < 0) a += Math.PI * 2;
  return a - Math.PI;
}
/** Frame-rate independent exponential approach of an angle (shortest way). */
export function dampAngle(current: number, target: number, lambda: number, dt: number): number {
  const d = wrapAngle(target - current);
  return current + d * (1 - Math.exp(-lambda * dt));
}
export function damp(current: number, target: number, lambda: number, dt: number): number {
  return current + (target - current) * (1 - Math.exp(-lambda * dt));
}
/** Heading (rotation.y) that makes a +Z-facing model look from a toward b. */
export function headingTo(from: THREE.Vector3, to: THREE.Vector3): number {
  return Math.atan2(to.x - from.x, to.z - from.z);
}

/** Small deterministic PRNG for visual variety (mulberry32). */
export function makeRand(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), s | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Normalise an animation speed multiplier: ≤0 / NaN → 1, huge → effectively instant. */
export function normSpeed(speed: number): number {
  if (!Number.isFinite(speed)) return speed > 0 ? 1e6 : 1;
  return speed > 0 ? speed : 1;
}

// ───────────────────────────── scheduler ─────────────────────────────
type Task = { fn: (dt: number) => boolean; done?: () => void };

/**
 * Cooperative scheduler advanced by `update(dt)` (driven by the render loop), so tweens
 * pause with the game loop and never drift from frame timing. Every promise it hands out
 * is resolved on `clear()` so awaiting code can never hang after dispose.
 */
export class Scheduler {
  private tasks: Task[] = [];
  private adding: Task[] = [];
  private updating = false;

  /** Run fn every frame until it returns false. Returns a cancel function. */
  add(fn: (dt: number) => boolean | void, done?: () => void): () => void {
    const task: Task = { fn: (dt) => fn(dt) !== false, done };
    (this.updating ? this.adding : this.tasks).push(task);
    return () => {
      task.fn = () => false;
    };
  }

  /** Resolves after `seconds` of scheduler time (immediately-ish when ≤ 0). */
  wait(seconds: number): Promise<void> {
    return new Promise((resolve) => {
      if (!(seconds > 0) || !Number.isFinite(seconds)) { resolve(); return; }
      let t = 0;
      this.add((dt) => { t += dt; return t < seconds - 1e-6; }, resolve);
    });
  }

  /** onUpdate(easedT, rawT) every frame for `duration` seconds; always ends with t = 1. */
  tween(duration: number, onUpdate: (t: number, raw: number) => void, ease: (t: number) => number = (t) => t): Promise<void> {
    return new Promise((resolve) => {
      if (!(duration > 0) || !Number.isFinite(duration)) { onUpdate(ease(1), 1); resolve(); return; }
      let t = 0;
      onUpdate(ease(0), 0);
      this.add((dt) => {
        t = Math.min(duration, t + dt);
        if (t > duration - 1e-6) t = duration; // float accumulation must not cost an extra frame
        const raw = t / duration;
        onUpdate(ease(raw), raw);
        return t < duration;
      }, resolve);
    });
  }

  update(dt: number): void {
    if (!(dt > 0)) dt = 0;
    dt = Math.min(dt, 0.1); // a long frame (tab switch) must not teleport animations
    this.updating = true;
    const keep: Task[] = [];
    for (const task of this.tasks) {
      let alive = false;
      try {
        alive = task.fn(dt);
      } catch (err) {
        console.error('[anim] task failed', err);
        alive = false;
      }
      if (alive) keep.push(task);
      else task.done?.();
    }
    this.updating = false;
    this.tasks = keep.concat(this.adding);
    this.adding = [];
  }

  get size(): number { return this.tasks.length + this.adding.length; }

  /** Drop every task and resolve every pending promise. */
  clear(): void {
    const all = this.tasks.concat(this.adding);
    this.tasks = [];
    this.adding = [];
    for (const t of all) t.done?.();
  }
}

// ───────────────────────────── canvas helpers ─────────────────────────────
export function makeCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

export function roundRect(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const rr = Math.min(r, w / 2, h / 2);
  g.beginPath();
  g.moveTo(x + rr, y);
  g.arcTo(x + w, y, x + w, y + h, rr);
  g.arcTo(x + w, y + h, x, y + h, rr);
  g.arcTo(x, y + h, x, y, rr);
  g.arcTo(x, y, x + w, y, rr);
  g.closePath();
}

export function canvasTexture(c: HTMLCanvasElement, srgb = true): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(c);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  t.needsUpdate = true;
  return t;
}

/** Display font stack (Cinzel is loaded by index.html; serif fallbacks otherwise). */
export const DISPLAY_FONT = "'Cinzel', 'Trajan Pro', Georgia, 'Times New Roman', serif";
export const UI_FONT = "'Alegreya Sans', 'Segoe UI', system-ui, sans-serif";

// ───────────────────────────── terrain draping ─────────────────────────────
export type HeightFn = (x: number, z: number) => number;

/** Rewrite every vertex Y of a flat (XZ) geometry to sit `lift` above the terrain. Positions are world-space x/z offsets from (ox, oz). */
export function drapeGeometry(geo: THREE.BufferGeometry, heightAt: HeightFn, ox: number, oz: number, lift: number, minY = -Infinity): void {
  const pos = geo.getAttribute('position') as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i) + ox;
    const z = pos.getZ(i) + oz;
    pos.setY(i, Math.max(minY, heightAt(x, z)) + lift);
  }
  pos.needsUpdate = true;
  geo.computeBoundingSphere();
}

/** A flat disc geometry (XZ plane) with radial + angular subdivisions, uv = (u,v) in [0,1]² over the disc's square. */
export function discGeometry(radius: number, segments = 32, rings = 3): THREE.BufferGeometry {
  const pos: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  pos.push(0, 0, 0);
  uv.push(0.5, 0.5);
  for (let r = 1; r <= rings; r++) {
    const rr = (radius * r) / rings;
    for (let s = 0; s < segments; s++) {
      const a = (s / segments) * Math.PI * 2;
      const x = Math.cos(a) * rr, z = Math.sin(a) * rr;
      pos.push(x, 0, z);
      uv.push(0.5 + x / (2 * radius), 0.5 - z / (2 * radius));
    }
  }
  for (let s = 0; s < segments; s++) {
    const a = 1 + s, b = 1 + ((s + 1) % segments);
    idx.push(0, b, a);
  }
  for (let r = 1; r < rings; r++) {
    const base0 = 1 + (r - 1) * segments, base1 = 1 + r * segments;
    for (let s = 0; s < segments; s++) {
      const a0 = base0 + s, a1 = base0 + ((s + 1) % segments);
      const b0 = base1 + s, b1 = base1 + ((s + 1) % segments);
      idx.push(a0, a1, b1, a0, b1, b0);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** Common GLSL include: tone mapping + colour space conversion so ShaderMaterials match lit materials. */
export const GLSL_OUTPUT = `
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
`;

/**
 * Free the bone textures of every skeleton under `root` (three creates one per Skeleton on its
 * first skinned draw, and only Skeleton.dispose() releases it). Only call this on clones: the
 * asset library's template skeletons are shared. Safe to call twice.
 */
export function disposeSkeletons(root: THREE.Object3D): void {
  const seen = new Set<THREE.Skeleton>();
  root.traverse((o) => {
    const sk = (o as THREE.SkinnedMesh).isSkinnedMesh ? (o as THREE.SkinnedMesh).skeleton : null;
    if (sk && !seen.has(sk)) { seen.add(sk); sk.dispose(); }
  });
}
