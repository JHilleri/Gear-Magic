// RTS camera: WASD/arrow pan (keyState filled by the controller), edge pan (optional),
// middle- or right-drag "grab" pan, wheel zoom toward the cursor with pitch that tilts toward
// the horizon when close, smooth Q/E rotation, focus easing, inertia, map clamping and shake.
// The clamp follows the zoom: the target is kept where the view's ground footprint (edge
// midpoints) stays within the map plus a small slack, so panning never fills the screen with void;
// on an axis where the view is wider than the map, the map is centred instead.
import * as THREE from 'three';
import type { WorldRect } from './fow';

const MIN_DIST = 5.5;
const MAX_DIST = 46;
/** Camera distance of a fresh game view. */
export const DEFAULT_DIST = 14;
/** Forward reach cap (world) of a view ray that grazes the horizon. */
const RAY_CAP = 40;
/** PointerEvent.buttons bit of each PointerEvent.button the camera drags with (middle, right). */
const BUTTON_BIT: Record<number, number> = { 0: 1, 1: 4, 2: 2 };
const DRAG_THRESHOLD = 5;   // px before a right-button press counts as a drag (keeps RMB-click = cancel)

export interface CameraControllerOpts {
  camera: THREE.PerspectiveCamera;
  canvas: HTMLCanvasElement;
  /** Terrain height under a point (used to keep the target on the ground and the camera above it). */
  heightAt: (x: number, z: number) => number;
}

export class RtsCamera {
  readonly camera: THREE.PerspectiveCamera;
  private canvas: HTMLCanvasElement;
  private heightAt: (x: number, z: number) => number;

  /** Ground point the camera orbits. */
  readonly target = new THREE.Vector3(0, 0, 0);
  private targetY = 0;
  private dist = DEFAULT_DIST;
  private distGoal = DEFAULT_DIST;
  private yaw = 0;
  private yawGoal = 0;
  private vel = new THREE.Vector2();
  /** Playable map rectangle (world) and how far past it the view may show. */
  private bounds: WorldRect = { minX: -10, maxX: 10, minZ: -10, maxZ: 10 };
  private slack = 2.5;
  private focusAnim: { from: THREE.Vector3; to: THREE.Vector3; t: number; dur: number; distFrom: number; distTo: number } | null = null;
  private shakeAmt = 0;
  private shakeT = 0;
  private zoomAnchor: { x: number; z: number } | null = null;

  // pointer drag state
  private drag: { id: number; button: number; sx: number; sy: number; active: boolean; grab: THREE.Vector3 } | null = null;
  private mouse = { x: 0, y: 0, inside: false };
  /** Enable panning when the cursor touches a screen edge. */
  edgePan = false;
  /** True while (or right after) a drag gesture — clicks ending a drag should be ignored by the controller. */
  dragging = false;

  private ray = new THREE.Raycaster();
  private listeners: [EventTarget, string, EventListenerOrEventListenerObject, AddEventListenerOptions | boolean][] = [];

  constructor(o: CameraControllerOpts) {
    this.camera = o.camera;
    this.canvas = o.canvas;
    this.heightAt = o.heightAt;
    this.listen(this.canvas, 'pointerdown', this.onPointerDown as EventListener);
    this.listen(window, 'pointermove', this.onPointerMove as EventListener);
    this.listen(window, 'pointerup', this.onPointerUp as EventListener, true);
    this.listen(this.canvas, 'wheel', this.onWheel as EventListener, { passive: false });
    this.listen(this.canvas, 'contextmenu', this.onContextMenu as EventListener, true);
    // Edge pan tracks the pointer at window level so HUD bars along the edges don't block it.
    this.listen(document, 'mouseout', ((e: MouseEvent) => { if (e.relatedTarget === null) this.mouse.inside = false; }) as EventListener);
    this.listen(window, 'blur', (() => { this.dropDrag(); this.dragging = false; this.vel.set(0, 0); this.mouse.inside = false; }) as EventListener);
    // A press anywhere but the map ends any drag whose release was never seen (released outside
    // the window, a lost pointerup), so it cannot capture the next HUD click onto the canvas.
    this.listen(window, 'pointerdown', ((e: PointerEvent) => { if (e.target !== this.canvas && this.drag) { this.dropDrag(); this.dragging = false; } }) as EventListener, true);
  }

  /** Forget the drag and give back any pointer capture it took. */
  private dropDrag(): void {
    const d = this.drag;
    this.drag = null;
    if (!d) return;
    try { if (this.canvas.hasPointerCapture?.(d.id)) this.canvas.releasePointerCapture(d.id); } catch { /* ignore */ }
  }

  private listen(t: EventTarget, type: string, fn: EventListenerOrEventListenerObject, opts: AddEventListenerOptions | boolean = false) {
    t.addEventListener(type, fn, opts);
    this.listeners.push([t, type, fn, opts]);
  }

  setHeightFn(fn: (x: number, z: number) => number): void { this.heightAt = fn; }

  /** `r`: the map rectangle; `slack`: world units of off-map ground the view may show at an edge. */
  setBounds(r: WorldRect, opts: { slack?: number } = {}): void {
    this.bounds = { ...r };
    if (opts.slack !== undefined) this.slack = opts.slack;
    this.clampTarget();
  }

  /**
   * Ground footprint of the view around the target, as world x/z offsets of the four screen-edge
   * midpoints (top, bottom, left, right) intersected with the target's ground plane. Analytic (no
   * matrices), so it can be evaluated for a zoom the camera has not reached yet.
   */
  viewOffsets(dist = this.dist, yaw = this.yaw): { oxMin: number; oxMax: number; ozMin: number; ozMax: number } {
    const p = this.pitch(dist);
    const cp = Math.cos(p), sp = Math.sin(p);
    const Z = new THREE.Vector3(Math.sin(yaw) * cp, sp, Math.cos(yaw) * cp); // camera backward
    const X = new THREE.Vector3(Math.cos(yaw), 0, -Math.sin(yaw));
    const Y = new THREE.Vector3().crossVectors(Z, X);
    const tanH = Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2);
    const aspect = this.camera.aspect || 1;
    const h = sp * dist;
    const r = { oxMin: Infinity, oxMax: -Infinity, ozMin: Infinity, ozMax: -Infinity };
    const w = new THREE.Vector3();
    for (const [sx, sy] of [[0, 1], [0, -1], [-1, 0], [1, 0]]) {
      w.copy(X).multiplyScalar(sx * tanH * aspect).addScaledVector(Y, sy * tanH).sub(Z);
      let ox: number, oz: number;
      const camX = Z.x * dist, camZ = Z.z * dist; // camera relative to the target
      if (w.y < -1e-3) {
        const t = h / -w.y;
        ox = camX + w.x * t; oz = camZ + w.z * t;
        const hd = Math.hypot(w.x * t, w.z * t);
        if (hd > RAY_CAP) { ox = camX + (w.x * t * RAY_CAP) / hd; oz = camZ + (w.z * t * RAY_CAP) / hd; }
      } else {
        const hl = Math.hypot(w.x, w.z) || 1;
        ox = camX + (w.x / hl) * RAY_CAP; oz = camZ + (w.z / hl) * RAY_CAP;
      }
      r.oxMin = Math.min(r.oxMin, ox); r.oxMax = Math.max(r.oxMax, ox);
      r.ozMin = Math.min(r.ozMin, oz); r.ozMax = Math.max(r.ozMax, oz);
    }
    return r;
  }

  /** Target clamp rectangle for a zoom level (see the header). */
  effectiveBounds(dist = this.dist, yaw = this.yaw): WorldRect {
    const b = this.bounds, o = this.viewOffsets(dist, yaw), k = this.slack;
    let minX = b.minX - k - o.oxMin, maxX = b.maxX + k - o.oxMax;
    let minZ = b.minZ - k - o.ozMin, maxZ = b.maxZ + k - o.ozMax;
    if (minX > maxX) minX = maxX = (minX + maxX) / 2;
    if (minZ > maxZ) minZ = maxZ = (minZ + maxZ) / 2;
    return { minX, maxX, minZ, maxZ };
  }

  /**
   * Smoothly centre on a world point (optionally zooming). `pace` shortens the glide (enemy turns
   * at a higher animation speed). Returns the glide's length in seconds (0 when instant).
   */
  focusOn(x: number, z: number, instant = false, dist?: number, pace = 1): number {
    const to = new THREE.Vector3(x, 0, z);
    this.clampVec(to, dist !== undefined ? THREE.MathUtils.clamp(dist, MIN_DIST, MAX_DIST) : this.distGoal, this.yawGoal);
    if (instant) {
      this.target.set(to.x, this.target.y, to.z);
      this.targetY = this.groundAt(to.x, to.z);
      this.target.y = this.targetY;
      if (dist !== undefined) this.dist = this.distGoal = THREE.MathUtils.clamp(dist, MIN_DIST, MAX_DIST);
      this.focusAnim = null;
      this.vel.set(0, 0);
      return 0;
    }
    const d = this.target.distanceTo(to);
    const dur = THREE.MathUtils.clamp(0.35 + d * 0.018, 0.35, 0.95) / (pace > 0 && Number.isFinite(pace) ? pace : 1);
    this.focusAnim = {
      from: this.target.clone(), to, t: 0, dur,
      distFrom: this.distGoal, distTo: dist !== undefined ? THREE.MathUtils.clamp(dist, MIN_DIST, MAX_DIST) : this.distGoal,
    };
    this.vel.set(0, 0);
    return dur;
  }

  /**
   * Ground point the view will be centred on once it settles: `x,z` as focusOn() would clamp it,
   * or (without a point) the end of the glide in progress, else the current target.
   */
  restingTarget(x?: number, z?: number): THREE.Vector3 {
    if (x !== undefined && z !== undefined) {
      const to = new THREE.Vector3(x, 0, z);
      this.clampVec(to, this.distGoal, this.yawGoal);
      return to.setY(this.target.y);
    }
    return this.focusAnim ? this.focusAnim.to.clone().setY(this.target.y) : this.target.clone();
  }

  shake(amount: number): void { this.shakeAmt = Math.min(1, Math.max(this.shakeAmt, amount)); }

  get distance(): number { return this.dist; }
  get rotation(): number { return this.yaw; }

  update(dt: number, keys: Set<string>): void {
    // ── keyboard pan & rotate ──
    let ix = 0, iz = 0, rot = 0, zoom = 0;
    for (const raw of keys) {
      const k = raw.toLowerCase();
      if (k === 'w' || k === 'keyw' || k === 'arrowup') iz -= 1;
      else if (k === 's' || k === 'keys' || k === 'arrowdown') iz += 1;
      else if (k === 'a' || k === 'keya' || k === 'arrowleft') ix -= 1;
      else if (k === 'd' || k === 'keyd' || k === 'arrowright') ix += 1;
      else if (k === 'q' || k === 'keyq') rot += 1;
      else if (k === 'e' || k === 'keye') rot -= 1;
      else if (k === 'pageup' || k === 'equal' || k === 'numpadadd') zoom -= 1;
      else if (k === 'pagedown' || k === 'minus' || k === 'numpadsubtract') zoom += 1;
    }
    if (zoom) {
      this.distGoal = THREE.MathUtils.clamp(this.distGoal * Math.exp(Math.sign(zoom) * dt * 1.6), MIN_DIST, MAX_DIST);
      this.zoomAnchor = null;
    }
    if (this.edgePan && this.mouse.inside && !this.drag && document.hasFocus()) {
      const r = this.canvas.getBoundingClientRect();
      const m = 14;
      if (this.mouse.x - r.left < m) ix -= 1;
      if (r.right - this.mouse.x < m) ix += 1;
      if (this.mouse.y - r.top < m) iz -= 1;
      if (r.bottom - this.mouse.y < m) iz += 1;
    }
    ix = Math.max(-1, Math.min(1, ix));
    iz = Math.max(-1, Math.min(1, iz));
    const speed = 6 + this.dist * 1.15;
    const sin = Math.sin(this.yaw), cos = Math.cos(this.yaw);
    // screen-relative → world: forward is -Z rotated by yaw
    const wx = ix * cos + iz * sin;
    const wz = -ix * sin + iz * cos;
    const len = Math.hypot(wx, wz) || 1;
    const goalVx = (ix || iz) ? (wx / len) * speed : 0;
    const goalVz = (ix || iz) ? (wz / len) * speed : 0;
    const accel = (ix || iz) ? 10 : 6.5;
    const a = 1 - Math.exp(-accel * dt);
    this.vel.x += (goalVx - this.vel.x) * a;
    this.vel.y += (goalVz - this.vel.y) * a;
    if (this.vel.lengthSq() > 1e-6) {
      this.target.x += this.vel.x * dt;
      this.target.z += this.vel.y * dt;
      if (ix || iz) this.focusAnim = null;
    }
    if (rot) this.yawGoal += rot * dt * 1.9;
    this.yaw += (this.yawGoal - this.yaw) * (1 - Math.exp(-9 * dt));

    // ── focus animation ──
    if (this.focusAnim) {
      const f = this.focusAnim;
      f.t = Math.min(1, f.t + dt / f.dur);
      const e = f.t < 0.5 ? 4 * f.t * f.t * f.t : 1 - Math.pow(-2 * f.t + 2, 3) / 2;
      this.target.x = f.from.x + (f.to.x - f.from.x) * e;
      this.target.z = f.from.z + (f.to.z - f.from.z) * e;
      this.distGoal = f.distFrom + (f.distTo - f.distFrom) * e;
      if (f.t >= 1) this.focusAnim = null;
    }

    // ── zoom (with cursor anchoring: the ground point under the cursor stays put) ──
    const prevDist = this.dist;
    this.dist += (this.distGoal - this.dist) * (1 - Math.exp(-11 * dt));
    if (this.zoomAnchor && Math.abs(prevDist - this.dist) > 1e-4) {
      const k = 1 - this.dist / prevDist;
      this.target.x += (this.zoomAnchor.x - this.target.x) * k * 0.85;
      this.target.z += (this.zoomAnchor.z - this.target.z) * k * 0.85;
    }
    if (Math.abs(this.distGoal - this.dist) < 0.01) this.zoomAnchor = null;

    this.clampTarget();
    // Ground following (smoothed) so zooming over mountains never clips.
    const gy = this.groundAt(this.target.x, this.target.z);
    this.targetY += (gy - this.targetY) * (1 - Math.exp(-5 * dt));
    this.target.y = this.targetY;

    this.apply(dt);
  }

  /** Pitch from the zoom level: close → toward the horizon, far → top-down-ish. */
  private pitch(d = this.dist): number {
    const t = THREE.MathUtils.clamp((d - MIN_DIST) / (MAX_DIST - MIN_DIST), 0, 1);
    const e = Math.pow(t, 0.7);
    return THREE.MathUtils.lerp(0.6, 1.12, e);
  }

  private apply(dt: number): void {
    const p = this.pitch();
    const cp = Math.cos(p), sp = Math.sin(p);
    const cam = this.camera;
    cam.position.set(
      this.target.x + Math.sin(this.yaw) * cp * this.dist,
      this.target.y + sp * this.dist,
      this.target.z + Math.cos(this.yaw) * cp * this.dist,
    );
    // Keep above the terrain under the camera.
    const floor = this.heightAt(cam.position.x, cam.position.z) + 0.8;
    if (cam.position.y < floor) cam.position.y = floor;
    const look = new THREE.Vector3(this.target.x, this.target.y + 0.15, this.target.z);
    if (this.shakeAmt > 0.001) {
      this.shakeT += dt * 38;
      const s = this.shakeAmt * this.shakeAmt * 0.12 * (0.5 + this.dist / 30);
      const ox = (Math.sin(this.shakeT * 1.3) + Math.sin(this.shakeT * 2.9) * 0.5) * s;
      const oy = (Math.cos(this.shakeT * 1.7) + Math.sin(this.shakeT * 3.7) * 0.5) * s;
      cam.position.x += ox; cam.position.y += oy;
      look.x += ox * 0.5; look.y += oy * 0.5;
      this.shakeAmt *= Math.exp(-5 * dt);
    }
    cam.lookAt(look);
    cam.updateMatrixWorld();
  }

  private groundAt(x: number, z: number): number { return Math.max(0, this.heightAt(x, z) * 0.85); }

  private clampVec(v: THREE.Vector3, dist = this.dist, yaw = this.yaw): void {
    const b = this.effectiveBounds(dist, yaw);
    v.x = THREE.MathUtils.clamp(v.x, b.minX, b.maxX);
    v.z = THREE.MathUtils.clamp(v.z, b.minZ, b.maxZ);
  }
  private clampTarget(): void {
    const b = this.effectiveBounds();
    const x = THREE.MathUtils.clamp(this.target.x, b.minX, b.maxX);
    const z = THREE.MathUtils.clamp(this.target.z, b.minZ, b.maxZ);
    if (x !== this.target.x) this.vel.x = 0;
    if (z !== this.target.z) this.vel.y = 0;
    this.target.x = x;
    this.target.z = z;
  }

  /** Point on the horizontal plane y = planeY under a client pixel. */
  private groundUnder(clientX: number, clientY: number, planeY: number, out: THREE.Vector3): boolean {
    const r = this.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
    this.ray.setFromCamera(ndc, this.camera);
    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -planeY);
    return this.ray.ray.intersectPlane(plane, out) !== null;
  }

  private onPointerDown = (e: PointerEvent) => {
    if (e.button !== 1 && e.button !== 2) return;
    if (e.button === 1) e.preventDefault();
    const grab = new THREE.Vector3();
    if (!this.groundUnder(e.clientX, e.clientY, this.target.y, grab)) return;
    this.drag = { id: e.pointerId, button: e.button, sx: e.clientX, sy: e.clientY, active: e.button === 1, grab };
    this.dragging = e.button === 1;
    this.focusAnim = null;
  };

  private onPointerMove = (e: PointerEvent) => {
    this.mouse.x = e.clientX;
    this.mouse.y = e.clientY;
    this.mouse.inside = e.pointerType === 'mouse';
    const d = this.drag;
    if (!d || e.pointerId !== d.id) return;
    // The dragging button is no longer held: its release was missed. Drop the drag rather than
    // pan (or capture the pointer) on a plain hover.
    if (e.pointerType === 'mouse' && (e.buttons & BUTTON_BIT[d.button]) === 0) {
      this.dropDrag();
      this.dragging = false;
      return;
    }
    if (!d.active && Math.hypot(e.clientX - d.sx, e.clientY - d.sy) > DRAG_THRESHOLD) {
      d.active = true;
      this.dragging = true;
      try { this.canvas.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    }
    if (!d.active) return;
    // Grab pan: keep the grabbed ground point under the cursor.
    this.camera.updateMatrixWorld();
    const cur = new THREE.Vector3();
    if (!this.groundUnder(e.clientX, e.clientY, this.target.y, cur)) return;
    this.target.x += d.grab.x - cur.x;
    this.target.z += d.grab.z - cur.z;
    this.clampTarget();
    this.apply(0);
    this.vel.set(0, 0);
  };

  private onPointerUp = (e: PointerEvent) => {
    const d = this.drag;
    if (!d || e.pointerId !== d.id) return;
    this.drag = null;
    try { this.canvas.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
    if (d.active) {
      // Swallow the release so the controller does not treat the end of a drag as a click/cancel.
      e.stopImmediatePropagation();
      this.dragging = true;
      setTimeout(() => { this.dragging = false; }, 0);
    } else {
      this.dragging = false;
    }
  };

  private onContextMenu = (e: MouseEvent) => {
    e.preventDefault();
    if (this.dragging) e.stopImmediatePropagation();
  };

  private onWheel = (e: WheelEvent) => {
    e.preventDefault();
    let dy = e.deltaY;
    if (e.deltaMode === 1) dy *= 32;
    else if (e.deltaMode === 2) dy *= 400;
    dy = THREE.MathUtils.clamp(dy, -240, 240);
    const old = this.distGoal;
    this.distGoal = THREE.MathUtils.clamp(this.distGoal * Math.exp(dy * 0.0016), MIN_DIST, MAX_DIST);
    if (this.distGoal < old) {
      const p = new THREE.Vector3();
      if (this.groundUnder(e.clientX, e.clientY, this.target.y, p)) this.zoomAnchor = { x: p.x, z: p.z };
    } else {
      this.zoomAnchor = null;
    }
    this.focusAnim = null;
  };

  dispose(): void {
    for (const [t, type, fn, opts] of this.listeners) t.removeEventListener(type, fn, opts);
    this.listeners = [];
  }
}
