// Balance table (not part of the normal suite): exact combat forecasts between level-1 recruits of
// every preset, so a change to damage, hit points or armor can be read as numbers before it is played.
// Run with: BALANCE_TABLE=1 npx vitest run tests/balance-table.test.ts
// Each cell: expected damage of one attack as a share of the defender's HP, and the expected damage
// the attacker takes back (retaliation), on grass (40% defense). "flanked": a second attacker stands
// on the hex opposite the first.
import { describe, it } from 'vitest';
import type { AttackKind, FactionId, Hex, PresetId, Unit } from '../src/core/types';
import { createUnit, effectiveStats, getAttackDefs } from '../src/sim/units';
import { availableAttackKinds, forecastCombat } from '../src/sim/combat';
import { makeTestState } from './helpers';

const env = (globalThis as { process?: { env: Record<string, string | undefined>; stderr: { write(s: string): void } } }).process;
const ON = !!env?.env.BALANCE_TABLE;
const out = (s: string) => env?.stderr.write(s + '\n');

const PRESETS: PresetId[] = ['commoner', 'builder', 'swordsman', 'spearman', 'archer', 'knight', 'apprentice', 'battlemage'];
const pad = (s: string | number, n: number) => String(s).padEnd(n);

function fresh() {
  const s = makeTestState(12, 10, 'grass');
  // Every tech, so every preset can be fielded.
  s.factions.valen.techs = ['polearms', 'tanning', 'shieldcraft', 'platesmithing', 'horsemanship', 'arcana', 'wandcraft', 'jewelcraft'];
  s.factions.thorn.techs = [...s.factions.valen.techs];
  return s;
}

function unit(s: ReturnType<typeof fresh>, f: FactionId, pos: Hex, p: PresetId): Unit {
  return createUnit(s, { faction: f, pos, preset: p });
}

function bestKind(s: ReturnType<typeof fresh>, a: Unit, d: Unit): AttackKind | null {
  const kinds = availableAttackKinds(s, a, d);
  let best: AttackKind | null = null, bv = -1;
  for (const k of kinds) {
    const fc = forecastCombat(s, a, d, k);
    if (fc && fc.expectedDamageToDefender > bv) { bv = fc.expectedDamageToDefender; best = k; }
  }
  return best;
}

describe.runIf(ON)('balance table', () => {
  it('level-1 matchups (valen attacks thorn on grass)', () => {
    out('\n== Recruits (valen / thorn): HP, block, armor %, attack');
    for (const p of PRESETS) {
      const s = fresh();
      for (const f of ['valen', 'thorn'] as const) {
        const u = unit(s, f, { q: 2, r: 2 }, p);
        const st = effectiveStats(s, u) as unknown as Record<string, number>;
        const atk = getAttackDefs(u).map((a) => `${a.name} ${a.base}×${a.strikes}${a.kind !== 'melee' ? ` (${a.kind})` : ''}`).join(', ');
        out(`  ${pad(`${p} ${f}`, 20)} HP ${pad(st.maxHp, 4)} block ${pad(st.block ?? '-', 3)} armor ${pad(st.armor, 4)} ${atk}`);
      }
    }
    for (const flank of [false, true]) {
      out(`\n== ${flank ? 'FLANKED (melee only)' : 'Frontal'}: dealt % of defender HP / taken back (HP)`);
      out(`  ${pad('att \\ def', 12)}${PRESETS.map((p) => pad(p, 13)).join('')}`);
      for (const ap of PRESETS) {
        const cells: string[] = [];
        for (const dp of PRESETS) {
          const s = fresh();
          // Defender at (5,4); the attacker west of it at range 1 (melee) or 2 (shooters).
          const d = unit(s, 'thorn', { q: 5, r: 4 }, dp);
          const probe = unit(s, 'valen', { q: 4, r: 4 }, ap);
          const ranged = getAttackDefs(probe).some((x) => x.kind !== 'melee');
          if (ranged && !flank) probe.pos = { q: 3, r: 4 };
          if (flank) {
            if (ranged) { cells.push(pad('', 13)); continue; }
            unit(s, 'valen', { q: 6, r: 4 }, 'commoner'); // opposite hex of (4,4) around (5,4)
          }
          const k = bestKind(s, probe, d);
          const fc = k ? forecastCombat(s, probe, d, k) : null;
          if (!fc) { cells.push(pad('-', 13)); continue; }
          const hp = effectiveStats(s, d).maxHp;
          cells.push(pad(`${Math.round((fc.expectedDamageToDefender / hp) * 100)}%/${fc.expectedDamageToAttacker.toFixed(0)}`, 13));
        }
        out(`  ${pad(ap, 12)}${cells.join('')}`);
      }
    }
  });
});
