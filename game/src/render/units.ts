// Unit visuals: rigged GLBs per race×body, equipment on hand bones, animations, team ring, HP bar.
// Falls back to procedural rigs (render/procedural.ts) for any model the manifest lacks.
import * as THREE from 'three';
import { clone as skeletonClone } from 'three/addons/utils/SkeletonUtils.js';
import type { AttackKind, BodyVariant, FactionId, GameState, Hex, ItemId, MonsterKind, RaceId, StrikeEvent, Unit, UnitId } from '../core/types';
import { hexToWorld, inBounds, tileIndex, worldToHex } from '../core/hex';
import { FACTIONS } from '../data/factions';
import { ITEMS } from '../data/items';
import { bodyVariant, effectiveStats } from '../sim/units';
import { DEFAULT_RUN_SPEED, DEFAULT_WALK_SPEED, FOOT_SPEED, UNIT_HEIGHT, walkTimeScale } from './types';
import type { CreateUnitLayer, FxLayerApi, RenderContext, UnitLayerApi } from './types';
import {
  Scheduler, GLSL_OUTPUT, bump, clamp, clamp01, damp, dampAngle, discGeometry, drapeGeometry, easeInQuad, easeOutBack, easeOutCubic,
  disposeSkeletons, easeOutQuad, headingTo, lerp, makeCanvas, normSpeed, roundRect, smoothstep, trapezoidProfile, DISPLAY_FONT, UI_FONT,
} from './anim';
import { rayCylinder } from './pick';
import {
  CLIP_IMPACT, MELEE_IMPACT, MOUNT_COATS, RACE_GLOW, animateMonster, animateQuadruped, createHumanoid, createMonster, createPaletteMaterial,
  createQuadruped, humanoidClips, itemModel, monsterPalette, softDotTexture, unitPalette,
  type ClipStyle, type MonsterRig, type MountKind, type PaletteMaterial, type QuadrupedRig,
} from './procedural';
import { hasFxExtras } from './fx';

// ───────────────────────────── helpers ─────────────────────────────
const sanitize = (n: string) => THREE.PropertyBinding.sanitizeNodeName(n);
/** GLTFLoader strips dots from node names ('grip.R' → 'gripR'): look both up. */
function findNode(root: THREE.Object3D, name: string): THREE.Object3D | null {
  return root.getObjectByName(name) ?? root.getObjectByName(sanitize(name)) ?? null;
}
function hashId(id: number): number {
  let h = (id * 2654435761) >>> 0;
  h ^= h >>> 15; h = Math.imul(h, 2246822519) >>> 0; h ^= h >>> 13;
  return h >>> 0;
}
const MONSTER_HEIGHT: Record<MonsterKind, number> = { wolf: 0.72, spider: 0.56, golem: 1.25, elemental: 1.3 };
/** Standing distance from the hex centre when the hex holds a building nobody measured. */
const ON_BUILDING_OFFSET = 0.42;
/** Farthest a unit stands from its hex centre (the corner toward the camera is at 1.0). */
const ON_BUILDING_MAX = 0.78;
/** Half-width (world) of a unit's body seen from the camera, used to stand it clear of a building. */
const STAND_HALF_WIDTH: Record<MonsterKind | 'foot' | 'mounted', number> = { foot: 0.14, mounted: 0.26, wolf: 0.2, spider: 0.28, golem: 0.32, elemental: 0.32 };
/**
 * Height (world) of a mounted unit's status bar: above the rider's head in the riding pose (a GLB
 * ride clip lowers the hips by `standDrop` below a standing rider's) or the mount's own top.
 * `riderY`, `standDrop` and `mountTop` are in unit space (1 = one unit height).
 */
export function mountedTopY(riderY: number, standDrop: number, mountTop: number): number {
  return Math.max(riderY - standDrop + 1.02, mountTop) * UNIT_HEIGHT + 0.08;
}
/** Farthest a unit stands toward a hex edge midpoint (the edge is at 0.866). */
const ON_BUILDING_MAX_EDGE = 0.7;
/**
 * Where a unit stands on a building hex. `front(j)`: how far the building reaches toward direction
 * j (0..11, at 30j−30° in x/z: even j = hex corners, odd j = edge midpoints; null = unmeasured).
 * `facing`: the hex corner (0..5) toward the camera. The camera-facing corner wins when the unit
 * fits in front of the building there; else the nearest direction (within ±60°) where it does, so
 * a unit is not swallowed by a building that fills its hex toward the camera (a castle's gate
 * towers); when none fits, the one with the most room.
 */
export function chooseStandSpot(front: (j: number) => number | null, facing: number, halfWidth: number): { dir: number; d: number } {
  let best: { dir: number; d: number; room: number } | null = null;
  for (const off of [0, -1, 1, -2, 2]) {
    const j = (((2 * facing + off) % 12) + 12) % 12;
    const cap = j % 2 === 0 ? ON_BUILDING_MAX : ON_BUILDING_MAX_EDGE;
    const need = Math.max(ON_BUILDING_OFFSET, (front(j) ?? ON_BUILDING_OFFSET) + halfWidth + 0.04);
    if (need <= cap) return { dir: j, d: need };
    // corner directions keep a little preference when nothing fits
    const room = cap - need + (off === 0 ? 0.05 : 0);
    if (!best || room > best.room) best = { dir: j, d: cap, room };
  }
  return { dir: best!.dir, d: best!.d };
}
/** Unit vector (x, z) toward direction j (0..11) of chooseStandSpot. */
export function standDir(j: number): { x: number; z: number } {
  const a = (j * Math.PI) / 6 - Math.PI / 6;
  return { x: Math.cos(a), z: Math.sin(a) };
}
/** Hex corner sector (0..5, corner k at 60k−30° in x/z) a direction (x, z) points at. */
export function cornerSector(x: number, z: number): number {
  const a = Math.atan2(z, x);
  return (((Math.round((a + Math.PI / 6) / (Math.PI / 3)) % 6) + 6) % 6);
}
/** Unit vector (x, z) toward corner `k`. */
export function cornerDir(k: number): { x: number; z: number } {
  const a = (k * Math.PI) / 3 - Math.PI / 6;
  return { x: Math.cos(a), z: Math.sin(a) };
}
const MONSTER_HALF_WIDTH: Record<MonsterKind, number> = { wolf: 0.16, spider: 0.3, golem: 0.32, elemental: 0.32 };
const MOUNT_FOR: Record<string, MountKind> = { human: 'horse', orc: 'wolf', undead: 'nightmare' };
const DEFAULT_SADDLE: Record<MountKind, [number, number, number]> = { horse: [0, 0.75, -0.03], wolf: [0, 0.64, -0.04], nightmare: [0, 0.75, -0.03] };
const TRINKET_COLOR: Partial<Record<ItemId, string>> = { amulet: '#ff4d5e', ring: '#79b6ff' };
/** Procedural walk cycles were tuned to look right at 1.5× while moving 2 u/s: keep that stride ratio. */
const PROCEDURAL_WALK_RATE = (1.5 * FOOT_SPEED) / 2.0;

/**
 * The clip a GLB rider sitting on a mount plays instead of `clip`. Only the ride_* clips lower the
 * root so the seat is at the origin (blender/README); every other clip stands on its feet and would
 * lift the rider out of the saddle. null: no seated version (hit / death are handled by transforms).
 */
export function seatedClip(clip: string): string | null {
  if (clip === 'ride_idle' || clip === 'ride_attack') return clip;
  if (clip === 'attack_melee' || clip === 'attack_ranged' || clip === 'cast') return 'ride_attack';
  if (clip === 'hit' || clip === 'death') return null;
  return 'ride_idle'; // work, idle, walk…: stay seated
}

/** Body armour that has its own rigged body (`<race>_padded`) while the sim still calls it 'commoner'. */
const PADDED_ITEM: ItemId = 'tunic';
/**
 * Rigged GLB keys a unit's body may use, best first: a commoner in the padded tunic wears the
 * '<race>_padded' model once it ships, else the plain commoner body.
 */
export function unitBodyKeys(race: RaceId, body: BodyVariant, bodyItem: ItemId | null | undefined): string[] {
  const keys: string[] = [];
  if (body === 'commoner' && bodyItem === PADDED_ITEM) keys.push(`${race}_padded`);
  keys.push(`${race}_${body}`);
  return keys;
}
/** First of `keys` the asset library has (null: none, use the procedural body). */
export function firstAvailable(keys: string[], has: (key: string) => boolean): string | null {
  for (const k of keys) if (has(k)) return k;
  return null;
}

function safeBody(u: Unit): BodyVariant {
  try { return bodyVariant(u); } catch {
    if (u.isLeader) return 'leader';
    const b = u.equipment.body ? ITEMS[u.equipment.body]?.body : undefined;
    return b ?? 'commoner';
  }
}
function safeMaxHp(state: GameState, u: Unit): number {
  try { return Math.max(1, effectiveStats(state, u).maxHp); } catch {
    let hp = u.base.maxHp;
    for (const it of Object.values(u.equipment)) if (it) hp += ITEMS[it as ItemId]?.stats?.maxHp ?? 0;
    return Math.max(1, hp);
  }
}

interface Attachment { obj: THREE.Object3D; tip: THREE.Object3D; glow: THREE.Sprite | null }
interface StatusData { hp: number; maxHp: number; level: number; leader: boolean; poisoned: boolean; pending: number; buffs: string[]; summon: number | null }

interface UnitView {
  id: UnitId;
  faction: FactionId;
  race: RaceId;
  monster: MonsterKind | null;
  equipment: Unit['equipment'];
  pos: Hex;
  sig: string;
  root: THREE.Group;
  body: THREE.Group;
  unitSpace: THREE.Group;
  rider: THREE.Group;
  model: THREE.Object3D | null;
  procedural: boolean;
  mixer: THREE.AnimationMixer | null;
  clips: Map<string, THREE.AnimationClip>;
  actions: Map<string, THREE.AnimationAction>;
  current: THREE.AnimationAction | null;
  currentName: string;
  style: ClipStyle | null;
  material: PaletteMaterial;
  glbMats: THREE.Material[];
  mount: { obj: THREE.Object3D; rig: QuadrupedRig | null; kind: MountKind } | null;
  monsterRig: MonsterRig | null;
  mainItem: Attachment | null;
  offItem: Attachment | null;
  trinket: { obj: THREE.Object3D; glow: THREE.Sprite } | null;
  gripR: THREE.Object3D | null;
  gripL: THREE.Object3D | null;
  chest: THREE.Object3D | null;
  ring: THREE.Mesh;
  ringMat: THREE.ShaderMaterial;
  ringAt: THREE.Vector3;
  bar: THREE.Sprite;
  barCanvas: HTMLCanvasElement;
  barTex: THREE.CanvasTexture;
  barKey: string;
  /** Far-zoom strategic marker (created on first need). */
  marker: { sprite: THREE.Sprite; canvas: HTMLCanvasElement; tex: THREE.CanvasTexture; key: string } | null;
  /** Faction-coloured silhouettes drawn only where the body is hidden behind terrain / buildings / props. */
  xrays: THREE.Mesh[];
  /** Readability uniforms of the GLB body / mount materials (rim strength scaled by dissolve). */
  reads: { uRim: { value: number }; base: number }[];
  status: StatusData;
  dispHp: number;
  heading: number;
  targetHeading: number;
  offset: THREE.Vector3;          // lunge / dodge / knockback (world XZ)
  lift: number;                   // vertical offset (spawn / death sink)
  moving: number;                 // gait blend 0..1
  movingTarget: number;
  busy: number;
  dying: boolean;
  seed: number;
  timeScale: number;
  flash: number;
  topY: number;                   // bar height above ground (world)
  pickTop: number;                // top of the clickable volume (bar / marker included)
  pickR: number;                  // radius of the clickable bar / marker volume
  chestY: number;                 // fallback anchor height
  mountTop: number;
  riderBaseY: number;
  /** GLB riders: how much higher the hips sit in a standing clip than in ride_idle (unit space). */
  standDrop: number;
  /** GLB walkers: planted-foot speed of the walk cycle (model heights/s at timeScale 1); 0 = procedural. */
  walkSpeed: number;
  /** Planted-foot speed of the GLB `run` clip (0: no run clip, walk instead). */
  runSpeed: number;
  /** Locomotion clip of the move in flight. */
  gait: 'walk' | 'run';
  /** While walking: exact walk-cycle timeScale (feet planted), overriding the per-unit variation; 0 = none. */
  walkRate: number;
  playToken: number;              // invalidates pending "back to loop" timers when a clip is replayed
  animT: number;                  // private clock for transform animations
  monsterPose: { tilt: number; pitch: number; hop: number; armSwing: number };
}

// ───────────────────────────── ring material ─────────────────────────────
function makeRingMaterial(color: THREE.Color, accent: THREE.Color, leader: boolean): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: color.clone() }, uAccent: { value: accent.clone() }, uLeader: { value: leader ? 1 : 0 },
      uTime: { value: 0 }, uAlpha: { value: 1 },
    },
    vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: `
      uniform vec3 uColor; uniform vec3 uAccent; uniform float uLeader; uniform float uTime; uniform float uAlpha;
      varying vec2 vUv;
      void main(){
        vec2 p = vUv * 2.0 - 1.0;
        float r = length(p);
        float ring = smoothstep(0.66, 0.76, r) * (1.0 - smoothstep(0.79, 0.9, r));
        float inner = (1.0 - smoothstep(0.2, 0.78, r)) * 0.1;
        float pulse = 0.9 + 0.1 * sin(uTime * 2.2);
        vec3 col = uColor * (ring * 0.95 * pulse + inner);
        float a = ring * 0.48 * pulse + inner;
        if (uLeader > 0.5) {
          float ang = atan(p.y, p.x);
          float dash = smoothstep(0.35, 0.5, abs(fract(ang * 1.909859 + uTime * 0.12) - 0.5) * 2.0);
          float outer = smoothstep(0.9, 0.94, r) * (1.0 - smoothstep(0.96, 1.0, r)) * dash;
          col += uAccent * outer * 1.6;
          a += outer;
        }
        gl_FragColor = vec4(col, a * uAlpha);
        ${GLSL_OUTPUT}
      }`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3,
  });
}

// ───────────────────────────── status bar drawing ─────────────────────────────
const BAR_W = 256, BAR_H = 84;
const BAR_WORLD_W = 0.6;
function drawCrown(g: CanvasRenderingContext2D, x: number, y: number, s: number): void {
  g.save();
  g.translate(x, y);
  g.fillStyle = '#f3c845';
  g.strokeStyle = '#3a2706';
  g.lineWidth = 2.5;
  g.beginPath();
  g.moveTo(-s, s * 0.6); g.lineTo(-s, -s * 0.25); g.lineTo(-s * 0.5, s * 0.15); g.lineTo(0, -s * 0.65);
  g.lineTo(s * 0.5, s * 0.15); g.lineTo(s, -s * 0.25); g.lineTo(s, s * 0.6); g.closePath();
  g.fill(); g.stroke();
  g.fillStyle = '#e8473c';
  g.beginPath(); g.arc(0, s * 0.25, s * 0.18, 0, Math.PI * 2); g.fill();
  g.restore();
}
function drawStar(g: CanvasRenderingContext2D, x: number, y: number, s: number): void {
  g.save();
  g.translate(x, y);
  g.shadowColor = '#ffd84a';
  g.shadowBlur = 10;
  g.fillStyle = '#ffe27a';
  g.strokeStyle = '#5a3a00';
  g.lineWidth = 2;
  g.beginPath();
  for (let i = 0; i < 10; i++) {
    const r = i % 2 === 0 ? s : s * 0.45;
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    if (i === 0) g.moveTo(Math.cos(a) * r, Math.sin(a) * r); else g.lineTo(Math.cos(a) * r, Math.sin(a) * r);
  }
  g.closePath();
  g.fill();
  g.shadowBlur = 0;
  g.stroke();
  g.restore();
}
function drawDrop(g: CanvasRenderingContext2D, x: number, y: number, s: number): void {
  g.save();
  g.translate(x, y);
  g.fillStyle = '#6fdc4f';
  g.strokeStyle = '#123a08';
  g.lineWidth = 2.5;
  g.beginPath();
  g.moveTo(0, -s);
  g.bezierCurveTo(s * 0.9, -s * 0.1, s * 0.75, s * 0.8, 0, s * 0.8);
  g.bezierCurveTo(-s * 0.75, s * 0.8, -s * 0.9, -s * 0.1, 0, -s);
  g.fill(); g.stroke();
  g.fillStyle = 'rgba(255,255,255,0.6)';
  g.beginPath(); g.arc(-s * 0.25, s * 0.15, s * 0.16, 0, Math.PI * 2); g.fill();
  g.restore();
}
function drawBuff(g: CanvasRenderingContext2D, kind: string, x: number, y: number, s: number): void {
  g.save();
  g.translate(x, y);
  g.lineWidth = 2.5;
  g.strokeStyle = '#1a1206';
  if (kind === 'bless') {
    g.fillStyle = '#ffd76a';
    for (let i = 0; i < 8; i++) {
      g.save(); g.rotate((i * Math.PI) / 4);
      g.fillRect(-1.5, -s, 3, s * 0.45);
      g.restore();
    }
    g.beginPath(); g.arc(0, 0, s * 0.45, 0, Math.PI * 2); g.fill(); g.stroke();
  } else if (kind === 'fortify') {
    g.fillStyle = '#9fb6d6';
    g.beginPath();
    g.moveTo(0, -s); g.lineTo(s * 0.85, -s * 0.6); g.lineTo(s * 0.7, s * 0.3); g.lineTo(0, s); g.lineTo(-s * 0.7, s * 0.3); g.lineTo(-s * 0.85, -s * 0.6); g.closePath();
    g.fill(); g.stroke();
  } else if (kind === 'haste') {
    g.fillStyle = '#7fd2ff';
    g.beginPath();
    g.moveTo(s * 0.2, -s); g.lineTo(-s * 0.6, s * 0.15); g.lineTo(-s * 0.05, s * 0.15); g.lineTo(-s * 0.3, s); g.lineTo(s * 0.65, -s * 0.2); g.lineTo(s * 0.05, -s * 0.2); g.closePath();
    g.fill(); g.stroke();
  } else if (kind === 'powerstrike') {
    g.fillStyle = '#ff8a5a';
    g.beginPath(); g.moveTo(0, -s); g.lineTo(s * 0.3, s * 0.6); g.lineTo(0, s * 0.3); g.lineTo(-s * 0.3, s * 0.6); g.closePath(); g.fill(); g.stroke();
  } else if (kind === 'farsight') {
    g.fillStyle = '#8fe9ff';
    g.beginPath(); g.ellipse(0, 0, s, s * 0.55, 0, 0, Math.PI * 2); g.fill(); g.stroke();
    g.fillStyle = '#06222c'; g.beginPath(); g.arc(0, 0, s * 0.3, 0, Math.PI * 2); g.fill();
  }
  g.restore();
}
function drawHourglass(g: CanvasRenderingContext2D, x: number, y: number, s: number, n: number): void {
  g.save();
  g.translate(x, y);
  g.fillStyle = '#ffb347';
  g.strokeStyle = '#2a1600';
  g.lineWidth = 2;
  g.beginPath(); g.moveTo(-s * 0.6, -s); g.lineTo(s * 0.6, -s); g.lineTo(0, 0); g.lineTo(s * 0.6, s); g.lineTo(-s * 0.6, s); g.lineTo(0, 0); g.closePath();
  g.fill(); g.stroke();
  g.font = `700 ${Math.round(s * 1.5)}px ${UI_FONT}`;
  g.textBaseline = 'middle';
  g.lineWidth = 4;
  g.strokeStyle = 'rgba(0,0,0,0.9)';
  g.strokeText(String(n), s * 0.9, 1);
  g.fillStyle = '#ffe3b0';
  g.fillText(String(n), s * 0.9, 1);
  g.restore();
}

function drawBar(c: HTMLCanvasElement, s: StatusData, color: string, accent: string): void {
  const g = c.getContext('2d')!;
  g.clearRect(0, 0, BAR_W, BAR_H);
  // pips row
  let px = 80;
  const py = 17;
  if (s.leader) { drawCrown(g, px, py, 13); px += 32; }
  if (s.pending > 0) { drawStar(g, px, py, 14); px += 32; }
  if (s.poisoned) { drawDrop(g, px, py + 1, 12); px += 28; }
  for (const b of s.buffs) { drawBuff(g, b, px, py, 11); px += 28; }
  if (s.summon !== null) { drawHourglass(g, px, py, 10, s.summon); px += 40; }
  // hp bar
  const x0 = 66, y0 = 40, w = 182, h = 24;
  g.fillStyle = 'rgba(6,5,4,0.82)';
  roundRect(g, x0 - 3, y0 - 3, w + 6, h + 6, 9);
  g.fill();
  const frac = clamp01(s.hp / Math.max(1, s.maxHp));
  const fill = frac > 0.6 ? ['#8df06a', '#3fae3a'] : frac > 0.3 ? ['#ffe06a', '#d39a1c'] : ['#ff7a5a', '#c42a1e'];
  if (frac > 0) {
    const gr = g.createLinearGradient(0, y0, 0, y0 + h);
    gr.addColorStop(0, fill[0]);
    gr.addColorStop(1, fill[1]);
    g.fillStyle = gr;
    roundRect(g, x0, y0, Math.max(8, w * frac), h, 6);
    g.fill();
    g.fillStyle = 'rgba(255,255,255,0.22)';
    roundRect(g, x0 + 2, y0 + 2, Math.max(4, w * frac - 4), h * 0.36, 4);
    g.fill();
  }
  // tick marks every 10 hp
  g.fillStyle = 'rgba(0,0,0,0.35)';
  for (let hp = 10; hp < s.maxHp; hp += 10) {
    const x = x0 + (w * hp) / s.maxHp;
    g.fillRect(Math.round(x) - 1, y0 + 3, 2, h - 6);
  }
  // faction stripe
  g.fillStyle = color;
  g.fillRect(x0, y0 + h + 1, w, 3);
  // hp text
  g.font = `700 19px ${UI_FONT}`;
  g.textAlign = 'right';
  g.textBaseline = 'middle';
  g.lineWidth = 4;
  g.strokeStyle = 'rgba(0,0,0,0.85)';
  const txt = `${Math.max(0, Math.round(s.hp))}/${s.maxHp}`;
  g.strokeText(txt, x0 + w - 6, y0 + h / 2 + 1);
  g.fillStyle = '#ffffff';
  g.fillText(txt, x0 + w - 6, y0 + h / 2 + 1);
  // level badge
  const cx = 36, cy = 52, r = 27;
  const bg = g.createRadialGradient(cx - 8, cy - 10, 4, cx, cy, r);
  const base = new THREE.Color(color);
  bg.addColorStop(0, `#${base.clone().lerp(new THREE.Color('#ffffff'), 0.35).getHexString()}`);
  bg.addColorStop(1, `#${base.clone().multiplyScalar(0.55).getHexString()}`);
  g.fillStyle = bg;
  g.beginPath(); g.arc(cx, cy, r, 0, Math.PI * 2); g.fill();
  g.lineWidth = 4;
  g.strokeStyle = s.pending > 0 ? '#ffe27a' : accent;
  g.stroke();
  g.lineWidth = 2;
  g.strokeStyle = 'rgba(0,0,0,0.8)';
  g.beginPath(); g.arc(cx, cy, r + 2.5, 0, Math.PI * 2); g.stroke();
  g.font = `900 30px ${DISPLAY_FONT}`;
  g.textAlign = 'center';
  g.lineWidth = 5;
  g.strokeStyle = 'rgba(0,0,0,0.85)';
  g.strokeText(String(s.level), cx, cy + 2);
  g.fillStyle = '#fff8e8';
  g.fillText(String(s.level), cx, cy + 2);
}

// ───────────────────────────── far-zoom marker ─────────────────────────────
const MARK_W = 96, MARK_H = 124;
/** Screen height (CSS px) of the strategic marker shown when zoomed far out. */
const MARKER_PX = 28;
function drawMarker(c: HTMLCanvasElement, color: string, accent: string, level: number, leader: boolean, hpFrac: number): void {
  const g = c.getContext('2d')!;
  g.clearRect(0, 0, MARK_W, MARK_H);
  const top = leader ? 26 : 8;
  // shield
  const x0 = 10, x1 = MARK_W - 10, y0 = top, y1 = MARK_H - 22;
  const shield = () => {
    g.beginPath();
    g.moveTo(x0, y0);
    g.lineTo(x1, y0);
    g.lineTo(x1, y0 + (y1 - y0) * 0.45);
    g.quadraticCurveTo(x1, y1 - 10, MARK_W / 2, y1);
    g.quadraticCurveTo(x0, y1 - 10, x0, y0 + (y1 - y0) * 0.45);
    g.closePath();
  };
  const base = new THREE.Color(color);
  const gr = g.createLinearGradient(0, y0, 0, y1);
  gr.addColorStop(0, `#${base.clone().lerp(new THREE.Color('#ffffff'), 0.3).getHexString()}`);
  gr.addColorStop(1, `#${base.clone().multiplyScalar(0.55).getHexString()}`);
  shield();
  g.fillStyle = gr;
  g.fill();
  g.lineWidth = 7;
  g.strokeStyle = 'rgba(0,0,0,0.9)';
  g.stroke();
  g.lineWidth = 4;
  g.strokeStyle = accent;
  g.stroke();
  // level
  g.font = `900 44px ${DISPLAY_FONT}`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.lineWidth = 6;
  g.strokeStyle = 'rgba(0,0,0,0.85)';
  const ty = y0 + (y1 - y0) * 0.45;
  g.strokeText(String(level), MARK_W / 2, ty);
  g.fillStyle = '#fff8e8';
  g.fillText(String(level), MARK_W / 2, ty);
  if (leader) drawCrown(g, MARK_W / 2, 16, 15);
  // hp strip
  const hx = 12, hy = MARK_H - 14, hw = MARK_W - 24, hh = 11;
  g.fillStyle = 'rgba(6,5,4,0.88)';
  roundRect(g, hx - 2, hy - 2, hw + 4, hh + 4, 5);
  g.fill();
  const f = clamp01(hpFrac);
  if (f > 0) {
    g.fillStyle = f > 0.6 ? '#6fdc4f' : f > 0.3 ? '#f0c43a' : '#e8473c';
    roundRect(g, hx, hy, Math.max(4, hw * f), hh, 4);
    g.fill();
  }
}

// ───────────────────────────── the layer ─────────────────────────────
export const createUnitLayer: CreateUnitLayer = (ctx: RenderContext, fx: FxLayerApi): UnitLayerApi => {
  const root = new THREE.Group();
  root.name = 'units';
  ctx.scene.add(root);
  const ringGroup = new THREE.Group();
  ringGroup.name = 'unit-rings';
  ctx.scene.add(ringGroup);
  const sched = new Scheduler();
  const views = new Map<UnitId, UnitView>();
  let lastState: GameState | null = null;
  let visibleFn: (h: Hex) => boolean = () => true;
  const ext = hasFxExtras(fx) ? fx : null;
  const gemGeo = new THREE.OctahedronGeometry(0.022);
  const gemMats = new Map<string, THREE.MeshStandardMaterial>();
  const frustum = new THREE.Frustum();
  const projScreen = new THREE.Matrix4();
  const tmpV = new THREE.Vector3();
  const tmpV2 = new THREE.Vector3();
  const sphere = new THREE.Sphere();

  const groundY = (x: number, z: number) => ctx.heightAt(x, z);
  /** Hex corner sector facing the camera (units on buildings stand on that side). */
  let sector = 2;
  const camFwd = new THREE.Vector3();
  const refreshSector = (): boolean => {
    ctx.camera.getWorldDirection(camFwd);
    if (camFwd.x * camFwd.x + camFwd.z * camFwd.z < 1e-8) return false;
    const k = cornerSector(-camFwd.x, -camFwd.z);
    if (k === sector) return false;
    sector = k;
    return true;
  };
  const halfWidthOf = (v: UnitView | undefined): number =>
    !v ? STAND_HALF_WIDTH.foot : v.monster ? STAND_HALF_WIDTH[v.monster] : v.mount ? STAND_HALF_WIDTH.mounted : STAND_HALF_WIDTH.foot;
  /** Does hex h show a building (by the building layer, else by the state)? */
  const buildingAt = (h: Hex): boolean => {
    const f = ctx.buildingFront?.(h, 2 * sector);
    if (f !== undefined && f !== null) return true;
    const st = lastState;
    if (st && inBounds(h, st.width, st.height)) {
      const t = st.tiles[tileIndex(h, st.width)];
      if (t && t.building !== null && t.building !== undefined) return true;
    }
    return false;
  };
  /**
   * Where a unit stands on a hex: the centre, or — when the hex holds a building — in front of it
   * on the camera side, clear of the model by the unit's half-width (see chooseStandSpot).
   */
  const hexXZ = (h: Hex, v?: UnitView) => {
    const w = hexToWorld(h);
    const p = new THREE.Vector3(w.x, 0, w.z);
    if (buildingAt(h)) {
      const spot = chooseStandSpot((j) => ctx.buildingFront?.(h, j) ?? null, sector, halfWidthOf(v));
      const dir = standDir(spot.dir);
      p.x += dir.x * spot.d;
      p.z += dir.z * spot.d;
    }
    return p;
  };
  const canSee = (v: UnitView, h: Hex) => v.faction === ctx.viewer || visibleFn(h);
  const factionHex = (f: FactionId) => `#${ctx.factionColor(f).getHexString()}`;

  // ───────── view construction ─────────
  function signature(u: Unit): string {
    const e = u.equipment;
    // the body item, not only the body variant: the padded tunic has its own model (unitBodyKeys)
    return [u.race, u.monster ?? '', u.faction, u.monster ? '' : safeBody(u), e.body, e.main, e.off, e.trinket, e.mount, u.isLeader ? 1 : 0].join('|');
  }

  function statusOf(u: Unit, state: GameState | null): StatusData {
    const buffs = [...new Set(u.buffs.map((b) => b.id))];
    return {
      hp: u.hp, maxHp: state ? safeMaxHp(state, u) : u.base.maxHp, level: u.level, leader: u.isLeader, poisoned: u.poisoned,
      pending: u.pendingLevelUps, buffs, summon: u.summonTurns ?? null,
    };
  }

  function createView(u: Unit): UnitView {
    const seed = hashId(u.id);
    const faction = u.faction;
    const color = ctx.factionColor(faction);
    const accent = new THREE.Color(FACTIONS[faction]?.accent ?? '#cccccc');
    const rootG = new THREE.Group();
    rootG.name = `unit_${u.id}`;
    const body = new THREE.Group();
    const unitSpace = new THREE.Group();
    const rider = new THREE.Group();
    unitSpace.scale.setScalar(UNIT_HEIGHT);
    unitSpace.add(rider);
    body.add(unitSpace);
    rootG.add(body);
    root.add(rootG);
    // ring
    const ringR = u.isLeader ? 0.56 : u.monster === 'golem' || u.monster === 'elemental' ? 0.56 : 0.48;
    const ringGeo = discGeometry(ringR, 40, 3);
    const ringMat = makeRingMaterial(color, accent, u.isLeader);
    const ring = new THREE.Mesh(ringGeo, ringMat);
    ring.renderOrder = 4;
    ring.frustumCulled = false;
    ringGroup.add(ring);
    // bar
    const barCanvas = makeCanvas(BAR_W, BAR_H);
    const barTex = new THREE.CanvasTexture(barCanvas);
    barTex.colorSpace = THREE.SRGBColorSpace;
    barTex.anisotropy = 4;
    const barMat = new THREE.SpriteMaterial({ map: barTex, depthTest: false, depthWrite: false, transparent: true, fog: false });
    const bar = new THREE.Sprite(barMat);
    bar.center.set(0.5, 0);
    bar.renderOrder = 900;
    bar.scale.set(BAR_WORLD_W, (BAR_WORLD_W * BAR_H) / BAR_W, 1);
    rootG.add(bar);
    const v: UnitView = {
      id: u.id, faction, race: u.race, monster: u.monster ?? null, equipment: { ...u.equipment }, pos: { ...u.pos }, sig: '',
      root: rootG, body, unitSpace, rider, model: null, procedural: true, mixer: null, clips: new Map(), actions: new Map(),
      current: null, currentName: '', style: null,
      material: createPaletteMaterial(unitPalette(u.race, faction, seed)),
      glbMats: [], mount: null, monsterRig: null, mainItem: null, offItem: null, trinket: null, gripR: null, gripL: null, chest: null,
      ring, ringMat, ringAt: new THREE.Vector3(NaN, NaN, NaN), bar, barCanvas, barTex, barKey: '', marker: null, xrays: [], reads: [],
      status: statusOf(u, lastState), dispHp: u.hp,
      heading: ((seed % 1000) / 1000 - 0.5) * 0.9, targetHeading: 0, offset: new THREE.Vector3(), lift: 0,
      moving: 0, movingTarget: 0, busy: 0, dying: false, seed, timeScale: 0.92 + ((seed >> 10) % 100) / 100 * 0.16, flash: 0,
      topY: UNIT_HEIGHT + 0.12, pickTop: UNIT_HEIGHT + 0.3, pickR: 0.3, chestY: UNIT_HEIGHT * 0.7, mountTop: 0, riderBaseY: 0, standDrop: 0, walkSpeed: 0, runSpeed: 0, gait: 'walk', walkRate: 0, playToken: 0, animT: (seed % 997) / 97,
      monsterPose: { tilt: 0, pitch: 0, hop: 0, armSwing: 0 },
    };
    v.targetHeading = v.heading;
    buildModel(v, u);
    placeAt(v, u.pos);
    views.set(u.id, v);
    return v;
  }

  function clearModel(v: UnitView): void {
    if (v.mixer) { v.mixer.stopAllAction(); v.mixer.uncacheRoot(v.mixer.getRoot()); }
    v.mixer = null;
    // Every view owns its skeletons (SkeletonUtils / asset clones, procedural rigs): free their bone textures.
    disposeSkeletons(v.unitSpace);
    v.xrays = [];
    v.reads = [];
    v.actions.clear();
    v.clips.clear();
    v.current = null;
    v.currentName = '';
    for (const m of v.glbMats) m.dispose();
    v.glbMats = [];
    if (v.mainItem?.glow) (v.mainItem.glow.material as THREE.Material).dispose();
    if (v.offItem?.glow) (v.offItem.glow.material as THREE.Material).dispose();
    if (v.trinket) (v.trinket.glow.material as THREE.Material).dispose();
    v.rider.clear();
    if (v.mount) v.unitSpace.remove(v.mount.obj);
    v.unitSpace.clear();
    v.unitSpace.add(v.rider);
    v.rider.position.set(0, 0, 0);
    v.standDrop = 0;
    v.walkSpeed = 0;
    v.runSpeed = 0;
    v.model = null; v.mount = null; v.monsterRig = null; v.mainItem = null; v.offItem = null; v.trinket = null;
    v.gripR = v.gripL = v.chest = null;
  }

  /**
   * Clone the materials of a GLB instance so flashes/fades stay per unit. Bodies and mounts also get
   * the readability pass: a hue-preserving albedo floor and a metalness cap on dark texels (dark
   * metal reflects almost nothing of the weak environment and reads as a black blob), plus a thin
   * faction-coloured fresnel rim so a unit separates from dark castles and shadows.
   */
  function adoptMaterials(v: UnitView, obj: THREE.Object3D, tint?: THREE.Color, role: 'body' | 'mount' | 'other' = 'other', leader = false): void {
    const rim = role === 'body' ? (leader ? 0.5 : 0.35) : role === 'mount' ? 0.2 : 0;
    const rimColor = role === 'other' ? null : ctx.factionColor(v.faction);
    obj.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      m.castShadow = true;
      m.receiveShadow = true;
      m.renderOrder = 2;
      const conv = (mat: THREE.Material) => {
        const c = mat.clone();
        if (tint && (c as THREE.MeshStandardMaterial).color) {
          const s = c as THREE.MeshStandardMaterial;
          s.color.multiply(tint);
          if (s.emissive) { s.emissive.copy(tint).multiplyScalar(0.25); s.emissiveIntensity = 1; }
        }
        const em = (c as THREE.MeshStandardMaterial).emissive;
        c.userData.baseEmissive = em ? em.clone() : null;
        if (rimColor && (c as THREE.MeshStandardMaterial).isMeshStandardMaterial) {
          const read = { uMinLum: { value: role === 'body' ? 0.05 : 0.045 }, uRimColor: { value: rimColor.clone() }, uRim: { value: rim } };
          c.userData.read = read;
          v.reads.push({ uRim: read.uRim, base: rim });
          c.onBeforeCompile = (sh) => {
            Object.assign(sh.uniforms, read);
            sh.fragmentShader = sh.fragmentShader
              .replace('#include <common>', '#include <common>\nuniform float uMinLum; uniform vec3 uRimColor; uniform float uRim;')
              .replace('#include <map_fragment>', `#include <map_fragment>
  float uReadLum = dot(diffuseColor.rgb, vec3(0.2126, 0.7152, 0.0722));
  diffuseColor.rgb *= clamp(uMinLum / max(uReadLum, 1e-4), 1.0, 3.0);`)
              .replace('#include <metalnessmap_fragment>', `#include <metalnessmap_fragment>
  metalnessFactor = min(metalnessFactor, mix(0.45, 1.0, smoothstep(0.06, 0.16, uReadLum)));`)
              .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
  { float fr = 1.0 - saturate(dot(normal, normalize(vViewPosition))); totalEmissiveRadiance += uRimColor * (uRim * fr * fr * fr); }`);
          };
          c.customProgramCacheKey = () => 'unit-readable';
        }
        v.glbMats.push(c);
        return c;
      };
      m.material = Array.isArray(m.material) ? m.material.map(conv) : conv(m.material);
    });
  }

  // ───────── x-ray silhouettes ─────────
  // Draw order: occluders (terrain, decor, buildings: renderOrder 0) → x-ray twins (1, depth test
  // GREATER, no depth write: only where something already drawn hides the body) → bodies (2), so a
  // twin never tests against its own unit and is overwritten wherever the body itself is visible.
  const xrayMats = new Map<string, THREE.MeshBasicMaterial>();
  function xrayMaterial(f: FactionId): THREE.MeshBasicMaterial {
    const own = f === ctx.viewer;
    const key = `${f}|${own ? 1 : 0}`;
    let m = xrayMats.get(key);
    if (m) return m;
    const color = ctx.factionColor(f);
    const u = { uXColor: { value: color }, uXStrength: { value: own ? 1.0 : 0.6 } };
    m = new THREE.MeshBasicMaterial({ color, depthFunc: THREE.GreaterDepth, depthWrite: false, transparent: false, fog: false, toneMapped: true });
    m.onBeforeCompile = (sh) => {
      Object.assign(sh.uniforms, u);
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vXView;')
        .replace('#include <project_vertex>', `#include <project_vertex>
  // Pulled toward the camera so ground contact and grass on the unit's own tile never light it up.
  mvPosition.z += 0.16;
  gl_Position = projectionMatrix * mvPosition;
  vXView = mvPosition.xyz;`);
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vXView; uniform vec3 uXColor; uniform float uXStrength;')
        .replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>
  vec3 xN = normalize(cross(dFdx(vXView), dFdy(vXView)));
  float xFr = 1.0 - abs(dot(xN, normalize(-vXView)));
  // ghost: a solid rim and a dithered (half-covered) interior
  if (xFr < 0.55 && mod(floor(gl_FragCoord.x) + floor(gl_FragCoord.y), 2.0) < 0.5) discard;`)
        .replace('#include <opaque_fragment>', `outgoingLight = uXColor * uXStrength * (0.45 + 1.1 * xFr * xFr);
#include <opaque_fragment>`);
    };
    m.customProgramCacheKey = () => 'unit-xray';
    xrayMats.set(key, m);
    return m;
  }
  /** Give every body mesh of the unit an x-ray twin (shares geometry and, for skinned meshes, the skeleton). */
  function addXray(v: UnitView): void {
    const meshes: THREE.Mesh[] = [];
    v.unitSpace.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh || (o as unknown as THREE.Sprite).isSprite || o.userData.xray) return;
      m.renderOrder = 2;
      meshes.push(m);
    });
    const mat = xrayMaterial(v.faction);
    for (const m of meshes) {
      const twin = m.clone(false) as THREE.Mesh;
      twin.position.set(0, 0, 0);
      twin.quaternion.identity();
      twin.scale.set(1, 1, 1);
      twin.material = mat;
      twin.renderOrder = 1;
      twin.castShadow = false;
      twin.receiveShadow = false;
      twin.userData = { xray: true, noAO: true };
      twin.name = '';
      m.add(twin);
      v.xrays.push(twin);
    }
  }

  function measureHeight(obj: THREE.Object3D): number {
    obj.updateWorldMatrix(true, true);
    const box = new THREE.Box3().setFromObject(obj, true);
    return Math.max(0.05, box.max.y - Math.min(0, box.min.y));
  }

  function attachItem(v: UnitView, id: ItemId | string, grip: THREE.Object3D, isShield: boolean): Attachment {
    const glbKey = isShield ? `shield_${v.race}` : id;
    const glb = ctx.assets.model('items', glbKey) ?? (isShield ? ctx.assets.model('items', 'shield') : null);
    let obj: THREE.Object3D;
    let tipPos: THREE.Vector3;
    let glowInfo: { pos: THREE.Vector3; size: number; color: string } | undefined;
    if (glb) {
      obj = glb;
      adoptMaterials(v, obj);
      const box = new THREE.Box3().setFromObject(obj, true);
      tipPos = isShield ? new THREE.Vector3(0, 0, box.max.z) : new THREE.Vector3(0, box.max.y, 0);
      if (id === 'staff' || id === 'wand') glowInfo = { pos: tipPos.clone().multiplyScalar(0.94), size: id === 'staff' ? 0.3 : 0.16, color: RACE_GLOW[v.race] ?? '#7cc8ff' };
    } else {
      const im = itemModel((isShield ? 'shield' : id) as ItemId, v.race);
      const mesh = new THREE.Mesh(im.geometry, v.material);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      obj = mesh;
      tipPos = im.tip.clone();
      glowInfo = im.glow;
    }
    const holder = new THREE.Group();
    holder.name = `item_${id}`;
    holder.add(obj);
    grip.add(holder);
    // items are authored relative to a 1.0-tall unit: undo any bone scale between unit space and the grip
    v.unitSpace.updateWorldMatrix(true, true);
    const gs = grip.getWorldScale(tmpV).x;
    const us = v.unitSpace.getWorldScale(tmpV2).x;
    if (gs > 1e-6) holder.scale.setScalar(us / gs);
    const tip = new THREE.Object3D();
    tip.position.copy(tipPos);
    holder.add(tip);
    let glow: THREE.Sprite | null = null;
    if (glowInfo) {
      const gm = new THREE.SpriteMaterial({ map: softDotTexture(), color: glowInfo.color, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, fog: false, opacity: 0.9 });
      glow = new THREE.Sprite(gm);
      glow.position.copy(glowInfo.pos);
      glow.scale.setScalar(glowInfo.size);
      glow.renderOrder = 8;
      holder.add(glow);
    }
    return { obj: holder, tip, glow };
  }

  /** Create grip.R/grip.L on a GLB rig that lacks them, from the T-pose hand orientation (item +Y = thumb, +Z = fingertips). */
  function ensureGrip(model: THREE.Object3D, side: 'R' | 'L', H: number): THREE.Object3D | null {
    const existing = findNode(model, `grip.${side}`);
    if (existing) return existing;
    const hand = findNode(model, `hand.${side}`);
    if (!hand) return null;
    model.updateWorldMatrix(true, true);
    const rel = model.matrixWorld.clone().invert().multiply(hand.matrixWorld);
    const hp = new THREE.Vector3(), hq = new THREE.Quaternion(), hs = new THREE.Vector3();
    rel.decompose(hp, hq, hs);
    const fingers = new THREE.Vector3(side === 'R' ? -1 : 1, 0, 0);
    const thumb = new THREE.Vector3(0, 0, 1);
    const xAxis = new THREE.Vector3().crossVectors(thumb, fingers);
    const want = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(xAxis, thumb, fingers));
    const inv = hq.clone().invert();
    const g = new THREE.Object3D();
    g.name = `grip.${side}`;
    g.quaternion.copy(inv.clone().multiply(want));
    g.position.copy(fingers.multiplyScalar(0.035 * H).applyQuaternion(inv).divide(hs));
    hand.add(g);
    return g;
  }

  function clipStyleFor(u: Unit): ClipStyle {
    const main = u.equipment.main;
    const hold: ClipStyle['hold'] = !main ? 'none' : main === 'bow' ? 'bow' : main === 'spear' || main === 'staff' ? 'long' : 'weapon';
    const melee: ClipStyle['melee'] = main === 'spear' ? 'thrust' : !main ? 'punch' : 'swing';
    return { race: u.race, hold, shield: u.equipment.off === 'shield', melee, mounted: !!u.equipment.mount };
  }

  function buildModel(v: UnitView, u: Unit): void {
    clearModel(v);
    v.faction = u.faction;
    v.race = u.race;
    v.monster = u.monster ?? null;
    v.equipment = { ...u.equipment };
    v.sig = signature(u);
    const color = ctx.factionColor(u.faction);
    v.ringMat.uniforms.uColor.value.copy(color);
    v.ringMat.uniforms.uLeader.value = u.isLeader ? 1 : 0;

    if (u.monster) {
      const kind = u.monster;
      v.material.dispose();
      v.material = createPaletteMaterial(monsterPalette(kind, u.faction));
      let glb = ctx.assets.model('monsters', kind);
      let tint: THREE.Color | undefined;
      if (!glb && kind === 'elemental') {
        glb = ctx.assets.model('monsters', 'golem');
        tint = new THREE.Color('#ffb060');
      }
      const targetH = MONSTER_HEIGHT[kind];
      if (glb) {
        adoptMaterials(v, glb, tint);
        const h = measureHeight(glb);
        const holder = new THREE.Group();
        holder.add(glb);
        holder.scale.setScalar(targetH / h);
        v.rider.add(holder);
        v.model = holder;
        v.procedural = false;
      } else {
        const rig = createMonster(kind, v.material);
        v.rider.add(rig.group);
        v.model = rig.group;
        v.monsterRig = rig;
        v.procedural = true;
      }
      v.style = null;
      v.topY = targetH * UNIT_HEIGHT + 0.1;
      v.chestY = targetH * UNIT_HEIGHT * 0.6;
      addXray(v);
      return;
    }

    const body = safeBody(u);
    const mountKind: MountKind | null = u.equipment.mount ? MOUNT_FOR[u.race] ?? 'horse' : null;
    const coat = mountKind ? MOUNT_COATS[mountKind][v.seed % MOUNT_COATS[mountKind].length] : undefined;
    v.material.dispose();
    v.material = createPaletteMaterial(unitPalette(u.race, u.faction, v.seed, coat));

    // mount
    let saddle = new THREE.Vector3();
    let mountTop = 0;
    if (mountKind) {
      const glb = ctx.assets.model('mounts', mountKind);
      if (glb) {
        adoptMaterials(v, glb, undefined, 'mount');
        const s = ctx.assets.manifest.mounts?.[mountKind]?.saddle ?? DEFAULT_SADDLE[mountKind];
        saddle.set(s[0], s[1], s[2]);
        // measure while parentless: unit space, independent of the unit scale and the ground height
        mountTop = measureHeight(glb);
        const holder = new THREE.Group();
        holder.add(glb);
        v.unitSpace.add(holder);
        v.mount = { obj: holder, rig: null, kind: mountKind };
      } else {
        const rig = createQuadruped(mountKind, v.material, true);
        v.unitSpace.add(rig.group);
        v.mount = { obj: rig.group, rig, kind: mountKind };
        saddle = rig.saddle.clone();
        mountTop = rig.height;
      }
    }

    // body
    const bodyKeys = unitBodyKeys(u.race, body, u.equipment.body);
    const key = firstAvailable(bodyKeys, (k) => !!ctx.assets.skinned(k)) ?? bodyKeys[bodyKeys.length - 1];
    const sk = ctx.assets.skinned(key);
    let hipsH = 0.5;
    let H = 1;
    if (sk) {
      const model = skeletonClone(sk.scene);
      adoptMaterials(v, model, undefined, 'body', u.isLeader);
      H = ctx.assets.manifest.units?.[key]?.height ?? measureHeight(model);
      const holder = new THREE.Group();
      holder.add(model);
      holder.scale.setScalar(1 / H);
      v.rider.add(holder);
      v.model = holder;
      v.procedural = false;
      v.mixer = new THREE.AnimationMixer(model);
      for (const c of sk.animations) v.clips.set(c.name, c);
      v.walkSpeed = ctx.assets.manifest.units?.[key]?.walkSpeed ?? DEFAULT_WALK_SPEED;
      v.runSpeed = v.clips.has('run') ? ctx.assets.manifest.units?.[key]?.runSpeed ?? DEFAULT_RUN_SPEED : 0;
      const hips = findNode(model, 'hips');
      if (hips) {
        // hips rest height in the model's own space (independent of where the unit stands)
        model.updateWorldMatrix(true, true);
        const local = hips.getWorldPosition(tmpV).applyMatrix4(model.matrixWorld.clone().invert());
        hipsH = local.y / H;
      }
      v.gripR = ensureGrip(model, 'R', H);
      v.gripL = ensureGrip(model, 'L', H);
      v.chest = findNode(model, 'chest_socket') ?? findNode(model, 'chest');
      v.style = null;
    } else {
      const hum = createHumanoid(u.race, body, v.seed, v.material);
      v.rider.add(hum.root);
      v.model = hum.root;
      v.procedural = true;
      v.style = clipStyleFor(u);
      v.mixer = new THREE.AnimationMixer(hum.root);
      for (const c of humanoidClips(v.style)) v.clips.set(c.name, c);
      v.gripR = hum.gripR;
      v.gripL = hum.gripL;
      v.chest = hum.chestSocket;
      hipsH = hum.hipsHeight;
    }
    if (v.mount) {
      // Seat the rider: measure the hips in the actual riding pose (rigs differ: some ride clips keep
      // the hips at rest height, others drop them to the seat), then put them ≈4.5 cm above the saddle.
      const hipsNode = v.model ? findNode(v.model, 'hips') : null;
      const hipsIn = (name: string): number | null => {
        const a = action(v, name);
        if (!a || !hipsNode || !v.mixer) return null;
        a.reset();
        a.play();
        v.mixer.update(0);
        v.rider.updateWorldMatrix(true, true);
        const y = v.rider.worldToLocal(hipsNode.getWorldPosition(new THREE.Vector3())).y;
        a.stop();
        return y;
      };
      const ride = hipsIn('ride_idle');
      if (ride !== null) hipsH = ride;
      // A standing clip (death) keeps the feet at the origin: remember how far it lifts the hips.
      if (!v.procedural && ride !== null) {
        const stand = hipsIn(v.clips.has('death') ? 'death' : 'idle');
        if (stand !== null) v.standDrop = Math.max(0, stand - ride);
      }
      v.rider.position.set(saddle.x, saddle.y - (hipsH - 0.045), saddle.z);
    }
    v.riderBaseY = v.rider.position.y;
    v.mountTop = mountTop;
    // GLB ride clips lower the rider's hips by standDrop: the head sits that much below a standing rider's.
    const seatY = v.mount ? v.rider.position.y - v.standDrop : 0;
    v.topY = v.mount ? mountedTopY(v.rider.position.y, v.standDrop, mountTop) : 1.02 * UNIT_HEIGHT + 0.08;
    v.chestY = (seatY + 0.72) * UNIT_HEIGHT;

    // equipment — GLB rigs hold the bow in the LEFT palm ('hold.L'), which their attack_ranged
    // draw animation is authored around; every other main-hand item goes in the right palm.
    const main = u.equipment.main;
    const holdL = !v.procedural && v.model ? findNode(v.model, 'hold.L') : null;
    const mainGrip = main === 'bow' && holdL ? holdL : v.gripR;
    if (main && mainGrip) v.mainItem = attachItem(v, main, mainGrip, false);
    const off = u.equipment.off;
    if (off && v.gripL) v.offItem = attachItem(v, off, v.gripL, true);
    const trinket = u.equipment.trinket;
    if (trinket && v.chest) {
      const col = TRINKET_COLOR[trinket] ?? '#ffd76a';
      let gm = gemMats.get(col);
      if (!gm) {
        gm = new THREE.MeshStandardMaterial({ color: col, emissive: col, emissiveIntensity: 2.2, roughness: 0.15, metalness: 0.2 });
        gemMats.set(col, gm);
      }
      const holder = new THREE.Group();
      const gem = new THREE.Mesh(gemGeo, gm);
      gem.scale.set(1, 1.3, 0.7);
      holder.add(gem);
      const sm = new THREE.SpriteMaterial({ map: softDotTexture(), color: col, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, fog: false });
      const glow = new THREE.Sprite(sm);
      glow.scale.setScalar(0.14);
      glow.renderOrder = 8;
      holder.add(glow);
      v.chest.add(holder);
      v.unitSpace.updateWorldMatrix(true, true);
      const gs = v.chest.getWorldScale(tmpV).x, us = v.unitSpace.getWorldScale(tmpV2).x;
      if (gs > 1e-6) holder.scale.setScalar(us / gs);
      if (!v.procedural && v.chest.name !== 'chest_socket') holder.position.set(0, 0.06, 0.09).multiplyScalar(gs > 1e-6 ? us / gs : 1);
      v.trinket = { obj: holder, glow };
    }
    addXray(v);
    // start the base loop at a random phase so groups don't animate in lockstep
    const loop = playLoop(v, baseLoopName(v), 0);
    if (loop) loop.time = (v.seed % 1000) / 1000 * loop.getClip().duration;
  }

  // ───────── clips ─────────
  const FALLBACK: Record<string, string[]> = {
    ride_idle: ['idle'], ride_attack: ['attack_melee'], work: ['attack_melee'], attack_ranged: ['attack_melee'],
    cast: ['attack_ranged', 'attack_melee'], walk: ['idle'], hit: [], death: [], attack_melee: [],
  };
  function resolveClip(v: UnitView, name: string): THREE.AnimationClip | null {
    const c = v.clips.get(name);
    if (c) return c;
    for (const alt of FALLBACK[name] ?? []) { const a = v.clips.get(alt); if (a) return a; }
    return null;
  }
  function action(v: UnitView, name: string): THREE.AnimationAction | null {
    if (!v.mixer) return null;
    let a = v.actions.get(name);
    if (!a) {
      const clip = resolveClip(v, name);
      if (!clip) return null;
      a = v.mixer.clipAction(clip);
      v.actions.set(name, a);
    }
    return a;
  }
  function baseLoopName(v: UnitView): string {
    if (v.mount) return v.moving > 0.5 && v.procedural ? 'walk' : 'ride_idle';
    return v.movingTarget > 0 ? v.gait : 'idle';
  }
  function playLoop(v: UnitView, name: string, fade = 0.2, timeScale = 1): THREE.AnimationAction | null {
    const a = action(v, name);
    if (!a) return null;
    a.timeScale = (name === 'walk' || name === 'run') && v.walkRate > 0 ? v.walkRate : timeScale * v.timeScale;
    if (v.current === a && a.isRunning()) return a;
    a.reset();
    a.setLoop(THREE.LoopRepeat, Infinity);
    a.clampWhenFinished = false;
    a.enabled = true;
    a.setEffectiveWeight(1);
    if (v.current && fade > 0) a.crossFadeFrom(v.current, fade, false);
    else if (v.current) v.current.stop();
    a.play();
    v.current = a;
    v.currentName = name;
    v.playToken++;
    return a;
  }
  /** Play a clip once; resolves at `at`·duration (default the end). Returns the clip duration (at speed 1). */
  function playOnce(v: UnitView, name: string, speed: number, clamp = false, fade = 0.12): { dur: number; action: THREE.AnimationAction } | null {
    const a = action(v, name);
    if (!a) return null;
    a.reset();
    a.setLoop(THREE.LoopOnce, 1);
    a.clampWhenFinished = true;
    a.timeScale = speed;
    a.enabled = true;
    a.setEffectiveWeight(1);
    if (v.current && v.current !== a) {
      if (fade > 0) a.crossFadeFrom(v.current, fade / Math.max(1, speed * 0.5), false);
      else v.current.stop();
    }
    a.play();
    v.current = a;
    v.currentName = name;
    const token = ++v.playToken;
    if (!clamp) {
      const dur = a.getClip().duration / speed;
      // return to the base loop shortly before the end so the blend is seamless (unless replayed meanwhile)
      sched.wait(Math.max(0, dur - 0.14)).then(() => {
        if (v.playToken === token && v.current === a && !v.dying) playLoop(v, baseLoopName(v), 0.16);
      });
    }
    return { dur: a.getClip().duration, action: a };
  }
  function impactFrac(v: UnitView, name: string): number {
    if (v.procedural && v.style && name === 'attack_melee') return v.style.mounted ? CLIP_IMPACT.ride_attack : MELEE_IMPACT[v.style.melee];
    return CLIP_IMPACT[name] ?? 0.5;
  }

  // ───────── placement ─────────
  function placeAt(v: UnitView, h: Hex): void {
    const w = hexXZ(h, v);
    v.pos = { ...h };
    v.root.position.set(w.x, groundY(w.x, w.z), w.z);
  }

  function updateRing(v: UnitView): void {
    const p = v.root.position;
    const x = p.x + v.offset.x, z = p.z + v.offset.z;
    if (Math.abs(x - v.ringAt.x) < 1e-3 && Math.abs(z - v.ringAt.z) < 1e-3) return;
    v.ringAt.set(x, 0, z);
    v.ring.position.set(x, 0, z);
    drapeGeometry(v.ring.geometry, ctx.heightAt, x, z, 0.025);
  }

  function anchorOf(v: UnitView, out = new THREE.Vector3()): THREE.Vector3 {
    if (v.chest && v.model && !v.monster) {
      v.chest.updateWorldMatrix(true, false);
      v.chest.getWorldPosition(out);
      if (Number.isFinite(out.x)) return out;
    }
    out.copy(v.root.position).add(v.offset);
    out.y += v.chestY + v.lift;
    return out;
  }
  function tipOf(v: UnitView, out = new THREE.Vector3()): THREE.Vector3 {
    const t = v.mainItem?.tip;
    if (t) { t.updateWorldMatrix(true, false); return t.getWorldPosition(out); }
    return anchorOf(v, out).add(tmpV.set(Math.sin(v.heading) * 0.15, 0.05, Math.cos(v.heading) * 0.15));
  }

  function refreshStatus(v: UnitView): void {
    const s = v.status;
    const key = `${Math.round(v.dispHp)}|${s.maxHp}|${s.level}|${s.leader}|${s.poisoned}|${s.pending}|${s.buffs.join(',')}|${s.summon}`;
    if (key === v.barKey) return;
    v.barKey = key;
    drawBar(v.barCanvas, { ...s, hp: v.dispHp }, factionHex(v.faction), FACTIONS[v.faction]?.accent ?? '#cccccc');
    v.barTex.needsUpdate = true;
  }

  function setVisible(v: UnitView, vis: boolean): void {
    v.root.visible = vis;
    v.ring.visible = vis && !v.dying;
  }

  function disposeView(v: UnitView): void {
    clearModel(v);
    root.remove(v.root);
    ringGroup.remove(v.ring);
    v.ring.geometry.dispose();
    v.ringMat.dispose();
    v.barTex.dispose();
    (v.bar.material as THREE.Material).dispose();
    if (v.marker) { v.marker.tex.dispose(); (v.marker.sprite.material as THREE.Material).dispose(); v.marker = null; }
    v.material.dispose();
    views.delete(v.id);
  }

  // ───────── material effects (dissolve / flash) ─────────
  function setDissolve(v: UnitView, amount: number, color?: THREE.ColorRepresentation): void {
    const u = v.material.userData.pal.uFx.value;
    u.z = amount;
    u.w = 1.0;
    if (color) v.material.userData.pal.uDissColor.value.set(color);
    const shadow = amount < 0.02;
    v.root.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh && !o.userData.xray) m.castShadow = shadow; });
    for (const x of v.xrays) x.visible = shadow;
    for (const r of v.reads) r.uRim.value = r.base * (1 - amount);
    // GLB materials cannot dissolve: fade them instead
    for (const m of v.glbMats) {
      const wantT = amount > 0.001;
      if (m.transparent !== wantT) { m.transparent = wantT; m.needsUpdate = true; }
      m.opacity = 1 - amount;
      m.depthWrite = amount < 0.5;
    }
    if (v.mainItem?.glow) (v.mainItem.glow.material as THREE.SpriteMaterial).opacity = 0.9 * (1 - amount);
    if (v.trinket) (v.trinket.glow.material as THREE.SpriteMaterial).opacity = 1 - amount;
  }
  function applyFlash(v: UnitView): void {
    const f = v.material.userData.pal.uFlash.value;
    f.w = v.flash * 0.9;
    for (const m of v.glbMats) {
      const s = m as THREE.MeshStandardMaterial;
      const base = m.userData.baseEmissive as THREE.Color | null | undefined;
      if (s.emissive && base) s.emissive.setRGB(base.r + v.flash * 0.9, base.g + v.flash * 0.15, base.b + v.flash * 0.08);
    }
  }

  // ───────── transform animations for monsters / static meshes ─────────
  async function monsterStrike(v: UnitView, dir: THREE.Vector3, sp: number, onImpact: () => void): Promise<void> {
    const dur = (v.monster === 'golem' || v.monster === 'elemental' ? 0.85 : 0.62) / sp;
    const imp = 0.45;
    const reach = v.monster === 'spider' ? 0.55 : v.monster === 'wolf' ? 0.65 : 0.45;
    const hopH = v.monster === 'wolf' ? 0.14 : v.monster === 'spider' ? 0.08 : 0.0;
    v.busy++;
    let fired = false;
    await sched.tween(dur, (_t, raw) => {
      const k = raw < imp ? easeInQuad(raw / imp) : 1 - easeOutCubic((raw - imp) / (1 - imp));
      const windup = raw < imp * 0.6 ? Math.sin((raw / (imp * 0.6)) * Math.PI) * 0.12 : 0;
      v.offset.copy(dir).multiplyScalar(reach * k - windup * 0.4);
      v.monsterPose.hop = hopH * bump(raw / imp) * (raw < imp ? 1 : 0);
      v.monsterPose.pitch = -0.25 * windup / 0.12 + 0.18 * k;
      v.monsterPose.armSwing = raw < imp ? -1.6 * easeOutQuad(raw / imp * 0.7) + 2.4 * easeInQuad(Math.max(0, raw / imp - 0.55) / 0.45) : 0.8 * (1 - (raw - imp) / (1 - imp));
      if (!fired && raw >= imp) { fired = true; onImpact(); }
    });
    if (!fired) onImpact();
    v.offset.set(0, 0, 0);
    v.monsterPose.hop = 0; v.monsterPose.pitch = 0; v.monsterPose.armSwing = 0;
    v.busy--;
  }
  function flinch(v: UnitView, dir: THREE.Vector3, sp: number): Promise<void> {
    return sched.tween(0.38 / sp, (_t, raw) => {
      const k = bump(Math.min(1, raw * 1.6)) * (1 - raw * 0.3);
      v.offset.copy(dir).multiplyScalar(0.07 * k);
      if (!v.mixer || !v.procedural || v.monster) v.monsterPose.tilt = -0.22 * k;
    }).then(() => { v.offset.set(0, 0, 0); v.monsterPose.tilt = 0; });
  }

  /** A GLB rider on a mount: only seat-preserving clips may play (see seatedClip). */
  const seatedGlb = (v: UnitView) => !!v.mount && !v.procedural;

  // ───────── combat ─────────
  function meleeClip(v: UnitView): string {
    if (v.mount && !v.procedural) return 'ride_attack';
    return 'attack_melee';
  }
  function rangedClip(v: UnitView, kind: AttackKind): string {
    if (v.mount && !v.procedural) return 'ride_attack';
    return kind === 'magic' ? 'cast' : 'attack_ranged';
  }
  function retaliationKind(v: UnitView | undefined, kind: AttackKind): AttackKind {
    if (kind === 'melee') return 'melee';
    const m = v?.equipment.main;
    if (m === 'staff' || m === 'wand') return 'magic';
    if (m === 'bow') return 'ranged';
    return kind;
  }

  function reaction(S: UnitView | undefined, T: UnitView | undefined, s: StrikeEvent, kind: AttackKind, sp: number): void {
    if (!T) return;
    const dir = S ? tmpV.copy(T.root.position).sub(S.root.position).setY(0).normalize().clone() : new THREE.Vector3(0, 0, -1);
    const at = anchorOf(T);
    if (s.hit) {
      T.dispHp = Math.max(0, T.dispHp - s.damage);
      T.flash = 1;
      fx.hitSpark(at, kind);
      fx.damageNumber(at.clone().add(new THREE.Vector3(0, 0.22, 0)), `-${s.damage}`, '#ff4d3d');
      if (s.damage >= 14) ctx.shake(Math.min(0.3, 0.06 + s.damage / 90));
      if (T.dispHp > 0) {
        if (T.mixer && !T.monster && !seatedGlb(T)) playOnce(T, 'hit', sp);
        flinch(T, dir, sp);
      }
      if (s.poisoned) {
        T.status.poisoned = true;
        sched.wait(0.22 / sp).then(() => fx.damageNumber(anchorOf(T).add(new THREE.Vector3(0, 0.3, 0)), 'poisoned', '#7ddc55'));
        ext?.wisps(at, '#7ddc55', 8);
      }
      if (s.drained && S) {
        S.dispHp = Math.min(S.status.maxHp, S.dispHp + s.drained);
        const sa = anchorOf(S);
        fx.damageNumber(sa.clone().add(new THREE.Vector3(0, 0.22, 0)), `+${s.drained}`, '#5be07a');
        ext?.wisps(sa, '#ff4060', 8);
      }
    } else {
      // dodge sidestep perpendicular to the attack
      const side = new THREE.Vector3(-dir.z, 0, dir.x).multiplyScalar(T.seed % 2 ? 1 : -1);
      T.busy++;
      sched.tween(0.42 / sp, (_t, raw) => {
        T.offset.copy(side).multiplyScalar(0.16 * bump(raw)).addScaledVector(dir, 0.04 * bump(raw));
      }).then(() => { T.offset.set(0, 0, 0); T.busy--; });
      fx.damageNumber(at.clone().add(new THREE.Vector3(0, 0.22, 0)), 'miss', '#c9c9c9');
    }
  }

  async function strike(S: UnitView | undefined, T: UnitView | undefined, s: StrikeEvent, kind: AttackKind, sp: number): Promise<void> {
    const dir = S && T ? new THREE.Vector3().copy(T.root.position).sub(S.root.position).setY(0).normalize() : new THREE.Vector3(0, 0, 1);
    if (S) S.targetHeading = Math.atan2(dir.x, dir.z);
    if (!S || S.dying) {
      // invisible / unknown striker: still show the result
      await sched.wait(0.25 / sp);
      reaction(S, T, s, kind, sp);
      await sched.wait(0.3 / sp);
      return;
    }
    if (S.monster || !S.mixer) {
      await monsterStrike(S, dir, sp, () => reaction(S, T, s, kind, sp));
      await sched.wait(0.15 / sp);
      return;
    }
    if (kind === 'melee') {
      const name = meleeClip(S);
      const played = playOnce(S, name, sp);
      const dur = (played?.dur ?? 0.9) / sp;
      const imp = impactFrac(S, name);
      const dist = T ? Math.hypot(T.root.position.x - S.root.position.x, T.root.position.z - S.root.position.z) : 1.7;
      const reach = Math.min(S.mount ? 0.7 : 0.62, dist * 0.36);
      S.busy++;
      await sched.tween(dur * imp, (t) => { S.offset.copy(dir).multiplyScalar(reach * easeInQuad(t)); });
      reaction(S, T, s, kind, sp);
      sched.tween(dur * (1 - imp) * 0.8, (t) => { S.offset.copy(dir).multiplyScalar(reach * (1 - easeOutQuad(t))); })
        .then(() => { S.offset.set(0, 0, 0); S.busy--; });
      await sched.wait(dur * (1 - imp) * 0.6);
      return;
    }
    // ranged / magic
    const name = rangedClip(S, kind);
    const played = playOnce(S, name, sp);
    const dur = (played?.dur ?? 1.0) / sp;
    const imp = impactFrac(S, name);
    await sched.wait(dur * imp);
    const from = tipOf(S);
    let to = T ? anchorOf(T) : from.clone().addScaledVector(dir, 2);
    if (!s.hit && T) {
      const side = new THREE.Vector3(-dir.z, 0, dir.x).multiplyScalar(S.seed % 2 ? 1 : -1);
      to = to.clone().addScaledVector(side, 0.38).addScaledVector(dir, 0.45).add(new THREE.Vector3(0, -0.12, 0));
    }
    if (kind === 'magic') ext?.flash(from, RACE_GLOW[S.race] ?? '#8fa8ff', 0.5, 0.25);
    await fx.projectile(from, to, kind, sp);
    reaction(S, T, s, kind, sp);
    await sched.wait(Math.max(0.12 / sp, dur * (1 - imp) * 0.35));
  }

  async function animateCombat(attacker: UnitId, defender: UnitId, kind: AttackKind, strikes: StrikeEvent[], speed: number): Promise<void> {
    const sp = normSpeed(speed);
    const A = views.get(attacker), D = views.get(defender);
    if (!A && !D) return;
    if (A) A.busy++;
    if (D) D.busy++;
    try {
      if (A && D) {
        A.targetHeading = headingTo(A.root.position, D.root.position);
        D.targetHeading = headingTo(D.root.position, A.root.position);
        await sched.wait(0.2 / sp);
      }
      const defKind = retaliationKind(D, kind);
      for (const s of strikes) {
        const byA = s.by === 'attacker';
        const S = byA ? A : D;
        const T = byA ? D : A;
        await strike(S, T, s, byA ? kind : defKind, sp);
        if ((A && A.dispHp <= 0) || (D && D.dispHp <= 0)) break;
      }
      await sched.wait(0.15 / sp);
    } finally {
      for (const v of [A, D]) {
        if (!v) continue;
        v.busy--;
        v.offset.set(0, 0, 0);
        // let a still-running one-shot (hit / swing) finish: its own timer returns to the loop
        if (!v.dying && v.dispHp > 0 && v.mixer && (!v.current || !v.current.isRunning())) playLoop(v, baseLoopName(v), 0.2);
      }
    }
  }

  // ───────── movement ─────────
  async function animateMove(id: UnitId, path: Hex[], speed: number): Promise<void> {
    const v = views.get(id);
    if (!v || v.dying || path.length === 0) return; // not rendered (or not synced yet): nothing to animate
    const sp = normSpeed(speed);
    const start = v.root.position.clone().setY(0);
    const pts: THREE.Vector3[] = [start];
    for (const h of path) {
      const p = hexXZ(h, v);
      if (pts[pts.length - 1].distanceToSquared(p) > 1e-6) pts.push(p);
    }
    const end = path[path.length - 1];
    if (pts.length < 2) { placeAt(v, end); return; }
    v.busy++;
    try {
      const curve: THREE.Curve<THREE.Vector3> = pts.length === 2 ? new THREE.LineCurve3(pts[0], pts[1]) : new THREE.CatmullRomCurve3(pts, false, 'centripetal', 0.5);
      const len = curve.getLength();
      const mounted = !!v.mount;
      const base = v.monster ? (v.monster === 'wolf' ? 2.9 : v.monster === 'spider' ? 2.4 : 1.5) : mounted ? 2.9 : FOOT_SPEED;
      const dur = len / (base * sp);
      v.movingTarget = 1;
      let stepEvery = (mounted ? 0.2 : 0.3) / sp;
      let walk: THREE.AnimationAction | null = null;
      if (v.mixer && !v.monster) {
        if (mounted) playLoop(v, v.procedural ? 'walk' : 'ride_idle', 0.18, 1.0 * sp);
        else {
          // GLB locomotion cycles run exactly as fast as the ground moves under them, so the feet stay
          // planted: the long-stride run when the model has one, else the walk at a brisker cadence.
          v.gait = v.runSpeed > 0 ? 'run' : 'walk';
          const footSpeed = v.gait === 'run' ? v.runSpeed : v.walkSpeed;
          v.walkRate = footSpeed > 0 ? walkTimeScale(base * sp, footSpeed) : 0;
          walk = playLoop(v, v.gait, 0.18, PROCEDURAL_WALK_RATE * sp);
          // one dust puff per stride
          if (walk && walk.timeScale > 0) stepEvery = walk.getClip().duration / walk.timeScale;
        }
      }
      // Smooth start, constant cruise, and a deceleration over the last stretch (same total time,
      // so the controller's footstep timeline stays valid). The gait follows the ground speed.
      const ta = Math.min(0.22 / sp, 0.25 * dur), td = Math.min(0.42 / sp, 0.35 * dur);
      const walkBase = walk ? walk.timeScale : 0;
      let lastStep = -1;
      const p = new THREE.Vector3();
      const tan = new THREE.Vector3();
      await sched.tween(dur, (_t, raw) => {
        const prof = trapezoidProfile(raw * dur, dur, len, ta, td);
        const u = Math.min(1, prof.s / len);
        const ratio = prof.v / (base * sp);
        if (walk && v.current === walk) {
          // frozen on arrival, so the idle cross-fade blends from a still pose (no foot drift)
          walk.timeScale = raw >= 1 ? 0 : (v.walkRate > 0 ? v.walkRate : walkBase) * ratio;
        }
        curve.getPointAt(u, p);
        curve.getTangentAt(u, tan);
        v.root.position.set(p.x, groundY(p.x, p.z), p.z);
        if (tan.lengthSq() > 1e-8) v.targetHeading = Math.atan2(tan.x, tan.z);
        setVisible(v, canSee(v, worldToHex(p.x, p.z)));
        // dust puffs at the feet
        const k = Math.floor((raw * dur) / stepEvery);
        if (ext && v.root.visible && k !== lastStep) {
          lastStep = k;
          ext.dust(v.root.position, mounted || v.monster === 'golem' ? 0.55 : 0.28, '#b9a888');
        }
      });
      placeAt(v, end);
      setVisible(v, canSee(v, end));
    } finally {
      v.movingTarget = 0;
      v.walkRate = 0;
      v.gait = 'walk';
      v.busy--;
      if (v.mixer && !v.monster && !v.dying) playLoop(v, v.mount ? 'ride_idle' : 'idle', 0.2);
    }
  }

  // ───────── death / spawn ─────────
  async function animateDeath(id: UnitId, speed: number): Promise<void> {
    const v = views.get(id);
    if (!v || v.dying) return;
    const sp = normSpeed(speed);
    v.dying = true;
    v.busy++;
    v.bar.visible = false;
    v.ring.visible = false;
    const faction = v.faction;
    try {
      let deathDur = 0.9 / sp;
      if (v.mixer && !v.monster) {
        const seated = seatedGlb(v);
        const d = playOnce(v, 'death', sp, true, seated ? 0 : 0.1);
        if (d) {
          deathDur = d.dur / sp;
          // The death clip stands on its feet: lower the rider so the fall starts from the saddle.
          if (seated) { v.rider.position.y -= v.standDrop; v.mixer.update(0); }
        } else {
          // GLB without a death clip: tip over
          await sched.tween(0.8 / sp, (t) => { v.monsterPose.tilt = -1.45 * easeInQuad(t); });
        }
        if (v.mount) {
          const m = v.mount.obj;
          const ry = v.rider.position.y;
          sched.tween(deathDur * 0.9, (t) => {
            m.rotation.z = 1.45 * easeInQuad(t);
            m.position.y = -0.05 * t;
            v.rider.position.y = lerp(ry, 0.02, easeInQuad(t));
            v.rider.position.x = 0.12 * t;
          });
        }
      } else {
        // monsters: tip over and slump
        await sched.tween(0.7 / sp, (t) => {
          v.monsterPose.tilt = -1.5 * easeInQuad(t);
          v.lift = -0.06 * t;
        });
        deathDur = 0.15 / sp;
      }
      await sched.wait(deathDur);
      const soul = v.race === 'undead' ? '#a77bff' : faction === 'neutral' ? '#d0c4a8' : factionHex(faction);
      ext?.wisps(anchorOf(v).setY(v.root.position.y + 0.15), soul, 16);
      ext?.dust(v.root.position, 0.7);
      const dissolveColor = v.race === 'undead' ? '#b07bff' : '#ff9a3c';
      const lift0 = v.lift;
      await sched.tween(0.9 / sp, (t) => {
        setDissolve(v, t, dissolveColor);
        v.lift = lift0 - 0.12 * easeInQuad(t);
      });
    } finally {
      disposeView(v);
    }
  }

  async function animateSpawn(id: UnitId, speed: number): Promise<void> {
    const sp = normSpeed(speed);
    let v = views.get(id);
    if (!v) {
      const u = lastState?.units[String(id)];
      if (!u) return;
      v = createView(u);
    }
    const view = v;
    const vis = canSee(view, view.pos);
    setVisible(view, vis);
    view.busy++;
    try {
      const color = factionHex(view.faction);
      if (!vis) return;
      const at = anchorOf(view);
      if (view.monster === 'elemental' || view.faction !== 'neutral') ext?.summonCircle(view.root.position, view.monster ? '#ffb347' : color, 1.2 / sp);
      fx.burst(at, view.monster === 'elemental' ? '#ffb347' : color, 30);
      ext?.sparkles(view.root.position.clone().add(new THREE.Vector3(0, 0.1, 0)), color, 20, 0.35, 1.0);
      view.ringMat.uniforms.uAlpha.value = 0;
      await sched.tween(0.85 / sp, (t) => {
        setDissolve(view, 1 - t, view.race === 'undead' ? '#b07bff' : '#ffd27a');
        view.lift = -0.18 * (1 - easeOutBack(t));
        view.ringMat.uniforms.uAlpha.value = t;
      });
    } finally {
      setDissolve(view, 0);
      view.lift = 0;
      view.ringMat.uniforms.uAlpha.value = 1;
      view.busy--;
    }
  }

  async function playClip(id: UnitId, clip: string, speed: number): Promise<void> {
    const v = views.get(id);
    if (!v || v.dying) return;
    const sp = normSpeed(speed);
    v.busy++;
    try {
      const name = seatedGlb(v) ? seatedClip(clip) : clip;
      if (v.mixer && !v.monster && name === null) {
        // seated GLB rider: react without leaving the saddle
        if (clip === 'death') await animateDeath(id, sp);
        else await flinch(v, new THREE.Vector3(-Math.sin(v.heading), 0, -Math.cos(v.heading)), sp);
      } else if (v.mixer && !v.monster && name !== null) {
        const d = playOnce(v, name, sp);
        if (name === 'cast' || clip === 'cast') {
          sched.wait(((d?.dur ?? 1) * 0.5) / sp).then(() => {
            const tip = tipOf(v);
            ext?.flash(tip, RACE_GLOW[v.race] ?? '#8fa8ff', 0.7, 0.35);
            ext?.sparkles(tip, RACE_GLOW[v.race] ?? '#8fa8ff', 12, 0.15, 0.6);
          });
        }
        if (name === 'work' && d) {
          const n = 2;
          for (let i = 0; i < n; i++) {
            sched.wait(((CLIP_IMPACT.work + i) * d.dur) / sp).then(() => { if (!v.dying) ext?.dust(tipOf(v), 0.3, '#c8b48c'); });
          }
          // 'work' is a loop: play it twice for a readable beat
          await sched.wait((d.dur * 2) / sp);
          playLoop(v, baseLoopName(v), 0.2);
          return;
        }
        await sched.wait((d?.dur ?? 0.6) / sp);
      } else if (clip === 'hit') {
        await flinch(v, new THREE.Vector3(-Math.sin(v.heading), 0, -Math.cos(v.heading)), sp);
      } else if (clip === 'death') {
        await animateDeath(id, sp);
      } else {
        const fwd = new THREE.Vector3(Math.sin(v.heading), 0, Math.cos(v.heading));
        await monsterStrike(v, fwd, sp, () => undefined);
      }
    } finally {
      if (views.has(id)) v.busy--;
    }
  }

  // ───────── sync ─────────
  function updateFromUnit(v: UnitView, u: Unit, state: GameState): void {
    v.status = statusOf(u, state);
    if (!v.busy) v.dispHp = u.hp;
    if (v.faction !== u.faction) v.faction = u.faction;
  }

  function sync(state: GameState, visible: (h: Hex) => boolean, _explored: (h: Hex) => boolean): void {
    lastState = state;
    visibleFn = visible;
    const seen = new Set<UnitId>();
    for (const key of Object.keys(state.units)) {
      const u = state.units[key];
      if (!u) continue;
      seen.add(u.id);
      let v = views.get(u.id);
      if (v?.dying) continue;
      if (!v) v = createView(u);
      else if (v.sig !== signature(u)) {
        buildModel(v, u);
      }
      updateFromUnit(v, u, state);
      if (!v.busy && (v.pos.q !== u.pos.q || v.pos.r !== u.pos.r || !Number.isFinite(v.root.position.y))) placeAt(v, u.pos);
      else if (!v.busy) {
        // terrain may have been rebuilt (new game) or a building raised: re-seat on the surface
        const w = hexXZ(u.pos, v);
        v.root.position.set(w.x, groundY(w.x, w.z), w.z);
      }
      if (!v.busy) setVisible(v, canSee(v, u.pos));
    }
    for (const v of [...views.values()]) {
      if (!seen.has(v.id) && !v.dying && !v.busy) disposeView(v);
    }
  }

  function refreshUnit(state: GameState, id: UnitId): void {
    lastState = state;
    const u = state.units[String(id)];
    const v = views.get(id);
    if (!u) return;
    if (!v) { const nv = createView(u); updateFromUnit(nv, u, state); setVisible(nv, canSee(nv, u.pos)); return; }
    if (v.dying) return;
    const changed = v.sig !== signature(u);
    if (changed) {
      const heading = v.heading;
      buildModel(v, u);
      v.heading = v.targetHeading = heading;
      if (v.root.visible) {
        const at = anchorOf(v);
        ext?.sparkles(at, FACTIONS[u.faction]?.accent ?? '#ffd76a', 18, 0.25, 0.7);
        ext?.flash(at, '#ffe9b0', 0.5, 0.25);
      }
    }
    updateFromUnit(v, u, state);
  }

  // ───────── per-frame ─────────
  function update(dt: number): void {
    if (!(dt > 0)) dt = 0;
    dt = Math.min(dt, 0.1);
    sched.update(dt);
    projScreen.multiplyMatrices(ctx.camera.projectionMatrix, ctx.camera.matrixWorldInverse);
    frustum.setFromProjectionMatrix(projScreen);
    const t = ctx.time;
    // The camera turned past a hex corner: idle units on buildings step round to the new front.
    if (refreshSector()) {
      for (const v of views.values()) if (!v.busy && !v.dying && buildingAt(v.pos)) placeAt(v, v.pos);
    }
    const vh = Math.max(1, ctx.viewportHeight?.() ?? 900);
    const tanHalf = Math.tan(THREE.MathUtils.degToRad(ctx.camera.fov) / 2);
    for (const v of views.values()) {
      v.animT += dt;
      if (!v.root.visible) continue;
      sphere.center.copy(v.root.position);
      sphere.center.y += 0.4;
      sphere.radius = 1.0;
      const onScreen = frustum.intersectsSphere(sphere);
      if (!onScreen && !v.busy) { updateRing(v); continue; }
      // facing & gait
      v.heading = dampAngle(v.heading, v.targetHeading, 9, dt);
      v.moving = damp(v.moving, v.movingTarget, 8, dt);
      v.body.rotation.y = v.heading;
      v.body.position.set(v.offset.x, v.lift + v.monsterPose.hop, v.offset.z);
      // flash decay
      if (v.flash > 0) { v.flash = Math.max(0, v.flash - dt * 5); applyFlash(v); }
      // skeleton
      v.mixer?.update(dt);
      // mounts
      let bob = 0;
      if (v.mount && !v.dying) {
        if (v.mount.rig) {
          animateQuadruped(v.mount.rig, v.animT, v.moving, true, v.seed % 7);
          bob = v.mount.rig.body.position.y;
        } else {
          const p = v.animT * Math.PI * 2 * 2.2;
          v.mount.obj.position.y = v.moving * 0.03 * Math.abs(Math.sin(p)) + 0.004 * Math.sin(v.animT * 1.3);
          v.mount.obj.rotation.x = v.moving * 0.035 * Math.sin(p * 2);
          bob = v.mount.obj.position.y;
        }
        // the rider follows the mount's gait
        v.rider.position.y = v.riderBaseY + bob;
      }
      if (v.monster) {
        if (v.monsterRig) animateMonster(v.monsterRig, v.animT, v.moving, v.seed % 11);
        else if (v.model) {
          const br = 1 + 0.015 * Math.sin(v.animT * 2.1) + v.moving * 0.03 * Math.abs(Math.sin(v.animT * 9));
          v.model.scale.y = v.model.scale.x * br;
        }
        const target = v.model;
        if (target) {
          // tip over around the bottom edge (not the centre) so the body lands on its side
          const tilt = v.monsterPose.tilt;
          const hw = MONSTER_HALF_WIDTH[v.monster] ?? 0.15;
          target.rotation.z = tilt;
          target.rotation.x = v.monsterPose.pitch;
          target.position.x = hw * (1 - Math.cos(tilt));
          target.position.y = -hw * Math.sin(tilt);
        }
        if (v.monsterRig && v.monsterRig.arms.length) {
          for (const arm of v.monsterRig.arms) arm.rotation.x += v.monsterPose.armSwing;
        }
      } else if (v.model && !v.procedural) {
        v.model.rotation.x = v.monsterPose.tilt;
      }
      // glows
      if (v.mainItem?.glow) v.mainItem.glow.scale.setScalar((v.mainItem.glow.userData.s0 ??= v.mainItem.glow.scale.x) * (0.9 + 0.12 * Math.sin(t * 3.1 + v.seed)));
      if (v.trinket) v.trinket.glow.scale.setScalar(0.12 + 0.03 * Math.sin(t * 2.4 + v.seed));
      // ring & bar
      v.ringMat.uniforms.uTime.value = t + (v.seed % 100) * 0.1;
      updateRing(v);
      // bars grow a little when zoomed out so they stay legible
      const camD = ctx.camera.position.distanceTo(v.root.position);
      const k = Math.min(1.9, Math.max(1, camD / 11));
      v.bar.scale.set(BAR_WORLD_W * k, (BAR_WORLD_W * k * BAR_H) / BAR_W, 1);
      // far out, a constant-size faction marker replaces the (then unreadable) body and bar
      const far = v.dying ? 0 : smoothstep(22, 28, camD);
      const markerH = (MARKER_PX * 2 * camD * tanHalf) / vh;
      if (far > 0.01) {
        const mk = ensureMarker(v);
        mk.sprite.visible = true;
        (mk.sprite.material as THREE.SpriteMaterial).opacity = far;
        mk.sprite.scale.set((markerH * MARK_W) / MARK_H, markerH, 1);
        mk.sprite.position.set(v.offset.x, v.topY * 0.6 + v.lift, v.offset.z);
        refreshMarker(v);
      } else if (v.marker) v.marker.sprite.visible = false;
      v.bar.visible = !v.dying && far < 0.99;
      (v.bar.material as THREE.SpriteMaterial).opacity = 1 - far;
      v.bar.position.set(v.offset.x, v.topY + v.lift + (far > 0.01 ? markerH * 0.45 * far : 0), v.offset.z);
      v.pickTop = v.topY + (far > 0.5 ? markerH * 0.45 : (BAR_WORLD_W * k * BAR_H) / BAR_W);
      v.pickR = far > 0.5 ? Math.max(0.3, (markerH * MARK_W) / MARK_H / 2) : Math.max(halfWidthOf(v) + 0.1, (BAR_WORLD_W * k) / 2 * 0.8);
      refreshStatus(v);
    }
  }

  function ensureMarker(v: UnitView): NonNullable<UnitView['marker']> {
    if (v.marker) return v.marker;
    const canvas = makeCanvas(MARK_W, MARK_H);
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    const mat = new THREE.SpriteMaterial({ map: tex, depthTest: false, depthWrite: false, transparent: true, fog: false });
    const sprite = new THREE.Sprite(mat);
    sprite.center.set(0.5, 0);
    sprite.renderOrder = 899;
    v.root.add(sprite);
    v.marker = { sprite, canvas, tex, key: '' };
    return v.marker;
  }
  function refreshMarker(v: UnitView): void {
    const mk = v.marker;
    if (!mk) return;
    const s = v.status;
    const hpB = Math.round(clamp01(v.dispHp / Math.max(1, s.maxHp)) * 10);
    const key = `${v.faction}|${s.level}|${s.leader}|${hpB}`;
    if (key === mk.key) return;
    mk.key = key;
    drawMarker(mk.canvas, factionHex(v.faction), FACTIONS[v.faction]?.accent ?? '#cccccc', s.level, s.leader, hpB / 10);
    mk.tex.needsUpdate = true;
  }

  /** Nearest unit under the ray: its body (where it is drawn: building front, lunges) or its always-on-top bar/marker. */
  function pick(ray: THREE.Ray): { hex: Hex; t: number } | null {
    let best: { hex: Hex; t: number } | null = null;
    const base = new THREE.Vector3();
    for (const v of views.values()) {
      if (!v.root.visible || v.dying) continue;
      base.copy(v.root.position).add(v.offset);
      base.y += v.lift;
      const body = rayCylinder(ray.origin, ray.direction, base, halfWidthOf(v) + 0.1, Math.max(0.2, v.topY - 0.06));
      tmpV.copy(base); tmpV.y += v.topY - 0.06;
      const top = rayCylinder(ray.origin, ray.direction, tmpV, v.pickR, Math.max(0.05, v.pickTop - v.topY + 0.06));
      const t = body === null ? top : top === null ? body : Math.min(body, top);
      if (t !== null && (!best || t < best.t)) best = { hex: { ...v.pos }, t };
    }
    return best;
  }

  function dispose(): void {
    sched.clear();
    for (const v of [...views.values()]) disposeView(v);
    views.clear();
    gemGeo.dispose();
    for (const m of gemMats.values()) m.dispose();
    gemMats.clear();
    for (const m of xrayMats.values()) m.dispose();
    xrayMats.clear();
    ctx.scene.remove(root);
    ctx.scene.remove(ringGroup);
  }

  return {
    sync, update, dispose, animateMove, animateCombat, animateDeath, animateSpawn, playClip, refreshUnit, pick,
    unitAnchor(id: UnitId): THREE.Vector3 | null {
      const v = views.get(id);
      if (!v) return null;
      return anchorOf(v);
    },
  };
};
