// Active unit skills. See DESIGN §4.8 and data/skills.ts ACTIVES.
import type { ActiveId, Buff, EffectEntry, EffectPreview, GameEvent, GameState, Hex, Unit } from '../core/types';
import { hexDistance, inBounds, spiral } from '../core/hex';
import { rand } from '../core/rng';
import { ACTIVES } from '../data/skills';
import { isEnemy } from './state';
import { effectiveStats, getAttackDefs } from './units';
import { moveCost } from './pathfinding';
import { isExplored, isVisible } from './visibility';
import { applyDamage, attackProfile, withDeferredVictory } from './combat';
import { giveXp, logFor, roundHalfUp, unitOn } from './ruleutil';
import { binomial, hitsOutcome } from './spells';
import { orderInterrupted } from './orders';

const VOLLEY_DAMAGE = 0.6;
const MEND_HP = 12;
const FIREBOLT_DAMAGE = 14;
const RALLY_MP = 2;
const RALLY_RADIUS = 2;
const FORTIFY_ARMOR = 20;
const POWERSTRIKE_MULT = 1.5;

/** Damage of one Volley arrow given the unit's ranged damage against that target. */
export function volleyStrikeDamage(rangedDamage: number): number {
  return Math.max(1, roundHalfUp(rangedDamage * VOLLEY_DAMAGE));
}

/** A unit the skill user's faction can currently see (fog of war). */
function seen(state: GameState, viewer: Unit, other: Unit): boolean {
  if (other.faction === viewer.faction) return true;
  if (viewer.faction === 'neutral') return true;
  return isVisible(state, viewer.faction, other.pos);
}

function visibleEnemyAt(state: GameState, unit: Unit, h: Hex): Unit | undefined {
  const o = unitOn(state, h);
  return o && o.faction !== unit.faction && isEnemy(unit.faction, o.faction) && seen(state, unit, o) ? o : undefined;
}

function enemiesAround(state: GameState, unit: Unit, center: Hex, radius: number, visibleOnly: boolean): Unit[] {
  const out: Unit[] = [];
  for (const k in state.units) {
    const o = state.units[k];
    if (o.faction === unit.faction || !isEnemy(unit.faction, o.faction)) continue;
    if (hexDistance(o.pos, center) > radius) continue;
    if (visibleOnly && !seen(state, unit, o)) continue;
    out.push(o);
  }
  return out.sort((a, b) => a.id - b.id);
}

function alliesAround(state: GameState, unit: Unit, radius: number): Unit[] {
  const out: Unit[] = [];
  for (const k in state.units) {
    const o = state.units[k];
    if (o.id === unit.id || o.faction !== unit.faction) continue;
    if (hexDistance(o.pos, unit.pos) <= radius) out.push(o);
  }
  return out.sort((a, b) => a.id - b.id);
}

/** Rally passes by fresh recruits and summons, and units whose attack already ended their movement. */
const canMarch = (a: Unit): boolean => !a.justSpawned && !a.moveEnded;

function rangedAttack(unit: Unit) {
  return getAttackDefs(unit).find((a) => a.kind === 'ranged') ?? null;
}

/** Target-only validity (no ownership / cooldown / acted checks). */
function targetError(state: GameState, unit: Unit, skill: ActiveId, target?: Hex): string | null {
  const def = ACTIVES[skill];
  switch (skill) {
    case 'powerstrike':
    case 'fortify':
      return null;
    case 'rally':
      return alliesAround(state, unit, RALLY_RADIUS).some(canMarch) ? null : 'No allies within 2 hexes who can march';
    case 'volley': {
      const ra = rangedAttack(unit);
      if (!ra) return 'Requires a bow';
      if (!target) return 'Choose a target hex';
      if (!inBounds(target, state.width, state.height)) return 'Out of the map';
      const d = hexDistance(unit.pos, target);
      if (d < 1 || d > ra.range) return 'Target out of bow range';
      return enemiesAround(state, unit, target, 1, true).length ? null : 'No enemies near that hex';
    }
    case 'heal': {
      if (!target) return 'Choose an ally';
      if (hexDistance(unit.pos, target) > def.range) return 'Target must be adjacent';
      const o = unitOn(state, target);
      if (!o || o.faction !== unit.faction) return 'Choose an allied unit';
      const max = effectiveStats(state, o).maxHp;
      if (o.hp >= max && !o.poisoned) return 'That unit is not hurt';
      return null;
    }
    case 'firebolt': {
      if (!target) return 'Choose an enemy';
      const d = hexDistance(unit.pos, target);
      if (d < 1 || d > def.range) return 'Target out of range';
      return visibleEnemyAt(state, unit, target) ? null : 'Choose a visible enemy';
    }
    case 'blink': {
      if (!target) return 'Choose a destination';
      if (!inBounds(target, state.width, state.height)) return 'Out of the map';
      const d = hexDistance(unit.pos, target);
      if (d < 1 || d > def.range) return 'Destination out of range';
      if (unit.faction !== 'neutral' && !isExplored(state, unit.faction, target)) return 'Cannot blink into unexplored land';
      if (!Number.isFinite(moveCost(state, unit, target))) return 'Cannot stand there';
      if (unitOn(state, target)) return 'The destination is occupied';
      return null;
    }
    case 'masonry':
    case 'devotion':
      return 'This skill is permanent knowledge, not an action';
  }
  return 'Unknown skill';
}

/** Null if usable now (owned, off cooldown, not acted unless cd 0 permanent, valid target), else reason. */
export function canUseSkill(state: GameState, unit: Unit, skill: ActiveId, target?: Hex): string | null {
  return skillBlocker(state, unit, skill) ?? targetError(state, unit, skill, target);
}

/**
 * Why the unit cannot use the skill at all this turn (unknown, recharging, already acted…), before
 * any target is looked at; null when only a target is missing. The HUD says "no valid target in
 * range" for the rest, rather than canUseSkill's per-target wording ("Choose an ally").
 */
export function skillBlocker(state: GameState, unit: Unit, skill: ActiveId): string | null {
  const def = ACTIVES[skill];
  if (!def) return 'Unknown skill';
  if (!state.units[String(unit.id)]) return 'Unit is gone';
  if (!unit.actives.includes(skill)) return `${unit.name} does not know ${def.name}`;
  if (def.cooldown === 0) return 'This skill is permanent knowledge, not an action';
  const cd = unit.cooldowns[skill] ?? 0;
  if (cd > 0) return `${def.name} is recharging (${cd} turn${cd === 1 ? '' : 's'})`;
  if (unit.acted) return 'This unit has already acted this turn';
  if (skill === 'powerstrike' && unit.buffs.some((b) => b.id === 'powerstrike')) return 'Power Strike is already prepared';
  return null;
}

/** Shown when a targeted skill has nothing it could be used on from where the unit stands. */
export const NO_SKILL_TARGET = 'No valid target in range';

/** Valid target hexes for the skill (for UI highlighting); [] for target 'none'. */
export function skillTargets(state: GameState, unit: Unit, skill: ActiveId): Hex[] {
  const def = ACTIVES[skill];
  if (!def || def.target === 'none' || def.range <= 0) return [];
  const out: Hex[] = [];
  for (const h of spiral(unit.pos, def.range)) {
    if (!inBounds(h, state.width, state.height)) continue;
    if (skill === 'blink') {
      // Hidden units are not revealed by the highlight; the skill itself checks for real.
      const o = unitOn(state, h);
      if (o && seen(state, unit, o)) continue;
      if (hexDistance(unit.pos, h) < 1) continue;
      if (unit.faction !== 'neutral' && !isExplored(state, unit.faction, h)) continue;
      if (!Number.isFinite(moveCost(state, unit, h))) continue;
      out.push(h);
      continue;
    }
    if (targetError(state, unit, skill, h) === null) out.push(h);
  }
  return out;
}

function addBuff(unit: Unit, buff: Buff): void {
  unit.buffs = unit.buffs.filter((b) => b.id !== buff.id);
  unit.buffs.push(buff);
}

/**
 * Apply the skill: sets cooldown, emits skillUsed + effects. Every active costs the unit's action
 * (acted) except Power Strike (it only charges the next melee attack this turn) and Rally (a
 * shout before the host moves). Fortify takes the action but leaves movement: dig in, then step.
 */
export function useSkill(state: GameState, unit: Unit, skill: ActiveId, target?: Hex): GameEvent[] {
  const def = ACTIVES[skill];
  const events: GameEvent[] = [];
  unit.cooldowns[skill] = def.cooldown;
  const skillEv: Extract<GameEvent, { type: 'skillUsed' }> = { type: 'skillUsed', unit: unit.id, skill };
  if (target) skillEv.target = { ...target };
  events.push(skillEv);

  switch (skill) {
    case 'powerstrike':
      // Lasts until spent by a melee attack or the start of the unit's next turn.
      addBuff(unit, { id: 'powerstrike', turns: 1, damageMult: POWERSTRIKE_MULT });
      events.push(...logFor(state, [unit.faction], `${unit.name} readies a Power Strike.`, 'combat', unit.faction));
      break;

    case 'fortify':
      addBuff(unit, { id: 'fortify', turns: 1, armor: FORTIFY_ARMOR });
      unit.acted = true;
      events.push(...logFor(state, [unit.faction], `${unit.name} fortifies (+${FORTIFY_ARMOR} armor).`, 'combat', unit.faction));
      break;

    case 'rally': {
      // Fresh recruits and summons cannot march on their first turn, and a unit that has
      // attacked has ended its movement (no hit-and-run): Rally passes them by.
      const allies = alliesAround(state, unit, RALLY_RADIUS).filter(canMarch);
      for (const a of allies) {
        a.mp += RALLY_MP;
        addBuff(a, { id: 'haste', turns: 1 });
      }
      skillEv.targets = allies.map((a) => a.id);
      events.push(...logFor(state, [unit.faction], `${unit.name} rallies ${allies.length} ${allies.length === 1 ? 'ally' : 'allies'} (+${RALLY_MP} movement).`, 'combat', unit.faction));
      break;
    }

    case 'volley': {
      const ra = rangedAttack(unit)!;
      const victims = enemiesAround(state, unit, target!, 1, false);
      skillEv.targets = victims.map((v) => v.id);
      let hits = 0;
      // Several leaders may fall to one volley: victory is decided once every arrow has landed.
      events.push(...withDeferredVictory(state, () => {
        const evs: GameEvent[] = [];
        for (const v of victims) {
          if (!state.units[String(v.id)]) continue;
          const prof = attackProfile(state, unit, v, 'ranged');
          if (!prof) continue;
          const dmg = volleyStrikeDamage(prof.damage);
          let total = 0;
          for (let i = 0; i < ra.strikes; i++) if (rand(state) < prof.hitChance) { total += dmg; hits++; }
          if (total > 0) evs.push(...applyDamage(state, v, total, 'skill', unit, undefined, { cat: 'ranged' }));
          else {
            // Every arrow missed: still shot at, so no rest and no standing order.
            v.restedLastTurn = false;
            evs.push(...orderInterrupted(state, v));
          }
        }
        return evs;
      }));
      unit.mp = 0;
      unit.moveEnded = true;
      unit.acted = true;
      events.push(...logFor(state, [unit.faction, ...victims.map((v) => v.faction)], `${unit.name} looses a volley at ${victims.length} ${victims.length === 1 ? 'enemy' : 'enemies'}.`, 'combat', unit.faction));
      if (state.units[String(unit.id)]) events.push(...giveXp(state, unit, 'ranged', 1 + hits));
      break;
    }

    case 'heal': {
      const o = unitOn(state, target!)!;
      const max = effectiveStats(state, o).maxHp;
      const amount = Math.max(0, Math.min(MEND_HP, max - o.hp));
      o.hp += amount;
      o.poisoned = false;
      skillEv.targets = [o.id];
      if (amount > 0) events.push({ type: 'unitHealed', unit: o.id, amount });
      unit.acted = true;
      events.push(...logFor(state, [unit.faction], `${unit.name} mends ${o.id === unit.id ? 'their wounds' : o.name} (+${amount} HP).`, 'magic', unit.faction));
      events.push(...giveXp(state, unit, 'magic', 2));
      break;
    }

    case 'firebolt': {
      const o = unitOn(state, target!)!;
      skillEv.targets = [o.id];
      unit.mp = 0;
      unit.moveEnded = true;
      unit.acted = true;
      events.push(...logFor(state, [unit.faction, o.faction], `${unit.name} hurls a firebolt at ${o.name}.`, 'magic', unit.faction));
      events.push(...giveXp(state, unit, 'magic', 2));
      events.push(...applyDamage(state, o, FIREBOLT_DAMAGE, 'skill', unit, undefined, { cat: 'magic' }));
      break;
    }

    case 'blink': {
      unit.pos = { ...target! };
      unit.mp = 0;
      unit.moveEnded = true;
      unit.acted = true;
      unit.moved = true;
      events.push(...logFor(state, [unit.faction], `${unit.name} blinks away.`, 'magic', unit.faction));
      break;
    }

    default:
      break;
  }
  return events;
}

/**
 * What `unit` using `skill` on `target` would do, without changing anything (UI preview). Lists
 * only units the user's faction can see; the numbers come from the same constants useSkill uses.
 */
export function previewSkill(state: GameState, unit: Unit, skill: ActiveId, target: Hex): EffectPreview {
  const entries: EffectEntry[] = [];
  const notes: string[] = [];
  const entry = (u: Unit, hpDelta: number, killChance: number, extra: Partial<EffectEntry> = {}): EffectEntry => ({
    unit: u.id, own: u.faction === unit.faction, hpBefore: u.hp, maxHp: effectiveStats(state, u).maxHp, hpDelta, killChance, ...extra,
  });
  switch (skill) {
    case 'firebolt': {
      const o = visibleEnemyAt(state, unit, target);
      if (o) entries.push(entry(o, -Math.min(FIREBOLT_DAMAGE, Math.max(0, o.hp)), o.hp <= FIREBOLT_DAMAGE ? 1 : 0));
      notes.push('Ignores armor · no retaliation');
      return { tone: 'harm', entries, notes };
    }
    case 'volley': {
      const ra = rangedAttack(unit);
      if (ra) {
        for (const v of enemiesAround(state, unit, target, 1, true)) {
          const prof = attackProfile(state, unit, v, 'ranged');
          if (!prof) continue;
          const o = hitsOutcome(Math.max(0, v.hp), volleyStrikeDamage(prof.damage), binomial(ra.strikes, prof.hitChance));
          entries.push(entry(v, o.hpDelta, o.killChance, { hpDist: o.hpDist }));
        }
        notes.push(`${ra.strikes} arrows at ${Math.round(VOLLEY_DAMAGE * 100)}% damage per enemy · armor applies · no retaliation`);
      }
      return { tone: 'harm', entries, notes };
    }
    case 'heal': {
      const o = unitOn(state, target);
      if (o && o.faction === unit.faction) entries.push(entry(o, Math.max(0, Math.min(MEND_HP, effectiveStats(state, o).maxHp - o.hp)), 0));
      notes.push('Cures poison');
      return { tone: 'help', entries, notes };
    }
    case 'blink':
      notes.push(`${unit.name} teleports here; its movement ends`);
      return { tone: 'neutral', entries, notes };
    default:
      return { tone: 'neutral', entries, notes };
  }
}

/** True when `skill` is a permanent knowledge skill (no action). */
export function isPermanentSkill(skill: ActiveId): boolean {
  return ACTIVES[skill]?.cooldown === 0;
}
