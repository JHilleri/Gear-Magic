// Research & unlock queries. See DESIGN §6.
import type { ActiveId, BuildingId, FactionId, GameEvent, GameState, ItemId, PresetId, TechId, Unit } from '../core/types';
import { TECHS, TECH_LIST } from '../data/research';
import { ITEMS } from '../data/items';
import { BUILDINGS } from '../data/buildings';
import { PRESETS } from '../data/presets';
import { addLog } from './state';

export function hasTech(state: GameState, faction: FactionId, tech: TechId): boolean {
  const fs = state.factions[faction];
  return !!fs && fs.techs.includes(tech);
}

/** Techs not yet researched whose prerequisites are met. */
export function availableTechs(state: GameState, faction: FactionId): TechId[] {
  const fs = state.factions[faction];
  if (!fs) return [];
  return TECH_LIST
    .filter((t) => !fs.techs.includes(t.id) && t.requires.every((req) => fs.techs.includes(req)))
    .map((t) => t.id);
}

export function canResearch(state: GameState, faction: FactionId, tech: TechId): string | null {
  const fs = state.factions[faction];
  if (!fs || faction === 'neutral') return 'This faction cannot research.';
  if (!fs.alive) return 'This faction has been eliminated.';
  const def = TECHS[tech];
  if (!def) return 'Unknown technology.';
  if (fs.techs.includes(tech)) return `${def.name} is already researched.`;
  const missing = def.requires.filter((req) => !fs.techs.includes(req));
  if (missing.length > 0) return `Requires ${missing.map((m) => TECHS[m].name).join(' and ')}.`;
  return null;
}

/** Switch the current project (progress carries over to the new project). */
export function setResearch(state: GameState, faction: FactionId, tech: TechId): GameEvent[] {
  if (canResearch(state, faction, tech) !== null) return [];
  const fs = state.factions[faction];
  if (fs.researching === tech) return [];
  fs.researching = tech;
  // AI research choices are private; only the human's choice goes to the shared log.
  if (!fs.isHuman) return [];
  const entry = addLog(state, `Began researching ${TECHS[tech].name}.`, 'research', faction);
  return [{ type: 'log', entry }];
}

/**
 * Add points; complete (possibly chaining leftover into nothing — project becomes null) and
 * emit researchCompleted. Points earned with no project are banked in researchProgress and
 * carry over into the next project.
 */
export function progressResearch(state: GameState, faction: FactionId, points: number): GameEvent[] {
  const fs = state.factions[faction];
  if (!fs || !fs.alive) return [];
  if (Number.isFinite(points) && points > 0) fs.researchProgress += points;
  // Avoid floating drift from fractional multipliers (e.g. 3 × 1.25 × 1.1).
  fs.researchProgress = Math.round(fs.researchProgress * 1000) / 1000;
  const tech = fs.researching;
  if (!tech) return [];
  if (fs.techs.includes(tech)) { fs.researching = null; return []; }
  const def = TECHS[tech];
  if (fs.researchProgress < def.cost) return [];
  fs.researchProgress = Math.round((fs.researchProgress - def.cost) * 1000) / 1000;
  fs.techs.push(tech);
  fs.researching = null;
  fs.stats.researched++;
  const events: GameEvent[] = [{ type: 'researchCompleted', faction, tech }];
  // Like the choice of project, a rival's discoveries stay private (no anonymous chronicle
  // line that reads as the player's own progress and leaks the AI's tech path).
  if (fs.isHuman) events.push({ type: 'log', entry: addLog(state, `${def.name} discovered.`, 'research', faction) });
  return events;
}

export function itemUnlocked(state: GameState, faction: FactionId, item: ItemId): boolean {
  const def = ITEMS[item];
  if (!def) return false;
  return def.unlock === null || hasTech(state, faction, def.unlock);
}

/** Tech-unlocked, or (for skill buildings) `unit` knows the skill. Without a unit: any living unit of the faction knows it. */
export function buildingUnlocked(state: GameState, faction: FactionId, building: BuildingId, unit?: Unit): boolean {
  const def = BUILDINGS[building];
  if (!def) return false;
  if (def.unlock !== null && !hasTech(state, faction, def.unlock)) return false;
  if (def.unlockSkill) {
    const skill: ActiveId = def.unlockSkill;
    if (unit) return unit.actives.includes(skill);
    return Object.values(state.units).some((u) => u.faction === faction && u.hp > 0 && u.actives.includes(skill));
  }
  return true;
}

export function presetUnlocked(state: GameState, faction: FactionId, preset: PresetId): boolean {
  const def = PRESETS[preset];
  if (!def) return false;
  return def.items.every((it) => itemUnlocked(state, faction, it));
}

/** Product of tech bonus multipliers for a resource (croprotation, guilds, scholarship). */
export function resourceMult(state: GameState, faction: FactionId, resource: string): number {
  const fs = state.factions[faction];
  if (!fs) return 1;
  let m = 1;
  for (const t of fs.techs) {
    const b = TECHS[t]?.bonus;
    if (b && b.resource === resource && b.mult) m *= b.mult;
  }
  return m;
}

/** Tactics: 1.1, else 1. */
export function techDamageMult(state: GameState, faction: FactionId): number {
  const fs = state.factions[faction];
  if (!fs) return 1;
  let m = 1;
  for (const t of fs.techs) {
    const b = TECHS[t]?.bonus;
    if (b && b.damageMult) m *= b.damageMult;
  }
  return m;
}

/** Research points still needed for the current project (0 when none). */
export function researchRemaining(state: GameState, faction: FactionId): number {
  const fs = state.factions[faction];
  if (!fs || !fs.researching) return 0;
  return Math.max(0, TECHS[fs.researching].cost - fs.researchProgress);
}

export type { ActiveId };
