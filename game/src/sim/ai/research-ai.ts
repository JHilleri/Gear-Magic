// Research choice: the faction's priority list, adapted to the situation. Switching projects
// is free (progress carries over), so the AI re-evaluates every turn but only changes course
// when the best pick actually changes.
import type { Action, TechId } from '../../core/types';
import { TECHS } from '../../data/research';
import { availableTechs, hasTech } from '../research';
import { isMounted } from '../units';
import type { Ctx } from './types';
import { attempt } from './util';

/** Ordered list of techs this house wants next (may contain unavailable / known ones). */
export function researchOrder(ctx: Ctx): TechId[] {
  const { s, f } = ctx;
  const has = (t: TechId) => hasTech(s, f, t);
  const order: TechId[] = [];
  const push = (...ts: TechId[]) => { for (const t of ts) if (!order.includes(t)) order.push(t); };

  // Research is the engine of everything else: libraries first (Writing quadruples research),
  // then iron for weapons and tools. (Mining first was tried: it delays Writing by ~35 rounds.)
  const libraries = ctx.own.filter((b) => b.type === 'library').length;
  if (!has('writing') && libraries === 0) push('writing');

  // Adaptation: enemy cavalry → spears (first strike, +50% vs mounted).
  const riders = ctx.foes.filter((u) => isMounted(u)).length;
  if (riders >= 1) push('polearms');

  push('mining');

  // Threatened at home and able to build walls soon.
  if (ctx.t.strategy && ctx.t.strategy.castleThreat >= 3 && has('mining')) push('masonry');

  // Magic is a pillar of every house: once a library stands and iron is on its way, the road to
  // the first mage tower comes next, so the tower and its first spell arrive in mid game. Cheap
  // foundations (≤ 30 points) the house's own list ranks before Crystal Lore come first
  // (Thorn's Tanning: leather for its spearmen and archers).
  if (libraries > 0 && has('mining')) {
    const road = ctx.def.researchPriority.indexOf('crystallore');
    for (const t of ctx.def.researchPriority.slice(0, Math.max(0, road))) if (TECHS[t].cost <= 30) push(t);
    push('crystallore', 'arcana');
  }

  // With Arcana the tower is on its way: Healing Light (the cheapest spell worth its mana) is
  // learned while it rises, then the house's signature spell (the first other than Healing
  // Light and Farsight on its own list). The rest of the spellbook follows that list (Valen:
  // support, Thorn: fire and storm, Ashen: fire and summoning).
  if (has('arcana')) {
    push('spell_heal');
    const own = ctx.def.researchPriority.find((t) => TECHS[t].unlocksSpell && t !== 'spell_heal' && t !== 'spell_farsight');
    if (own) push(own);
  }

  for (const t of ctx.def.researchPriority) push(t);
  return order;
}

/** Research action if the project should change (or none is set), else null. */
export function researchPhase(ctx: Ctx): Action | null {
  const { s, f, fs } = ctx;
  const avail = new Set(availableTechs(s, f));
  if (!avail.size) return null;
  let pick: TechId | null = null;
  for (const t of researchOrder(ctx)) {
    if (avail.has(t)) { pick = t; break; }
  }
  if (!pick) {
    // Nothing on the list is open: cheapest available tech.
    pick = [...avail].sort((a, b) => TECHS[a].cost - TECHS[b].cost || a.localeCompare(b))[0];
  }
  if (fs.researching === pick) return null;
  return attempt(ctx, { type: 'research', faction: f, tech: pick });
}
