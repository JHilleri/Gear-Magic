// What the human last saw of each tile (buildings and territory), so the UI shows remembered
// state under the fog instead of the live state, as the renderer does with its own copy.
// Pure; no DOM.
import type { Building, FactionId, GameState } from '../core/types';
import { computeTerritory } from '../sim/economy';
import type { LastSeenMap } from './store';

export class FogMemory implements LastSeenMap {
  buildings: (Building | null)[] = [];
  territory: (FactionId | null)[] = [];

  clear(): void {
    this.buildings = [];
    this.territory = [];
  }

  /**
   * Record every tile `viewer` sees now. `initial` (new game, load) also takes explored tiles
   * from the live state, since nothing older is known.
   */
  update(s: GameState, viewer: FactionId, initial = false): void {
    const n = s.width * s.height;
    if (this.buildings.length !== n) {
      this.buildings = new Array<Building | null>(n).fill(null);
      this.territory = new Array<FactionId | null>(n).fill(null);
      initial = true;
    }
    const fs = s.factions[viewer];
    if (!fs) return;
    let terr: (FactionId | null)[] | null = null;
    for (let i = 0; i < n; i++) {
      if (!fs.visible[i] && !(initial && fs.explored[i])) continue;
      terr ??= computeTerritory(s);
      const id = s.tiles[i]?.building;
      const b = id != null ? s.buildings[String(id)] : undefined;
      this.buildings[i] = b ? { ...b, pos: { ...b.pos } } : null;
      this.territory[i] = terr[i] ?? null;
    }
  }
}
