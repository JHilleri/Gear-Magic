// Upgrade preview: what raising a building one level costs, how long it takes and what it gives.
import type { Building, BuildingDef, GameState, Resources, Unit } from '../../core/types';
import { BUILDINGS } from '../../data/buildings';
import { buildingOutput, buildingXpPerTurn, buildRate, upgradeBuildPoints, upgradeCost } from '../../sim/economy';
import { Cost, Output } from '../common';
import { fmt, plural, safe, XP_NAMES } from '../util';

/** Tile defense bonus of a building at `level` (mirrors sim/combat tileDefense). */
function defenseAt(def: BuildingDef, level: number): number {
  const d = def.defense;
  return d?.length ? d[Math.min(d.length, Math.max(1, level)) - 1] : 0;
}

/**
 * `builder`: the unit with tools that would do the upgrade (for the time estimate). `stationed`: the
 * own unit standing on the building, whose drill XP kind it shows (a bowman drills Ranged), as the
 * tile panel's chip does; without one a Training Ground reads "Melee / Ranged".
 */
export function UpgradeDetails({ s, b, have, builder, stationed }: { s: GameState; b: Building; have?: Resources; builder?: Unit; stationed?: Unit }) {
  const def = BUILDINGS[b.type];
  const next: Building = { ...b, level: b.level + 1, buildLeft: 0, upgrading: false };
  const cost = safe(() => upgradeCost(b), def.cost);
  const points = safe(() => upgradeBuildPoints(b), def.buildPoints * b.level);
  const rate = builder ? safe(() => buildRate(builder), 1) : 0;
  const outNow = safe(() => buildingOutput(s, b), def.output);
  const outNext = safe(() => buildingOutput(s, next), def.output);
  const defNow = defenseAt(def, b.level);
  const defNext = defenseAt(def, next.level);
  const xpNow = safe(() => buildingXpPerTurn(b, stationed), null);
  const xpNext = safe(() => buildingXpPerTurn(next, stationed), null);
  const xpAlt = !stationed && def.xpPerTurn?.rangedCat ? def.xpPerTurn.rangedCat : null;
  return (
    <table class="breakdown upgrade-info">
      <tbody>
        <tr><td>Cost</td><td><Cost cost={cost} have={have} compact /></td></tr>
        <tr>
          <td>Work</td>
          <td>{fmt(points)} build points{rate > 0 ? ` (~${plural(Math.max(1, Math.ceil(points / rate)), 'turn')})` : ''}</td>
        </tr>
        {Object.keys(def.output).length > 0 && (
          <tr><td>Output</td><td><Output out={outNow} /> → <Output out={outNext} /></td></tr>
        )}
        {defNext > defNow && <tr><td>Defense</td><td>+{defNow}% → +{defNext}%</td></tr>}
        {b.type === 'forge' && <tr><td>Crafts / turn</td><td>{b.level + 1} → {next.level + 1}</td></tr>}
        {xpNow && xpNext && xpNext.amount > xpNow.amount && (
          <tr><td>{XP_NAMES[xpNow.cat]}{xpAlt ? ` / ${XP_NAMES[xpAlt]}` : ''} XP / turn</td><td>+{xpNow.amount} → +{xpNext.amount}</td></tr>
        )}
      </tbody>
    </table>
  );
}
