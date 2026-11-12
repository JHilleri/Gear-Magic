// Undead elite augments (DESIGN §2): bought with dark energy, no level-up needed, one stat each,
// a little stronger than the level-up pick of the same stat, and each rank adds mana upkeep.
import type { EliteId, UnitStats } from '../core/types';

export interface EliteDef {
  id: EliteId;
  name: string;
  stat: keyof UnitStats;
  /** Added to the stat per rank. */
  per: number;
  icon: string;
  description: string;
}

export const ELITES: Record<EliteId, EliteDef> = {
  vigor:   { id: 'vigor', name: 'Unholy Vigor', stat: 'maxHp', per: 10, icon: 'skills/stat_hp.png', description: '+10 max HP per rank (the level-up pick gives 8).' },
  might:   { id: 'might', name: 'Grave Might', stat: 'str', per: 4, icon: 'skills/stat_str.png', description: '+4 Strength per rank (the level-up pick gives 3).' },
  deadeye: { id: 'deadeye', name: 'Deadeye', stat: 'dex', per: 4, icon: 'skills/stat_dex.png', description: '+4 Dexterity per rank (the level-up pick gives 3).' },
  wisdom:  { id: 'wisdom', name: 'Dark Wisdom', stat: 'int', per: 4, icon: 'skills/stat_int.png', description: '+4 Intellect per rank (the level-up pick gives 3).' },
};

/** Mana upkeep per elite rank, per turn. */
export const ELITE_UPKEEP = 0.5;

/** Dark energy the `rank`-th rank of an elite augment costs (10, 20, 30…). */
export function eliteCost(rank: number): number {
  return 10 * Math.max(1, rank);
}
