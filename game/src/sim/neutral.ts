// Neutral monsters around ruins. See DESIGN §8.
import type { FactionId, GameEvent, GameState, Hex, ItemId, MonsterKind, Unit } from '../core/types';
import { hexDistance, indexToHex, inBounds, ring, tileIndex } from '../core/hex';
import { rand } from '../core/rng';
import { ITEMS, ITEM_LIST } from '../data/items';
import { MONSTERS } from '../data/factions';
import { createUnit, unitValue } from './units';
import { reachable } from './pathfinding';
import { clearReactions, forecastCombat, resolveCombat } from './combat';
import { itemUnlocked, progressResearch } from './research';
import { computeVisibility } from './visibility';
import { manaCap } from './spells';
import { unitTurnUpkeep } from './turn';
import { buildingOn, giveXp, isHumanFaction, logEvent, passableForSpawn, unitOn } from './ruleutil';

/** No monster is placed within this distance of a faction's start. */
const START_SAFE_RADIUS = 5;
/** Monsters guard within this many hexes of home and will not stray further to attack. */
const GUARD_RADIUS = 3;
const LEASH_RADIUS = 4;
/** Monsters never stand within this distance of a castle: its territory (radius 2) is safe. */
export const CASTLE_SANCTUARY = 3;
/** During the first rounds monsters only defend their lair (no raids on fresh starts). */
const LAIR_ONLY_ROUNDS = 3;
const RESPAWN_EVERY = 12;
const RUINS_XP = 12;

function ruinsHexes(state: GameState): Hex[] {
  const out: Hex[] = [];
  for (let i = 0; i < state.tiles.length; i++) if (state.tiles[i].terrain === 'ruins') out.push(indexToHex(i, state.width));
  return out;
}

/** Start positions (castles and leaders of every playing faction). */
function startHexes(state: GameState): Hex[] {
  const out: Hex[] = [];
  for (const f of state.turnOrder) {
    const fs = state.factions[f];
    if (!fs) continue;
    const c = fs.castleId != null ? state.buildings[String(fs.castleId)] : undefined;
    if (c) out.push(c.pos);
    const l = fs.leaderId != null ? state.units[String(fs.leaderId)] : undefined;
    if (l) out.push(l.pos);
  }
  return out;
}

/** Hexes of every faction castle (sites included): the sanctuaries monsters keep out of. */
export function castleHexes(state: GameState): Hex[] {
  const out: Hex[] = [];
  for (const k in state.buildings) {
    const b = state.buildings[k];
    if (b.type === 'castle' && b.owner !== null && b.owner !== 'neutral') out.push(b.pos);
  }
  return out;
}

/**
 * May neutral monster `m` end its move on `hex`? Within the leash of its lair and outside every
 * castle's sanctuary (DESIGN §8). Its own hex is always allowed.
 */
export function monsterMayStand(state: GameState, m: Unit, hex: Hex, castles: Hex[] = castleHexes(state)): boolean {
  if (hex.q === m.pos.q && hex.r === m.pos.r) return true;
  if (hexDistance(hex, m.home ?? m.pos) > LEASH_RADIUS) return false;
  for (const c of castles) if (hexDistance(hex, c) <= CASTLE_SANCTUARY) return false;
  return true;
}

function distToNearest(h: Hex, list: Hex[]): number {
  let d = Infinity;
  for (const s of list) d = Math.min(d, hexDistance(h, s));
  return d;
}

function shuffled<T>(state: GameState, arr: T[]): T[] {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand(state) * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Free hexes around a ruin for monsters (ring 1, then ring 2), away from starts. */
function guardSpots(state: GameState, ruin: Hex, starts: Hex[]): Hex[] {
  const spots: Hex[] = [];
  for (const radius of [1, 2]) {
    const ringHexes = shuffled(state, ring(ruin, radius));
    for (const h of ringHexes) {
      if (!inBounds(h, state.width, state.height)) continue;
      if (!passableForSpawn(state, h, false)) continue;
      if (unitOn(state, h) || buildingOn(state, h)) continue;
      if (distToNearest(h, starts) <= START_SAFE_RADIUS) continue;
      spots.push(h);
    }
  }
  return spots;
}

function spawnMonster(state: GameState, kind: MonsterKind, pos: Hex, home: Hex): Unit {
  const u = createUnit(state, { faction: 'neutral', pos: { ...pos }, monster: kind });
  u.home = { ...home };
  return u;
}

/** Pack composition by remoteness: near ruins get a lone beast, far ones a golem-led pack. */
function packFor(state: GameState, dist: number): MonsterKind[] {
  const r = rand(state);
  if (dist <= 8) return [r < 0.65 ? 'wolf' : 'spider'];
  if (dist <= 12) return r < 0.5 ? ['wolf', 'wolf'] : ['wolf', 'spider'];
  return r < 0.5 ? ['golem', 'wolf', 'spider'] : ['golem', 'spider', 'wolf'];
}

/** Place initial guardians around each ruin (1–3 of wolf/spider/golem by distance from starts; none within 5 hexes of a start). */
export function spawnInitialMonsters(state: GameState, ruins: Hex[]): void {
  const starts = startHexes(state);
  for (const ruin of ruins) {
    const d = starts.length ? distToNearest(ruin, starts) : 99;
    const pack = packFor(state, d);
    const spots = guardSpots(state, ruin, starts);
    for (let i = 0; i < pack.length && i < spots.length; i++) spawnMonster(state, pack[i], spots[i], ruin);
  }
}

function monsterCap(state: GameState): number {
  return Math.max(4, ruinsHexes(state).length * 2);
}

/** Every 12 rounds: ruins without guardians and without nearby troops spawn a new pack member. */
function respawn(state: GameState): GameEvent[] {
  const events: GameEvent[] = [];
  const monsters = Object.values(state.units).filter((u) => u.faction === 'neutral');
  let count = monsters.length;
  const cap = monsterCap(state);
  if (count >= cap) return events;
  const starts = startHexes(state);
  for (const ruin of ruinsHexes(state)) {
    if (count >= cap) break;
    if (monsters.some((m) => m.home && hexDistance(m.home, ruin) === 0)) continue;
    const troopsNear = Object.values(state.units).some((u) => u.faction !== 'neutral' && hexDistance(u.pos, ruin) <= 4);
    if (troopsNear) continue;
    const spots = guardSpots(state, ruin, starts);
    if (!spots.length) continue;
    // Later waves are tougher.
    const r = rand(state);
    const kind: MonsterKind = state.round >= 36 && r < 0.3 ? 'golem' : r < 0.6 ? 'wolf' : 'spider';
    const u = spawnMonster(state, kind, spots[0], ruin);
    count++;
    events.push({ type: 'unitSpawned', unit: u.id, pos: { ...u.pos }, reason: 'monster' });
  }
  return events;
}

interface Plan { hex: Hex; path: Hex[]; mpLeft: number; target: Unit; score: number }

/**
 * Best attack for a monster from hexes within its leash and outside castle sanctuaries
 * (forecast-scored). In the first rounds it only fights from its guard area around the lair.
 */
function bestAttack(state: GameState, m: Unit, home: Hex, castles: Hex[]): Plan | null {
  const lairOnly = state.round <= LAIR_ONLY_ROUNDS;
  const options: { hex: Hex; path: Hex[]; mpLeft: number }[] = [];
  if (!lairOnly || hexDistance(m.pos, home) <= GUARD_RADIUS) options.push({ hex: { ...m.pos }, path: [], mpLeft: m.mp });
  if (m.mp > 0) {
    for (const ri of reachable(state, m)) {
      if (!monsterMayStand(state, m, ri.hex, castles)) continue;
      if (lairOnly && hexDistance(ri.hex, home) > GUARD_RADIUS) continue;
      options.push({ hex: ri.hex, path: ri.path, mpLeft: ri.zocStop ? 0 : ri.mpLeft });
    }
  }
  const origin = m.pos;
  let best: Plan | null = null;
  try {
    for (const o of options) {
      m.pos = o.hex;
      for (const k in state.units) {
        const t = state.units[k];
        if (t.faction === 'neutral' || hexDistance(t.pos, o.hex) !== 1) continue;
        const fc = forecastCombat(state, m, t, 'melee');
        if (!fc) continue;
        const value = Math.max(1, unitValue(t));
        const score = fc.expectedDamageToDefender * (t.isLeader ? 1.5 : 1)
          + fc.defenderKillChance * (12 + value * 0.2)
          - fc.expectedDamageToAttacker * 0.7
          - fc.attackerKillChance * 15
          - o.path.length * 0.05; // prefer shorter approach on ties
        if (score > 0.5 && (!best || score > best.score)) best = { hex: o.hex, path: o.path, mpLeft: o.mpLeft, target: t, score };
      }
    }
  } finally {
    m.pos = origin;
  }
  return best;
}

function moveMonster(state: GameState, m: Unit, path: Hex[], mpLeft: number): GameEvent[] {
  if (!path.length) return [];
  m.pos = { ...path[path.length - 1] };
  m.mp = Math.max(0, mpLeft);
  m.moved = true;
  return [{ type: 'unitMoved', unit: m.id, path: path.map((h) => ({ ...h })) }];
}

function actMonster(state: GameState, m: Unit, castles: Hex[]): GameEvent[] {
  const home = m.home ?? m.pos;
  const plan = bestAttack(state, m, home, castles);
  if (plan) {
    const events = moveMonster(state, m, plan.path, plan.mpLeft);
    events.push(...resolveCombat(state, m, plan.target, 'melee'));
    return events;
  }
  if (m.mp <= 0) return [];
  const opts = reachable(state, m).filter((ri) => monsterMayStand(state, m, ri.hex, castles));
  if (!opts.length) return [];
  // Strayed too far (after a chase): head home.
  if (hexDistance(m.pos, home) > GUARD_RADIUS) {
    let pick = opts[0];
    for (const ri of opts) if (hexDistance(ri.hex, home) < hexDistance(pick.hex, home)) pick = ri;
    return moveMonster(state, m, pick.path, pick.zocStop ? 0 : pick.mpLeft);
  }
  // An intruder near the lair: close in (stay inside the leash).
  let intruder: Unit | null = null;
  for (const k in state.units) {
    const t = state.units[k];
    if (t.faction === 'neutral' || hexDistance(t.pos, home) > LEASH_RADIUS + 1) continue;
    // Units at home are left alone (no crowding at the edge of a castle's sanctuary).
    if (castles.some((c) => hexDistance(t.pos, c) <= CASTLE_SANCTUARY + 1)) continue;
    if (!intruder || hexDistance(t.pos, m.pos) < hexDistance(intruder.pos, m.pos)) intruder = t;
  }
  if (intruder) {
    let pick: (typeof opts)[number] | null = null;
    for (const ri of opts) {
      if (!pick || hexDistance(ri.hex, intruder.pos) < hexDistance(pick.hex, intruder.pos)) pick = ri;
    }
    if (pick && hexDistance(pick.hex, intruder.pos) < hexDistance(m.pos, intruder.pos)) {
      return moveMonster(state, m, pick.path, pick.zocStop ? 0 : pick.mpLeft);
    }
    return [];
  }
  // Idle wandering inside the guard area.
  if (rand(state) < 0.35) {
    const near = opts.filter((ri) => hexDistance(ri.hex, home) <= GUARD_RADIUS && ri.path.length <= 2);
    if (near.length) {
      const ri = near[Math.floor(rand(state) * near.length)];
      return moveMonster(state, m, ri.path, ri.zocStop ? 0 : ri.mpLeft);
    }
  }
  return [];
}

/**
 * Monsters act: attack an adjacent/near enemy (best forecast) else wander within 3 hexes of
 * `home`; never from within 3 hexes of a castle, and only around their lair in rounds 1-3.
 * Every 12 rounds respawn at ruins under cap.
 */
export function runNeutralTurn(state: GameState): GameEvent[] {
  const events: GameEvent[] = [];
  if (state.gameOver) return events;
  clearReactions(state); // the wilds' turn: everyone may retaliate again
  const list = () => Object.values(state.units).filter((u) => u.faction === 'neutral').sort((a, b) => a.id - b.id);
  for (const m of list()) events.push(...unitTurnUpkeep(state, m));
  if (state.round > 0 && state.round % RESPAWN_EVERY === 0) events.push(...respawn(state));
  const touched = new Set<FactionId>();
  const castles = castleHexes(state);
  for (const m of list()) {
    if (state.gameOver) break;
    if (!state.units[String(m.id)]) continue;
    const evs = actMonster(state, m, castles);
    for (const e of evs) {
      if (e.type === 'unitDied') touched.add(e.faction);
    }
    events.push(...evs);
    // A monster's turn ends where it stands.
    m.restedLastTurn = !m.moved && !m.acted;
  }
  // Fallen units no longer see: refresh the affected factions' fog.
  for (const f of touched) if (f !== 'neutral' && state.factions[f]?.alive) computeVisibility(state, f);
  return events;
}

/** Loot table for ruins items: prefer what the finder can use. */
function lootItem(state: GameState, f: FactionId): ItemId {
  const usable = ITEM_LIST.filter((it) => it.id !== 'tools' && itemUnlocked(state, f, it.id));
  const pool = usable.length ? usable : ITEM_LIST.filter((it) => it.unlock === null && it.id !== 'tools');
  return pool[Math.floor(rand(state) * pool.length)].id;
}

/** First own unit visiting unlooted ruins: reward (gold/resources/item/explore XP 12) and mark looted. Called by actions.move. */
export function exploreRuins(state: GameState, unitId: number): GameEvent[] {
  const u = state.units[String(unitId)];
  if (!u || u.faction === 'neutral' || u.monster) return [];
  const tile = state.tiles[tileIndex(u.pos, state.width)];
  if (!tile || tile.terrain !== 'ruins' || tile.ruinsLooted) return [];
  tile.ruinsLooted = true;
  const fs = state.factions[u.faction];
  const events: GameEvent[] = [];
  const r = rand(state);
  let reward: string;
  if (r < 0.35) {
    const gold = 25 + Math.floor(rand(state) * 21);
    fs.resources.gold += gold;
    reward = `${gold} gold`;
  } else if (r < 0.6) {
    const wood = 10 + Math.floor(rand(state) * 11);
    const stone = 8 + Math.floor(rand(state) * 8);
    const rare = rand(state) < 0.5 ? 'iron' : 'crystal';
    const rareAmt = 5 + Math.floor(rand(state) * 6);
    fs.resources.wood += wood;
    fs.resources.stone += stone;
    fs.resources[rare] += rareAmt;
    reward = `${wood} wood, ${stone} stone, ${rareAmt} ${rare}`;
  } else if (r < 0.85) {
    const item = lootItem(state, u.faction);
    fs.stockpile[item] = (fs.stockpile[item] ?? 0) + 1;
    reward = `${ITEMS[item].name} (added to your stockpile)`;
  } else if (fs.researching) {
    const pts = 25;
    events.push(...progressResearch(state, u.faction, pts));
    reward = `ancient scrolls (+${pts} research)`;
  } else {
    fs.resources.mana = Math.min(manaCap(state, u.faction), fs.resources.mana + 20);
    reward = 'an aether cache (+20 mana)';
  }
  events.unshift({ type: 'ruinsExplored', unit: u.id, pos: { ...u.pos }, reward });
  events.push(...giveXp(state, u, 'explore', RUINS_XP));
  if (isHumanFaction(state, u.faction)) events.push(logEvent(state, `${u.name} explores the ruins and finds ${reward}.`, 'info', u.faction));
  return events;
}
