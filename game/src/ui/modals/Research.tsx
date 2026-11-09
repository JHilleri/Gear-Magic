// Research tree: three branches as bands of tier columns with SVG prerequisite links.
import type { TechDef, TechId } from '../../core/types';
import { BUILDING_LIST, BUILDINGS } from '../../data/buildings';
import { ITEMS } from '../../data/items';
import { PRESET_LIST } from '../../data/presets';
import { TECH_LIST, TECHS } from '../../data/research';
import { SPELLS } from '../../data/spells';
import { factionIncome } from '../../sim/economy';
import { availableTechs } from '../../sim/research';
import { Bar, TipCard } from '../common';
import { act, useUi } from '../ctx';
import { Icon, ResIcon, Sym } from '../icons';
import { tip } from '../tooltip';
import { cls, fmt, isMyTurn, presetTechs, safe, viewerOf } from '../util';
import { Modal } from './Modal';

const BRANCHES: { id: TechDef['branch']; name: string; color: string }[] = [
  { id: 'civic', name: 'Civic', color: '#c9a24e' },
  { id: 'military', name: 'Military', color: '#c0563f' },
  { id: 'arcane', name: 'Arcane', color: '#8f6fe0' },
];
// Layout in rem.
const NODE_W = 13, NODE_H = 3.6, COL_GAP = 3.4, ROW_GAP = 0.55, BRANCH_GAP = 1.5, LABEL_W = 2.4, PAD = 0.6;
const TIERS = Math.max(...TECH_LIST.map((t) => t.tier)) + 1;

interface Pos { x: number; y: number }

function layout(): { pos: Record<string, Pos>; bands: { id: string; name: string; color: string; y: number; h: number }[]; w: number; h: number } {
  const pos: Record<string, Pos> = {};
  const bands: { id: string; name: string; color: string; y: number; h: number }[] = [];
  let y = PAD;
  for (const b of BRANCHES) {
    const techs = TECH_LIST.filter((t) => t.branch === b.id);
    const rows = Math.max(...techs.map((t) => t.row)) + 1;
    const h = rows * NODE_H + (rows - 1) * ROW_GAP;
    for (const t of techs) pos[t.id] = { x: LABEL_W + PAD + t.tier * (NODE_W + COL_GAP), y: y + t.row * (NODE_H + ROW_GAP) };
    bands.push({ ...b, y, h });
    y += h + BRANCH_GAP;
  }
  return { pos, bands, w: LABEL_W + PAD * 2 + TIERS * NODE_W + (TIERS - 1) * COL_GAP, h: y - BRANCH_GAP + PAD };
}
const LAYOUT = layout();

/** What researching `t` opens up; `done` (researched techs) only trims "also needs" notes. */
function unlockLines(t: TechDef, done: ReadonlySet<TechId>): { icon: string; text: string }[] {
  const out: { icon: string; text: string }[] = [];
  for (const b of t.unlocksBuildings ?? []) out.push({ icon: BUILDINGS[b].icon, text: `Building: ${BUILDINGS[b].name}` });
  for (const i of t.unlocksItems ?? []) out.push({ icon: ITEMS[i].icon, text: `Item: ${ITEMS[i].name}` });
  // Recruit presets whose equipment needs this tech.
  for (const p of PRESET_LIST) {
    const needs = presetTechs(p.id);
    if (!needs.includes(t.id)) continue;
    const sites = BUILDING_LIST.filter((b) => b.recruits?.includes(p.id)).map((b) => b.name);
    const others = needs.filter((x) => x !== t.id && !done.has(x)).map((x) => TECHS[x].name);
    const item = p.items.find((i) => ITEMS[i].unlock === t.id) ?? p.items[0];
    out.push({ icon: ITEMS[item].icon, text: `Recruit: ${p.name} (${sites.join(', ')})${others.length ? ` · also needs ${others.join(', ')}` : ''}` });
  }
  if (t.unlocksSpell) out.push({ icon: SPELLS[t.unlocksSpell].icon, text: `Spell: ${SPELLS[t.unlocksSpell].name}` });
  const bo = t.bonus;
  if (bo?.resource && bo.mult) out.push({ icon: `resources/${bo.resource}.png`, text: `+${Math.round((bo.mult - 1) * 100)}% ${bo.resource}` });
  if (bo?.damageMult) out.push({ icon: 'techs/tactics.png', text: `+${Math.round((bo.damageMult - 1) * 100)}% damage for all units` });
  if (bo?.maxBuildingLevel) out.push({ icon: 'techs/architecture.png', text: `Buildings upgrade to level ${bo.maxBuildingLevel}` });
  return out;
}

export function ResearchModal() {
  const { store } = useUi();
  const s = store.state!;
  const f = viewerOf(s);
  const fs = s.factions[f];
  const done = new Set(fs.techs);
  const avail = new Set(safe(() => availableTechs(s, f), TECH_LIST.filter((t) => !done.has(t.id) && t.requires.every((r) => done.has(r))).map((t) => t.id)));
  const perTurn = safe(() => factionIncome(s, f).research, fs.income.research ?? 0);
  const cur = fs.researching ? TECHS[fs.researching] : null;
  const my = isMyTurn(s, store.ui);
  const turnsFor = (cost: number, progress: number) => (perTurn > 0 ? Math.max(1, Math.ceil((cost - progress) / perTurn)) : Infinity);

  const choose = (id: TechId) => { if (my) void act(store, { type: 'research', faction: f, tech: id }); };

  const { pos, bands, w, h } = LAYOUT;
  return (
    <Modal size="xl" title="Research" icon={<Icon k="resources/research.png" size={40} />} onClose={() => store.closeModal()}
      sub={<span>{fs.techs.length} of {TECH_LIST.length} discovered · <ResIcon r="research" size={14} /> {fmt(perTurn)} per turn</span>}>
      <div class={cls('research-current', !cur && 'none')}>
        {cur ? (
          <>
            <Icon k={cur.icon} size={44} />
            <div class="rc-main">
              <div class="rc-title"><span class="t-dim">Researching</span> <b>{cur.name}</b></div>
              <Bar kind="research" value={fs.researchProgress} max={cur.cost} label={`${fmt(fs.researchProgress)} / ${cur.cost}`} />
            </div>
            <div class="rc-eta">{Number.isFinite(turnsFor(cur.cost, fs.researchProgress)) ? <><b>{turnsFor(cur.cost, fs.researchProgress)}</b><small>turns</small></> : <small>No research income</small>}</div>
          </>
        ) : (
          <><Sym name="research" /><span>Choose a technology to research. Progress carries over if you switch.</span></>
        )}
      </div>

      <div class="tech-scroll">
        <div class="tech-tree" style={{ width: `${w}rem`, height: `${h}rem` }}>
          {bands.map((b) => (
            <div key={b.id} class="tech-band" style={{ top: `${b.y - 0.3}rem`, height: `${b.h + 0.6}rem`, '--bc': b.color } as Record<string, string>}>
              <span class="tech-band-label">{b.name}</span>
            </div>
          ))}
          <svg class="tech-links" viewBox={`0 0 ${w} ${h}`} style={{ width: `${w}rem`, height: `${h}rem` }} aria-hidden="true">
            {TECH_LIST.flatMap((t) => t.requires.map((r) => {
              const a = pos[r], b = pos[t.id];
              if (!a || !b) return null;
              const x1 = a.x + NODE_W, y1 = a.y + NODE_H / 2, x2 = b.x, y2 = b.y + NODE_H / 2;
              const dx = Math.max(1.2, (x2 - x1) * 0.5);
              const cross = TECHS[r].branch !== t.branch;
              const state = done.has(r) ? (done.has(t.id) ? 'done' : 'open') : 'locked';
              return (
                <path key={`${r}-${t.id}`} class={cls('tech-link', state, cross && 'cross')}
                  d={`M${x1} ${y1} C${x1 + dx} ${y1} ${x2 - dx} ${y2} ${x2} ${y2}`} />
              );
            }))}
          </svg>
          {TECH_LIST.map((t) => {
            const p = pos[t.id];
            const isDone = done.has(t.id);
            const isCur = fs.researching === t.id;
            const isAvail = !isDone && avail.has(t.id);
            const state = isDone ? 'done' : isCur ? 'current' : isAvail ? 'available' : 'locked';
            const missing = t.requires.filter((r) => !done.has(r));
            // Progress is one pool that carries over on a switch, so every estimate starts from it.
            const turns = turnsFor(t.cost, fs.researchProgress);
            const lines = unlockLines(t, done);
            const body = () => (
              <TipCard icon={<Icon k={t.icon} size={40} />} title={t.name}
                sub={<span>{t.branch[0].toUpperCase() + t.branch.slice(1)} · <ResIcon r="research" size={13} /> {t.cost}{!isDone && Number.isFinite(turns) ? ` · ~${turns} turns` : ''}</span>}>
                <div>{t.description}</div>
                {lines.length > 0 && (
                  <div class="tip-unlocks">
                    {lines.map((l) => <div key={l.text} class="tip-unlock"><Icon k={l.icon} size={20} /><span>{l.text}</span></div>)}
                  </div>
                )}
                {t.requires.length > 0 && (
                  <div class="tip-note">Requires: {t.requires.map((r, i) => (
                    <span key={r} class={done.has(r) ? 't-good' : 't-bad'}>{i > 0 ? ', ' : ''}{TECHS[r].name}</span>
                  ))}</div>
                )}
                {isDone && <div class="tip-note t-good">Researched</div>}
                {isAvail && !isCur && my && <div class="tip-note t-gold">Click to research{fs.researching ? ' (progress carries over)' : ''}</div>}
              </TipCard>
            );
            return (
              <button type="button" key={t.id} class={cls('tech-node', state)} aria-disabled={!(isAvail && !isCur)}
                style={{ left: `${p.x}rem`, top: `${p.y}rem`, width: `${NODE_W}rem`, height: `${NODE_H}rem` }}
                onClick={isAvail && !isCur ? () => choose(t.id) : undefined} {...tip(body, 'right')}>
                <Icon k={t.icon} size={38} dim={state === 'locked'} />
                <span class="tn-main">
                  <span class="tn-name">{t.name}</span>
                  <span class="tn-meta">
                    {isDone ? <span class="t-good">Researched</span>
                      : isCur ? <span>{fmt(fs.researchProgress)} / {t.cost}</span>
                        : missing.length ? <span><Sym name="lock" /> {missing.map((r) => TECHS[r].name).join(', ')}</span>
                          : <span><ResIcon r="research" size={13} /> {t.cost}{Number.isFinite(turns) ? ` · ${turns}t` : ''}</span>}
                  </span>
                </span>
                {isDone && <span class="tn-check"><Sym name="check" /></span>}
                {isCur && <span class="tn-progress"><span style={{ width: `${Math.min(100, (fs.researchProgress / t.cost) * 100)}%` }} /></span>}
              </button>
            );
          })}
        </div>
      </div>
    </Modal>
  );
}
