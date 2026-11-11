// Pure helpers for the unit sheet (modals/UnitSheet.tsx): what each stat, attack, augment and kind
// of experience is made of, as plain data the component lays out and the tests can check. Every
// figure is read from the sim (statBreakdown, the data tables, the combat constants) so the sheet
// cannot drift from the rules.
import type {
  ActiveSkillDef, AttackDef, BuildingDef, EfficiencyId, FactionId, GameState, ItemDef, PassiveId, SkillOptionDef, StatBreakdown,
  StatContribution, Unit, UnitStats, XpCategory,
} from '../core/types';
import { BUILDING_LIST } from '../data/buildings';
import { FACTIONS } from '../data/factions';
import { ITEM_LIST, ITEMS } from '../data/items';
import { ACTIVES, LEVEL_OPTION_BY_ID, LEVEL_OPTIONS, PASSIVES, XP_CATEGORY_NAMES, xpToNext } from '../data/skills';
import { augmentRank, augmentText, berserkMult, drainShare, marksmanMin, rankedName, venomDamage } from '../data/ranks';
import { SPELLS } from '../data/spells';
import { CHARGE_MULT, COMBAT_XP, FLANK_MULT, MAGIC_HIT, reactionsLeft, reactionsPerTurn } from '../sim/combat';
import { BARE_WORKER_MULT, BUILD_XP, WORK_XP, WORKER_MULT } from '../sim/economy';
import { techDamageMult } from '../sim/research';
import { displayDamage, safe, signed, STAT_LABELS, STAT_NAMES, XP_CATS } from './util';

// ───────────────────────────── stats ─────────────────────────────

/** Display order of the attributes on the sheet. */
export const STAT_ORDER: readonly (keyof UnitStats)[] = ['maxHp', 'str', 'dex', 'int', 'block', 'armor', 'mov', 'vis'];

/** What each attribute does (the sheet's stat tooltips). */
export const STAT_HELP: Record<keyof UnitStats, string> = {
  maxHp: 'Hit points. The unit dies at 0.',
  str: 'Melee damage: +1 per strike for every 2 points.',
  dex: 'Ranged damage: +1 per strike for every 2 points.',
  int: 'Damage of magic attacks (staff, wand: +1 per 2 points) and spell range from a Mage Tower (+1 per 3 points). Spell and Firebolt damage is fixed.',
  armor: 'After block, takes this percentage off the damage of every strike that hits (at most 70). Spells, Firebolt, poison and starvation ignore it.',
  block: 'Flat damage taken off every strike that hits, before armor. Magic attacks and flanking strikes pass it by; so do spells, Firebolt, poison and starvation.',
  mov: 'Movement points per turn.',
  vis: 'Vision radius in hexes (+1 on hills and mountains).',
};

/**
 * Colour family of one stat contribution: the sim's kinds, with 'other' split into level-up gains
 * ('level': the HP per level and stat picks from the level history) and the caps ('limit').
 */
export type ContributionTone = 'item' | 'mount' | 'buff' | 'passive' | 'tech' | 'faction' | 'level' | 'limit';

export function contributionTone(c: StatContribution): ContributionTone {
  if (c.kind !== 'other') return c.kind;
  return c.option || /^Level/.test(c.source) ? 'level' : 'limit';
}

export const TONE_LABEL: Record<ContributionTone, string> = {
  item: 'Equipment', mount: 'Mount', buff: 'Effect', passive: 'Passive', tech: 'Research', faction: 'House', level: 'Level-up', limit: 'Limit',
};

export interface StatPart { label: string; value: number; tone: ContributionTone; text: string }
export interface StatRow {
  key: keyof UnitStats;
  name: string;
  short: string;
  base: number;
  total: number;
  /** total − base: what equipment, the house, levels and effects add on top of the base. */
  bonus: number;
  parts: StatPart[];
  /** '%' for armor (a percentage reduction), else ''. */
  unit: string;
}

/** "+2 Magic Staff", "−1 Plate Armor", "+6% Iron Skin". */
export function formatContribution(k: keyof UnitStats, c: Pick<StatContribution, 'value' | 'source'>): string {
  return `${signed(c.value)}${k === 'armor' ? '%' : ''} ${c.source}`;
}

/** Rows of the attribute table: `base + Σ parts.value === total` for every row (statBreakdown's invariant). */
export function statRows(b: StatBreakdown): StatRow[] {
  return STAT_ORDER.map((k) => {
    const line = b[k];
    const parts = line.contributions.filter((c) => c.value !== 0).map((c) => ({
      label: c.source, value: c.value, tone: contributionTone(c), text: formatContribution(k, c),
    }));
    return { key: k, name: STAT_NAMES[k], short: STAT_LABELS[k], base: line.base, total: line.total, bonus: line.total - line.base, parts, unit: k === 'armor' ? '%' : '' };
  });
}

/** A multiplier as players read it: ×1.25, ×1.1, ×1.56, ×2 (two decimals at most, no trailing zeros). */
export function fmtMult(v: number): string {
  return `×${(Math.round(v * 100) / 100).toString().replace('-', '−')}`;
}

// ───────────────────────────── attacks ─────────────────────────────

const EFF_OF_KIND: Record<AttackDef['kind'], EfficiencyId> = { melee: 'attack', ranged: 'ranged', magic: 'magic' };
const STAT_OF_KIND: Record<AttackDef['kind'], keyof UnitStats> = { melee: 'str', ranged: 'dex', magic: 'int' };

export interface AttackMult { label: string; value: number }
export interface AttackLine {
  attack: AttackDef;
  /** Damage per strike before the target's block and armor (what the unit panel shows). */
  perStrike: number;
  base: number;
  /** floor(stat / 2) of the attack's stat. */
  statBonus: number;
  statName: string;
  /** Multipliers already in perStrike (their product times base + statBonus, rounded, is perStrike). */
  mults: AttackMult[];
  /** Situational effects not in the number (charge, berserker, poison…), and the hit chance. */
  notes: string[];
  hit: string;
}

/**
 * The unit's attacks explained: base + ½ stat, then the multipliers that always apply (efficiency,
 * house, research, buffs, magic items; the same as displayDamage), plus situational notes. Mirrors
 * sim/combat buildProfile for an attack the unit makes against an unarmoured target.
 */
export function attackLines(s: GameState, u: Unit, attacks: readonly AttackDef[], stats: UnitStats): AttackLine[] {
  const fd = FACTIONS[u.faction];
  const tech = u.faction === 'neutral' ? 1 : safe(() => techDamageMult(s, u.faction), 1);
  return attacks.map((a, i) => {
    const statKey = STAT_OF_KIND[a.kind];
    const statBonus = Math.floor(Math.max(0, stats[statKey]) / 2);
    const mults: AttackMult[] = [];
    const effv = u.efficiency?.[EFF_OF_KIND[a.kind]] ?? 1;
    if (effv !== 1) mults.push({ label: LEVEL_OPTION_BY_ID[`eff_${EFF_OF_KIND[a.kind]}`]?.name ?? `${EFFICIENCY_NAMES[EFF_OF_KIND[a.kind]]} efficiency`, value: effv });
    const house = (a.kind === 'melee' ? fd?.meleeMult : a.kind === 'ranged' ? fd?.rangedMult : fd?.magicMult) ?? 1;
    if (house !== 1) mults.push({ label: fd?.name ?? u.faction, value: house });
    if (tech !== 1) mults.push({ label: 'Research', value: tech });
    for (const b of u.buffs ?? []) {
      if (!b.damageMult || (b.id === 'powerstrike' && a.kind !== 'melee')) continue;
      mults.push({ label: BUFF_INFO[b.id]?.name ?? b.id, value: b.damageMult });
    }
    if (a.kind === 'magic') {
      const t = u.equipment?.trinket;
      const ring = t ? ITEMS[t]?.magicDamageMult : undefined;
      if (ring && ring !== 1) mults.push({ label: ITEMS[t!].name, value: ring });
    }
    const perStrike = displayDamage(u, a, stats, house * tech);
    const notes: string[] = [];
    if (a.firststrike) notes.push('First strike: always strikes first, even when defending.');
    if (a.vsMounted) notes.push(`${fmtMult(a.vsMounted)} damage against mounted units.`);
    if (a.kind === 'melee' && !u.monster && u.equipment?.mount && ITEMS[u.equipment.mount]?.mount) {
      notes.push(`Charge: ${fmtMult(CHARGE_MULT)} when it attacks from open ground.`);
    }
    const berserk = augmentRank(u, 'berserker');
    if (a.kind === 'melee' && berserk > 0) {
      notes.push(`${rankedName('Berserker', berserk)}: ${fmtMult(berserkMult(berserk))} while below half health${u.hp < stats.maxHp / 2 ? ' (now)' : ''}.`);
    }
    const venom = augmentRank(u, 'poison');
    if (a.kind === 'melee' && venom > 0) notes.push(`${rankedName('Venom Blades', venom)}: a hit poisons the target for ${venomDamage(venom)} damage a turn.`);
    const drink = augmentRank(u, 'vampiric');
    if (a.kind === 'melee' && drink > 0) notes.push(`${rankedName('Life Drinker', drink)}: heals ${Math.round(drainShare(drink) * 100)}% of the damage dealt.`);
    if (a.kind === 'melee' && u.buffs?.some((b) => b.id === 'powerstrike')) notes.push('Power Strike is spent on the next melee attack it makes.');
    if (i === 0) {
      // One riposte per turn for the whole unit, whichever weapon answers (DESIGN §4.5).
      const per = safe(() => reactionsPerTurn(u), 1);
      const left = safe(() => reactionsLeft(u), per);
      const rank = augmentRank(u, 'reflexes');
      const why = rank <= 0 ? '' : ` (${rankedName('Combat Reflexes', rank)})`;
      const used = left < per ? (left === 0 ? ': already has this turn' : `: ${left} left this turn`) : '';
      notes.push(`Strikes back ${per === 1 ? 'once' : `${per} times`} per turn${why}${used}.`);
    }
    if (a.kind === 'melee') notes.push(`Flanking (an ally on the far side of the target): ${fmtMult(FLANK_MULT)} and ignores block.`);
    const hit = a.kind === 'magic'
      ? `Always ${Math.round(MAGIC_HIT * 100)}% to hit; passes the target's block.`
      : a.kind === 'ranged' && augmentRank(u, 'marksman') > 0
        ? `Hits 100% − the target's defense, at least ${Math.round(marksmanMin(augmentRank(u, 'marksman')) * 100)}% (${rankedName('Marksman', augmentRank(u, 'marksman'))}).`
        : "Hits 100% − the target's terrain defense.";
    return { attack: a, perStrike, base: a.base, statBonus, statName: STAT_NAMES[statKey], mults, notes, hit };
  });
}

// ───────────────────────────── status & augments ─────────────────────────────

export const EFFICIENCY_NAMES: Record<EfficiencyId, string> = {
  attack: 'Melee', ranged: 'Ranged', magic: 'Magic', farming: 'Farming', building: 'Building', mining: 'Mining',
  gathering: 'Gathering', mana: 'Mana', research: 'Research', trade: 'Trade',
};

/** Timed effects on a unit (the sheet's status pills): name, symbol and what it does. */
export const BUFF_INFO: Record<Unit['buffs'][number]['id'], { name: string; icon: string; text: (b: Unit['buffs'][number]) => string }> = {
  bless: { name: SPELLS.bless?.name ?? 'Bless', icon: 'star', text: (b) => `+${Math.round(((b.damageMult ?? 1.2) - 1) * 100)}% damage, +${b.armor ?? 10}% armor` },
  fortify: { name: ACTIVES.fortify.name, icon: 'shield', text: (b) => `+${b.armor ?? 7.5}% armor` },
  haste: { name: SPELLS.haste?.name ?? 'Haste', icon: 'boot', text: () => 'Extra movement this turn' },
  powerstrike: { name: ACTIVES.powerstrike.name, icon: 'sword', text: (b) => `Next melee attack deals ${Math.round(((b.damageMult ?? 1.15) - 1) * 100)}% more damage` },
  farsight: { name: SPELLS.farsight?.name ?? 'Farsight', icon: 'eye', text: () => 'Revealing a distant area' },
};

export interface EffRow { id: EfficiencyId; name: string; value: number; pctText: string; description: string; icon: string }

/** The unit's efficiency multipliers other than ×1, in data order (picks stack: two give ×1.56). */
export function efficiencyRows(u: Unit): EffRow[] {
  return (Object.keys(EFFICIENCY_NAMES) as EfficiencyId[])
    .filter((k) => { const v = u.efficiency?.[k]; return v != null && Math.abs(v - 1) > 1e-6; })
    .map((k) => {
      const v = u.efficiency[k]!;
      const opt = LEVEL_OPTION_BY_ID[`eff_${k}`];
      return {
        id: k, name: opt?.name ?? EFFICIENCY_NAMES[k], value: v,
        pctText: `${v >= 1 ? '+' : '−'}${Math.round(Math.abs(v - 1) * 100)}%`,
        description: opt?.description ?? `${EFFICIENCY_NAMES[k]} ${fmtMult(v)}`, icon: opt?.icon ?? 'skills/eff_attack.png',
      };
    });
}

export interface Augments {
  /** Passives with their rank; `name` carries the rank numeral and `description` states that rank (DESIGN §4.8). */
  passives: { id: PassiveId; name: string; description: string; icon: string; rank: number }[];
  /** Usable active skills (with a cooldown), likewise at their rank. */
  actives: (ActiveSkillDef & { rank: number })[];
  /** Permanent building skills (Masonry, Devotion: cooldown 0). */
  crafts: ActiveSkillDef[];
  efficiencies: EffRow[];
}

export function augmentsOf(u: Unit): Augments {
  return {
    passives: u.passives.filter((p) => PASSIVES[p]).map((p) => {
      const rank = augmentRank(u, p);
      return { id: p, ...PASSIVES[p], name: rankedName(PASSIVES[p].name, rank), description: augmentText(p, rank), rank };
    }),
    actives: u.actives.map((a) => ACTIVES[a]).filter((d): d is ActiveSkillDef => !!d && d.cooldown > 0).map((d) => {
      const rank = augmentRank(u, d.id);
      return { ...d, name: rankedName(d.name, rank), description: augmentText(d.id, rank), rank };
    }),
    crafts: u.actives.map((a) => ACTIVES[a]).filter((d): d is ActiveSkillDef => !!d && d.cooldown === 0),
    efficiencies: efficiencyRows(u),
  };
}

/** Number of augments shown (0: a fresh recruit). */
export function augmentCount(a: Augments): number {
  return a.passives.length + a.actives.length + a.crafts.length + a.efficiencies.length;
}

export interface HistoryRow { level: number; id: string; option: SkillOptionDef | undefined; name: string }

/** Level history, oldest first ("Level 3 — +3 Strength"); unknown option ids keep their raw id. */
export function levelHistory(u: Unit): HistoryRow[] {
  return [...(u.learned ?? [])]
    .sort((a, b) => a.level - b.level)
    .map((l) => ({ level: l.level, id: l.option, option: LEVEL_OPTION_BY_ID[l.option], name: LEVEL_OPTION_BY_ID[l.option]?.name ?? l.option }));
}

// ───────────────────────────── experience ─────────────────────────────

/** How each kind of XP is earned (DESIGN §4.7), for the sheet and its tooltips. */
export const XP_SOURCES: Record<XpCategory, string> = {
  melee: `Melee attacks and parries (+${COMBAT_XP} and +1 per hit landed), melee kills (+8 per level of the victim), Training Ground drill (not for bowmen).`,
  ranged: 'Ranged attacks and return fire, ranged kills, Volley, Training Ground drill for a unit with a bow.',
  building: `Construction and upgrades with Builder's Tools (+${BUILD_XP} a turn), the leader raising its castle.`,
  civic: `Working a farm, mine, lumber camp, quarry, house or the castle (+${WORK_XP} a turn it does not act; the leader learns leadership there), the smith crafting at a forge.`,
  explore: 'Revealing new land (+1 per 3 hexes) and exploring ruins (+12).',
  leader: `Leaders only: recruiting (+2), allies' kills nearby (+1), working its castle (+${WORK_XP} a turn).`,
  magic: 'Magic attacks, Firebolt, Mend, spells cast from its tower, Mage Tower drill, working a library, shrine, watchtower or mage tower (not the castle).',
};

export interface XpRow {
  cat: XpCategory;
  name: string;
  /** Earned during the current level (weights the next level-up offer). */
  level: number;
  /** Lifetime total. */
  lifetime: number;
  /** level / XP needed for this level, capped to 1. */
  levelFrac: number;
  /** lifetime / the unit's lifetime XP of every kind. */
  lifeShare: number;
  /** Share of this level's XP: how much it weights the next offer. */
  levelShare: number;
  /** Only leaders earn this kind. */
  leaderOnly: boolean;
}

/** The seven XP kinds of a unit, in XP_CATS order. */
export function xpRows(u: Unit): XpRow[] {
  const need = xpToNext(u.level);
  const life = XP_CATS.reduce((a, c) => a + Math.max(0, u.xpByCat?.[c] ?? 0), 0);
  const lvl = XP_CATS.reduce((a, c) => a + Math.max(0, u.levelXpByCat?.[c] ?? 0), 0);
  return XP_CATS.map((c) => {
    const level = Math.max(0, u.levelXpByCat?.[c] ?? 0);
    const lifetime = Math.max(0, u.xpByCat?.[c] ?? 0);
    return {
      cat: c, name: XP_CATEGORY_NAMES[c], level, lifetime,
      levelFrac: need > 0 ? Math.min(1, level / need) : 0,
      lifeShare: life > 0 ? lifetime / life : 0,
      levelShare: lvl > 0 ? level / lvl : 0,
      leaderOnly: c === 'leader' && !u.isLeader,
    };
  });
}

/** Level-up options a kind of XP makes likely (data/skills LEVEL_OPTIONS categories), in data order. */
export function optionsFavouredBy(cat: XpCategory): SkillOptionDef[] {
  return LEVEL_OPTIONS.filter((o) => o.categories.includes(cat));
}

const KIND_WORDS: Record<SkillOptionDef['kind'], [string, string]> = {
  stat: ['attribute', 'attributes'], efficiency: ['efficiency', 'efficiencies'], passive: ['passive', 'passives'], active: ['active skill', 'active skills'],
};

/** "2 attributes · 1 efficiency · 3 passives · 1 active skill" (kinds in a fixed order, empty ones left out). */
export function kindSummary(opts: readonly SkillOptionDef[]): string {
  const order: SkillOptionDef['kind'][] = ['stat', 'efficiency', 'passive', 'active'];
  return order
    .map((k) => { const n = opts.filter((o) => o.kind === k).length; return n ? `${n} ${KIND_WORDS[k][n === 1 ? 0 : 1]}` : ''; })
    .filter(Boolean)
    .join(' · ');
}

// ───────────────────────────── inventory ─────────────────────────────

/** Items in a house's stockpile with their counts, in item-table order. */
export function stockpileRows(s: GameState, f: FactionId): { def: ItemDef; count: number }[] {
  const st = s.factions[f]?.stockpile ?? {};
  return ITEM_LIST.filter((d) => (st[d.id] ?? 0) > 0).map((d) => ({ def: d, count: st[d.id] ?? 0 }));
}

/** Buildings a unit can equip on (armories), from the data table. */
export function armoryBuildings(): BuildingDef[] {
  return BUILDING_LIST.filter((b) => b.armory);
}

/** "castle, house, forge, training ground and mage tower" (lower case, data order). */
export function armoryNames(): string {
  const names = armoryBuildings().map((b) => b.name.toLowerCase());
  return names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** What a worker brings to a building it works (the sheet's work note). */
export function workerBonusText(tools: boolean): string {
  return tools
    ? `With Builder's Tools it works a building at ${fmtMult(WORKER_MULT)} output (bare-handed ${fmtMult(BARE_WORKER_MULT)}).`
    : `It works the building it stands on at ${fmtMult(BARE_WORKER_MULT)} output (${fmtMult(WORKER_MULT)} with Builder's Tools).`;
}
