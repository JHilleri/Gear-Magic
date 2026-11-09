// Selection ring, movement range tint, path preview, attack targets, AoE / spell range previews.
// Everything is draped on the terrain (ctx.heightAt) and drawn just above it with polygon offset.
import * as THREE from 'three';
import type { GameState, Hex, ReachInfo, UnitId } from '../core/types';
import { DIRS, hexCorner, hexKey, hexToWorld, inBounds, spiral, tileIndex } from '../core/hex';
import type { OverlayState } from './index';
import type { CreateOverlayLayer, OverlayLayerApi, RenderContext } from './types';
import { GLSL_OUTPUT, discGeometry, makeCanvas, roundRect, DISPLAY_FONT } from './anim';

const FILL_LIFT = 0.03;
const EDGE_LIFT = 0.045;
const DECAL_LIFT = 0.05;

const COLORS = {
  // pale silver: lightens the reachable ground without turning grass into shallow water
  reach: new THREE.Color('#dce8f2'),
  zoc: new THREE.Color('#ffb04a'),
  edge: new THREE.Color('#e4f0ff'),
  hover: new THREE.Color('#ffffff'),
  path: new THREE.Color('#ffe7a3'),
  pathZoc: new THREE.Color('#ffb04a'),
  select: new THREE.Color('#ffe9a8'),
  attack: new THREE.Color('#ff3b2f'),
  forecast: new THREE.Color('#ff7a2a'),
  aoeOk: new THREE.Color('#5fe07a'),
  aoeHarm: new THREE.Color('#ff8a2a'),
  aoeWarn: new THREE.Color('#ff3d6e'),
  aoeBad: new THREE.Color('#8a6a6a'),
  range: new THREE.Color('#b07cff'),
};

// ───────────────────────────── shaders ─────────────────────────────
function fillMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: COLORS.reach.clone() }, uColor2: { value: COLORS.zoc.clone() }, uTime: { value: 0 },
      uInner: { value: 0.07 }, uOuter: { value: 0.27 }, uAlpha: { value: 1 }, uPulse: { value: 0 }, uRimBoost: { value: 0.6 },
    },
    vertexShader: `
      attribute float aEdge; attribute float aKind;
      varying float vEdge; varying float vKind; varying vec3 vW;
      void main(){
        vEdge = aEdge; vKind = aKind;
        vec4 w = modelMatrix * vec4(position, 1.0);
        vW = w.xyz;
        gl_Position = projectionMatrix * viewMatrix * w;
      }`,
    fragmentShader: `
      uniform vec3 uColor; uniform vec3 uColor2; uniform float uTime; uniform float uInner; uniform float uOuter; uniform float uAlpha; uniform float uPulse; uniform float uRimBoost;
      varying float vEdge; varying float vKind; varying vec3 vW;
      void main(){
        float rim = smoothstep(0.5, 1.0, vEdge);
        float a = mix(uInner, uOuter, rim * rim);
        a *= 1.0 - smoothstep(0.96, 1.0, vEdge) * 0.6;
        vec3 col = mix(uColor, uColor2, step(0.5, vKind));
        if (vKind > 0.5) {
          float stripe = smoothstep(0.35, 0.5, abs(fract((vW.x - vW.z) * 2.6 - uTime * 0.25) - 0.5) * 2.0);
          a *= 0.55 + 0.45 * stripe;
        }
        a *= uAlpha * (1.0 + uPulse * 0.3 * sin(uTime * 3.2));
        gl_FragColor = vec4(col * (1.0 + rim * uRimBoost), a);
        ${GLSL_OUTPUT}
      }`,
    transparent: true, depthWrite: false, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
  });
}

function ribbonMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { uColor: { value: COLORS.edge.clone() }, uTime: { value: 0 }, uAlpha: { value: 0.9 }, uDash: { value: 0 }, uFlow: { value: 0 }, uGlow: { value: 1.3 } },
    vertexShader: `
      attribute float aAcross; attribute float aAlong;
      varying float vAcross; varying float vAlong;
      void main(){ vAcross = aAcross; vAlong = aAlong; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: `
      uniform vec3 uColor; uniform float uTime; uniform float uAlpha; uniform float uDash; uniform float uFlow; uniform float uGlow;
      varying float vAcross; varying float vAlong;
      void main(){
        float core = 1.0 - smoothstep(0.25, 1.0, abs(vAcross));
        float a = core * uAlpha;
        if (uDash > 0.0) a *= smoothstep(0.25, 0.45, abs(fract(vAlong * uDash - uTime * uFlow) - 0.5) * 2.0);
        gl_FragColor = vec4(uColor * uGlow, a);
        ${GLSL_OUTPUT}
      }`,
    transparent: true, depthWrite: false, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3,
  });
}

/** Disc decal: mode 0 selection (rotating dashes), 1 attack target (pulse), 2 forecast (brackets), 3 path end. */
function decalMaterial(color: THREE.Color, mode: number): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { uColor: { value: color.clone() }, uTime: { value: 0 }, uMode: { value: mode }, uAlpha: { value: 1 } },
    vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: `
      uniform vec3 uColor; uniform float uTime; uniform float uMode; uniform float uAlpha; varying vec2 vUv;
      float band(float r, float a, float b, float s){ return smoothstep(a - s, a, r) * (1.0 - smoothstep(b, b + s, r)); }
      void main(){
        vec2 p = vUv * 2.0 - 1.0;
        float r = length(p);
        float ang = atan(p.y, p.x);
        float a = 0.0; float glow = 1.4;
        if (uMode < 0.5) {
          float dash = smoothstep(0.3, 0.45, abs(fract(ang * 1.909859 * 2.0 + uTime * 0.35) - 0.5) * 2.0);
          float pulse = 0.85 + 0.15 * sin(uTime * 4.0);
          a = band(r, 0.8, 0.88, 0.04) * pulse * 0.85 + band(r, 0.92, 0.97, 0.03) * dash * 0.75 + (1.0 - smoothstep(0.0, 0.85, r)) * 0.06;
          glow = 1.1;
        } else if (uMode < 1.5) {
          float pulse = 0.7 + 0.3 * sin(uTime * 6.0);
          a = band(r, 0.76, 0.9, 0.05) * pulse + (1.0 - smoothstep(0.2, 0.9, r)) * 0.14 * pulse;
        } else if (uMode < 2.5) {
          float pulse = 0.85 + 0.15 * sin(uTime * 8.0);
          float brackets = step(0.82, abs(cos(2.0 * (ang + uTime * 0.6)))) ;
          a = band(r, 0.7, 0.84, 0.04) * pulse * 0.9 + band(r, 0.9, 1.0, 0.02) * brackets + (1.0 - smoothstep(0.0, 0.8, r)) * 0.12;
          glow = 1.3;
        } else {
          a = band(r, 0.52, 0.66, 0.06) * (0.8 + 0.2 * sin(uTime * 5.0)) + (1.0 - smoothstep(0.0, 0.4, r)) * 0.5;
        }
        if (a < 0.003) discard;
        gl_FragColor = vec4(uColor * glow, clamp(a, 0.0, 1.0) * uAlpha);
        ${GLSL_OUTPUT}
      }`,
    transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4,
  });
}

function chevronMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { uColor: { value: COLORS.path.clone() }, uTime: { value: 0 }, uAlpha: { value: 1 } },
    vertexShader: `
      attribute vec2 aUv; attribute float aIdx;
      varying vec2 vUv; varying float vIdx;
      void main(){ vUv = aUv; vIdx = aIdx; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: `
      uniform vec3 uColor; uniform float uTime; uniform float uAlpha;
      varying vec2 vUv; varying float vIdx;
      void main(){
        // chevron "V" pointing toward +u
        float target = 0.72 - 0.42 * abs(vUv.y);
        float d = abs(vUv.x - target);
        float m = 1.0 - smoothstep(0.1, 0.2, d);
        m *= 1.0 - smoothstep(0.85, 1.0, abs(vUv.y));
        if (m < 0.01) discard;
        float wave = 0.55 + 0.45 * sin(vIdx * 1.6 - uTime * 7.0);
        gl_FragColor = vec4(uColor * (1.1 + wave * 0.8), m * (0.55 + 0.45 * wave) * uAlpha);
        ${GLSL_OUTPUT}
      }`,
    transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4,
  });
}

// ───────────────────────────── geometry builders ─────────────────────────────
const SUB = 8; // subdivisions per hex edge (fills)

export const createOverlayLayer: CreateOverlayLayer = (ctx: RenderContext): OverlayLayerApi => {
  const root = new THREE.Group();
  root.name = 'overlays';
  ctx.scene.add(root);
  const mats: THREE.Material[] = [];
  const track = <M extends THREE.Material>(m: M) => { mats.push(m); return m; };

  /** Surface height for a point of hex h: water hexes stay flat at the water level. */
  function surface(h: Hex): (x: number, z: number) => number {
    const c = ctx.hexCenter(h);
    const ground = ctx.heightAt(c.x, c.z);
    if (c.y > ground + 0.01) { const wy = c.y; return () => wy; }
    return (x, z) => ctx.heightAt(x, z);
  }

  /**
   * Tinted hex fills. With `region`, the bright rim only runs along edges whose neighbour is outside
   * the region, so the glow outlines the whole area instead of beveling every tile.
   */
  function buildFills(cells: { hex: Hex; kind: number }[], region?: Set<string>): THREE.BufferGeometry {
    const pos: number[] = [], edge: number[] = [], kind: number[] = [], idx: number[] = [];
    // Dense rings so the tint hugs the 0.125 heightfield instead of spanning bumps and hollows
    // (a coarse drape floats over slopes and reads as a raised glassy rim). `aEdge` keeps the old
    // profile: 0 at the centre, 0.6 at r = 0.58, 1 at the rim.
    const RINGS = [0.2, 0.4, 0.58, 0.75, 0.88, 0.95];
    const edgeAt = (r: number) => (r <= 0.58 ? (0.6 * r) / 0.58 : 0.6 + (0.4 * (r - 0.58)) / 0.37);
    // hexCorner(i)..hexCorner(i + 1) is the edge facing DIRS[d] with (6 − d) % 6 === i
    const outerOn = (h: Hex, i: number): boolean => {
      if (!region) return true;
      const d = (6 - i) % 6;
      return !region.has(hexKey({ q: h.q + DIRS[d].q, r: h.r + DIRS[d].r }));
    };
    const N = 6 * SUB;
    for (const cell of cells) {
      const c = hexToWorld(cell.hex);
      const y = surface(cell.hex);
      const base = pos.length / 3;
      pos.push(c.x, y(c.x, c.z) + FILL_LIFT, c.z); edge.push(0); kind.push(cell.kind);
      const on = Array.from({ length: 6 }, (_, i) => outerOn(cell.hex, i));
      for (const r of RINGS) {
        const e = edgeAt(r);
        for (let i = 0; i < 6; i++) {
          const a = hexCorner(i), b = hexCorner((i + 1) % 6);
          for (let s = 0; s < SUB; s++) {
            const t = s / SUB;
            const x = c.x + (a.x + (b.x - a.x) * t) * r, z = c.z + (a.z + (b.z - a.z) * t) * r;
            // a corner vertex (s = 0) belongs to this edge and the previous one; interior edges
            // (neighbour inside the region) stay at the inner value, so only the outline glows
            const lit = on[i] || (s === 0 && on[(i + 5) % 6]);
            pos.push(x, y(x, z) + FILL_LIFT, z); edge.push(lit ? e : Math.min(e, 0.6)); kind.push(cell.kind);
          }
        }
      }
      for (let i = 0; i < N; i++) {
        const a = base + 1 + i, b = base + 1 + ((i + 1) % N);
        idx.push(base, b, a);
      }
      for (let ring = 0; ring + 1 < RINGS.length; ring++) {
        const r0 = base + 1 + ring * N;
        for (let i = 0; i < N; i++) {
          const a = r0 + i, b = r0 + ((i + 1) % N), oa = a + N, ob = b + N;
          idx.push(a, b, ob, a, ob, oa);
        }
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('aEdge', new THREE.Float32BufferAttribute(edge, 1));
    g.setAttribute('aKind', new THREE.Float32BufferAttribute(kind, 1));
    g.setIndex(idx);
    g.computeBoundingSphere();
    return g;
  }

  /** Ribbon along the boundary of a hex set (edges whose neighbour is outside the set). */
  function buildBoundary(hexes: Hex[], width: number, inset = 0.035, all = false): THREE.BufferGeometry {
    const set = new Set(hexes.map(hexKey));
    const pos: number[] = [], across: number[] = [], along: number[] = [], idx: number[] = [];
    for (const h of hexes) {
      const c = hexToWorld(h);
      const y = surface(h);
      for (let d = 0; d < 6; d++) {
        const n = { q: h.q + DIRS[d].q, r: h.r + DIRS[d].r };
        if (!all && set.has(hexKey(n))) continue;
        const ca = hexCorner((6 - d) % 6), cb = hexCorner((7 - d) % 6);
        // inset toward the centre so the line sits inside the region
        const k = 1 - inset;
        const ax = c.x + ca.x * k, az = c.z + ca.z * k, bx = c.x + cb.x * k, bz = c.z + cb.z * k;
        const dx = bx - ax, dz = bz - az;
        const len = Math.hypot(dx, dz);
        const px = (-dz / len) * width * 0.5, pz = (dx / len) * width * 0.5;
        const segs = Math.max(4, Math.ceil(len / 0.1)); // follow the heightfield along the edge
        const base = pos.length / 3;
        for (let s = 0; s <= segs; s++) {
          const t = s / segs;
          const x = ax + dx * t, z = az + dz * t;
          for (const side of [-1, 1]) {
            const vx = x + px * side, vz = z + pz * side;
            pos.push(vx, y(vx, vz) + EDGE_LIFT, vz);
            across.push(side);
            along.push(t * len + (c.x + c.z) * 0.37);
          }
        }
        for (let s = 0; s < segs; s++) {
          const a = base + s * 2;
          idx.push(a, a + 1, a + 3, a, a + 3, a + 2);
        }
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('aAcross', new THREE.Float32BufferAttribute(across, 1));
    g.setAttribute('aAlong', new THREE.Float32BufferAttribute(along, 1));
    g.setIndex(idx);
    g.computeBoundingSphere();
    return g;
  }

  // ───────── components ─────────
  const reachFillMat = track(fillMaterial());
  const reachEdgeMat = track(ribbonMaterial());
  const hoverFillMat = track(fillMaterial());
  const hoverEdgeMat = track(ribbonMaterial());
  const areaFillMat = track(fillMaterial());
  const areaEdgeMat = track(ribbonMaterial());
  const rangeFillMat = track(fillMaterial());
  const rangeEdgeMat = track(ribbonMaterial());
  const chevMat = track(chevronMaterial());
  hoverFillMat.uniforms.uColor.value.copy(COLORS.hover);
  hoverFillMat.uniforms.uInner.value = 0.06; hoverFillMat.uniforms.uOuter.value = 0.06; hoverFillMat.uniforms.uRimBoost.value = 0;
  hoverEdgeMat.uniforms.uColor.value.copy(COLORS.hover); hoverEdgeMat.uniforms.uAlpha.value = 0.5; hoverEdgeMat.uniforms.uGlow.value = 1.0;
  reachEdgeMat.uniforms.uAlpha.value = 0.8;
  reachEdgeMat.uniforms.uGlow.value = 1.0;
  reachFillMat.uniforms.uRimBoost.value = 0;
  reachFillMat.uniforms.uInner.value = 0.06; reachFillMat.uniforms.uOuter.value = 0.14;
  rangeFillMat.uniforms.uColor.value.copy(COLORS.range);
  rangeFillMat.uniforms.uInner.value = 0.025; rangeFillMat.uniforms.uOuter.value = 0.06;
  rangeEdgeMat.uniforms.uColor.value.copy(COLORS.range);
  rangeEdgeMat.uniforms.uDash.value = 3.0; rangeEdgeMat.uniforms.uFlow.value = 0.6; rangeEdgeMat.uniforms.uAlpha.value = 0.95;
  areaFillMat.uniforms.uInner.value = 0.16; areaFillMat.uniforms.uOuter.value = 0.42; areaFillMat.uniforms.uPulse.value = 1;
  areaEdgeMat.uniforms.uAlpha.value = 1;

  const mk = (mat: THREE.Material, order: number) => {
    const m = new THREE.Mesh(new THREE.BufferGeometry(), mat);
    m.renderOrder = order;
    m.frustumCulled = false;
    m.visible = false;
    root.add(m);
    return m;
  };
  const rangeFill = mk(rangeFillMat, 5);
  const reachFill = mk(reachFillMat, 5);
  const areaFill = mk(areaFillMat, 5);
  const hoverFill = mk(hoverFillMat, 5);
  const rangeEdge = mk(rangeEdgeMat, 6);
  const reachEdge = mk(reachEdgeMat, 6);
  const areaEdge = mk(areaEdgeMat, 6);
  const hoverEdge = mk(hoverEdgeMat, 6);
  const chevrons = mk(chevMat, 8);

  interface Decal { mesh: THREE.Mesh; mat: THREE.ShaderMaterial; at: string }
  function makeDecal(color: THREE.Color, mode: number, radius: number): Decal {
    const mat = track(decalMaterial(color, mode));
    const mesh = new THREE.Mesh(discGeometry(radius, 40, 3), mat);
    mesh.renderOrder = 7;
    mesh.frustumCulled = false;
    mesh.visible = false;
    root.add(mesh);
    return { mesh, mat, at: '' };
  }
  function placeDecal(d: Decal, h: Hex | null): void {
    if (!h) { d.mesh.visible = false; d.at = ''; return; }
    const key = hexKey(h);
    d.mesh.visible = true;
    if (d.at === key) return;
    d.at = key;
    const c = hexToWorld(h);
    d.mesh.position.set(c.x, 0, c.z);
    const y = surface(h);
    const pos = d.mesh.geometry.getAttribute('position') as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) pos.setY(i, y(c.x + pos.getX(i), c.z + pos.getZ(i)) + DECAL_LIFT);
    pos.needsUpdate = true;
    d.mesh.geometry.computeBoundingSphere();
  }
  const selectDecal = makeDecal(COLORS.select, 0, 0.66);
  const forecastDecal = makeDecal(COLORS.forecast, 2, 0.72);
  const pathEnd = makeDecal(COLORS.path, 3, 0.5);
  const attackDecals: Decal[] = [];

  // mp-left label
  const labelCache = new Map<string, THREE.CanvasTexture>();
  function labelTex(text: string, warn: boolean): THREE.CanvasTexture {
    const key = `${text}|${warn}`;
    let t = labelCache.get(key);
    if (t) return t;
    const c = makeCanvas(192, 72);
    const g = c.getContext('2d')!;
    g.fillStyle = 'rgba(12,10,8,0.86)';
    roundRect(g, 6, 8, 180, 56, 26);
    g.fill();
    g.lineWidth = 3;
    g.strokeStyle = warn ? '#ffb04a' : '#e8c35a';
    g.stroke();
    // boot glyph
    g.fillStyle = warn ? '#ffb04a' : '#e8c35a';
    g.beginPath();
    g.moveTo(34, 20); g.lineTo(48, 20); g.lineTo(48, 40); g.lineTo(62, 46); g.lineTo(62, 54); g.lineTo(30, 54); g.lineTo(30, 40); g.closePath();
    g.fill();
    g.font = `800 32px ${DISPLAY_FONT}`;
    g.textAlign = 'left';
    g.textBaseline = 'middle';
    g.fillStyle = '#fff6e0';
    g.fillText(text, 74, 38);
    t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    labelCache.set(key, t);
    return t;
  }
  const labelMat = track(new THREE.SpriteMaterial({ transparent: true, depthTest: false, depthWrite: false, fog: false }));
  const label = new THREE.Sprite(labelMat);
  label.renderOrder = 950;
  label.center.set(0.5, 0);
  label.scale.set(0.5, 0.19, 1);
  label.visible = false;
  root.add(label);

  // ───────── state ─────────
  const keys = { reach: '', hover: '', path: '', area: '', range: '', attack: '' };

  function setGeo(m: THREE.Mesh, g: THREE.BufferGeometry | null): void {
    m.geometry.dispose();
    m.geometry = g ?? new THREE.BufferGeometry();
    m.visible = !!g && (g.getIndex()?.count ?? 0) > 0;
  }

  function buildChevrons(points: THREE.Vector3[], hexes: Hex[]): THREE.BufferGeometry | null {
    if (points.length < 2) return null;
    const curve = points.length === 2 ? new THREE.LineCurve3(points[0], points[1]) : new THREE.CatmullRomCurve3(points, false, 'centripetal', 0.5);
    const len = curve.getLength();
    const step = 0.3;
    const n = Math.floor((len - 0.45) / step);
    if (n <= 0) return null;
    const pos: number[] = [], uv: number[] = [], ix: number[] = [], idx: number[] = [];
    const p = new THREE.Vector3(), tan = new THREE.Vector3();
    const hl = 0.11, hw = 0.13;
    // which hex owns a sample (for water-aware draping)
    const surfaces = hexes.map((h) => ({ c: hexToWorld(h), y: surface(h) }));
    const yAt = (x: number, z: number) => {
      let best = surfaces[0], bd = Infinity;
      for (const s of surfaces) { const d = (s.c.x - x) ** 2 + (s.c.z - z) ** 2; if (d < bd) { bd = d; best = s; } }
      return best.y(x, z);
    };
    for (let i = 0; i < n; i++) {
      const u = (0.3 + i * step) / len;
      curve.getPointAt(Math.min(1, u), p);
      curve.getTangentAt(Math.min(1, u), tan);
      tan.y = 0; tan.normalize();
      const sx = -tan.z, sz = tan.x;
      const base = pos.length / 3;
      const corners: [number, number, number, number][] = [[-hl, -hw, 0, -1], [hl, -hw, 1, -1], [hl, hw, 1, 1], [-hl, hw, 0, 1]];
      for (const [a, b, uu, vv] of corners) {
        const x = p.x + tan.x * a + sx * b, z = p.z + tan.z * a + sz * b;
        pos.push(x, yAt(x, z) + EDGE_LIFT + 0.01, z);
        uv.push(uu, vv);
        ix.push(i);
      }
      idx.push(base, base + 2, base + 1, base, base + 3, base + 2);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('aUv', new THREE.Float32BufferAttribute(uv, 2));
    g.setAttribute('aIdx', new THREE.Float32BufferAttribute(ix, 1));
    g.setIndex(idx);
    g.computeBoundingSphere();
    return g;
  }

  function set(o: OverlayState, state: GameState | null): void {
    if (!state) {
      for (const m of [rangeFill, reachFill, areaFill, hoverFill, rangeEdge, reachEdge, areaEdge, hoverEdge, chevrons]) setGeo(m, null);
      for (const k of Object.keys(keys) as (keyof typeof keys)[]) keys[k] = '';
      placeDecal(selectDecal, null); placeDecal(forecastDecal, null); placeDecal(pathEnd, null);
      for (const d of attackDecals) placeDecal(d, null);
      label.visible = false;
      return;
    }
    const unitPos = (id: UnitId | null): Hex | null => (id === null ? null : state.units[String(id)]?.pos ?? null);
    const selPos = unitPos(o.selectedUnit);

    // movement range
    const reach = o.reach ?? [];
    const reachKey = reach.map((r) => `${r.hex.q},${r.hex.r},${r.zocStop ? 1 : 0}`).join(';');
    if (reachKey !== keys.reach) {
      keys.reach = reachKey;
      if (reach.length) {
        const cells = reach.map((r) => ({ hex: r.hex, kind: r.zocStop ? 1 : 0 }));
        const region = reach.map((r) => r.hex);
        if (selPos && !region.some((h) => h.q === selPos.q && h.r === selPos.r)) region.push(selPos);
        setGeo(reachFill, buildFills(cells, new Set(region.map(hexKey))));
        setGeo(reachEdge, buildBoundary(region, 0.05));
      } else { setGeo(reachFill, null); setGeo(reachEdge, null); }
    }

    // hover outline: land hexes are outlined by the terrain shader (world.ts → uHoverHex), which
    // hugs the heightfield at a constant screen width; a coarse draped mesh would stand up as a
    // glassy wall on slopes. Only flat water hexes (drawn over by the water plane) use a mesh.
    const hk = o.hoverHex ? hexKey(o.hoverHex) : '';
    if (hk !== keys.hover) {
      keys.hover = hk;
      const h = o.hoverHex;
      const water = !!h && inBounds(h, state.width, state.height) && ['water', 'shallows'].includes(state.tiles[tileIndex(h, state.width)].terrain);
      if (h && water) {
        setGeo(hoverFill, buildFills([{ hex: h, kind: 0 }]));
        setGeo(hoverEdge, buildBoundary([h], 0.04, 0.03, true));
      } else { setGeo(hoverFill, null); setGeo(hoverEdge, null); }
    }

    // path preview
    const path = o.path ?? [];
    const pk = `${selPos ? hexKey(selPos) : ''}>${path.map(hexKey).join(';')}`;
    if (pk !== keys.path) {
      keys.path = pk;
      const hexes: Hex[] = [];
      if (selPos && (!path.length || path[0].q !== selPos.q || path[0].r !== selPos.r)) hexes.push(selPos);
      hexes.push(...path);
      if (hexes.length >= 2) {
        const pts = hexes.map((h) => { const w = hexToWorld(h); return new THREE.Vector3(w.x, 0, w.z); });
        setGeo(chevrons, buildChevrons(pts, hexes));
        const end = hexes[hexes.length - 1];
        const info: ReachInfo | undefined = reach.find((r) => r.hex.q === end.q && r.hex.r === end.r);
        const zoc = !!info?.zocStop;
        placeDecal(pathEnd, end);
        pathEnd.mat.uniforms.uColor.value.copy(zoc ? COLORS.pathZoc : COLORS.path);
        chevMat.uniforms.uColor.value.copy(zoc ? COLORS.pathZoc : COLORS.path);
        if (info) {
          labelMat.map = labelTex(zoc ? `${info.mpLeft} ZoC` : `${info.mpLeft} MP`, zoc);
          labelMat.needsUpdate = true;
          const c = ctx.hexCenter(end);
          label.position.set(c.x, Math.max(c.y, ctx.heightAt(c.x, c.z)) + 0.42, c.z);
          label.scale.set(zoc ? 0.6 : 0.5, (zoc ? 0.6 : 0.5) * (72 / 192), 1);
          label.visible = true;
        } else label.visible = false;
      } else {
        setGeo(chevrons, null);
        placeDecal(pathEnd, null);
        label.visible = false;
      }
    }

    // selection
    placeDecal(selectDecal, selPos);

    // attack targets
    const targets = (o.attackable ?? []).map((id) => unitPos(id)).filter((h): h is Hex => !!h);
    const ak = targets.map(hexKey).join(';');
    if (ak !== keys.attack) {
      keys.attack = ak;
      while (attackDecals.length < targets.length) attackDecals.push(makeDecal(COLORS.attack, 1, 0.62));
      attackDecals.forEach((d, i) => placeDecal(d, targets[i] ?? null));
    }
    const fPos = unitPos(o.forecastTarget);
    placeDecal(forecastDecal, fPos);

    // AoE preview
    const ak2 = o.areaCenter ? `${hexKey(o.areaCenter)}|${o.areaRadius}|${o.areaValid}|${o.areaTone ?? 'help'}` : '';
    if (ak2 !== keys.area) {
      keys.area = ak2;
      if (o.areaCenter) {
        const hexes = spiral(o.areaCenter, Math.max(0, o.areaRadius | 0)).filter((h) => inBounds(h, state.width, state.height));
        // Invalid: a dim grey-red, clearly unlike the fiery colour of a harmful (but valid) blast.
        const col = !o.areaValid ? COLORS.aoeBad : o.areaTone === 'harm' ? COLORS.aoeHarm : o.areaTone === 'warn' ? COLORS.aoeWarn : COLORS.aoeOk;
        areaFillMat.uniforms.uColor.value.copy(col);
        areaEdgeMat.uniforms.uColor.value.copy(col);
        areaFillMat.uniforms.uAlpha.value = o.areaValid ? 1 : 0.55;
        setGeo(areaFill, buildFills(hexes.map((h) => ({ hex: h, kind: 0 })), new Set(hexes.map(hexKey))));
        setGeo(areaEdge, buildBoundary(hexes, 0.08));
      } else { setGeo(areaFill, null); setGeo(areaEdge, null); }
    }

    // spell range of towers
    const ranges = o.spellRanges ?? [];
    const rk = ranges.map((t) => `${hexKey(t.pos)}:${t.range}`).join(';');
    if (rk !== keys.range) {
      keys.range = rk;
      const set = new Map<string, Hex>();
      for (const t of ranges) {
        if (t.range > 0) for (const h of spiral(t.pos, t.range)) if (inBounds(h, state.width, state.height)) set.set(hexKey(h), h);
      }
      const hexes = [...set.values()];
      if (hexes.length) {
        setGeo(rangeFill, buildFills(hexes.map((h) => ({ hex: h, kind: 0 })), new Set(hexes.map(hexKey))));
        setGeo(rangeEdge, buildBoundary(hexes, 0.08, 0.02));
      } else { setGeo(rangeFill, null); setGeo(rangeEdge, null); }
    }
  }

  function update(dt: number): void {
    const t = ctx.time;
    for (const m of mats) {
      const u = (m as THREE.ShaderMaterial).uniforms;
      if (u?.uTime) u.uTime.value = t;
    }
    void dt;
  }

  function dispose(): void {
    for (const m of [rangeFill, reachFill, areaFill, hoverFill, rangeEdge, reachEdge, areaEdge, hoverEdge, chevrons]) m.geometry.dispose();
    for (const d of [selectDecal, forecastDecal, pathEnd, ...attackDecals]) d.mesh.geometry.dispose();
    for (const m of mats) m.dispose();
    for (const t of labelCache.values()) t.dispose();
    labelCache.clear();
    ctx.scene.remove(root);
  }

  return { set, update, dispose };
};
