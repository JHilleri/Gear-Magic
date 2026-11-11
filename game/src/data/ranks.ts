// Augment ranks (DESIGN §4.8): every passive and active skill can be learned again, each learning one
// more rank and a stronger effect. Building unlocks (Masonry, Devotion) are knowledge, not power: they
// stay single. This module holds the per-rank numbers and the text that states them, so the rules,
// the previews and the UI read one source. Pure; no game state.
import type { ActiveId, PassiveId, Unit } from '../core/types';

export type AugmentId = PassiveId | ActiveId;

/** Augments that unlock something and have nothing to grow: learned once. */
export const SINGLE_RANK: readonly AugmentId[] = ['masonry', 'devotion'];

/** Can `id` be learned again for a higher rank? */
export function isUpgradable(id: AugmentId): boolean {
  return !SINGLE_RANK.includes(id);
}

/**
 * Rank of augment `id` on `u`: 0 when it does not have it, else 1 + its further learnings
 * (`unit.ranks`, which only stores ranks of 2 and more).
 */
export function augmentRank(u: Pick<Unit, 'passives' | 'actives' | 'ranks'>, id: AugmentId): number {
  const owned = (u.passives as readonly string[]).includes(id) || (u.actives as readonly string[]).includes(id);
  if (!owned) return 0;
  return Math.max(1, Math.floor(u.ranks?.[id] ?? 1));
}

// ───────────────────────────── per-rank effects ─────────────────────────────
// Rank 1 is the effect the augment always had; each further rank adds the step.

/** Regeneration: HP healed at the start of each turn (2 a rank: an Amulet of Vigor's 3 still counts). */
export const regenHeal = (r: number): number => 2 * r;
/** Venom Blades: poison damage per turn on the victim. */
export const venomDamage = (r: number): number => 5 + 3 * (r - 1);
/** Iron Skin: block (1 a rank: a shield's 2 still counts). */
export const ironskinBlock = (r: number): number => r;
/** Leadership: damage multiplier of adjacent allies. */
export const leadershipMult = (r: number): number => 1 + 0.15 * r;
/** Harvester, Prospector, Mana Spring, Scholar: resource per turn. */
export const yieldPerTurn = (r: number): number => r;
/** Marksman: minimum ranged hit chance. */
export const marksmanMin = (r: number): number => Math.min(0.9, 0.6 + 0.05 * (r - 1));
/** Berserker: melee damage multiplier below half health. */
export const berserkMult = (r: number): number => 1 + 0.25 * r;
/** Life Drinker: share of melee damage dealt healed. */
export const drainShare = (r: number): number => Math.min(1, 0.3 + 0.1 * (r - 1));
/** Inspiring: XP adjacent allies gain each turn (3 a rank: a level-1 neighbour levels in 10 turns). */
export const inspireXp = (r: number): number => 3 * r;
/** Combat Reflexes: retaliations per turn on top of the first. */
export const extraReactions = (r: number): number => r;
/** Skirmisher, Pathfinder: movement added by ranks beyond the first. */
export const extraMov = (r: number): number => Math.max(0, r - 1);
/** Power Strike: damage multiplier of the next melee attack (+15% a rank). */
export const powerStrikeMult = (r: number): number => 1 + 0.15 * r;
/** Volley: share of ranged damage per arrow (before block and armor). */
export const volleyShare = (r: number): number => Math.min(1, 0.6 + 0.1 * (r - 1));
/** Mend: HP healed. */
export const mendHp = (r: number): number => 15 + 5 * (r - 1);
/** Firebolt: damage. */
export const fireboltDamage = (r: number): number => 18 + 6 * (r - 1);
/** Rally: movement given to each ally. */
export const rallyMp = (r: number): number => 2 + (r - 1);
/** Fortify: armor % until the next turn (7.5 a rank; no block: that is Iron Skin's and the shield's). */
export const fortifyArmor = (r: number): number => 7.5 * r;
/** Blink: teleport range. */
export const blinkRange = (r: number): number => 3 + (r - 1);

const pct = (x: number): number => Math.round(x * 100);
const plusMov = (r: number): string => (extraMov(r) > 0 ? ` and +${extraMov(r)} movement` : '');
const times = (n: number): string => (n === 1 ? 'once' : n === 2 ? 'twice' : `${n} times`);

/** What augment `id` does at rank `r` (rank 1 is its plain description). */
export function augmentText(id: AugmentId, r: number): string {
  const n = Math.max(1, Math.floor(r));
  switch (id) {
    case 'regeneration': return `Heals ${regenHeal(n)} HP at the start of each turn.`;
    case 'poison': return `Melee hits poison the target: ${venomDamage(n)} damage per turn until cured at a castle or shrine.`;
    case 'skirmisher': return `Ignores enemy zones of control${plusMov(n)}.`;
    case 'pathfinder': return `Forest and hills cost only 1 movement${plusMov(n)}.`;
    case 'ironskin': return `+${ironskinBlock(n)} block: every strike that hits deals ${ironskinBlock(n)} less damage.`;
    case 'leadership': return `Adjacent allies deal ${pct(leadershipMult(n) - 1)}% more damage.`;
    case 'harvester': return `+${yieldPerTurn(n)} food every turn.`;
    case 'prospector': return `+${yieldPerTurn(n)} iron every turn.`;
    case 'manaspring': return `+${yieldPerTurn(n)} mana every turn.`;
    case 'scholar': return `+${yieldPerTurn(n)} research every turn.`;
    case 'marksman': return `Ranged attacks have at least ${pct(marksmanMin(n))}% chance to hit.`;
    case 'berserker': return `+${pct(berserkMult(n) - 1)}% melee damage while below half health.`;
    case 'vampiric': return `Heals ${pct(drainShare(n))}% of melee damage dealt.`;
    case 'inspiring': return `Adjacent allies gain ${inspireXp(n)} XP each turn, in the kind of XP they earn most.`;
    case 'reflexes': return `Retaliates ${times(1 + extraReactions(n))} per turn instead of once.`;
    case 'powerstrike': return `Your next melee attack this turn deals ${pct(powerStrikeMult(n) - 1)}% more damage. Free: does not use the action.`;
    case 'volley': return `Rain arrows on every enemy within 1 hex of a target hex in bow range, at ${pct(volleyShare(n))}% damage, no retaliation.`;
    case 'heal': return `Heal an adjacent ally (or yourself) for ${mendHp(n)} HP and cure poison.`;
    case 'firebolt': return `Hurl a bolt of fire: ${fireboltDamage(n)} damage to an enemy within 3 hexes, ignoring block and armor, no retaliation.`;
    case 'rally': return `Allies within 2 hexes gain +${rallyMp(n)} movement this turn (not units that have already attacked). Free: does not use the action.`;
    case 'fortify': return `+${fortifyArmor(n)}% armor until your next turn. Uses the action: no attack after it (movement stays).`;
    case 'blink': return `Teleport to an empty hex within ${blinkRange(n)}.`;
    case 'masonry': return 'Permanently learned: this unit can build Watchtowers.';
    case 'devotion': return 'Permanently learned: this unit can build Shrines.';
  }
}

/** Roman numeral of a rank for names ("Firebolt III"); digits past 3999. */
export function rankNumeral(n: number): string {
  if (!Number.isInteger(n) || n < 1 || n > 3999) return String(n);
  const parts: [number, string][] = [[1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'], [100, 'C'], [90, 'XC'], [50, 'L'], [40, 'XL'], [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']];
  let out = '';
  let v = n;
  for (const [k, s] of parts) while (v >= k) { out += s; v -= k; }
  return out;
}

/** "Firebolt" at rank 1, "Firebolt III" at rank 3. */
export function rankedName(name: string, rank: number): string {
  return rank > 1 ? `${name} ${rankNumeral(rank)}` : name;
}
