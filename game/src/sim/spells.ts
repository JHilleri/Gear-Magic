// Global spells cast from mage towers. See DESIGN §7.
import type { Building, BuildingInstanceId, EffectEntry, EffectPreview, FactionId, GameEvent, GameState, Hex, SpellId, Unit } from '../core/types';
import { hexDistance, inBounds, tileIndex } from '../core/hex';
import { rand } from '../core/rng';
import { SPELLS } from '../data/spells';
import { TECH_LIST } from '../data/research';
import { TERRAIN } from '../data/terrain';
import { FACTIONS } from '../data/factions';
import { isEnemy } from './state';
import { createUnit, effectiveStats } from './units';
import { hasTech } from './research';
import { computeVisibility, isExplored, isVisible } from './visibility';
import { applyDamage, withDeferredVictory } from './combat';
import { buildingOn, giveXp, isFunctional, logFor, unitOn } from './ruleutil';

const HEAL_HP = 15;
const BLESS_BUFF = { damageMult: 1.2, armor: 10, turns: 2 };
const FIREBALL_CENTER = 18;
const FIREBALL_SPLASH = 8;
const HASTE_MP = 3;
const FARSIGHT_TURNS = 3;
const SUMMON_TURNS = 8;
const STORM_BOLTS = 4;
const STORM_DAMAGE = 14;
const CAST_XP = 6;

/** Fireball damage at `dist` hexes from its target hex (0 = the target hex itself). */
export function fireballDamageAt(dist: number): number {
  return dist === 0 ? FIREBALL_CENTER : FIREBALL_SPLASH;
}

/** P(k successes) for k = 0..n. */
export function binomial(n: number, p: number): number[] {
  const out: number[] = [];
  let c = 1;
  for (let k = 0; k <= n; k++) {
    out.push(c * p ** k * (1 - p) ** (n - k));
    c = (c * (n - k)) / (k + 1);
  }
  return out;
}

/** Final-HP distribution after k hits of `dmg` (k ~ `hits`), with expected HP change and kill chance. */
export function hitsOutcome(hp: number, dmg: number, hits: number[]): { hpDist: number[]; hpDelta: number; killChance: number } {
  const hpDist = new Array(Math.max(0, hp) + 1).fill(0);
  let exp = 0;
  hits.forEach((p, k) => {
    const left = Math.max(0, hp - k * dmg);
    hpDist[left] += p;
    exp += p * (left - hp);
  });
  return { hpDist, hpDelta: exp, killChance: hpDist[0] ?? 0 };
}

/**
 * What casting `spell` on `target` would do, without changing anything (UI preview). Lists only
 * units the caster's faction can see; the numbers come from the same constants castSpell uses.
 */
export function previewSpell(state: GameState, faction: FactionId, spell: SpellId, target: Hex): EffectPreview {
  const def = SPELLS[spell];
  const entries: EffectEntry[] = [];
  const notes: string[] = [];
  if (!def) return { tone: 'neutral', entries, notes };
  const entry = (u: Unit, hpDelta: number, killChance: number, extra: Partial<EffectEntry> = {}): EffectEntry => ({
    unit: u.id, own: u.faction === faction, hpBefore: u.hp, maxHp: effectiveStats(state, u).maxHp, hpDelta, killChance, ...extra,
  });
  const inArea = unitsWithin(state, target, def.radius).filter((u) => visibleTo(state, faction, u));
  switch (spell) {
    case 'heal':
      for (const u of inArea) {
        if (u.faction !== faction) continue;
        entries.push(entry(u, Math.max(0, Math.min(HEAL_HP, effectiveStats(state, u).maxHp - u.hp)), 0));
      }
      notes.push('Cures poison');
      return { tone: 'help', entries, notes };
    case 'bless':
      for (const u of inArea) if (u.faction === faction) entries.push(entry(u, 0, 0));
      notes.push(`+${Math.round((BLESS_BUFF.damageMult - 1) * 100)}% damage and +${BLESS_BUFF.armor} armor for ${BLESS_BUFF.turns} turns`);
      return { tone: 'help', entries, notes };
    case 'fireball':
      for (const u of inArea) {
        const dmg = fireballDamageAt(hexDistance(u.pos, target));
        entries.push(entry(u, -Math.min(dmg, Math.max(0, u.hp)), u.hp <= dmg ? 1 : 0));
      }
      notes.push('Ignores armor · hits friend and foe');
      return { tone: 'harm', entries, notes };
    case 'haste': {
      const u = unitOn(state, target);
      if (u && u.faction === faction) entries.push(entry(u, 0, 0, { mpDelta: HASTE_MP }));
      return { tone: 'help', entries, notes };
    }
    case 'storm': {
      const foes = inArea.filter((u) => u.faction !== faction && isEnemy(faction, u.faction));
      const hits = binomial(STORM_BOLTS, foes.length ? 1 / foes.length : 0);
      for (const u of foes) {
        const o = hitsOutcome(Math.max(0, u.hp), STORM_DAMAGE, hits);
        entries.push(entry(u, o.hpDelta, o.killChance, { hpDist: o.hpDist, approx: foes.length > 1 }));
      }
      notes.push(`${STORM_BOLTS} bolts of ${STORM_DAMAGE}, each at a random enemy in the area · ignores armor`);
      return { tone: 'harm', entries, notes };
    }
    case 'farsight':
      notes.push(`Reveals everything within ${def.radius} hexes for ${FARSIGHT_TURNS} turns`);
      return { tone: 'neutral', entries, notes };
    case 'summon':
      notes.push(`A Stone Elemental appears here for ${SUMMON_TURNS} turns`);
      return { tone: 'help', entries, notes };
  }
  return { tone: 'neutral', entries, notes };
}

/** Spells the faction has unlocked through research. */
export function knownSpells(state: GameState, faction: FactionId): SpellId[] {
  const out: SpellId[] = [];
  for (const t of TECH_LIST) {
    if (t.unlocksSpell && hasTech(state, faction, t.id) && !out.includes(t.unlocksSpell)) out.push(t.unlocksSpell);
  }
  const order = Object.keys(SPELLS) as SpellId[];
  return out.sort((a, b) => order.indexOf(a) - order.indexOf(b));
}

/** The own unit channeling in the tower (standing on it), if any. */
export function towerChanneler(state: GameState, tower: Building): Unit | undefined {
  const u = unitOn(state, tower.pos);
  return u && u.faction === tower.owner ? u : undefined;
}

/** Effective range of `spell` from tower (spell.range + floor(int/3) of the best own unit standing on it). */
export function towerRange(state: GameState, tower: BuildingInstanceId, spell: SpellId): number {
  const b = state.buildings[String(tower)];
  const def = SPELLS[spell];
  if (!b || !def) return 0;
  const u = towerChanneler(state, b);
  const bonus = u && !u.monster ? Math.floor(Math.max(0, effectiveStats(state, u).int) / 3) : 0;
  return def.range + bonus;
}

function ownTowers(state: GameState, faction: FactionId): Building[] {
  return Object.values(state.buildings)
    .filter((b) => b.type === 'magetower' && b.owner === faction && isFunctional(b))
    .sort((a, b) => a.id - b.id);
}

/** Own completed mage towers from which `target` is within range (sorted best first). */
export function towersInRange(state: GameState, faction: FactionId, spell: SpellId, target: Hex): BuildingInstanceId[] {
  // Best = a channeler present (earns XP), then nearest, then oldest.
  return ownTowers(state, faction)
    .filter((b) => hexDistance(b.pos, target) <= towerRange(state, b.id, spell))
    .sort((a, b) => (towerChanneler(state, b) ? 1 : 0) - (towerChanneler(state, a) ? 1 : 0)
      || hexDistance(a.pos, target) - hexDistance(b.pos, target) || a.id - b.id)
    .map((b) => b.id);
}

function unitsWithin(state: GameState, center: Hex, radius: number): Unit[] {
  const out: Unit[] = [];
  for (const k in state.units) {
    const u = state.units[k];
    if (hexDistance(u.pos, center) <= radius) out.push(u);
  }
  return out.sort((a, b) => a.id - b.id);
}

const visibleTo = (state: GameState, faction: FactionId, u: Unit): boolean =>
  u.faction === faction || isVisible(state, faction, u.pos);

/** Null if castable: known, mana, cooldown, tower owned & complete, target in range & valid (e.g. summon needs an empty passable hex that is not someone else's building, haste needs an ally that has not attacked). */
export function canCast(state: GameState, faction: FactionId, spell: SpellId, tower: BuildingInstanceId, target: Hex): string | null {
  const def = SPELLS[spell];
  if (!def) return 'Unknown spell';
  const fs = state.factions[faction];
  if (!fs || !fs.alive || faction === 'neutral') return 'Faction cannot cast';
  if (!knownSpells(state, faction).includes(spell)) return `${def.name} has not been researched`;
  const cd = fs.spellCooldowns[spell] ?? 0;
  if (cd > 0) return `${def.name} is recharging (${cd} turn${cd === 1 ? '' : 's'})`;
  if ((fs.resources.mana ?? 0) + 1e-9 < def.mana) return `Not enough mana (${def.mana} needed)`;
  const b = state.buildings[String(tower)];
  if (!b || b.type !== 'magetower') return 'Spells are cast from a Mage Tower';
  if (b.owner !== faction) return 'Not your Mage Tower';
  if (!isFunctional(b)) return 'The Mage Tower is still under construction';
  if (!target || !inBounds(target, state.width, state.height)) return 'Target is outside the map';
  // Farsight exists to look into the unknown; everything else needs known ground.
  if (spell !== 'farsight' && !isExplored(state, faction, target)) return 'Cannot target unexplored land';
  if (hexDistance(b.pos, target) > towerRange(state, b.id, spell)) return 'Target is out of range of this tower';
  switch (spell) {
    case 'heal': {
      const allies = unitsWithin(state, target, def.radius).filter((u) => u.faction === faction);
      if (!allies.length) return 'No allies in the area';
      if (!allies.some((u) => u.poisoned || u.hp < effectiveStats(state, u).maxHp)) return 'No wounded allies in the area';
      return null;
    }
    case 'bless':
      return unitsWithin(state, target, def.radius).some((u) => u.faction === faction) ? null : 'No allies in the area';
    case 'fireball':
      return unitsWithin(state, target, def.radius).some((u) => visibleTo(state, faction, u)) ? null : 'Nothing to burn there';
    case 'storm':
      return unitsWithin(state, target, def.radius)
        .some((u) => u.faction !== faction && isEnemy(faction, u.faction) && visibleTo(state, faction, u)) ? null : 'No enemies in the area';
    case 'haste': {
      const u = unitOn(state, target);
      if (!u || u.faction !== faction) return 'Choose one of your units';
      if (u.justSpawned) return 'Fresh recruits cannot march yet';
      if (u.moveEnded) return 'It has already attacked: its movement is over this turn';
      return null;
    }
    case 'farsight':
      return null;
    case 'summon': {
      const t = state.tiles[tileIndex(target, state.width)];
      if (!t || !Number.isFinite(TERRAIN[t.terrain].moveCost)) return 'The elemental cannot stand there';
      if (!isVisible(state, faction, target)) return 'Target must be in sight';
      if (unitOn(state, target)) return 'The hex is occupied';
      // Same rule as a recruit's spawn hex (DESIGN §4.9): never on another faction's building.
      const bt = buildingOn(state, target);
      if (bt && bt.owner !== faction) return "The elemental cannot appear on another faction's building";
      return null;
    }
  }
  return 'Unknown spell';
}

/** Apply: pay mana, set cooldown, effects (with state RNG), +6 magic XP to the tower's unit, stats.spellsCast++. */
export function castSpell(state: GameState, faction: FactionId, spell: SpellId, tower: BuildingInstanceId, target: Hex): GameEvent[] {
  const def = SPELLS[spell];
  const fs = state.factions[faction];
  const b = state.buildings[String(tower)];
  const caster = towerChanneler(state, b);
  fs.resources.mana = Math.max(0, Math.round((fs.resources.mana - def.mana) * 100) / 100);
  fs.spellCooldowns[spell] = def.cooldown;
  fs.stats.spellsCast++;

  const cast: Extract<GameEvent, { type: 'spellCast' }> = {
    type: 'spellCast', faction, spell, from: { ...b.pos }, target: { ...target }, affected: [],
  };
  const events: GameEvent[] = [cast];
  const effects: GameEvent[] = [];
  const affected: number[] = [];
  const killer = caster && !caster.monster ? caster : null;
  // Without a channeler the house itself is credited with what its tower kills.
  const credit = { by: faction };

  switch (spell) {
    case 'heal': {
      for (const u of unitsWithin(state, target, def.radius)) {
        if (u.faction !== faction) continue;
        const max = effectiveStats(state, u).maxHp;
        const amount = Math.max(0, Math.min(HEAL_HP, max - u.hp));
        u.hp += amount;
        u.poisoned = false;
        affected.push(u.id);
        if (amount > 0) effects.push({ type: 'unitHealed', unit: u.id, amount });
      }
      break;
    }
    case 'bless': {
      for (const u of unitsWithin(state, target, def.radius)) {
        if (u.faction !== faction) continue;
        u.buffs = u.buffs.filter((x) => x.id !== 'bless');
        u.buffs.push({ id: 'bless', turns: BLESS_BUFF.turns, damageMult: BLESS_BUFF.damageMult, armor: BLESS_BUFF.armor });
        affected.push(u.id);
      }
      break;
    }
    case 'fireball': {
      // Friend or foe: 18 on the target hex, 8 to everything around it. Victory is decided
      // once the whole blast has landed.
      effects.push(...withDeferredVictory(state, () => {
        const evs: GameEvent[] = [];
        for (const u of unitsWithin(state, target, def.radius)) {
          affected.push(u.id);
          const dmg = fireballDamageAt(hexDistance(u.pos, target));
          evs.push(...applyDamage(state, u, dmg, 'spell', killer, undefined, credit));
        }
        return evs;
      }));
      break;
    }
    case 'haste': {
      const u = unitOn(state, target)!;
      // (canCast refuses fresh recruits and summons, which cannot march on their first turn, and
      // units whose attack ended their movement.)
      u.mp += HASTE_MP;
      u.buffs = u.buffs.filter((x) => x.id !== 'haste');
      u.buffs.push({ id: 'haste', turns: 1 });
      affected.push(u.id);
      break;
    }
    case 'farsight': {
      fs.farsight.push({ hex: { ...target }, turns: FARSIGHT_TURNS });
      computeVisibility(state, faction);
      break;
    }
    case 'summon': {
      const u = createUnit(state, { faction, pos: { ...target }, monster: 'elemental' });
      u.summonTurns = SUMMON_TURNS;
      u.mp = 0;
      u.acted = true;
      u.moved = false;
      u.justSpawned = true;
      affected.push(u.id);
      effects.push({ type: 'unitSpawned', unit: u.id, pos: { ...target }, reason: 'summon' });
      computeVisibility(state, faction);
      break;
    }
    case 'storm': {
      // Each bolt picks a random enemy still standing in the area.
      effects.push(...withDeferredVictory(state, () => {
        const evs: GameEvent[] = [];
        for (let i = 0; i < STORM_BOLTS; i++) {
          const pool = unitsWithin(state, target, def.radius).filter((u) => u.faction !== faction && isEnemy(faction, u.faction));
          if (!pool.length) break;
          const v = pool[Math.floor(rand(state) * pool.length)];
          if (!affected.includes(v.id)) affected.push(v.id);
          evs.push(...applyDamage(state, v, STORM_DAMAGE, 'spell', killer, undefined, credit));
        }
        return evs;
      }));
      break;
    }
  }
  cast.affected = affected;
  events.push(...effects);

  if (caster && state.units[String(caster.id)]) events.push(...giveXp(state, caster, 'magic', CAST_XP));
  const fname = FACTIONS[faction].name;
  const affectedFactions = affected.map((id) => state.units[String(id)]?.faction).filter(Boolean) as FactionId[];
  events.push(...logFor(state, [faction, ...affectedFactions],
    `${fname} casts ${def.name}${affected.length ? ` (${affected.length} affected)` : ''}.`, 'magic', faction));
  return events;
}

/** Max mana = 100 + 50 × completed mage towers. */
export function manaCap(state: GameState, faction: FactionId): number {
  return 100 + 50 * ownTowers(state, faction).length;
}

/** Spell target hexes in range of any own tower (for UI highlighting). */
export function spellTargetsFrom(state: GameState, faction: FactionId, spell: SpellId, tower: BuildingInstanceId): Hex[] {
  const b = state.buildings[String(tower)];
  if (!b) return [];
  const range = towerRange(state, tower, spell);
  const out: Hex[] = [];
  for (let dq = -range; dq <= range; dq++) {
    for (let dr = Math.max(-range, -dq - range); dr <= Math.min(range, -dq + range); dr++) {
      const h = { q: b.pos.q + dq, r: b.pos.r + dr };
      if (canCast(state, faction, spell, tower, h) === null) out.push(h);
    }
  }
  return out;
}

