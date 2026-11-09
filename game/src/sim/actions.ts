// The single entry point for state mutation. UI, controller and AI all go through applyAction.
import type {
  Action, ActionResult, ActiveId, AttackKind, BuildingId, BuildingInstanceId, FactionId, GameEvent, GameState, Hex, ItemId,
  PresetId, Unit, UnitId,
} from '../core/types';
import { hexEq, inBounds } from '../core/hex';
import { BUILDINGS, BUILDING_LIST } from '../data/buildings';
import { ITEM_LIST } from '../data/items';
import { PRESETS } from '../data/presets';
import { ACTIVES, LEVEL_OPTION_BY_ID } from '../data/skills';
import { currentFaction, isEnemy } from './state';
import { canEquip, canUnequip, equip, unequip } from './units';
import { findPath, inEnemyZoc, moveCost } from './pathfinding';
import { canResearch, setResearch } from './research';
import { applyLevelOption } from './progression';
import { computeVisibility, isVisible } from './visibility';
import { availableAttackKinds, canAttack, resolveCombat } from './combat';
import {
  canBuildAt, canCraft, canRecruit, canUpgrade, craft, recruit, startBuilding, startUpgrade,
} from './economy';
import { canCast, castSpell } from './spells';
import { canUseSkill, useSkill } from './skills';
import { endTurn } from './turn';
import { exploreRuins } from './neutral';
import { giveXp, isHumanFaction, logEvent, unitOn } from './ruleutil';
import { canGiveOrder, setOrder } from './orders';

const fail = (error: string): ActionResult => ({ ok: false, error, events: [] });

function ownUnit(state: GameState, id: UnitId, f: FactionId): Unit | string {
  const u = state.units[String(id)];
  if (!u) return 'No such unit';
  if (u.faction !== f) return 'Not your unit';
  return u;
}

/** A unit of another faction the viewer can currently see. */
function seenBy(state: GameState, viewer: FactionId, u: Unit): boolean {
  return u.faction === viewer || isVisible(state, viewer, u.pos);
}

/** Null if the action is legal for the faction whose turn it is, else a reason. */
export function validateAction(state: GameState, action: Action): string | null {
  if (state.gameOver) return 'The game is over';
  const f = currentFaction(state);
  const fs = state.factions[f];
  if (!action || typeof action !== 'object') return 'Invalid action';
  if (action.type === 'endTurn') return action.faction === f ? null : 'It is not your turn';
  if (!fs || !fs.alive) return 'Your faction has been eliminated';

  switch (action.type) {
    case 'move': {
      const u = ownUnit(state, action.unit, f);
      if (typeof u === 'string') return u;
      if (!action.to || !inBounds(action.to, state.width, state.height)) return 'Destination is off the map';
      if (hexEq(u.pos, action.to)) return 'Already there';
      if (u.justSpawned) return 'Fresh recruits cannot move on their first turn';
      if (u.moveEnded) return "Attacking ended this unit's movement this turn";
      if (u.mp <= 0) return 'No movement left this turn';
      // Pathfinding only knows enemies the faction can see (no fog leaks).
      const path = findPath(state, u, action.to);
      if (!path || !path.length) return 'Cannot reach that hex this turn';
      return null;
    }
    case 'attack': {
      const u = ownUnit(state, action.unit, f);
      if (typeof u === 'string') return u;
      const t = state.units[String(action.target)];
      if (!t) return 'No such target';
      if (t.faction === f || !isEnemy(f, t.faction)) return 'Not an enemy';
      if (!seenBy(state, f, t)) return 'Target not visible';
      return canAttack(state, u, t, action.kind);
    }
    case 'build': {
      const u = ownUnit(state, action.unit, f);
      if (typeof u === 'string') return u;
      if (!BUILDINGS[action.building]) return 'Unknown building';
      return canBuildAt(state, u, action.building);
    }
    case 'upgrade': {
      const u = ownUnit(state, action.unit, f);
      if (typeof u === 'string') return u;
      return canUpgrade(state, u);
    }
    case 'recruit': {
      const b = state.buildings[String(action.site)];
      if (!b) return 'No such building';
      if (b.owner !== f) return 'Not your building';
      return canRecruit(state, action.site, action.preset);
    }
    case 'craft': {
      const b = state.buildings[String(action.forge)];
      if (!b) return 'No such building';
      if (b.owner !== f) return 'Not your forge';
      return canCraft(state, action.forge, action.item);
    }
    case 'equip': {
      const u = ownUnit(state, action.unit, f);
      if (typeof u === 'string') return u;
      if (u.monster) return 'This creature cannot use equipment';
      return canEquip(state, u, action.item);
    }
    case 'unequip': {
      const u = ownUnit(state, action.unit, f);
      if (typeof u === 'string') return u;
      if (u.monster) return 'This creature cannot use equipment';
      return canUnequip(state, u, action.slot);
    }
    case 'research':
      if (action.faction !== f) return 'It is not your turn';
      return canResearch(state, f, action.tech);
    case 'cast':
      if (action.faction !== f) return 'It is not your turn';
      return canCast(state, f, action.spell, action.tower, action.target);
    case 'skill': {
      const u = ownUnit(state, action.unit, f);
      if (typeof u === 'string') return u;
      if (!ACTIVES[action.skill]) return 'Unknown skill';
      return canUseSkill(state, u, action.skill, action.target);
    }
    case 'levelup': {
      const u = ownUnit(state, action.unit, f);
      if (typeof u === 'string') return u;
      if (u.pendingLevelUps <= 0) return 'No level-up pending';
      if (!LEVEL_OPTION_BY_ID[action.option]) return 'Unknown option';
      const opts = u.levelUpOptions[0];
      if (!opts || !opts.includes(action.option)) return 'That option is not on offer';
      return null;
    }
    case 'order': {
      const u = ownUnit(state, action.unit, f);
      if (typeof u === 'string') return u;
      return canGiveOrder(state, u, action.order);
    }
  }
  return 'Unknown action';
}

/**
 * Validate then apply. move: walks the path step by step (stops early if a hidden enemy
 * blocks / ZOC), updates visibility, explore XP (+1 per 3 newly explored tiles), ruins.
 * All other actions delegate to the sim modules. Never throws on illegal input: returns
 * { ok:false, error, events: [] }.
 */
export function applyAction(state: GameState, action: Action): ActionResult {
  const err = validateAction(state, action);
  if (err) return fail(err);
  const f = currentFaction(state);
  let events: GameEvent[] = [];
  // A standing order lasts only while the unit is left alone: any command to act ends it (silently).
  if (action.type === 'move' || action.type === 'attack' || action.type === 'skill' || action.type === 'build' || action.type === 'upgrade') {
    const u = state.units[String(action.unit)];
    if (u) delete u.order;
  }
  switch (action.type) {
    case 'move':
      events = applyMove(state, state.units[String(action.unit)], action.to);
      break;
    case 'attack': {
      const u = state.units[String(action.unit)];
      const t = state.units[String(action.target)];
      events = resolveCombat(state, u, t, action.kind);
      if (state.factions[f]?.alive) computeVisibility(state, f);
      break;
    }
    case 'build':
      events = startBuilding(state, state.units[String(action.unit)], action.building);
      break;
    case 'upgrade':
      events = startUpgrade(state, state.units[String(action.unit)]);
      break;
    case 'recruit':
      events = recruit(state, action.site, action.preset);
      break;
    case 'craft':
      events = craft(state, action.forge, action.item);
      break;
    case 'equip':
      events = equip(state, state.units[String(action.unit)], action.item);
      break;
    case 'unequip':
      events = unequip(state, state.units[String(action.unit)], action.slot);
      break;
    case 'research':
      events = setResearch(state, f, action.tech);
      break;
    case 'cast':
      events = castSpell(state, f, action.spell, action.tower, action.target);
      if (state.factions[f]?.alive) computeVisibility(state, f);
      break;
    case 'skill': {
      const u = state.units[String(action.unit)];
      events = useSkill(state, u, action.skill, action.target);
      if (action.skill === 'blink' && state.units[String(u.id)]) {
        // Arriving somewhere new: fog, exploration and ruins like a normal move.
        const fresh = computeVisibility(state, f);
        events.push(...giveXp(state, u, 'explore', Math.floor(fresh / 3)));
        events.push(...exploreRuins(state, u.id));
      } else if (state.factions[f]?.alive) {
        computeVisibility(state, f);
      }
      break;
    }
    case 'levelup':
      events = applyLevelOption(state, state.units[String(action.unit)], action.option);
      break;
    case 'order':
      events = setOrder(state.units[String(action.unit)], action.order);
      break;
    case 'endTurn':
      events = endTurn(state, action.faction);
      break;
  }
  refreshFog(state, events);
  return { ok: true, events };
}

/**
 * Units and buildings lost to someone else's action stop providing sight: refresh the fog
 * of every faction once such losses happened (cheap, keeps the viewer's map honest).
 */
function refreshFog(state: GameState, events: GameEvent[]): void {
  if (!events.some((e) => e.type === 'unitDied' || e.type === 'buildingCaptured' || e.type === 'buildingDestroyed')) return;
  for (const f of state.turnOrder) if (state.factions[f]?.alive) computeVisibility(state, f);
}

/** Walk the planned path, interrupted by ambushes (hidden enemies) and zones of control. */
function applyMove(state: GameState, unit: Unit, to: Hex): GameEvent[] {
  const f = unit.faction;
  const path = findPath(state, unit, to) ?? [];
  const start = { ...unit.pos };
  const walked: Hex[] = [];
  let mp = unit.mp;
  let lastFree = -1;          // index into `walked` of the last hex the unit may stop on
  let mpAtLastFree = mp;
  let interrupted = false;
  let ambushedBy: Unit | null = null;
  let explored = 0;
  for (const h of path) {
    const occ = unitOn(state, h);
    if (occ && occ.faction !== f) { interrupted = true; ambushedBy = occ; break; }
    const c = moveCost(state, unit, h);
    if (!Number.isFinite(c) || c > mp + 1e-9) break;
    mp -= c;
    walked.push(h);
    unit.pos = { ...h };
    explored += computeVisibility(state, f);
    if (!occ) { lastFree = walked.length - 1; mpAtLastFree = mp; }
    // Entering an enemy zone of control ends the move (also an unseen enemy's: ambush).
    if (inEnemyZoc(state, unit, h)) { interrupted = true; break; }
  }
  // Never end on a friend's hex: back up to the last free one.
  const finalPath = walked.slice(0, lastFree + 1);
  unit.pos = finalPath.length ? { ...finalPath[finalPath.length - 1] } : start;
  unit.mp = interrupted ? 0 : Math.max(0, lastFree >= 0 ? mpAtLastFree : unit.mp);
  if (finalPath.length) unit.moved = true;
  explored += computeVisibility(state, f);

  const events: GameEvent[] = [];
  if (finalPath.length) events.push({ type: 'unitMoved', unit: unit.id, path: finalPath.map((h) => ({ ...h })) });
  if (ambushedBy && isHumanFaction(state, f)) {
    events.push(logEvent(state, `Ambush! ${unit.name} runs into a hidden enemy and stops.`, 'warning', f));
  }
  events.push(...giveXp(state, unit, 'explore', Math.floor(explored / 3)));
  if (finalPath.length) events.push(...exploreRuins(state, unit.id));
  return events;
}

// ── UI helper queries (pure) ──
export interface BuildOption { building: BuildingId; error: string | null }
export function buildOptions(state: GameState, unit: Unit): BuildOption[] {
  return BUILDING_LIST.map((d) => ({ building: d.id, error: canBuildAt(state, unit, d.id) }));
}
export interface RecruitOption { preset: PresetId; error: string | null }
export function recruitOptions(state: GameState, site: BuildingInstanceId): RecruitOption[] {
  const b = state.buildings[String(site)];
  if (!b) return [];
  const list = BUILDINGS[b.type].recruits ?? [];
  return list.filter((p) => PRESETS[p]).map((p) => ({ preset: p, error: canRecruit(state, site, p) }));
}
export interface CraftOption { item: ItemId; error: string | null }
export function craftOptions(state: GameState, forge: BuildingInstanceId): CraftOption[] {
  const b = state.buildings[String(forge)];
  if (!b || b.type !== 'forge') return [];
  return ITEM_LIST.map((it) => ({ item: it.id, error: canCraft(state, forge, it.id) }));
}
export interface EquipOption { item: ItemId; count: number; error: string | null }
export function equipOptions(state: GameState, unit: Unit): EquipOption[] {
  const fs = state.factions[unit.faction];
  if (!fs) return [];
  const out: EquipOption[] = [];
  for (const it of ITEM_LIST) {
    const count = fs.stockpile[it.id] ?? 0;
    if (count <= 0) continue;
    out.push({ item: it.id, count, error: unit.monster ? 'This creature cannot use equipment' : canEquip(state, unit, it.id) });
  }
  return out;
}
export interface AttackTarget { unit: UnitId; kinds: AttackKind[] }
/** Enemies attackable from the unit's current hex. */
export function attackTargets(state: GameState, unit: Unit): AttackTarget[] {
  if (unit.acted) return [];
  const out: AttackTarget[] = [];
  const ids = Object.keys(state.units).map(Number).sort((a, b) => a - b);
  for (const id of ids) {
    const t = state.units[String(id)];
    if (t.faction === unit.faction || !isEnemy(unit.faction, t.faction)) continue;
    if (unit.faction !== 'neutral' && !seenBy(state, unit.faction, t)) continue;
    const kinds = availableAttackKinds(state, unit, t).filter((k) => canAttack(state, unit, t, k) === null);
    if (kinds.length) out.push({ unit: t.id, kinds });
  }
  return out;
}
/** Units of the current faction that can still move or act (for "next unit"). */
export function idleUnits(state: GameState): UnitId[] {
  if (state.gameOver) return [];
  const f = currentFaction(state);
  const out: UnitId[] = [];
  const ids = Object.keys(state.units).map(Number).sort((a, b) => a - b);
  for (const id of ids) {
    const u = state.units[String(id)];
    if (u.faction !== f) continue;
    if ((u.mp > 0 && !u.moveEnded) || (!u.acted && attackTargets(state, u).length > 0)) out.push(u.id);
  }
  return out;
}

/** Cheap pre-check for the UI: can this unit still do anything at all this turn? */
export function canStillAct(state: GameState, unit: Unit): boolean {
  return (unit.mp > 0 && !unit.moveEnded) || (!unit.acted && attackTargets(state, unit).length > 0);
}

export type { ActiveId };
