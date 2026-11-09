// Economy AI: what to build and where (site scoring), builder management, upgrades, crafting,
// equipping from the stockpile and recruitment. DESIGN §9 "Economy planner" / "Recruitment".
import type {
  Action, Building, BuildingId, EquipSlot, Hex, ItemId, PresetId, ResourceCost, ResourceId, Resources, Unit,
} from '../../core/types';
import { hexDistance, hexEq, inBounds, indexToHex, neighbors, spiral, tileIndex } from '../../core/hex';
import { BUILDINGS } from '../../data/buildings';
import { ITEMS } from '../../data/items';
import { COMMONER_COST, PRESETS } from '../../data/presets';
import { TERRAIN } from '../../data/terrain';
import { FACTIONS } from '../../data/factions';
import {
  canAfford, computeTerritory, forgeCapacity, maxBuildingLevel, presetCost, recruitSpawnHex, upgradeCost,
} from '../economy';
import { buildingUnlocked, hasTech, itemUnlocked, presetUnlocked } from '../research';
import { canBuildWith, costValue } from '../units';
import { isOperational } from '../state';
import { buildingOn, unitOn } from '../ruleutil';
import {
  COMPOSITION, SLOT_ORDER, desiredLoadout, itemPriority, loadoutQuality, mageWeaponFor, meleeWeaponFor, stockedWeapon, trackAvailable, trackOf,
  trackOfItem,
} from './loadout';
import { moveToward } from './movement';
import { getStrategy } from './strategy';
import { attackersOn, exposureAt } from './threat';
import type { BuildTask, Ctx, Track } from './types';
import { attempt, claim, claimedByOther, incomeOf, isHeldSite, reachOf } from './util';

const RES: ResourceId[] = ['gold', 'food', 'wood', 'stone', 'iron', 'crystal', 'mana'];
/** Kept back for an emergency recruit (castle defence) unless the castle is actually threatened. */
const DEFENSE_RESERVE: ResourceCost = { gold: 15, food: 5 };

const functional = (b: Building | undefined): b is Building => !!b && b.owner !== null && isOperational(b);

function subtract(r: Resources, c: ResourceCost): void {
  for (const k of RES) if (c[k]) r[k] = Math.max(0, (r[k] ?? 0) - c[k]!);
}
function addTo(a: ResourceCost, b: ResourceCost): void {
  for (const k of RES) if (b[k]) a[k] = (a[k] ?? 0) + b[k]!;
}

/** Turns of income needed before `cost` is affordable from `avail` (Infinity if a resource never comes). */
function turnsToAfford(avail: Resources, cost: ResourceCost, inc: Resources): number {
  let worst = 0;
  for (const k of RES) {
    const need = (cost[k] ?? 0) - (avail[k] ?? 0);
    if (need <= 1e-9) continue;
    const per = inc[k] ?? 0;
    if (per <= 0.05) return Infinity;
    worst = Math.max(worst, need / per);
  }
  return worst;
}

function countTypes(ctx: Ctx): Partial<Record<BuildingId, number>> {
  const c: Partial<Record<BuildingId, number>> = {};
  for (const b of ctx.own) c[b.type] = (c[b.type] ?? 0) + 1;
  return c;
}

/** One builder per ~4 buildings, between 1 and 3. */
export function builderTarget(ctx: Ctx): number {
  return Math.max(1, Math.min(3, Math.round(ctx.own.length / 4)));
}

/** A builder standing on its own unfinished construction (it keeps working). */
function workingSite(ctx: Ctx, u: Unit): Building | undefined {
  const b = buildingOn(ctx.s, u.pos);
  return b && b.owner === ctx.f && b.buildLeft > 0 ? b : undefined;
}

// ───────────────────────────── what to build ─────────────────────────────

/** Buildings wanted next, most important first (one entry per building instance). */
function desiredQueue(ctx: Ctx): BuildingId[] {
  const { s, f } = ctx;
  const c = countTypes(ctx);
  const planned: Partial<Record<BuildingId, number>> = {};
  const q: BuildingId[] = [];
  const n = (t: BuildingId) => (c[t] ?? 0) + (planned[t] ?? 0);
  const want = (t: BuildingId, upTo: number) => {
    if (BUILDINGS[t].unlockSkill) {
      if (!ctx.builders.some((b) => b.actives.includes(BUILDINGS[t].unlockSkill!))) return;
    } else if (!buildingUnlocked(s, f, t)) return;
    if (n(t) < upTo) { q.push(t); planned[t] = (planned[t] ?? 0) + 1; }
  };
  const has = (t: Parameters<typeof hasTech>[2]) => hasTech(s, f, t);
  const strat = getStrategy(ctx);
  const inc = incomeOf(ctx);
  let food = inc.food;
  const upkeep = FACTIONS[f].foodUpkeep;
  const growth = Math.max(0, strat.armyTarget - ctx.military.length);
  const foodNeed = 1 + Math.min(6, growth) * upkeep * 0.7;
  const farm = () => {
    if (food < foodNeed && n('farm') < 10) { want('farm', 99); food += 3; }
  };
  const threatened = strat.castleThreat > 0 || strat.intruders.some((e) => e.faction !== 'neutral');

  // Producers follow scarcity: another camp / quarry / house only while that resource runs low
  // (stone and gold pile up otherwise, and nothing else can be bought with them).
  const res = ctx.fs.resources;
  const scarce = {
    wood: res.wood < 40 && inc.wood < 14,
    stone: res.stone < 30 && inc.stone < 9 && (c.quarry ?? 0) >= 1,
    // Recruits and most gear cost gold: demand grows with the army.
    gold: res.gold < 60 && inc.gold < 12 + s.round / 5,
    iron: res.iron < 20,
  };
  const more = (t: BuildingId, max: number) => want(t, Math.min(max, (c[t] ?? 0) + (planned[t] ?? 0) + 1));

  farm();
  want('farm', 2);
  want('lumber', 1);
  want('quarry', 1);
  // The forge comes early: tunics/leather cost no iron, bows only one.
  want('forge', 1);
  if (has('writing')) want('library', 2);
  // The Ashen Covenant's mages and towers run on crystal: its mine comes before iron, and a
  // second quarry when stone runs short (the mine, the libraries and the tower all need it).
  if (f === 'ashen' && has('crystallore') && has('writing')) {
    if (scarce.stone) more('quarry', 2);
    want('crystalmine', 1);
  }
  if (has('mining')) want('mine', 1);
  want('house', 2);
  want('training', 1);
  // Then magic (DESIGN §9 mid game): a crystal mine and the first mage tower right after the
  // opening, so spells and mana arrive in time to matter.
  if (has('crystallore') && (s.round >= 8 || has('writing'))) want('crystalmine', 1);
  if (has('arcana')) want('magetower', 1);
  farm();
  if (scarce.wood) more('lumber', 4);
  if (scarce.gold) more('house', 5 + Math.floor(s.round / 40));
  if (has('mining') && scarce.iron) want('mine', 2);
  if (threatened && has('masonry')) want('wall', Math.min(3, (c.wall ?? 0) + 1));
  if (has('crystallore') && (s.round >= 8 || has('writing'))) want('crystalmine', f === 'ashen' ? 2 : 1);
  // A second tower once the first one works: +2 mana a turn, +50 mana cap, more reach.
  const towerUp = ctx.own.some((b) => b.type === 'magetower' && functional(b));
  if (has('arcana') && towerUp && s.round >= (f === 'ashen' ? 26 : 34)) want('magetower', 2);
  // Research is the scarce resource: libraries are the best use of spare wood, stone and gold.
  if (has('writing')) want('library', 3);
  want('lumber', 2);
  if (scarce.stone) more('quarry', 4);
  farm();
  want('watchtower', 2);
  want('shrine', 1);
  if (has('mining') && scarce.iron) want('mine', 3);
  if (has('arcana') && f === 'ashen') want('magetower', 2);
  if (has('writing') && s.round >= 40) want('library', 4);
  if (scarce.wood) more('lumber', 5);
  farm();
  if (s.round >= 40) want('forge', 2);
  if (has('crystallore') && res.crystal < 30) want('crystalmine', f === 'ashen' ? 3 : 2);
  if (has('writing') && s.round >= 70) want('library', 5);
  if (has('arcana') && s.round >= 80) want('magetower', f === 'ashen' ? 3 : 2);
  want('watchtower', 4);
  return q;
}

/** Tiles inside or adjacent to own territory (where a builder may break ground). */
function candidateTiles(ctx: Ctx, owners: (string | null)[]): number[] {
  const s = ctx.s;
  const out: number[] = [];
  const n = s.width * s.height;
  for (let i = 0; i < n; i++) {
    const own = owners[i];
    if (own !== null && own !== ctx.f) continue;
    if (s.tiles[i].building != null) continue;
    if (!TERRAIN[s.tiles[i].terrain].buildable) continue;
    if (own === ctx.f) { out.push(i); continue; }
    const h = indexToHex(i, s.width);
    if (neighbors(h).some((nb) => inBounds(nb, s.width, s.height) && owners[tileIndex(nb, s.width)] === ctx.f)) out.push(i);
  }
  return out;
}

/** Desirability of building `type` on tile `idx`, or null when impossible. */
function siteScore(ctx: Ctx, type: BuildingId, idx: number, owners: (string | null)[]): number | null {
  const s = ctx.s;
  const tile = s.tiles[idx];
  const def = BUILDINGS[type];
  if (tile.building != null || !def.terrains.includes(tile.terrain)) return null;
  if (def.deposit && tile.deposit !== def.deposit) return null;
  const h = indexToHex(idx, s.width);
  const occ = unitOn(s, h);
  if (occ && occ.faction !== ctx.f) return null;
  const d = hexDistance(h, ctx.home);
  let sc = 12 - d * 1.2;
  // One of ours stands there and cannot step aside this turn: an equal site elsewhere wins.
  if (occ && !canBuildWith(occ) && (occ.mp <= 0 || occ.justSpawned || occ.moveEnded)) sc -= 3;
  // Keep valuable ground for the building that needs it.
  if (tile.deposit === 'iron' && type !== 'mine') sc -= 8;
  if (tile.deposit === 'crystal' && type !== 'crystalmine') sc -= 8;
  if (tile.deposit === 'fertile' && type !== 'farm') sc -= 3;
  if (tile.terrain === 'forest' && type !== 'lumber') sc -= 2;
  switch (type) {
    case 'farm':
      if (tile.deposit === 'fertile') sc += 5;
      if (tile.terrain === 'grass') sc += 0.5;
      break;
    case 'quarry':
      if (tile.terrain === 'hills') sc += 2;
      if (tile.deposit === 'stone') sc += 3;
      break;
    case 'mine':
    case 'crystalmine':
      sc += 3;
      break;
    case 'wall': {
      const c = ctx.castle;
      if (!c) return null;
      const dc = hexDistance(h, c.pos);
      if (dc < 1 || dc > 2) return null;
      sc = 10 - dc * 2;
      const strat = getStrategy(ctx);
      let nearest = Infinity;
      for (const e of strat.intruders) if (e.faction !== 'neutral') nearest = Math.min(nearest, hexDistance(e.pos, h));
      if (Number.isFinite(nearest)) sc -= nearest * 0.6;
      break;
    }
    case 'watchtower':
      // Border lookouts: a few hexes out, toward the rival.
      sc = 6 + Math.min(d, 5) * 0.8 - (d > 6 ? (d - 6) * 2 : 0);
      break;
    case 'magetower': {
      if (tile.terrain === 'hills') sc += 1;
      // Later towers stand toward the rival: spells only reach 6-8 hexes (+⌊int/3⌋).
      const anchor = getStrategy(ctx).anchor;
      if (anchor && ctx.own.some((b) => b.type === 'magetower')) {
        sc += Math.max(0, Math.min(8, hexDistance(ctx.home, anchor) - hexDistance(h, anchor))) * 0.9;
      }
      break;
    }
    default:
      if (tile.terrain === 'grass' || tile.terrain === 'plains') sc += 1;
  }
  if (owners[idx] !== ctx.f) sc += 0.8; // pushes the border outward
  // Safety: nobody wants to break ground under enemy swords.
  if (attackersOn(ctx, h, false) > 0) sc -= 7;
  for (const m of ctx.monsters) if (hexDistance(m.pos, h) <= 4) sc -= 4;
  const strat = getStrategy(ctx);
  if (strat.anchor && def.id !== 'wall' && def.id !== 'watchtower' && def.id !== 'magetower') {
    // Slight preference for the side away from the enemy.
    sc -= Math.max(0, 6 - hexDistance(h, strat.anchor)) * 0.5;
  }
  return sc;
}

/** Producers worth pushing the border out for when no legal site is in reach. */
const EXPANDABLE = new Set<BuildingId>(['lumber', 'quarry', 'mine', 'crystalmine', 'farm']);

/** Nearest unclaimed tile (to home) where `type` could stand once our border reaches it. */
function nearestSiteFor(ctx: Ctx, type: BuildingId, owners: (string | null)[]): Hex | null {
  const s = ctx.s;
  const def = BUILDINGS[type];
  let best: Hex | null = null;
  let bd = Infinity;
  for (const h of spiral(ctx.home, 9)) {
    if (!inBounds(h, s.width, s.height)) continue;
    const i = tileIndex(h, s.width);
    const t = s.tiles[i];
    if (t.building != null || !def.terrains.includes(t.terrain)) continue;
    if (def.deposit && t.deposit !== def.deposit) continue;
    if (owners[i] !== null && owners[i] !== ctx.f) continue;
    const d = hexDistance(h, ctx.home);
    if (d < bd) { bd = d; best = h; }
  }
  return best;
}

const UPGRADE_PRIORITY: Partial<Record<BuildingId, number>> = {
  library: 10, mine: 8, crystalmine: 7, magetower: 6, farm: 5, house: 4, lumber: 3.5, quarry: 3, forge: 2.5,
  training: 2, wall: 2, watchtower: 1.5, shrine: 1.5,
};

/**
 * Builder jobs for this turn: affordable constructions first (by queue priority), then one job
 * to save for, then upgrades. Cached until a build starts.
 */
export function planTasks(ctx: Ctx): BuildTask[] {
  if (ctx.t.tasks) return ctx.t.tasks;
  const s = ctx.s;
  const tasks: BuildTask[] = [];
  ctx.t.tasks = tasks;
  const free = ctx.builders.filter((b) => !workingSite(ctx, b) && b.hp > 0);
  if (!free.length) return tasks;
  const inc = incomeOf(ctx);
  const avail: Resources = { ...ctx.fs.resources };
  if (!ctx.castle) subtract(avail, BUILDINGS.castle.cost);
  const queue = desiredQueue(ctx);
  const entries: { type: BuildingId; aff: boolean }[] = [];
  for (const type of queue) {
    const cost = BUILDINGS[type].cost;
    if (canAfford(avail, cost)) { entries.push({ type, aff: true }); subtract(avail, cost); continue; }
    // Only save up for what income will deliver soon (no iron income → no forge yet).
    const wait = turnsToAfford(avail, cost, inc);
    if (wait > 8) continue;
    entries.push({ type, aff: false });
    subtract(avail, cost);
  }
  const owners = computeTerritory(s) as (string | null)[];
  const cands = candidateTiles(ctx, owners);
  const used = new Set<number>();
  const pool = free.slice();
  // Abandoned construction (the builder fled or fell) is resumed before anything new.
  for (const b of ctx.own) {
    if (!pool.length) break;
    if (b.buildLeft <= 0) continue;
    const occ = unitOn(s, b.pos);
    if (occ && !(occ.faction === ctx.f && pool.includes(occ))) continue;
    if (attackersOn(ctx, b.pos, true) >= 2) continue;
    let bu: Unit | null = null;
    for (const p of pool) if (!bu || hexDistance(p.pos, b.pos) < hexDistance(bu.pos, b.pos)) bu = p;
    if (!bu) break;
    pool.splice(pool.indexOf(bu), 1);
    tasks.push({ kind: 'resume', type: b.type, site: { ...b.pos }, builder: bu.id, affordable: true });
  }
  const scoreCache = new Map<string, number | null>();
  const assign = (type: BuildingId, aff: boolean): boolean => {
    let best: { idx: number; b: Unit; v: number } | null = null;
    const skill = BUILDINGS[type].unlockSkill;
    for (const idx of cands) {
      if (used.has(idx) || claimedByOther(ctx, `site:${idx}`, -1)) continue;
      const key = `${type}|${idx}`;
      let sc = scoreCache.get(key);
      if (sc === undefined) { sc = siteScore(ctx, type, idx, owners); scoreCache.set(key, sc); }
      if (sc === null) continue;
      const h = indexToHex(idx, s.width);
      for (const b of pool) {
        if (skill && !b.actives.includes(skill)) continue;
        const v = sc - hexDistance(b.pos, h) * 0.8;
        if (!best || v > best.v) best = { idx, b, v };
      }
    }
    if (!best) return false;
    used.add(best.idx);
    pool.splice(pool.indexOf(best.b), 1);
    tasks.push({ kind: 'build', type, site: indexToHex(best.idx, s.width), builder: best.b.id, affordable: aff });
    return true;
  };
  // Producers whose terrain is out of reach: grow the border toward it with a cheap building.
  const expanded = new Set<BuildingId>();
  const expand = (type: BuildingId): boolean => {
    if (expanded.has(type) || !EXPANDABLE.has(type)) return false;
    expanded.add(type);
    const goal = nearestSiteFor(ctx, type, owners);
    if (!goal) return false;
    let best: { idx: number; b: Unit; v: number; kind: BuildingId } | null = null;
    const curD = Math.min(...cands.map((i) => hexDistance(indexToHex(i, s.width), goal)));
    for (const ex of ['farm', 'house', 'lumber', 'quarry'] as BuildingId[]) {
      if (ex === type || !canAfford(ctx.fs.resources, BUILDINGS[ex].cost)) continue;
      for (const idx of cands) {
        if (used.has(idx)) continue;
        const sc = siteScore(ctx, ex, idx, owners);
        if (sc === null) continue;
        const h = indexToHex(idx, s.width);
        const d = hexDistance(h, goal);
        if (d > curD) continue;
        for (const b of pool) {
          const v = -d * 3 + sc * 0.2 - hexDistance(b.pos, h) * 0.5;
          if (!best || v > best.v) best = { idx, b, v, kind: ex };
        }
      }
    }
    if (!best) return false;
    used.add(best.idx);
    pool.splice(pool.indexOf(best.b), 1);
    tasks.push({ kind: 'build', type: best.kind, site: indexToHex(best.idx, s.width), builder: best.b.id, affordable: true });
    return true;
  };
  for (const e of entries) {
    if (!pool.length) break;
    if (e.aff && !assign(e.type, true)) expand(e.type);
  }
  const save = entries.find((e) => !e.aff);
  if (save && pool.length && !assign(save.type, false)) expand(save.type);

  // Upgrades for builders left without construction work (Architecture and later).
  const maxLvl = maxBuildingLevel(s, ctx.f);
  if (pool.length && maxLvl >= 2) {
    const ups: { b: Building; pr: number }[] = [];
    for (const b of ctx.own) {
      if (!functional(b) || b.upgrading || b.buildLeft > 0) continue;
      if (b.level >= Math.min(BUILDINGS[b.type].maxLevel, maxLvl)) continue;
      let pr = UPGRADE_PRIORITY[b.type];
      if (!pr) continue;
      if (b.type === 'house' && ctx.fs.resources.gold < 60) pr = 9;
      const occ = unitOn(s, b.pos);
      if (occ && !(occ.faction === ctx.f && pool.includes(occ))) continue;
      if (!canAfford(avail, upgradeCost(b))) continue;
      ups.push({ b, pr: pr - b.level * 1.5 });
    }
    ups.sort((a, b) => b.pr - a.pr || a.b.id - b.b.id);
    for (const { b } of ups) {
      if (!pool.length) break;
      if (!canAfford(avail, upgradeCost(b))) continue;
      let bu: Unit | null = null;
      for (const p of pool) if (!bu || hexDistance(p.pos, b.pos) < hexDistance(bu.pos, b.pos)) bu = p;
      if (!bu || hexDistance(bu.pos, b.pos) > 10) continue;
      pool.splice(pool.indexOf(bu), 1);
      subtract(avail, upgradeCost(b));
      tasks.push({ kind: 'upgrade', type: b.type, site: { ...b.pos }, builder: bu.id, affordable: true });
    }
  }
  return tasks;
}

/** Resources promised to planned construction (and a new castle when the seat is lost). */
export function buildReserve(ctx: Ctx): ResourceCost {
  const r: ResourceCost = {};
  if (!ctx.castle) addTo(r, BUILDINGS.castle.cost);
  for (const t of planTasks(ctx)) {
    if (t.kind === 'resume') continue;
    if (t.kind === 'build') addTo(r, BUILDINGS[t.type].cost);
    else {
      const b = buildingOn(ctx.s, t.site);
      if (b) addTo(r, upgradeCost(b));
    }
  }
  return r;
}

/** Iron income the faction can count on (a working mine, a prospector, …). */
const ironIncome = (ctx: Ctx): boolean => incomeOf(ctx).iron > 0.05;

/**
 * Resources held back so the economy can never lock itself out (DESIGN §2: the starting iron
 * pays for a forge plus a first sword): the forge's iron until a forge stands or is planned,
 * and, while no iron comes in, a replacement set of Builder's Tools. `forBuilder`: the reserve
 * seen by a builder recruit, which may use the tools part (that is what it is for), and the
 * forge part too when no builder is left to build the forge anyway.
 */
export function economyReserve(ctx: Ctx, forBuilder = false): ResourceCost {
  const r: ResourceCost = {};
  const forgeStands = ctx.own.some((b) => b.type === 'forge');
  const forgePlanned = planTasks(ctx).some((t) => t.kind === 'build' && t.type === 'forge');
  if (!forgeStands && !forgePlanned && !(forBuilder && !ctx.builders.length)) {
    addTo(r, { iron: BUILDINGS.forge.cost.iron ?? 0 });
  }
  if (!forBuilder && !ironIncome(ctx)) addTo(r, ITEMS.tools.cost);
  return r;
}

/** What may be spent on recruits / crafting after construction (and defence) reserves. */
export function spendable(ctx: Ctx, purpose: 'recruit' | 'craft' | 'builder'): Resources {
  const r: Resources = { ...ctx.fs.resources };
  subtract(r, buildReserve(ctx));
  subtract(r, economyReserve(ctx, purpose === 'builder'));
  if (purpose === 'craft') {
    subtract(r, DEFENSE_RESERVE);
    // Wands and robes must not eat the crystal of the first mage tower (nor while Arcana, which
    // unlocks it, is being researched).
    const tower = ctx.own.some((b) => b.type === 'magetower')
      || planTasks(ctx).some((t) => t.kind === 'build' && t.type === 'magetower');
    if (!tower && (buildingUnlocked(ctx.s, ctx.f, 'magetower') || ctx.fs.researching === 'arcana')) {
      subtract(r, { crystal: BUILDINGS.magetower.cost.crystal ?? 0 });
    }
  }
  return r;
}

/**
 * True when one more levy can be armed soon: a usable weapon waits in the stockpile, or a forge
 * stands and the stock plus five turns of income pay for a weapon (every ingredient: a bow's
 * single iron is no use without its wood) for each unarmed unit and the newcomer.
 */
function canArmLevy(ctx: Ctx, unarmed: number, wanted: Track[]): boolean {
  if (wanted.some((tr) => stockedWeapon(ctx, tr, undefined, ctx.fs.stockpile))) return true;
  if (!ctx.own.some((b) => b.type === 'forge')) return false;
  const res = ctx.fs.resources;
  const inc = incomeOf(ctx);
  let best = 0;
  for (const tr of wanted) {
    const w = weaponForTrack(ctx, tr);
    if (!w || !itemUnlocked(ctx.s, ctx.f, w)) continue;
    let n = Infinity;
    for (const [r, c] of Object.entries(ITEMS[w].cost) as [ResourceId, number][]) {
      if (c) n = Math.min(n, ((res[r] ?? 0) + Math.max(0, inc[r] ?? 0) * 5) / c);
    }
    best = Math.max(best, n);
  }
  return best >= unarmed + 1;
}

// ───────────────────────────── builders ─────────────────────────────

/** Builders standing on their site start the job (DESIGN §5). */
export function buildPhase(ctx: Ctx): Action | null {
  for (const task of planTasks(ctx)) {
    const u = ctx.s.units[String(task.builder)];
    if (!u || u.acted || !hexEq(u.pos, task.site) || task.kind === 'resume') continue;
    const a = attempt(ctx, task.kind === 'build'
      ? { type: 'build', unit: u.id, building: task.type }
      : { type: 'upgrade', unit: u.id });
    if (a) {
      ctx.t.tasks = null;      // resources and territory change: plan again
      ctx.t.handled.add(u.id);
      return a;
    }
  }
  return null;
}

/** Is `u` standing on one of our own mage towers? */
function isTowerPost(ctx: Ctx, u: Unit): boolean {
  const b = buildingOn(ctx.s, u.pos);
  return !!b && b.owner === ctx.f && b.type === 'magetower';
}

const WORK_PRIORITY: Partial<Record<BuildingId, number>> = {
  library: 10, mine: 8, crystalmine: 7.5, magetower: 6, farm: 5, lumber: 4.5, quarry: 4, house: 3, watchtower: 2, shrine: 2,
};

export function builderMovePhase(ctx: Ctx): Action | null {
  const s = ctx.s;
  const tasks = planTasks(ctx);
  for (const u of ctx.builders) {
    if (ctx.t.handled.has(u.id) || u.mp <= 0) continue;
    ctx.t.handled.add(u.id);
    const hp = Math.max(1, u.hp);
    const danger = exposureAt(ctx, u, u.pos) >= hp * 0.7;
    const site = workingSite(ctx, u);
    if (site) {
      if (!danger) continue;            // keep hammering
      const home = ctx.castle?.pos ?? ctx.home;
      const a = moveToward(ctx, u, home, { risk: 3 });
      if (a) return a;
      continue;
    }
    const task = tasks.find((t) => t.builder === u.id);
    if (task) {
      if (hexEq(u.pos, task.site)) continue;   // waiting for resources on site
      // One of our own units squats on the site: it steps aside first (the builder is left
      // unhandled so it can walk on in the same turn).
      const occ = task.kind === 'build' ? unitOn(s, task.site) : undefined;
      if (occ && occ.faction === ctx.f && occ.id !== u.id && occ.mp > 0 && !occ.justSpawned && !occ.moveEnded) {
        let to: Hex | null = null;
        let bv = Infinity;
        const hp = Math.max(1, occ.hp);
        for (const ri of reachOf(ctx, occ)) {
          if (isHeldSite(ctx, ri.hex, occ)) continue;
          const v = (exposureAt(ctx, occ, ri.hex) / hp) * 10 + hexDistance(ri.hex, occ.pos) * 0.5 + ri.cost * 0.01;
          if (v < bv) { bv = v; to = ri.hex; }
        }
        if (to) {
          const a = attempt(ctx, { type: 'move', unit: occ.id, to: { ...to } });
          if (a) { ctx.t.handled.delete(u.id); return a; }
        }
      }
      const a = moveToward(ctx, u, task.site, { risk: 1.5, exact: true });
      if (a) return a;
      continue;
    }
    // Idle: work the most valuable building (+50% output) that nobody occupies.
    let best: Building | null = null;
    let bv = -Infinity;
    for (const b of ctx.own) {
      if (!functional(b)) continue;
      const pr = WORK_PRIORITY[b.type];
      if (!pr) continue;
      // A tower is a mage's post (spell reach): a builder only works it while no mage could.
      if (b.type === 'magetower' && ctx.military.some((m) => trackOf(m) === 'mage' && !isTowerPost(ctx, m))) continue;
      const occ = unitOn(s, b.pos);
      if (occ && occ.id !== u.id) continue;
      if (claimedByOther(ctx, `work:${b.id}`, u.id)) continue;
      const v = pr + b.level - hexDistance(u.pos, b.pos) * 0.6 - attackersOn(ctx, b.pos, false) * 5;
      if (v > bv) { bv = v; best = b; }
    }
    if (best) {
      claim(ctx, `work:${best.id}`, u.id);
      if (hexEq(best.pos, u.pos)) continue;
      const a = moveToward(ctx, u, best.pos, { risk: 1.5, exact: true });
      if (a) return a;
    } else if (danger) {
      const a = moveToward(ctx, u, ctx.home, { risk: 3 });
      if (a) return a;
    }
  }
  return null;
}

// ───────────────────────────── crafting & equipment ─────────────────────────────

interface Demand { item: ItemId; prio: number }

/**
 * Mages still missing to channel in our mage towers, standing or rising (one each, at most two):
 * a tower without one has a shorter reach and no magic XP, and the mage's robe brings mana. A
 * tower under construction counts, so its mage is armed by the time it opens.
 */
export function channelersShort(ctx: Ctx): number {
  if (!trackAvailable(ctx, 'mage')) return 0;
  const towers = ctx.own.filter((b) => b.type === 'magetower').length;
  if (!towers) return 0;
  const strat = getStrategy(ctx);
  let mages = 0;
  for (const u of ctx.military) if (trackOf(u) === 'mage' || (trackOf(u) === 'none' && strat.tracks.get(u.id) === 'mage')) mages++;
  return Math.max(0, Math.min(2, towers) - mages);
}

/** Ordered list of tracks the army is short of. */
export function wantedTracks(ctx: Ctx): Track[] {
  const counts: Partial<Record<Track, number>> = {};
  const strat = getStrategy(ctx);
  for (const u of ctx.military) {
    let t = trackOf(u);
    if (t === 'none') t = strat.tracks.get(u.id) ?? 'none';
    counts[t] = (counts[t] ?? 0) + 1;
  }
  const comp = adaptedComposition(ctx);
  const avail = (['melee', 'archer', 'mage'] as Track[]).filter((t) => trackAvailable(ctx, t) && (comp[t] ?? 0) > 0);
  const sum = avail.reduce((a, t) => a + (comp[t] ?? 0), 0) || 1;
  const total = avail.reduce((a, t) => a + (counts[t] ?? 0), 0);
  const order = avail
    .map((t) => ({ t, v: ((comp[t] ?? 0) / sum) * (total + 1) - (counts[t] ?? 0) }))
    .sort((a, b) => b.v - a.v || a.t.localeCompare(b.t))
    .map((x) => x.t);
  // A tower (standing or rising) without its channeler: the next recruit is a mage, whatever
  // the mix says.
  if (order.includes('mage') && channelersShort(ctx) > 0) return ['mage', ...order.filter((t) => t !== 'mage')];
  return order;
}

/**
 * Faction composition reweighted by what the treasury can pay for: a track whose weapon's
 * scarcest ingredient is plentiful gains weight (e.g. surplus crystal → more mages).
 */
export function adaptedComposition(ctx: Ctx): Partial<Record<Track, number>> {
  const base = COMPOSITION[ctx.f];
  const out: Partial<Record<Track, number>> = {};
  const res = ctx.fs.resources;
  const inc = incomeOf(ctx);
  for (const t of ['melee', 'archer', 'mage'] as Track[]) {
    const share = base[t] ?? 0;
    if (!share) continue;
    const w = weaponForTrack(ctx, t, 0);
    // Limited by the scarcest ingredient (gold and food are shared by every track).
    let factor = Infinity;
    if (w) {
      for (const [r, c] of Object.entries(ITEMS[w].cost) as [ResourceId, number][]) {
        if (!c || r === 'gold' || r === 'food') continue;
        const f = (res[r] + inc[r] * 5) / (c * 4);
        factor = Math.min(factor, Math.max(0.3, Math.min(2, f)));
      }
    }
    out[t] = share * (Number.isFinite(factor) ? factor : 1);
  }
  return out;
}

function weaponForTrack(ctx: Ctx, track: Track, id?: number): ItemId | null {
  if (track === 'archer') return 'bow';
  if (track === 'melee') return meleeWeaponFor(ctx, id);
  if (track === 'mage') return mageWeaponFor(ctx, id);
  return null;
}

function itemDemands(ctx: Ctx): Demand[] {
  const out: Demand[] = [];
  const strat = getStrategy(ctx);
  // Stocked weapons are handed out to unarmed units in turn (each item to one unit only).
  const stock: Partial<Record<ItemId, number>> = { ...ctx.fs.stockpile };
  for (const u of ctx.units) {
    if (u.monster) continue;
    const track = trackOf(u) === 'none' ? strat.tracks.get(u.id) ?? 'melee' : trackOf(u);
    const lo = desiredLoadout(ctx, u, undefined, stock);
    if (!u.equipment.main && lo.main && (stock[lo.main] ?? 0) > 0) stock[lo.main]! -= 1;
    const far = hexDistance(u.pos, ctx.home) > 12 ? 3 : 0;
    for (const slot of SLOT_ORDER) {
      const want = lo[slot];
      if (!want || u.equipment[slot] === want) continue;
      out.push({ item: want, prio: itemPriority(u, slot, want, track) - far });
    }
  }
  // Arm the next recruit too (commoner + stockpile is how flavour units like axemen are raised),
  // unless a weapon for its track already waits unclaimed in the stockpile. The house's usual
  // taste picks it: the recruit's id is unknown (buildings take ids too).
  // A house without a builder forges a set of tools for a commoner (cheaper than a recruit).
  if (!ctx.builders.length && !(stock.tools ?? 0)) out.push({ item: 'tools', prio: 9 });
  if (ctx.military.length < strat.armyTarget) {
    const tr = wantedTracks(ctx)[0];
    const w = tr && !stockedWeapon(ctx, tr, undefined, stock) ? weaponForTrack(ctx, tr) : null;
    if (w) out.push({ item: w, prio: 6 });
  }
  return out.sort((a, b) => b.prio - a.prio || a.item.localeCompare(b.item));
}

export function craftPhase(ctx: Ctx): Action | null {
  const s = ctx.s;
  const forges = ctx.own.filter((b) => b.type === 'forge' && functional(b) && forgeCapacity(b) > 0);
  if (!forges.length) return null;
  const stock: Partial<Record<ItemId, number>> = { ...ctx.fs.stockpile };
  const budget = spendable(ctx, 'craft');
  const inc = incomeOf(ctx);
  for (const d of itemDemands(ctx)) {
    if ((stock[d.item] ?? 0) > 0) { stock[d.item]! -= 1; continue; }
    if (!itemUnlocked(s, ctx.f, d.item)) continue;
    const cost = ITEMS[d.item].cost;
    // The replacement tools of a house left without builders are what the reserve was kept for.
    if (d.item === 'tools' && !ctx.builders.length && canAfford(ctx.fs.resources, cost)) {
      for (const fg of forges) {
        const a = attempt(ctx, { type: 'craft', forge: fg.id, item: d.item });
        if (a) return a;
      }
    }
    if (!canAfford(budget, cost)) {
      // Save for an important item that income will soon pay for, instead of frittering it away.
      if (d.prio >= 7 && turnsToAfford(budget, cost, inc) <= 4) subtract(budget, cost);
      continue;
    }
    for (const fg of forges) {
      const a = attempt(ctx, { type: 'craft', forge: fg.id, item: d.item });
      if (a) return a;
    }
  }
  return null;
}

const isArmory = (ctx: Ctx, b: Building | undefined): b is Building =>
  !!b && b.owner === ctx.f && !!BUILDINGS[b.type].armory && isOperational(b);

/** Units standing on an own armory put on whatever they want from the stockpile. */
export function equipPhase(ctx: Ctx): Action | null {
  const sp = ctx.fs.stockpile;
  for (const u of ctx.units) {
    if (u.monster) continue;
    if (!isArmory(ctx, buildingOn(ctx.s, u.pos))) continue;
    const lo = desiredLoadout(ctx, u);
    for (const slot of SLOT_ORDER) {
      const want = lo[slot];
      if (!want || u.equipment[slot] === want || (sp[want] ?? 0) < 1) continue;
      const a = attempt(ctx, { type: 'equip', unit: u.id, item: want });
      if (a) return a;
    }
  }
  return null;
}

/** Stockpiled items each unit could pick up (first come by proximity to home), for armory trips. */
export function equipClaims(ctx: Ctx): Map<number, ItemId[]> {
  const out = new Map<number, ItemId[]>();
  const stock: Partial<Record<ItemId, number>> = { ...ctx.fs.stockpile };
  if (!Object.values(stock).some((n) => (n ?? 0) > 0)) return out;
  const order = ctx.units.filter((u) => !u.monster)
    .sort((a, b) => hexDistance(a.pos, ctx.home) - hexDistance(b.pos, ctx.home) || a.id - b.id);
  for (const u of order) {
    const lo = desiredLoadout(ctx, u, undefined, stock);
    for (const slot of SLOT_ORDER) {
      const want = lo[slot];
      if (!want || u.equipment[slot] === want || (stock[want] ?? 0) < 1) continue;
      stock[want]! -= 1;
      const list = out.get(u.id) ?? [];
      list.push(want);
      out.set(u.id, list);
    }
  }
  return out;
}

/** Nearest own armory hex for `u` that is free (or its own), within `maxDist`. */
export function nearestArmory(ctx: Ctx, u: Unit, maxDist: number): Hex | null {
  let best: Building | null = null;
  let bd = Infinity;
  for (const b of ctx.own) {
    if (!isArmory(ctx, b)) continue;
    const occ = unitOn(ctx.s, b.pos);
    if (occ && occ.id !== u.id) continue;
    const d = hexDistance(b.pos, u.pos);
    if (d < bd && d <= maxDist) { bd = d; best = b; }
  }
  return best ? best.pos : null;
}

// ───────────────────────────── recruitment ─────────────────────────────

function recruitSites(ctx: Ctx): Building[] {
  const out: Building[] = [];
  for (const b of ctx.own) {
    if (!functional(b) || b.recruitedThisTurn || !BUILDINGS[b.type].recruits?.length) continue;
    if (b.type === 'castle' && !(ctx.leader && hexEq(ctx.leader.pos, b.pos))) continue;
    out.push(b);
  }
  return out;
}

function foodOk(ctx: Ctx, emergency: boolean): boolean {
  const inc = incomeOf(ctx);
  const after = inc.food - FACTIONS[ctx.f].foodUpkeep;
  const stock = ctx.fs.resources.food;
  if (after >= 0) return true;
  if (after >= -1 && stock >= 25) return true;
  return emergency && stock >= 12 && after >= -3;
}

/** Flavour bonus for presets (DESIGN §2 faction identities). */
function presetFlavor(ctx: Ctx, p: PresetId): number {
  switch (ctx.f) {
    case 'valen': return p === 'knight' ? 4 : p === 'archer' ? 1 : p === 'swordsman' ? 1 : 0;
    case 'thorn': return p === 'swordsman' ? -2 : p === 'spearman' ? 1 : p === 'knight' ? -1 : 0;
    case 'ashen': return p === 'battlemage' ? 4 : p === 'apprentice' ? 2 : p === 'spearman' ? 1 : 0;
  }
  return 0;
}

export function recruitPhase(ctx: Ctx): Action | null {
  const s = ctx.s;
  const sites = recruitSites(ctx);
  if (!sites.length) return null;
  const strat = getStrategy(ctx);
  const emergency = strat.castleThreat > 0;

  // Builders first: the economy is the backbone (unless the castle is under attack). A house
  // with no builder at all can neither build nor mine iron: that one comes first whatever happens
  // short of a siege, paid from the whole treasury.
  const noBuilder = !ctx.builders.length;
  const wantBuilder = noBuilder
    ? strat.castleThreat < 3
    : !emergency && ctx.builders.length < builderTarget(ctx) && s.round >= 2;
  if (wantBuilder) {
    // The economy reserve already keeps the forge's iron back (spendable 'builder').
    const budget = noBuilder ? { ...ctx.fs.resources } : spendable(ctx, 'builder');
    const cost = presetCost('builder');
    if (canAfford(budget, cost) && foodOk(ctx, noBuilder)) {
      const order = sites.filter((b) => BUILDINGS[b.type].recruits!.includes('builder'))
        .sort((a, b) => (a.type === 'castle' ? 1 : 0) - (b.type === 'castle' ? 1 : 0) || a.id - b.id);
      for (const b of order) {
        const a = attempt(ctx, { type: 'recruit', site: b.id, preset: 'builder' });
        if (a) { ctx.t.tasks = null; return a; }
      }
    }
  }

  // A tower still short of its channeler may take one recruit over the target (its mage).
  const cap = (emergency ? strat.armyTarget + 3 : strat.armyTarget) + (channelersShort(ctx) > 0 ? 1 : 0);
  // Summoned elementals crumble within 8 turns: they do not fill a recruit's place.
  if (ctx.military.filter((u) => !u.summonTurns).length >= cap) return null;
  if (!foodOk(ctx, emergency)) return null;
  const budget: Resources = emergency ? { ...ctx.fs.resources } : spendable(ctx, 'recruit');
  // Even in an emergency the last builder's replacement tools are kept (no iron income).
  if (emergency && ctx.builders.length <= 1 && !ironIncome(ctx)) subtract(budget, ITEMS.tools.cost);
  if (!emergency && ctx.military.length >= 3) subtract(budget, DEFENSE_RESERVE);
  const wanted = wantedTracks(ctx);
  const rank = (t: Track) => { const i = wanted.indexOf(t); return i === 0 ? 6 : i === 1 ? 3 : i < 0 ? -4 : 0; };
  const sp = ctx.fs.stockpile;
  const armed = ctx.military.filter((u) => u.equipment.main && u.equipment.main !== 'tools' || u.monster).length;
  const hasForge = ctx.own.some((b) => b.type === 'forge' && functional(b));

  const options: { a: Action; v: number }[] = [];
  const consider = (a: Action, v: number) => { options.push({ a, v }); };
  for (const site of sites) {
    const def = BUILDINGS[site.type];
    for (const p of def.recruits ?? []) {
      if (p === 'builder' || p === 'commoner') continue;
      if (!presetUnlocked(s, ctx.f, p)) continue;
      const cost = presetCost(p);
      if (!canAfford(budget, cost)) continue;
      const tr = trackOfItem(PRESETS[p].items.find((i) => ITEMS[i].slot === 'main'));
      consider({ type: 'recruit', site: site.id, preset: p },
        loadoutQuality(PRESETS[p].items) + rank(tr) + presetFlavor(ctx, p) - costValue(cost) * 0.12);
    }
    if (def.recruits?.includes('commoner') && canAfford(budget, COMMONER_COST)) {
      // A commoner spawning on an armory can be armed from the stockpile right away.
      const spawn = recruitSpawnHex(s, site, 'commoner');
      const onArmory = !!spawn && hexEq(spawn, site.pos) && !!def.armory;
      let v = -Infinity;
      if (onArmory) {
        for (const tr of wanted) {
          // The stocked weapon the new commoner would take up (desiredLoadout's own choice).
          const weapon = stockedWeapon(ctx, tr, s.nextId, sp);
          if (!weapon) continue;
          const bodies = (['plate', 'leather', 'robe', 'tunic'] as ItemId[]).filter((i) => (sp[i] ?? 0) > 0);
          v = Math.max(v, loadoutQuality([weapon, bodies[0]]) + rank(tr) + 2 - costValue(COMMONER_COST) * 0.12);
        }
      }
      // Plain militia: a couple to start with, more only when something can arm them soon (the
      // forge has the iron, bows cost a single iron, or a weapon waits in the stockpile).
      const unarmed = ctx.military.length - armed;
      const canArm = canArmLevy(ctx, unarmed, wanted);
      const armable = hasForge && canArm;
      // Treasury overflowing with nothing else to buy: raise a levy that will be armed shortly.
      const rich = canArm && ctx.fs.resources.gold >= 70 && ctx.fs.resources.food >= 45 && unarmed < 4 + Math.floor(s.round / 12);
      // Castle under attack: a couple of fist-fighting levies to body-block, not one every turn
      // the threat lasts.
      const levy = emergency && unarmed < Math.max(2, Math.min(4, strat.castleThreat + 1));
      if (!Number.isFinite(v) && (levy || ctx.military.length < 2 || (armable && unarmed < 3) || rich)) {
        v = -2 - costValue(COMMONER_COST) * 0.12;
      }
      if (Number.isFinite(v)) consider({ type: 'recruit', site: site.id, preset: 'commoner' }, v);
    }
  }
  options.sort((a, b) => b.v - a.v);
  for (const o of options) {
    const a = attempt(ctx, o.a);
    if (a) return a;
  }
  return null;
}

export type { EquipSlot };
