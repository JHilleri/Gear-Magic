// Combat resolution and forecast. See DESIGN §4.4–4.5.
import type {
  AttackDef, AttackKind, AttackMod, AttackProfile, CombatForecast, FactionId, GameEvent, GameState, Hex, StrikeEvent, Unit, XpCategory,
} from '../core/types';
import { hexDistance, neighbors } from '../core/hex';
import { rand } from '../core/rng';
import { TERRAIN, FLAT_TERRAIN, ROUGH_FOR_MOUNTS } from '../data/terrain';
import { BUILDINGS } from '../data/buildings';
import { ITEMS } from '../data/items';
import { FACTIONS } from '../data/factions';
import { getTile, isEnemy } from './state';
import { effectiveStats, getAttackDefs, isMounted, eff, mainAttackKind } from './units';
import { techDamageMult } from './research';
import { checkVictory } from './turn';
import { buildingOn, giveXp, isFunctional, isHumanFaction, logEvent, logFor, roundHalfUp, unitOn } from './ruleutil';
import { orderInterrupted } from './orders';

// ───────────────────────────── modifiers ─────────────────────────────

const MOUNT_ROUGH_PENALTY = 10;
export const LEADERSHIP_MULT = 1.15;
export const BERSERK_MULT = 1.25;
export const CHARGE_MULT = 1.25;
export const MAGIC_HIT = 0.7;
export const MARKSMAN_MIN = 0.6;
export const VAMPIRIC_SHARE = 0.3;

/** Defense % of `unit` standing on `h`: terrain + building bonus + shield + mount penalty, clamped [10, 90] as "chance to be missed"... returns 0..100. */
export function tileDefense(state: GameState, unit: Unit, h: Hex): number {
  const tile = getTile(state, h);
  if (!tile) return 10;
  let def = TERRAIN[tile.terrain].defense;
  // Fortifications only shelter their owner's troops (castle / wall / watchtower by level).
  const b = buildingOn(state, h);
  if (isFunctional(b) && b.owner === unit.faction) {
    const bd = BUILDINGS[b.type].defense;
    if (bd && bd.length) def += bd[Math.min(bd.length, Math.max(1, b.level)) - 1];
  }
  for (const slot of ['main', 'off', 'body', 'trinket', 'mount'] as const) {
    const it = unit.equipment[slot];
    if (it) def += ITEMS[it].terrainDefense ?? 0;
  }
  if (isMounted(unit) && ROUGH_FOR_MOUNTS.includes(tile.terrain)) def -= MOUNT_ROUGH_PENALTY;
  return Math.max(10, Math.min(90, def));
}

function attackDefOf(unit: Unit, kind: AttackKind): AttackDef | null {
  return getAttackDefs(unit).find((a) => a.kind === kind) ?? null;
}

/** Ranged and magic retaliate against each other; melee only against melee. */
const family = (k: AttackKind): 'melee' | 'ranged' => (k === 'melee' ? 'melee' : 'ranged');

function hasLeadershipNeighbor(state: GameState, unit: Unit): boolean {
  for (const n of neighbors(unit.pos)) {
    const o = unitOn(state, n);
    if (o && o.id !== unit.id && o.faction === unit.faction && o.passives.includes('leadership')) return true;
  }
  return false;
}

/** Total damage multiplier from active buffs. Power Strike only boosts melee attacks the unit initiates. */
function buffMult(unit: Unit, kind: AttackKind, attacking: boolean): number {
  let m = 1;
  for (const b of unit.buffs) {
    if (!b.damageMult) continue;
    if (b.id === 'powerstrike' && !(attacking && kind === 'melee')) continue;
    m *= b.damageMult;
  }
  return m;
}

/**
 * Profile of `unit` hitting `target` with attack `def`. `attacking` = it initiated the
 * fight (charge and Power Strike only apply on offence). The target's tile defense uses
 * its current position.
 */
function buildProfile(state: GameState, unit: Unit, target: Unit, def: AttackDef, attacking: boolean): AttackProfile {
  const st = effectiveStats(state, unit);
  const tst = effectiveStats(state, target);
  const kind = def.kind;
  const stat = kind === 'melee' ? st.str : kind === 'ranged' ? st.dex : st.int;
  // `mods` only explains the number (the forecast shows why); it never changes it.
  const mods: AttackMod[] = [];
  let dmg = def.base + Math.floor(Math.max(0, stat) / 2);
  dmg *= eff(unit, kind === 'melee' ? 'attack' : kind);
  dmg *= buffMult(unit, kind, attacking);
  const ps = attacking && kind === 'melee' ? unit.buffs.find((b) => b.id === 'powerstrike' && b.damageMult) : undefined;
  if (ps) mods.push({ id: 'powerstrike', label: 'Power Strike (spent on this attack)', mult: ps.damageMult });
  if (hasLeadershipNeighbor(state, unit)) {
    dmg *= LEADERSHIP_MULT;
    mods.push({ id: 'leadership', label: 'Leadership', mult: LEADERSHIP_MULT });
  }
  if (kind === 'melee' && unit.passives.includes('berserker') && unit.hp < st.maxHp / 2) {
    dmg *= BERSERK_MULT;
    mods.push({ id: 'berserker', label: 'Berserker', mult: BERSERK_MULT });
  }
  if (attacking && kind === 'melee' && isMounted(unit)) {
    const t = getTile(state, unit.pos);
    if (t && FLAT_TERRAIN.includes(t.terrain)) {
      dmg *= CHARGE_MULT;
      mods.push({ id: 'charge', label: 'Charge (open ground)', mult: CHARGE_MULT });
    }
  }
  const fdef = FACTIONS[unit.faction];
  if (kind === 'melee' && fdef.meleeMult) dmg *= fdef.meleeMult;
  if (kind === 'ranged' && fdef.rangedMult) dmg *= fdef.rangedMult;
  if (kind === 'magic' && fdef.magicMult) dmg *= fdef.magicMult;
  if (unit.faction !== 'neutral') dmg *= techDamageMult(state, unit.faction);
  if (kind === 'magic') {
    for (const slot of ['main', 'off', 'body', 'trinket', 'mount'] as const) {
      const it = unit.equipment[slot];
      if (it && ITEMS[it].magicDamageMult) dmg *= ITEMS[it].magicDamageMult!;
    }
  }
  if (def.vsMounted && isMounted(target)) {
    dmg *= def.vsMounted;
    mods.push({ id: 'vsMounted', label: 'Bonus vs mounted', mult: def.vsMounted });
  }
  if (kind === 'melee' && unit.passives.includes('poison') && !target.poisoned) mods.push({ id: 'poison', label: 'Poisons on hit (4/turn)' });
  if (kind === 'melee' && unit.passives.includes('vampiric')) mods.push({ id: 'vampiric', label: `Drains ${Math.round(VAMPIRIC_SHARE * 100)}% of damage dealt` });
  const armor = Math.max(0, Math.min(100, tst.armor));
  dmg *= 1 - armor / 100;
  const damage = Math.max(1, roundHalfUp(dmg));

  let hit = kind === 'magic' ? MAGIC_HIT : (100 - tileDefense(state, target, target.pos)) / 100;
  if (kind === 'ranged' && unit.passives.includes('marksman')) hit = Math.max(hit, MARKSMAN_MIN);
  return {
    kind, name: def.name, damage, strikes: def.strikes, hitChance: hit, range: def.range, firststrike: !!def.firststrike,
    ...(mods.length ? { mods } : {}),
  };
}

/** Full attack profile of `attacker` using its attack of `kind` against `defender` (damage after all modifiers, hit chance). Null if the attacker has no such attack. */
export function attackProfile(state: GameState, attacker: Unit, defender: Unit, kind: AttackKind): AttackProfile | null {
  const def = attackDefOf(attacker, kind);
  return def ? buildProfile(state, attacker, defender, def, true) : null;
}

/** The defender's retaliation profile (same family, must reach the attacker), or null. */
export function retaliationProfile(state: GameState, attacker: Unit, defender: Unit, kind: AttackKind): AttackProfile | null {
  const dist = hexDistance(attacker.pos, defender.pos);
  const want = family(kind);
  // Prefer the strongest reaching attack of the matching family (e.g. staff magic over nothing).
  let best: AttackProfile | null = null;
  for (const d of getAttackDefs(defender)) {
    if (family(d.kind) !== want) continue;
    if (dist > d.range || (d.kind === 'melee' && dist !== 1)) continue;
    const p = buildProfile(state, defender, attacker, d, false);
    if (!best || p.damage * p.strikes * p.hitChance > best.damage * best.strikes * best.hitChance) best = p;
  }
  return best;
}

/** Which attack kinds `attacker` could use on `defender` from its current hex (range check). */
export function availableAttackKinds(state: GameState, attacker: Unit, defender: Unit): AttackKind[] {
  const dist = hexDistance(attacker.pos, defender.pos);
  if (dist < 1) return [];
  const out: AttackKind[] = [];
  for (const d of getAttackDefs(attacker)) {
    if (d.kind === 'melee' ? dist === 1 : dist <= d.range) {
      if (!out.includes(d.kind)) out.push(d.kind);
    }
  }
  return out;
}

/** Null if legal, else reason (not enemy, already acted, out of range, no such attack). */
export function canAttack(state: GameState, attacker: Unit, defender: Unit, kind: AttackKind): string | null {
  if (!state.units[String(attacker.id)] || attacker.hp <= 0) return 'Attacker is gone';
  if (!state.units[String(defender.id)] || defender.hp <= 0) return 'Target is gone';
  if (attacker.faction === defender.faction || !isEnemy(attacker.faction, defender.faction)) return 'Not an enemy';
  if (attacker.acted) return 'This unit has already acted this turn';
  const def = attackDefOf(attacker, kind);
  if (!def) return `No ${kind} attack`;
  const dist = hexDistance(attacker.pos, defender.pos);
  if (def.kind === 'melee' ? dist !== 1 : dist < 1 || dist > def.range) return 'Target out of range';
  return null;
}

// ───────────────────────────── strike sequence ─────────────────────────────

type Side = 'attacker' | 'defender';

function strikeOrder(a: AttackProfile, d: AttackProfile | null): Side[] {
  // Wesnoth: firststrike on the defender lets it swing first unless the attacker has it too.
  const defenderFirst = !!d && d.firststrike && !a.firststrike;
  const order: Side[] = [];
  const n = Math.max(a.strikes, d?.strikes ?? 0);
  for (let i = 0; i < n; i++) {
    const pair: Side[] = defenderFirst ? ['defender', 'attacker'] : ['attacker', 'defender'];
    for (const s of pair) {
      const strikes = s === 'attacker' ? a.strikes : d?.strikes ?? 0;
      if (i < strikes) order.push(s);
    }
  }
  return order;
}

interface Setup {
  a: AttackProfile;
  d: AttackProfile | null;
  order: Side[];
  aMax: number; dMax: number;
  aHp: number; dHp: number;
  aDrain: boolean; dDrain: boolean;   // vampiric melee
  aPoison: boolean; dPoison: boolean; // poison melee
}

function setup(state: GameState, attacker: Unit, defender: Unit, kind: AttackKind): Setup | null {
  const a = attackProfile(state, attacker, defender, kind);
  if (!a) return null;
  const d = retaliationProfile(state, attacker, defender, kind);
  const aMax = Math.max(effectiveStats(state, attacker).maxHp, attacker.hp);
  const dMax = Math.max(effectiveStats(state, defender).maxHp, defender.hp);
  return {
    a, d, order: strikeOrder(a, d), aMax, dMax,
    aHp: Math.max(0, attacker.hp), dHp: Math.max(0, defender.hp),
    aDrain: a.kind === 'melee' && attacker.passives.includes('vampiric'),
    dDrain: !!d && d.kind === 'melee' && defender.passives.includes('vampiric'),
    aPoison: a.kind === 'melee' && attacker.passives.includes('poison'),
    dPoison: !!d && d.kind === 'melee' && defender.passives.includes('poison'),
  };
}

const drainOf = (dealt: number): number => Math.round(dealt * VAMPIRIC_SHARE);

/** Exact outcome distribution (no state mutation, no RNG). */
export function forecastCombat(state: GameState, attacker: Unit, defender: Unit, kind: AttackKind): CombatForecast | null {
  const s = setup(state, attacker, defender, kind);
  if (!s) return null;
  // Joint distribution over (attacker hp, defender hp); vampiric drain couples the two.
  const W = s.dMax + 1;
  let dist = new Map<number, number>();
  dist.set(s.aHp * W + s.dHp, 1);
  for (const side of s.order) {
    const prof = side === 'attacker' ? s.a : s.d!;
    const next = new Map<number, number>();
    const add = (k: number, p: number) => { if (p > 0) next.set(k, (next.get(k) ?? 0) + p); };
    for (const [k, p] of dist) {
      const ah = Math.floor(k / W), dh = k % W;
      if (ah <= 0 || dh <= 0) { add(k, p); continue; }
      add(k, p * (1 - prof.hitChance));
      if (side === 'attacker') {
        const nd = Math.max(0, dh - prof.damage);
        const na = s.aDrain ? Math.min(s.aMax, ah + drainOf(dh - nd)) : ah;
        add(na * W + nd, p * prof.hitChance);
      } else {
        const na = Math.max(0, ah - prof.damage);
        const nd = s.dDrain ? Math.min(s.dMax, dh + drainOf(ah - na)) : dh;
        add(na * W + nd, p * prof.hitChance);
      }
    }
    dist = next;
  }
  const attackerHpDist = new Array(s.aMax + 1).fill(0);
  const defenderHpDist = new Array(s.dMax + 1).fill(0);
  for (const [k, p] of dist) {
    attackerHpDist[Math.floor(k / W)] += p;
    defenderHpDist[k % W] += p;
  }
  const exp = (arr: number[]) => arr.reduce((acc, p, hp) => acc + p * hp, 0);
  return {
    attacker: s.a,
    defender: s.d,
    attackerHpDist,
    defenderHpDist,
    attackerKillChance: attackerHpDist[0],
    defenderKillChance: defenderHpDist[0],
    expectedDamageToDefender: Math.max(0, s.dHp - exp(defenderHpDist)),
    expectedDamageToAttacker: Math.max(0, s.aHp - exp(attackerHpDist)),
  };
}

/**
 * Forecast as if `attacker` stood on `from` (AI move+attack evaluation). The unit is moved
 * temporarily and always restored; no other state is touched.
 */
export function forecastFrom(state: GameState, attacker: Unit, from: Hex, defender: Unit, kind: AttackKind): CombatForecast | null {
  const origin = attacker.pos;
  attacker.pos = { q: from.q, r: from.r };
  try {
    return forecastCombat(state, attacker, defender, kind);
  } finally {
    attacker.pos = origin;
  }
}

/** XP category an attack of `kind` teaches: melee, ranged or magic (DESIGN §4.7). */
const xpCat = (kind: AttackKind): XpCategory => kind;
/** What a unit learns from a fight it took part in without striking a blow of its own: its own weapon's trade. */
const ownXpCat = (u: Unit): XpCategory => xpCat(mainAttackKind(u));

/** Resolve with state RNG; mutates hp, xp (via progression.grantXp), poison, kills, sets attacker mp=0/acted. Returns combat + death + level events. */
export function resolveCombat(state: GameState, attacker: Unit, defender: Unit, kind: AttackKind): GameEvent[] {
  const s = setup(state, attacker, defender, kind);
  if (!s) return [];
  const strikes: StrikeEvent[] = [];
  let aHits = 0, dHits = 0;
  for (const side of s.order) {
    if (attacker.hp <= 0 || defender.hp <= 0) break;
    const prof = side === 'attacker' ? s.a : s.d!;
    const striker = side === 'attacker' ? attacker : defender;
    const target = side === 'attacker' ? defender : attacker;
    const hit = rand(state) < prof.hitChance;
    const ev: StrikeEvent = { by: side, hit, damage: 0 };
    if (hit) {
      const before = target.hp;
      target.hp = Math.max(0, target.hp - prof.damage);
      ev.damage = before - target.hp;
      if (side === 'attacker') aHits++; else dHits++;
      const poisons = side === 'attacker' ? s.aPoison : s.dPoison;
      if (poisons && target.hp > 0 && !target.poisoned) {
        target.poisoned = true;
        ev.poisoned = true;
      }
      const drains = side === 'attacker' ? s.aDrain : s.dDrain;
      if (drains) {
        const max = side === 'attacker' ? s.aMax : s.dMax;
        const healed = Math.min(max - striker.hp, drainOf(ev.damage));
        if (healed > 0) { striker.hp += healed; ev.drained = healed; }
      }
    }
    strikes.push(ev);
  }

  // Power Strike is spent by the melee attack it boosted.
  if (kind === 'melee') attacker.buffs = attacker.buffs.filter((b) => b.id !== 'powerstrike');
  attacker.mp = 0;
  attacker.moveEnded = true; // DESIGN §4.5: no Haste or Rally brings it back this turn
  attacker.acted = true;
  defender.restedLastTurn = false;

  const events: GameEvent[] = [{
    type: 'combat', attacker: attacker.id, defender: defender.id, kind, strikes,
    attackerHp: attacker.hp, defenderHp: defender.hp,
  }];

  const aName = attacker.name, dName = defender.name;
  const aDealt = strikes.filter((x) => x.by === 'attacker').reduce((t, x) => t + x.damage, 0);
  const dDealt = strikes.filter((x) => x.by === 'defender').reduce((t, x) => t + x.damage, 0);
  events.push(...logFor(state, [attacker.faction, defender.faction],
    `${aName} attacks ${dName} (${s.a.name}): deals ${aDealt}${s.d ? `, takes ${dDealt}` : ''}.`, 'combat', attacker.faction));

  // Survivors learn from the exchange: 1 + 1 per strike landed.
  if (attacker.hp > 0) events.push(...giveXp(state, attacker, xpCat(kind), 1 + aHits));
  if (defender.hp > 0) events.push(...giveXp(state, defender, s.d ? xpCat(s.d.kind) : ownXpCat(defender), 1 + dHits));

  if (defender.hp <= 0) events.push(...killUnit(state, defender, attacker, xpCat(kind)));
  else if (attacker.hp <= 0) events.push(...killUnit(state, attacker, defender, s.d ? xpCat(s.d.kind) : ownXpCat(defender)));
  // Being attacked ends a standing order (rest or sentry) of a defender that lived through it.
  events.push(...orderInterrupted(state, defender));
  return events;
}

/** Extra kill bookkeeping for non-combat damage. */
export interface DamageCredit {
  /** XP category of a killing blow (default: magic for spells, else the killer's main weapon trade). */
  cat?: XpCategory;
  /** Faction credited with a kill when no living unit dealt it (a spell from an empty tower). */
  by?: FactionId | null;
}

/** Non-combat damage (spells, poison, starvation, skills). Handles death. `minHp` keeps the unit alive at that hp (starvation uses 1). */
export function applyDamage(
  state: GameState, unit: Unit, amount: number, source: 'spell' | 'poison' | 'starvation' | 'skill',
  killer?: Unit | null, minHp?: number, credit?: DamageCredit,
): GameEvent[] {
  if (!state.units[String(unit.id)] || amount <= 0) return [];
  const floor = Math.max(0, minHp ?? 0);
  const before = unit.hp;
  unit.hp = Math.max(Math.min(floor, before), before - Math.round(amount));
  const dealt = before - unit.hp;
  const events: GameEvent[] = [];
  if (dealt > 0) events.push({ type: 'unitDamaged', unit: unit.id, amount: dealt, source });
  if (source === 'spell' || source === 'skill') unit.restedLastTurn = false;
  if (unit.hp <= 0) {
    const cat = credit?.cat ?? (source === 'spell' ? 'magic' : undefined);
    events.push(...killUnit(state, unit, killer ?? null, cat, credit?.by ?? null));
  } else if ((source === 'spell' || source === 'skill') && (killer?.faction ?? credit?.by ?? null) !== unit.faction) {
    // A hostile spell or skill is an attack (the house's own Fireball on its lines is not).
    events.push(...orderInterrupted(state, unit));
  }
  return events;
}

/** Kill XP: 8 × level (4 for level-0 summons). */
export function killXp(victim: Unit): number {
  return victim.level <= 0 ? 4 : 8 * victim.level;
}

/**
 * Remove a unit. Leader death eliminates its faction: all its units are removed, its
 * buildings become owner=null, faction.alive=false (events: unitDied…, factionEliminated,
 * and gameOver via turn.checkVictory). Killer gains kill XP (8 × level, 4 for summons).
 * `cat` is the XP category of the killing blow (the attack kind used; default: the killer's main
 * weapon trade). `by` credits a faction (kill stats, elimination) when no unit dealt the blow,
 * e.g. a spell from an empty tower.
 */
export function killUnit(state: GameState, unit: Unit, killer: Unit | null, cat?: XpCategory, by: FactionId | null = null): GameEvent[] {
  const key = String(unit.id);
  if (!state.units[key]) return [];
  const events: GameEvent[] = [];
  const pos = { ...unit.pos };
  unit.hp = 0;
  delete state.units[key];
  events.push({ type: 'unitDied', unit: unit.id, killer: killer?.id ?? null, pos, faction: unit.faction });

  const victimFaction = state.factions[unit.faction];
  if (victimFaction && !unit.summonTurns) victimFaction.stats.lost++;
  // Friendly fire (a Fireball on your own lines) earns no glory.
  const hostileKiller = killer && killer.faction !== unit.faction ? killer : null;
  const killerAlive = !!hostileKiller && !!state.units[String(hostileKiller.id)];
  const creditFaction = hostileKiller?.faction
    ?? (!killer && by && by !== unit.faction && isEnemy(by, unit.faction) ? by : null);
  if (creditFaction) {
    const kf = state.factions[creditFaction];
    if (kf) kf.stats.kills++;
  }
  if (killerAlive) hostileKiller!.kills++;
  events.push(...logFor(state, [unit.faction, killer?.faction ?? creditFaction],
    killer ? `${unit.name} is slain by ${killer.name}.` : `${unit.name} has perished.`, 'combat', unit.faction));

  if (hostileKiller && killerAlive) {
    events.push(...giveXp(state, hostileKiller, cat ?? ownXpCat(hostileKiller), killXp(unit)));
    // The killer's leader earns command XP for allied kills nearby.
    const lid = state.factions[hostileKiller.faction]?.leaderId;
    const leader = lid != null ? state.units[String(lid)] : undefined;
    if (leader && leader.id !== hostileKiller.id && hexDistance(leader.pos, pos) <= 3) {
      events.push(...giveXp(state, leader, 'leader', 1));
    }
  }

  if (unit.isLeader && unit.faction !== 'neutral' && victimFaction?.alive) {
    events.push(...eliminateFaction(state, unit.faction, creditFaction));
  }
  return events;
}

/** While > 0, eliminations skip the victory check: a multi-target effect is still resolving. */
let victoryHold = 0;

/**
 * Run a multi-target damage effect (Fireball, Storm, Volley) and decide victory once it has
 * fully resolved, so a faction whose leader dies later in the same blast is never named winner.
 */
export function withDeferredVictory(state: GameState, effect: () => GameEvent[]): GameEvent[] {
  victoryHold++;
  let events: GameEvent[];
  try {
    events = effect();
  } finally {
    victoryHold--;
  }
  if (victoryHold === 0) events.push(...checkVictory(state));
  return events;
}

/** Faction loses its leader: everything it fielded vanishes, its buildings fall to ruin (owner null). */
export function eliminateFaction(state: GameState, f: Unit['faction'], by: Unit['faction'] | null): GameEvent[] {
  const fs = state.factions[f];
  if (!fs || !fs.alive) return [];
  const events: GameEvent[] = [];
  fs.alive = false;
  // Remembered for the end screen ("slain by …"); a house never slays itself (its own Fireball).
  fs.eliminatedBy = by && by !== f ? by : null;
  fs.leaderId = null;
  fs.castleId = null;
  fs.researching = null;
  const ids = Object.keys(state.units).map(Number).sort((a, b) => a - b);
  for (const id of ids) {
    const u = state.units[String(id)];
    if (!u || u.faction !== f) continue;
    delete state.units[String(id)];
    if (!u.summonTurns) fs.stats.lost++;
    events.push({ type: 'unitDied', unit: u.id, killer: null, pos: { ...u.pos }, faction: f });
  }
  for (const k of Object.keys(state.buildings)) {
    const b = state.buildings[k];
    if (b.owner === f) b.owner = null;
  }
  events.push({ type: 'factionEliminated', faction: f, by });
  const name = FACTIONS[f].name;
  const byName = fs.eliminatedBy ? FACTIONS[fs.eliminatedBy].name : null; // (never "destroyed by" itself)
  events.push(logEvent(state, isHumanFaction(state, f)
    ? `Your leader has fallen. ${name} is no more.`
    : `${name} has been destroyed${byName ? ` by ${byName}` : ''}!`, 'warning', f));
  if (victoryHold === 0) events.push(...checkVictory(state));
  return events;
}
