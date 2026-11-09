// Top resource bar, round/faction banner and the screen buttons.
import type { FactionId, GameState, ResourceId, Resources } from '../../core/types';
import { BUILDINGS } from '../../data/buildings';
import { FACTIONS } from '../../data/factions';
import { TECHS } from '../../data/research';
import { buildingOutput, factionIncome } from '../../sim/economy';
import { manaCap } from '../../sim/spells';
import { Kbd, TipCard } from '../common';
import { useUi } from '../ctx';
import { Emblem, ResIcon, Sym } from '../icons';
import { tip } from '../tooltip';
import {
  buildingsOwned, cls, displayTurn, fmt, isComplete, RESOURCE_NAMES, RESOURCE_ORDER, safe, signed, unitsOwned, viewerOf, warOver,
} from '../util';

interface BreakdownRow { label: string; value: number }

/** Income split into per-building-type rows, upkeep and "other" (items, passives). */
export function incomeBreakdown(s: GameState, f: FactionId, r: ResourceId, total: number): BreakdownRow[] {
  const groups = new Map<string, { count: number; value: number }>();
  for (const b of buildingsOwned(s, f)) {
    if (!isComplete(b)) continue;
    const v = safe(() => buildingOutput(s, b), {})[r] ?? 0;
    if (!v) continue;
    const name = BUILDINGS[b.type]?.name ?? b.type;
    const g = groups.get(name) ?? { count: 0, value: 0 };
    g.count++; g.value += v;
    groups.set(name, g);
  }
  const rows: BreakdownRow[] = [...groups.entries()]
    .sort((a, b) => b[1].value - a[1].value)
    .map(([name, g]) => ({ label: g.count > 1 ? `${name} ×${g.count}` : name, value: g.value }));
  let upkeep = 0;
  if (r === 'food') {
    const per = FACTIONS[f]?.foodUpkeep ?? 1;
    const eaters = unitsOwned(s, f).filter((u) => !u.isLeader && !u.monster && u.summonTurns == null).length;
    upkeep = -eaters * per;
    if (eaters > 0) rows.push({ label: `Upkeep (${eaters} units)`, value: upkeep });
  }
  const accounted = rows.reduce((a, x) => a + x.value, 0);
  const other = total - accounted;
  if (Math.abs(other) > 0.05) rows.push({ label: 'Equipment & skills', value: other });
  return rows;
}

function ResourceChip({ r, res, income, cap }: { r: ResourceId; res: Resources; income: Resources; cap: number }) {
  const { store } = useUi();
  const s = store.state!;
  const f = viewerOf(s);
  const fs = s.factions[f];
  const inc = income[r] ?? 0;
  let amount: string;
  let sub: string | null = null;
  if (r === 'mana') amount = `${fmt(Math.floor(res.mana))}`, sub = `/${fmt(cap)}`;
  else if (r === 'research') {
    const t = fs.researching ? TECHS[fs.researching] : null;
    amount = t ? `${fmt(Math.floor(fs.researchProgress))}` : '—';
    sub = t ? `/${t.cost}` : null;
  } else amount = fmt(Math.floor(res[r] ?? 0));
  const low = r !== 'research' && r !== 'mana' && inc < 0 && (res[r] ?? 0) + inc * 2 < 0;

  const tipBody = () => {
    const rows = incomeBreakdown(s, f, r, inc);
    const t = fs.researching ? TECHS[fs.researching] : null;
    return (
      <TipCard icon={<ResIcon r={r} size={28} />} title={RESOURCE_NAMES[r]}
        sub={r === 'research'
          ? (t ? `Researching ${t.name}: ${fmt(fs.researchProgress)}/${t.cost}${inc > 0 ? ` · ${Math.max(1, Math.ceil((t.cost - fs.researchProgress) / inc))} turns` : ''}` : 'No research project — press R')
          : r === 'mana' ? `${fmt(res.mana)} stored · cap ${fmt(cap)}` : `${fmt(res[r] ?? 0)} in store`}>
        <table class="breakdown">
          <tbody>
            {rows.length === 0 && <tr><td class="t-dim">No income</td><td /></tr>}
            {rows.map((row) => (
              <tr key={row.label}><td>{row.label}</td><td class={row.value < 0 ? 't-bad' : 't-good'}>{signed(row.value)}</td></tr>
            ))}
          </tbody>
          <tfoot><tr><td>Per turn</td><td class={inc < 0 ? 't-bad' : 't-good'}>{signed(inc)}</td></tr></tfoot>
        </table>
        {r === 'food' && inc < 0 && <div class="t-bad tip-note">Starvation: when food runs out, every unit loses 3 HP per turn.</div>}
        {r === 'mana' && res.mana >= cap && <div class="t-warn tip-note">Mana is at its cap. Build Mage Towers to raise it.</div>}
      </TipCard>
    );
  };

  return (
    <div class={cls('res-chip', `res-${r}`, low && 'res-low')} {...tip(tipBody)}>
      <ResIcon r={r} size={22} />
      <div class="res-nums">
        <span class="res-amount">{amount}{sub && <small>{sub}</small>}</span>
        <span class={cls('res-delta', inc > 0.05 ? 'up' : inc < -0.05 ? 'down' : 'flat')}>{signed(inc)}</span>
      </div>
    </div>
  );
}

function HudButton({ icon, label, hotkey, onClick, badge, disabled }: { icon: string; label: string; hotkey: string; onClick: () => void; badge?: string | null; disabled?: boolean }) {
  return (
    <button type="button" class="hud-btn" onClick={onClick} disabled={disabled}
      {...tip(<span>{label} <Kbd k={hotkey} /></span>, 'bottom')} aria-label={label}>
      <Sym name={icon} />
      {badge && <span class="hud-badge">{badge}</span>}
    </button>
  );
}

export function TopBar() {
  const { store } = useUi();
  const s = store.state!;
  const ui = store.ui;
  const f = viewerOf(s);
  const fs = s.factions[f];
  const income = safe(() => factionIncome(s, f), fs.income);
  const cap = safe(() => manaCap(s, f), 100);
  // The round and faction the playback shows (the sim may already be a phase further on).
  const tv = displayTurn(s, ui);
  const over = warOver(s, ui);
  const cur = over ? s.winner ?? tv.faction : tv.faction;
  const curDef = FACTIONS[cur];
  const mine = !over && cur === f;
  const status = over ? (s.winner === f ? 'Victory' : s.winner ? 'Victorious' : 'War over')
    : cur === 'neutral' ? 'Monsters stir…'
      : mine ? (ui.busy ? 'Resolving…' : 'Your turn') : ui.aiThinking ? 'Plotting…' : 'Their turn';
  const noResearch = !fs.researching;
  const hasForge = buildingsOwned(s, f).some((b) => b.type === 'forge' && isComplete(b));

  return (
    <div class="topbar panel">
      <div class="res-list">
        {RESOURCE_ORDER.map((r) => <ResourceChip key={r} r={r} res={fs.resources} income={income} cap={cap} />)}
      </div>
      <div class={cls('round-banner', mine && 'mine')} style={{ '--fc': curDef.color, '--fa': curDef.accent } as Record<string, string>}>
        <span class="round-num"><small>Round</small>{over ? s.round : tv.round}</span>
        <span class="round-sep" />
        <Emblem faction={cur} size={26} />
        <span class="round-faction">
          <b>{curDef.name}</b>
          <small>{status}</small>
        </span>
      </div>
      <div class="top-buttons">
        <HudButton icon="research" label="Research" hotkey="R" onClick={() => store.openModal('research')} badge={noResearch ? '!' : null} />
        <HudButton icon="spellbook" label="Spellbook" hotkey="M" onClick={() => store.openModal('spellbook')} />
        <HudButton icon="forge" label={hasForge ? 'Forge & Stockpile' : 'Stockpile (build a Forge to craft)'} hotkey="F" onClick={() => store.openModal('forge')} />
        <HudButton icon="help" label="Help" hotkey="H" onClick={() => store.openModal('help')} />
        <HudButton icon="menu" label="Menu" hotkey="Esc" onClick={() => store.openModal('menu')} />
      </div>
    </div>
  );
}
