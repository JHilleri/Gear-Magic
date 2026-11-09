// Turn-level strategy: which house to march on, attack or build up, army size, track plans
// for unarmed recruits. Computed once on the first call of an AI turn (stateless across turns:
// everything is re-derived from the game state, positions provide the hysteresis).
import type { FactionId, Hex, Unit } from '../../core/types';
import { hexDistance, tileIndex } from '../../core/hex';
import { FACTIONS } from '../../data/factions';
import { ITEMS } from '../../data/items';
import { effectiveStats, isMounted } from '../units';
import { isOperational } from '../state';
import { itemUnlocked } from '../research';
import { trackAvailable, trackOf, trackOfItem } from './loadout';
import { adaptedComposition, builderTarget } from './economy-ai';
import type { Ctx, Strategy, Track } from './types';
import { distField, enemyFactions, incomeOf, isArmed, median, powerOf } from './util';

const DIFFICULTY_ARMY = { easy: 0.7, normal: 1, hard: 1.3 } as const;

/** Where a hostile house can be found: its castle, else its building nearest to us, else its (seen) leader. */
export function factionAnchor(ctx: Ctx, o: FactionId): Hex | null {
  const s = ctx.s;
  const ofs = s.factions[o];
  if (!ofs?.alive) return null;
  const castle = ofs.castleId != null ? s.buildings[String(ofs.castleId)] : undefined;
  if (castle && castle.owner === o) return castle.pos;
  let best: Hex | null = null;
  let bd = Infinity;
  for (const k in s.buildings) {
    const b = s.buildings[k];
    if (b.owner !== o) continue;
    const d = hexDistance(b.pos, ctx.home);
    if (d < bd) { bd = d; best = b.pos; }
  }
  if (best) return best;
  // A house with neither castle nor buildings is a fugitive leader: word of its whereabouts
  // spreads (fog is respected loosely for this one case, or such games could never end).
  const lid = ofs.leaderId;
  const leader = lid != null ? s.units[String(lid)] : undefined;
  return leader ? leader.pos : null;
}

/** Player bias of the AI nearest the player, by difficulty (lower = keener on the player). */
const HUMAN_BIAS = { easy: 1, normal: 0.85, hard: 0.75 } as const;

/** A fixed reference point for a house: its castle, else its leader, else its oldest building. */
function seatOf(s: Ctx['s'], o: FactionId): Hex | null {
  const fs = s.factions[o];
  if (!fs?.alive) return null;
  const castle = fs.castleId != null ? s.buildings[String(fs.castleId)] : undefined;
  if (castle && castle.owner === o) return castle.pos;
  const leader = fs.leaderId != null ? s.units[String(fs.leaderId)] : undefined;
  if (leader) return leader.pos;
  let best: { id: number; pos: Hex } | null = null;
  for (const k in s.buildings) {
    const b = s.buildings[k];
    if (b.owner === o && (!best || b.id < best.id)) best = b;
  }
  return best ? best.pos : null;
}

/** Is `ctx.f` the AI house whose seat lies nearest the player `human`'s (ties: faction id)? */
function naturalNeighbour(ctx: Ctx, human: FactionId): boolean {
  const s = ctx.s;
  const hs = seatOf(s, human);
  if (!hs) return true;
  let best: FactionId | null = null;
  let bd = Infinity;
  for (const o of s.turnOrder) {
    if (o === human || !s.factions[o]?.alive || s.factions[o].isHuman) continue;
    const p = seatOf(s, o);
    if (!p) continue;
    const d = hexDistance(p, hs);
    if (d < bd || (d === bd && best !== null && o < best)) { bd = d; best = o; }
  }
  return best === null || best === ctx.f;
}

/**
 * The house to march on (DESIGN §9): nearest by distance, with a player bias (by difficulty)
 * for the AI nearest the player only, so two AIs do not both gang up on the player; a house
 * whose units raid us becomes our war target; one without a seat is easy prey; and an army
 * already marching keeps its goal. Stateless: positions supply the hysteresis.
 */
function chooseTarget(ctx: Ctx, intruders: Unit[]): { target: FactionId | null; anchor: Hex | null } {
  const s = ctx.s;
  let target: FactionId | null = null;
  let anchor: Hex | null = null;
  let best = Infinity;
  const armed = ctx.military.filter((u) => isArmed(u));
  for (const o of enemyFactions(s, ctx.f)) {
    const a = factionAnchor(ctx, o);
    if (!a) continue;
    const span = hexDistance(ctx.home, a);
    let d = span;
    if (s.factions[o].isHuman && naturalNeighbour(ctx, o)) d *= HUMAN_BIAS[s.settings.difficulty] ?? 1;
    const raiders = intruders.filter((e) => e.faction === o).length;
    if (raiders >= 3) d *= 0.55;
    else if (raiders >= 1) d *= 0.7;
    // A house without a seat (castle razed) is easy prey.
    if (s.factions[o].castleId == null) d *= 0.8;
    // A column already well on its way keeps its goal (no flip-flopping between turns).
    if (armed.length >= 2 && median(armed.map((u) => hexDistance(u.pos, a))) <= span * 0.6) d *= 0.8;
    if (d < best || (d === best && target && o < target)) { best = d; target = o; anchor = a; }
  }
  return { target, anchor };
}

export function getStrategy(ctx: Ctx): Strategy {
  if (!ctx.t.strategy) ctx.t.strategy = computeStrategy(ctx);
  return ctx.t.strategy;
}

function computeStrategy(ctx: Ctx): Strategy {
  const { s, f, fs } = ctx;

  // Hostile units near our holdings.
  const intruders: Unit[] = [];
  for (const e of ctx.enemies) {
    const nearHome = hexDistance(e.pos, ctx.home) <= 7;
    let nearBuilding = false;
    for (const b of ctx.own) {
      const d = hexDistance(e.pos, b.pos);
      if (d <= (e.faction === 'neutral' ? 2 : 4)) { nearBuilding = true; break; }
    }
    if (e.faction === 'neutral' ? nearBuilding : nearHome || nearBuilding) intruders.push(e);
  }
  const { target, anchor } = chooseTarget(ctx, intruders);
  const seat = ctx.castle?.pos ?? ctx.leader?.pos ?? ctx.home;
  // Only fighters count: a passing builder or unarmed scout must not switch on emergency
  // recruiting (and its full-treasury budget) for turns on end.
  const castleThreat = ctx.foes.filter((e) => (isArmed(e) || e.isLeader) && hexDistance(e.pos, seat) <= 6).length;

  // Army size target: grows with time, bounded by what the farms can feed.
  const inc = incomeOf(ctx);
  const upkeep = Math.max(0.25, FACTIONS[f].foodUpkeep);
  const foodRoom = Math.floor(Math.max(0, inc.food + (fs.resources.food >= 40 ? 1.5 : 0)) / upkeep);
  const base = (3 + Math.floor(s.round / 3)) * (DIFFICULTY_ARMY[s.settings.difficulty] ?? 1);
  const armyTarget = Math.max(1, Math.min(Math.round(base), ctx.military.length + foodRoom, 26));

  // Attack once a real army stands; positions give hysteresis (a forward army keeps pushing).
  const armed = ctx.military.filter((u) => isArmed(u));
  let stance: Strategy['stance'] = 'build';
  const need = Math.max(5, Math.min(9, 4 + Math.floor(s.round / 20)));
  if (anchor) {
    if (armed.length >= need) stance = 'attack';
    else if (armed.length >= 3) {
      const span = Math.max(1, hexDistance(ctx.home, anchor));
      const ds = armed.map((u) => hexDistance(u.pos, anchor));
      if (median(ds) <= span * 0.6) stance = 'attack';
    }
    // Late game: everyone marches even with a smaller host (stalemates help nobody).
    if (s.round >= 90 && armed.length >= 3) stance = 'attack';
  }
  // Heavy pressure at home: hold until it is dealt with.
  if (castleThreat >= 3 && armed.length < castleThreat + 2) stance = 'build';

  // Each working mage tower keeps its best mage nearby home to channel in it (+⌊int/3⌋ spell
  // reach, magic XP): tactics sends it to its tower before any other errand.
  const channelers = new Map<number, Hex>();
  for (const b of ctx.own) {
    if (b.type !== 'magetower' || !isOperational(b)) continue;
    let pick: Unit | null = null;
    let pv = -Infinity;
    for (const u of armed) {
      if (trackOf(u) !== 'mage' || channelers.has(u.id) || hexDistance(u.pos, b.pos) > 14) continue;
      const v = effectiveStats(s, u).int * 2 - hexDistance(u.pos, b.pos);
      if (v > pv) { pv = v; pick = u; }
    }
    if (pick) channelers.set(pick.id, { ...b.pos });
  }

  let army = new Set<number>();
  let garrison = new Set<number>();
  let balance = 0;
  if (stance === 'attack') {
    const sorted = armed.slice().sort((a, b) => hexDistance(a.pos, seat) - hexDistance(b.pos, seat) || a.id - b.id);
    const keep = armed.length >= 6 ? 1 : 0;
    sorted.forEach((u, i) => (i < keep ? garrison : army).add(u.id));
    // Channelers stay home, unless the host would be too small without them.
    for (const id of [...channelers.keys()]) {
      if (garrison.has(id)) continue;
      if (army.size > 2) { army.delete(id); garrison.add(id); } else channelers.delete(id);
    }
    // Look before leaping: hostile strength we can see around the host (and its goal).
    let ours = 0;
    let theirs = 0;
    const marching = ctx.military.filter((u) => army.has(u.id));
    for (const u of marching) ours += powerOf(s, u);
    for (const e of ctx.foes) {
      const near = (anchor && hexDistance(e.pos, anchor) <= 4) || marching.some((u) => hexDistance(u.pos, e.pos) <= 7);
      if (!near) continue;
      // Defenders on fortified ground count extra.
      const fort = s.tiles[tileIndex(e.pos, s.width)].building;
      theirs += powerOf(s, e) * (fort != null && s.buildings[String(fort)]?.owner === e.faction ? 1.35 : 1);
    }
    balance = theirs > 0 ? ours / theirs : 99;
    // Clearly outmatched: fall back to our lines and let them come to us.
    if (balance < 0.8 && s.round < 150) {
      stance = 'build';
      army = new Set();
      garrison = new Set();
    }
  }

  // Keep the column together: nobody runs more than ~5 movement ahead of the marching median.
  // Only units out in the field count — fresh recruits and home defenders must not hold the
  // front line back (that froze whole wars at the limit).
  let advanceLimit = -Infinity;
  if (stance === 'attack' && anchor && army.size >= 2) {
    const field = distField(ctx, anchor);
    const homeD = field[tileIndex(seat, s.width)];
    const ds: number[] = [];
    for (const id of army) {
      const u = s.units[String(id)];
      if (!u) continue;
      const d = field[tileIndex(u.pos, s.width)];
      if (!Number.isFinite(d)) continue;
      if (hexDistance(u.pos, seat) <= 5 && Number.isFinite(homeD) && d >= homeD - 4) continue;
      ds.push(d);
    }
    if (ds.length >= 2) {
      const m = median(ds);
      if (m > 10) advanceLimit = m - 5;
    }
  }

  // Plan tracks for unarmed commoners (composition deficits, stock and iron shape the choice).
  const tracks = new Map<number, Track>();
  const counts: Partial<Record<Track, number>> = {};
  for (const u of ctx.military) {
    const t = trackOf(u);
    if (t === 'melee' || t === 'archer' || t === 'mage') counts[t] = (counts[t] ?? 0) + 1;
  }
  const comp = adaptedComposition(ctx);
  const avail = (['melee', 'archer', 'mage'] as Track[]).filter((t) => trackAvailable(ctx, t) && (comp[t] ?? 0) > 0);
  const shareSum = avail.reduce((a, t) => a + (comp[t] ?? 0), 0) || 1;
  const ironPoor = fs.resources.iron < 6 && inc.iron < 1;
  // Usable (unlocked) weapons already in the stockpile, by track: unarmed units are matched to
  // them first, and desiredLoadout then hands them exactly those items.
  const stockTracks = new Set<Track>();
  const stockLeft: Partial<Record<Track, number>> = {};
  for (const [item, n] of Object.entries(fs.stockpile)) {
    const it = ITEMS[item as keyof typeof ITEMS];
    if (!it || it.slot !== 'main' || (n ?? 0) <= 0 || !itemUnlocked(s, f, it.id)) continue;
    stockTracks.add(trackOfItem(it.id));
    if (it.id !== 'tools') stockLeft[trackOfItem(it.id)] = (stockLeft[trackOfItem(it.id)] ?? 0) + (n ?? 0);
  }
  let total = (counts.melee ?? 0) + (counts.archer ?? 0) + (counts.mage ?? 0);
  // Builder's Tools waiting in the stockpile while builders are short: the unarmed commoner
  // nearest home takes them up (how a house that lost its builders gets back on its feet).
  if ((fs.stockpile.tools ?? 0) > 0 && ctx.builders.length < builderTarget(ctx)) {
    let pick: Unit | null = null;
    for (const u of ctx.military) {
      if (trackOf(u) !== 'none') continue;
      if (!pick || hexDistance(u.pos, ctx.home) < hexDistance(pick.pos, ctx.home)) pick = u;
    }
    if (pick) tracks.set(pick.id, 'builder');
  }
  // Every mage tower, standing or rising (up to two), wants a mage to channel in it: the first
  // unarmed commoners go to the mage track until each has one (economy-ai.channelersShort).
  const towersUp = Math.min(2, ctx.own.filter((b) => b.type === 'magetower').length);
  let mageShort = avail.includes('mage') ? Math.max(0, towersUp - (counts.mage ?? 0)) : 0;
  for (const u of ctx.military) {
    if (trackOf(u) !== 'none' || tracks.has(u.id)) continue;
    let bestT: Track = 'archer';
    let bestV = -Infinity;
    for (const t of avail) {
      let v = ((comp[t] ?? 0) / shareSum) * (total + 1) - (counts[t] ?? 0);
      if (t === 'mage' && mageShort > 0) v += 5;
      if ((stockLeft[t] ?? 0) > 0) v += 4;
      else if (stockTracks.has(t)) v += 0.5;
      if (t === 'melee' && ironPoor) v -= 2;
      if (t === 'mage' && fs.resources.crystal < 3 && inc.crystal < 1) v -= 2;
      if (v > bestV) { bestV = v; bestT = t; }
    }
    tracks.set(u.id, bestT);
    if (bestT === 'mage' && mageShort > 0) mageShort--;
    if ((stockLeft[bestT] ?? 0) > 0) stockLeft[bestT]! -= 1;
    counts[bestT] = (counts[bestT] ?? 0) + 1;
    total++;
  }

  return {
    stance, target, anchor, army, garrison, channelers, advanceLimit, intruders, castleThreat, armyTarget, tracks,
    enemyMounted: ctx.foes.some((u) => isMounted(u)),
    balance,
  };
}
