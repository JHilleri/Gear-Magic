// Entities lab (dev/entities.html): a small fake scene implementing RenderContext so the unit,
// building, overlay and fx layers can be inspected and every animation / effect triggered.
// ?glb=1 loads the rigged unit GLBs found in public/assets/models/units (no manifest needed).
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import type {
  AttackKind, Building, BuildingId, FactionId, GameState, Hex, ItemId, MonsterKind, RaceId, ReachInfo, SpellId, StrikeEvent, Unit, UnitId,
} from '../core/types';
import { hexCorner, hexToWorld, inBounds, offsetToAxial, axialToOffset, spiral, tileIndex, neighbors } from '../core/hex';
import { FACTIONS } from '../data/factions';
import { COMMONER_STATS, LEADER_STATS } from '../data/presets';
import { SPELLS } from '../data/spells';
import { zeroXp } from '../data/skills';
import { emptyManifest } from '../render/assets';
import type { AssetLibrary, RenderContext, SkinnedAsset } from '../render/types';
import type { OverlayState } from '../render/index';
import { createFxLayer } from '../render/fx';
import { createUnitLayer } from '../render/units';
import { createBuildingLayer } from '../render/buildings';
import { createOverlayLayer } from '../render/overlays';

const W = 22, H = 15;
const params = new URLSearchParams(location.search);

// ───────────── terrain stub ─────────────
function heightAt(x: number, z: number): number {
  const hill = 0.45 * Math.exp(-((x - 30) ** 2 + (z - 6) ** 2) / 10);
  return 0.05 * Math.sin(x * 0.7) * Math.cos(z * 0.55) + 0.03 * Math.sin(x * 1.9 + z * 1.3) + hill;
}

const canvas = document.getElementById('scene') as HTMLCanvasElement;
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
const scene = new THREE.Scene();
scene.background = new THREE.Color('#8fa7c2');
scene.fog = new THREE.FogExp2(0x8fa7c2, 0.012);
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
scene.environmentIntensity = 0.35;
const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 400);
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.maxPolarAngle = Math.PI * 0.47;

scene.add(new THREE.HemisphereLight(0xc8dcff, 0x5a4a32, 1.1));
const sun = new THREE.DirectionalLight(0xfff0d6, 2.8);
sun.position.set(-12, 22, 14);
sun.castShadow = true;
sun.shadow.mapSize.set(4096, 4096);
sun.shadow.camera.left = -28; sun.shadow.camera.right = 28; sun.shadow.camera.top = 22; sun.shadow.camera.bottom = -22;
sun.shadow.camera.near = 1; sun.shadow.camera.far = 80;
sun.shadow.bias = -0.0004;
sun.shadow.normalBias = 0.02;
sun.shadow.radius = 3;
const sunTarget = new THREE.Object3D();
scene.add(sun, sunTarget);
sun.target = sunTarget;

// terrain mesh + hex grid
const c00 = hexToWorld(offsetToAxial(0, 0)), c11 = hexToWorld(offsetToAxial(W - 1, H - 1));
const tw = c11.x - c00.x + 4, td = c11.z - c00.z + 4;
const tgeo = new THREE.PlaneGeometry(tw, td, Math.round(tw * 5), Math.round(td * 5)).rotateX(-Math.PI / 2);
tgeo.translate((c00.x + c11.x) / 2, 0, (c00.z + c11.z) / 2);
{
  const pos = tgeo.getAttribute('position');
  const col: number[] = [];
  const a = new THREE.Color('#5d7f3a'), b = new THREE.Color('#7f9445'), d = new THREE.Color('#8a7a52');
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), z = pos.getZ(i);
    pos.setY(i, heightAt(x, z));
    const n = 0.5 + 0.5 * Math.sin(x * 1.7 + Math.sin(z * 1.3) * 2) * Math.cos(z * 1.1);
    const c = a.clone().lerp(b, n).lerp(d, Math.max(0, Math.sin(x * 0.4 + z * 0.9)) * 0.25);
    col.push(c.r, c.g, c.b);
  }
  tgeo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  tgeo.computeVertexNormals();
}
const terrain = new THREE.Mesh(tgeo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95 }));
terrain.receiveShadow = true;
scene.add(terrain);
{
  const pts: number[] = [];
  for (let row = 0; row < H; row++) for (let col = 0; col < W; col++) {
    const h = offsetToAxial(col, row);
    const c = hexToWorld(h);
    for (let i = 0; i < 6; i++) {
      const p = hexCorner(i), q = hexCorner((i + 1) % 6);
      for (let s = 0; s < 3; s++) {
        const x0 = c.x + p.x + (q.x - p.x) * (s / 3), z0 = c.z + p.z + (q.z - p.z) * (s / 3);
        const x1 = c.x + p.x + (q.x - p.x) * ((s + 1) / 3), z1 = c.z + p.z + (q.z - p.z) * ((s + 1) / 3);
        pts.push(x0, heightAt(x0, z0) + 0.012, z0, x1, heightAt(x1, z1) + 0.012, z1);
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  scene.add(new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: 0x1c2410, transparent: true, opacity: 0.25 })));
}

// ───────────── fake state ─────────────
let nextId = 1;
const state: GameState = {
  version: 1, settings: { mapSize: 'small', seed: 1, playerFaction: 'valen', aiCount: 2, difficulty: 'normal' },
  width: W, height: H,
  tiles: Array.from({ length: W * H }, (_, i) => ({ terrain: 'grass' as const, deposit: null, elevation: 0.5, building: null, variant: (i * 7) % 6 })),
  units: {}, buildings: {}, factions: {}, turnOrder: ['valen', 'thorn', 'ashen'], currentTurn: 0, round: 3, nextId: 1, rngState: 1, log: [], winner: null, gameOver: false,
};
const SLOT: Record<ItemId, keyof Unit['equipment']> = { tools: 'main', sword: 'main', spear: 'main', axe: 'main', bow: 'main', staff: 'main', wand: 'main', shield: 'off', tunic: 'body', leather: 'body', plate: 'body', robe: 'body', amulet: 'trinket', ring: 'trinket', horse: 'mount' };

function addUnit(faction: FactionId, col: number, row: number, items: ItemId[], opts: Partial<Unit> = {}): Unit {
  const id = nextId++;
  const base = { ...(opts.isLeader ? LEADER_STATS : COMMONER_STATS) };
  const u: Unit = {
    id, faction, name: `${FACTIONS[faction].name.split(' ')[0]} ${id}`, race: FACTIONS[faction].race, isLeader: false, pos: offsetToAxial(col, row),
    hp: base.maxHp, base, level: 1 + (id % 4), xp: 0,
    xpByCat: zeroXp(), levelXpByCat: zeroXp(),
    pendingLevelUps: 0, levelUpOptions: [], equipment: { main: null, off: null, body: null, trinket: null, mount: null },
    efficiency: {}, passives: [], actives: [], cooldowns: {}, buffs: [], poisoned: false, mp: 5, acted: false, moved: false, restedLastTurn: false, kills: 0,
    ...opts,
  };
  for (const it of items) u.equipment[SLOT[it]] = it;
  state.units[String(id)] = u;
  return u;
}
function addBuilding(type: BuildingId, owner: FactionId | null, col: number, row: number, opts: Partial<Building> = {}): Building {
  const id = nextId++;
  const b: Building = { id, type, owner, pos: offsetToAxial(col, row), level: 1, buildLeft: 0, upgrading: false, recruitedThisTurn: false, craftedThisTurn: 0, foundedRound: 0, ...opts };
  state.buildings[String(id)] = b;
  state.tiles[tileIndex(b.pos, W)].building = id;
  return b;
}

const LOADOUTS: { name: string; items: ItemId[]; leader?: boolean }[] = [
  { name: 'Commoner', items: [] },
  { name: 'Builder', items: ['tools', 'tunic'] },
  { name: 'Swordsman', items: ['sword', 'tunic'] },
  { name: 'Spearman', items: ['spear', 'leather'] },
  { name: 'Axeman', items: ['axe', 'leather', 'shield'] },
  { name: 'Archer', items: ['bow', 'leather'] },
  { name: 'Knight', items: ['sword', 'shield', 'plate', 'horse'] },
  { name: 'Apprentice', items: ['wand', 'robe'] },
  { name: 'Battle Mage', items: ['staff', 'robe', 'ring'] },
  { name: 'Leader', items: ['sword', 'shield', 'amulet'], leader: true },
  { name: 'Rider Archer', items: ['bow', 'leather', 'horse'] },
];
const rows: [FactionId, number][] = [['valen', 1], ['thorn', 3], ['ashen', 5]];
for (const [f, row] of rows) {
  LOADOUTS.forEach((l, i) => {
    const u = addUnit(f, 2 + i, row, l.items, { isLeader: !!l.leader, name: `${l.name}` });
    if (l.leader) { u.pendingLevelUps = 1; u.level = 4; }
    if (l.name === 'Archer') { u.poisoned = true; u.hp = Math.round(u.hp * 0.4); }
    if (l.name === 'Spearman') u.buffs = [{ id: 'bless', turns: 2 }, { id: 'haste', turns: 1 }];
    if (l.name === 'Swordsman') u.hp = Math.round(u.hp * 0.65);
  });
}
const MONSTER_KINDS: MonsterKind[] = ['wolf', 'spider', 'golem', 'elemental'];
MONSTER_KINDS.forEach((k, i) => addUnit(k === 'elemental' ? 'valen' : 'neutral', 2 + i * 2, 7, [], { race: 'monster', monster: k, name: k, summonTurns: k === 'elemental' ? 6 : undefined, base: { ...COMMONER_STATS, maxHp: 40 }, hp: 40 }));
// duel arena
const duelA = addUnit('valen', 12, 7, ['sword', 'shield', 'plate']);
const duelB = addUnit('thorn', 13, 7, ['axe', 'leather']);
const duelC = addUnit('ashen', 15, 8, ['staff', 'robe']);
const duelD = addUnit('valen', 17, 8, ['bow', 'leather']);

const BTYPES: BuildingId[] = ['castle', 'house', 'farm', 'lumber', 'quarry', 'forge', 'training', 'mine', 'crystalmine', 'library', 'magetower', 'wall', 'watchtower', 'shrine'];
BTYPES.forEach((t, i) => addBuilding(t, i === 0 ? 'valen' : (['valen', 'thorn', 'ashen'] as FactionId[])[i % 3], 1 + (i % 7) * 2 + (i >= 7 ? 1 : 0), 10 + (i >= 7 ? 2 : 0), { level: 1 + (i % 3) }));
const site = addBuilding('library', 'valen', 16, 10, { buildLeft: 2 });
const upg = addBuilding('house', 'thorn', 18, 10, { buildLeft: 2, upgrading: true, level: 1 });
addBuilding('farm', null, 16, 12);
addBuilding('forge', 'ashen', 20, 12);
addBuilding('magetower', 'thorn', 20, 10);
const fogCols = new Set([20, 21]);

for (const f of ['valen', 'thorn', 'ashen', 'neutral'] as FactionId[]) {
  state.factions[f] = {
    id: f, isHuman: f === 'valen', alive: true, resources: { gold: 0, food: 0, wood: 0, stone: 0, iron: 0, crystal: 0, mana: 0, research: 0 },
    income: { gold: 0, food: 0, wood: 0, stone: 0, iron: 0, crystal: 0, mana: 0, research: 0 }, stockpile: {}, techs: [], researching: null, researchProgress: 0,
    spellCooldowns: {}, explored: new Array(W * H).fill(1), visible: new Array(W * H).fill(1), farsight: [], leaderId: null, castleId: null,
    stats: { kills: 0, lost: 0, built: 0, researched: 0, spellsCast: 0 },
  };
}
state.nextId = nextId;

// ───────────── assets ─────────────
async function devAssets(): Promise<AssetLibrary> {
  const manifest = emptyManifest();
  const skinned = new Map<string, SkinnedAsset>();
  if (params.get('glb') === '1') {
    const loader = new GLTFLoader();
    const keys: string[] = [];
    for (const r of ['human', 'orc', 'undead']) for (const b of ['commoner', 'light', 'heavy', 'robe', 'leader']) keys.push(`${r}_${b}`);
    await Promise.all(keys.map(async (k) => {
      try {
        const res = await fetch(`/assets/models/units/${k}.glb`, { method: 'HEAD' });
        if (!res.ok || (res.headers.get('content-type') ?? '').includes('html')) return;
        const g = await loader.loadAsync(`/assets/models/units/${k}.glb`);
        g.scene.traverse((o) => { if ((o as THREE.Mesh).isMesh) { o.castShadow = true; o.receiveShadow = true; } });
        skinned.set(k, { scene: g.scene, animations: g.animations });
        manifest.units[k] = { file: `models/units/${k}.glb`, height: 1.0 };
      } catch { /* procedural fallback */ }
    }));
    console.info('[entities-dev] GLB units:', [...skinned.keys()].join(', ') || 'none');
  }
  return {
    manifest,
    model: () => null,
    skinned: (key) => skinned.get(key) ?? null,
    texture: () => null,
    iconUrl: () => null,
    portraitUrl: () => null,
  };
}

// ───────────── render context ─────────────
let shakeAmt = 0;
const ctx: RenderContext = {
  scene, camera, renderer, assets: null as unknown as AssetLibrary,
  heightAt,
  hexCenter(h: Hex) { const w = hexToWorld(h); return new THREE.Vector3(w.x, heightAt(w.x, w.z), w.z); },
  factionColor(f: FactionId | null) { return new THREE.Color(f ? FACTIONS[f].color : '#9e9a8f'); },
  shake(a: number) { shakeAmt = Math.min(1, Math.max(shakeAmt, a)); },
  viewer: 'valen',
  time: 0,
};
const visible = (h: Hex) => inBounds(h, W, H) && !fogCols.has(axialToOffset(h).col);
const explored = (h: Hex) => inBounds(h, W, H);

async function main(): Promise<void> {
  ctx.assets = await devAssets();
  const fx = createFxLayer(ctx);
  const units = createUnitLayer(ctx, fx);
  const buildings = createBuildingLayer(ctx, fx);
  const overlays = createOverlayLayer(ctx);
  // first sync with fog disabled so the far-right buildings are remembered, then fog them
  const allVis = (h: Hex) => inBounds(h, W, H);
  buildings.sync(state, allVis, explored);
  units.sync(state, visible, explored);
  buildings.sync(state, visible, explored);

  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  const bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.55, 0.45, 0.9);
  composer.addPass(bloom);
  composer.addPass(new OutputPass());

  const resize = () => {
    const w = window.innerWidth, h = window.innerHeight;
    renderer.setSize(w, h, false);
    composer.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  };
  window.addEventListener('resize', resize);
  resize();

  const focus = (col: number, row: number, dist = 7, yaw = 0, pitch = 0.75) => {
    const c = hexToWorld(offsetToAxial(col, row));
    controls.target.set(c.x, heightAt(c.x, c.z) + 0.3, c.z);
    camera.position.set(c.x + Math.sin(yaw) * Math.cos(pitch) * dist, c.z * 0 + Math.sin(pitch) * dist, c.z + Math.cos(yaw) * Math.cos(pitch) * dist);
    controls.update();
  };
  focus(7, 3, 11);

  // ───── overlays state ─────
  const ov: OverlayState = {
    selectedUnit: null, hoverHex: null, reach: [], path: [], attackable: [], forecastTarget: null, areaCenter: null, areaRadius: 0, areaValid: true,
    spellRanges: [], showGrid: true,
  };
  let speed = 1;
  const U = (id: number) => state.units[String(id)];

  function reachFor(u: Unit, r: number): ReachInfo[] {
    return spiral(u.pos, r).slice(1).filter((h) => inBounds(h, W, H)).map((h) => {
      const d = Math.max(Math.abs(h.q - u.pos.q), Math.abs(h.r - u.pos.r), Math.abs(h.q + h.r - u.pos.q - u.pos.r));
      return { hex: h, cost: d, mpLeft: Math.max(0, r - d), path: [h], zocStop: (h.q * 3 + h.r) % 7 === 0 };
    });
  }

  // ───── actions ─────
  const dev = {
    state, units, buildings, overlays, fx, ctx, camera, controls, focus, duel: { A: duelA.id, B: duelB.id, C: duelC.id, D: duelD.id },
    setSpeed(s: number) { speed = s; },
    /** Frame the midpoint of some units from the front (yaw 0 = camera on +Z). */
    frame(ids: number[], dist = 4, yaw = 0, pitch = 0.42) {
      const pts = ids.map((i) => U(i)).filter(Boolean).map((u) => hexToWorld(u.pos));
      if (!pts.length) return;
      const x = pts.reduce((s, p) => s + p.x, 0) / pts.length, z = pts.reduce((s, p) => s + p.z, 0) / pts.length;
      controls.target.set(x, heightAt(x, z) + 0.3, z);
      camera.position.set(x + Math.sin(yaw) * Math.cos(pitch) * dist, heightAt(x, z) + 0.3 + Math.sin(pitch) * dist, z + Math.cos(yaw) * Math.cos(pitch) * dist);
      controls.update();
    },
    move(id: UnitId, steps: Hex[]) {
      const u = U(id);
      const path = steps;
      u.pos = { ...path[path.length - 1] };
      return units.animateMove(id, path, speed).then(() => units.sync(state, visible, explored));
    },
    walkLoop(id: UnitId) {
      const u = U(id);
      const start = { ...u.pos };
      const p1 = { q: start.q, r: start.r + 1 }, p2 = { q: start.q + 1, r: start.r + 1 }, p3 = { q: start.q + 1, r: start.r };
      return dev.move(id, [p1, p2, p3, start]);
    },
    combat(a: UnitId, d: UnitId, kind: AttackKind, strikes?: StrikeEvent[]) {
      const st: StrikeEvent[] = strikes ?? [
        { by: 'attacker', hit: true, damage: 7 }, { by: 'defender', hit: false, damage: 0 },
        { by: 'attacker', hit: true, damage: 12, poisoned: kind === 'melee' }, { by: 'defender', hit: true, damage: 5 },
        { by: 'attacker', hit: false, damage: 0 },
      ];
      return units.animateCombat(a, d, kind, st, speed).then(() => {
        for (const s of st) {
          const tgt = U(s.by === 'attacker' ? d : a);
          if (s.hit && tgt) tgt.hp = Math.max(1, tgt.hp - s.damage);
        }
        units.sync(state, visible, explored);
      });
    },
    kill(id: UnitId) {
      const u = U(id);
      if (!u) return Promise.resolve();
      const copy = structuredClone(u);
      return units.animateDeath(id, speed).then(() => {
        delete state.units[String(id)];
        units.sync(state, visible, explored);
        // respawn for the next round of testing
        setTimeout(() => { state.units[String(id)] = copy; copy.hp = copy.base.maxHp; units.animateSpawn(id, speed); }, 600);
      });
    },
    clip(id: UnitId, name: string) { return units.playClip(id, name, speed); },
    spell(spell: SpellId, fromCol = 9, fromRow = 12, toCol = 9, toRow = 8) {
      const from = ctx.hexCenter(offsetToAxial(fromCol, fromRow)).add(new THREE.Vector3(0, 1.15, 0));
      const to = ctx.hexCenter(offsetToAxial(toCol, toRow));
      return fx.spell(spell, from, to, SPELLS[spell].radius, speed);
    },
    numbers() {
      const at = units.unitAnchor(duelB.id)!;
      fx.damageNumber(at, '-12', '#ff4d3d');
      setTimeout(() => fx.damageNumber(at, '+8', '#5be07a'), 200);
      setTimeout(() => fx.damageNumber(at, 'miss', '#c9c9c9'), 400);
    },
    construct() { const b = state.buildings[String(site.id)]; b.buildLeft = Math.max(0, b.buildLeft - 1); buildings.sync(state, visible, explored); if (b.buildLeft === 0) return buildings.animateConstructed(site.id, speed); return Promise.resolve(); },
    resetSite() { const b = state.buildings[String(site.id)]; b.buildLeft = 3; b.upgrading = false; buildings.sync(state, visible, explored); },
    destroy(id: number) {
      const b = state.buildings[String(id)];
      if (!b) return Promise.resolve();
      const copy = structuredClone(b);
      return buildings.animateDestroyed(id, speed).then(() => {
        delete state.buildings[String(id)];
        buildings.sync(state, visible, explored);
        setTimeout(() => { state.buildings[String(id)] = copy; copy.buildLeft = 2; buildings.sync(state, visible, explored); }, 900);
      });
    },
    select(id: UnitId | null) {
      ov.selectedUnit = id;
      const u = id !== null ? U(id) : null;
      ov.reach = u ? reachFor(u, 3) : [];
      if (u) {
        const t1 = neighbors(u.pos)[5], t2 = neighbors(t1)[5], t3 = neighbors(t2)[0];
        ov.path = [t1, t2, t3];
        ov.hoverHex = t3;
        ov.attackable = Object.values(state.units).filter((o) => o.faction !== u.faction && Math.abs(o.pos.r - u.pos.r) <= 2 && Math.abs(o.pos.q - u.pos.q) <= 3).slice(0, 3).map((o) => o.id);
        ov.forecastTarget = ov.attackable[0] ?? null;
      } else { ov.path = []; ov.hoverHex = null; ov.attackable = []; ov.forecastTarget = null; }
      overlays.set(ov, state);
    },
    aoe(col: number, row: number, r: number, valid: boolean) { ov.areaCenter = offsetToAxial(col, row); ov.areaRadius = r; ov.areaValid = valid; overlays.set(ov, state); },
    range(on: boolean) { ov.spellRanges = on ? [{ pos: offsetToAxial(13, 12), range: 4 }] : []; overlays.set(ov, state); },
    clearOverlays() { ov.areaCenter = null; dev.range(false); dev.select(null); },
    equipCycle(id: UnitId) {
      const u = U(id);
      const mains: (ItemId | null)[] = [null, 'tools', 'sword', 'spear', 'axe', 'bow', 'staff', 'wand'];
      const i = mains.indexOf(u.equipment.main);
      u.equipment.main = mains[(i + 1) % mains.length];
      if (u.equipment.main === 'bow' || u.equipment.main === 'staff') u.equipment.off = null;
      units.refreshUnit(state, id);
    },
  };
  (window as unknown as { dev: typeof dev }).dev = dev;

  // ───── panel ─────
  const panel = document.getElementById('panel')!;
  const el = (tag: string, text?: string, onClick?: () => void) => {
    const e = document.createElement(tag);
    if (text) e.textContent = text;
    if (onClick) e.addEventListener('click', () => { try { const r = (onClick as () => unknown)(); if (r instanceof Promise) r.catch(console.error); } catch (err) { console.error(err); } });
    return e;
  };
  const section = (title: string) => { panel.append(el('h2', title)); };
  panel.append(el('h1', 'Entities Lab'));
  const unitSel = document.createElement('select');
  const targetSel = document.createElement('select');
  const refreshSelects = () => {
    for (const sel of [unitSel, targetSel]) {
      const prev = sel.value;
      sel.innerHTML = '';
      for (const u of Object.values(state.units)) {
        const o = document.createElement('option');
        o.value = String(u.id);
        o.textContent = `#${u.id} ${u.faction} · ${u.monster ?? u.race} · ${u.name}`;
        sel.append(o);
      }
      if (prev) sel.value = prev;
    }
  };
  refreshSelects();
  unitSel.value = String(duelA.id);
  targetSel.value = String(duelB.id);
  const sel = () => Number(unitSel.value);
  const tgt = () => Number(targetSel.value);
  section('Unit');
  panel.append(unitSel, el('div', 'target:'), targetSel);
  const row1 = el('div');
  row1.append(
    el('button', 'Walk', () => dev.walkLoop(sel())),
    el('button', 'Melee', () => dev.combat(sel(), tgt(), 'melee')),
    el('button', 'Ranged', () => dev.combat(sel(), tgt(), 'ranged')),
    el('button', 'Magic', () => dev.combat(sel(), tgt(), 'magic')),
    el('button', 'Death', () => dev.kill(sel())),
    el('button', 'Equip↻', () => dev.equipCycle(sel())),
  );
  panel.append(row1);
  const row2 = el('div');
  for (const c of ['idle', 'walk', 'attack_melee', 'attack_ranged', 'cast', 'hit', 'work', 'ride_idle', 'ride_attack']) row2.append(el('button', c, () => dev.clip(sel(), c)));
  panel.append(row2);
  section('Fx');
  const row3 = el('div');
  row3.append(
    el('button', 'Arrow', () => fx.projectile(units.unitAnchor(duelD.id)!, units.unitAnchor(duelC.id)!, 'ranged', speed)),
    el('button', 'Orb', () => fx.projectile(units.unitAnchor(duelC.id)!, units.unitAnchor(duelD.id)!, 'magic', speed)),
    el('button', 'Numbers', () => dev.numbers()),
    el('button', 'Burst', () => fx.burst(units.unitAnchor(duelB.id)!, '#e8c35a', 30)),
    el('button', 'Sparks', () => { const a = units.unitAnchor(duelB.id)!; fx.hitSpark(a, 'melee'); setTimeout(() => fx.hitSpark(a, 'ranged'), 300); setTimeout(() => fx.hitSpark(a, 'magic'), 600); }),
    el('button', 'Level up', () => fx.levelUp(units.unitAnchor(duelA.id)!)),
  );
  panel.append(row3);
  const row4 = el('div');
  for (const s of Object.keys(SPELLS) as SpellId[]) row4.append(el('button', s, () => dev.spell(s)));
  panel.append(row4);
  section('Buildings');
  const row5 = el('div');
  row5.append(
    el('button', 'Build step', () => dev.construct()),
    el('button', 'Reset site', () => dev.resetSite()),
    el('button', 'Destroy forge', () => dev.destroy(Object.values(state.buildings).find((b) => b.type === 'forge')!.id)),
    el('button', 'Upgrade step', () => { const b = state.buildings[String(upg.id)]; b.buildLeft = Math.max(0, b.buildLeft - 1); if (b.buildLeft === 0) { b.upgrading = false; b.level = Math.min(3, b.level + 1); } buildings.sync(state, visible, explored); }),
    el('button', 'Toggle fog', () => { if (fogCols.size) fogCols.clear(); else { fogCols.add(20); fogCols.add(21); } units.sync(state, visible, explored); buildings.sync(state, visible, explored); }),
  );
  panel.append(row5);
  section('Overlays');
  const row6 = el('div');
  row6.append(
    el('button', 'Select', () => dev.select(sel())),
    el('button', 'AoE ok', () => dev.aoe(9, 8, 1, true)),
    el('button', 'AoE bad', () => dev.aoe(9, 8, 2, false)),
    el('button', 'Spell range', () => dev.range(true)),
    el('button', 'Clear', () => dev.clearOverlays()),
  );
  panel.append(row6);
  section('View');
  const row7 = el('div');
  row7.append(
    el('button', 'Humans', () => focus(7, 1, 7)),
    el('button', 'Orcs', () => focus(7, 3, 7)),
    el('button', 'Undead', () => focus(7, 5, 7)),
    el('button', 'Monsters', () => focus(5, 7, 7)),
    el('button', 'Duel', () => focus(13, 7, 5)),
    el('button', 'Buildings', () => focus(7, 11, 9)),
    el('button', 'Overview', () => focus(10, 7, 22)),
  );
  panel.append(row7);
  const row8 = el('div');
  for (const s of [0.5, 1, 2, 4]) row8.append(el('button', `×${s}`, () => { speed = s; }));
  panel.append(row8);

  // ───── loop ─────
  const stats = document.getElementById('stats')!;
  const clock = new THREE.Timer();
  let frames = 0, acc = 0;
  const camOffset = new THREE.Vector3();
  // manual clock (deterministic captures): dev.pause(); dev.advance(seconds)
  let paused = false;
  const step = (dt: number, render: boolean) => {
    ctx.time += dt;
    controls.update();
    camera.position.sub(camOffset);
    camOffset.set(0, 0, 0);
    if (shakeAmt > 0.001) {
      const s = shakeAmt * shakeAmt * 0.18;
      camOffset.set(Math.sin(ctx.time * 50) * s, Math.cos(ctx.time * 63) * s, 0);
      camera.position.add(camOffset);
      shakeAmt *= Math.exp(-5 * dt);
    }
    camera.updateMatrixWorld();
    sunTarget.position.copy(controls.target);
    sun.position.copy(controls.target).add(new THREE.Vector3(-12, 22, 14));
    units.update(dt);
    buildings.update(dt);
    overlays.update(dt);
    fx.update(dt);
    if (render) composer.render();
  };
  Object.assign(dev, {
    pause() { paused = true; },
    resume() { paused = false; clock.update(); },
    /** Advance the simulation by `sec` in 1/60 s steps (promises resolve between steps), then render once. */
    async advance(sec: number) {
      const n = Math.max(1, Math.round(sec * 60));
      for (let i = 0; i < n; i++) { step(1 / 60, false); await Promise.resolve(); await Promise.resolve(); }
      composer.render();
    },
  });
  const tick = () => {
    clock.update();
    const dt = Math.min(0.1, clock.getDelta());
    if (!paused) {
      step(dt, true);
      frames++; acc += dt;
      if (acc > 0.5) { stats.textContent = `${Math.round(frames / acc)} fps · ${renderer.info.render.calls} calls · ${renderer.info.render.triangles} tris`; frames = 0; acc = 0; }
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

main().catch((e) => console.error('[entities-dev]', e));
void ({} as RaceId);
