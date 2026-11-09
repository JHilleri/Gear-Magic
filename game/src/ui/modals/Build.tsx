// Build menu: every building with cost, output and why it can't be built here.
import { useState } from 'preact/hooks';
import type { BuildingId } from '../../core/types';
import { BUILDING_LIST, BUILDINGS } from '../../data/buildings';
import { PRESETS } from '../../data/presets';
import { TECHS } from '../../data/research';
import { ACTIVES } from '../../data/skills';
import { TERRAIN } from '../../data/terrain';
import { buildOptions } from '../../sim/actions';
import { Cost, Output, TipCard } from '../common';
import { act, useUi } from '../ctx';
import { Icon, Sym } from '../icons';
import { tip } from '../tooltip';
import { cls, isMyTurn, optionError, presetTechs, safe, selectedUnitId, tileAt, unitById, viewerOf } from '../util';
import { Modal } from './Modal';

const GROUPS: { name: string; ids: BuildingId[] }[] = [
  { name: 'Economy', ids: ['farm', 'lumber', 'quarry', 'mine', 'crystalmine', 'house'] },
  { name: 'Military', ids: ['castle', 'training', 'forge', 'wall', 'watchtower'] },
  { name: 'Knowledge & Magic', ids: ['library', 'magetower', 'shrine'] },
];

export function BuildModal() {
  const { store } = useUi();
  // Moving the seat demolishes the old castle at once: the castle card asks for a second click.
  const [confirmCastle, setConfirmCastle] = useState(false);
  const s = store.state!;
  const f = viewerOf(s);
  const u = unitById(s, selectedUnitId(s, store.ui));
  if (!u || u.faction !== f) {
    return <Modal size="sm" title="Build" onClose={() => store.closeModal()}><div class="empty-note">Select your leader or one of your units carrying Builder's Tools.</div></Modal>;
  }
  const fs = s.factions[f];
  const tile = tileAt(s, u.pos);
  const tdef = tile ? TERRAIN[tile.terrain] : null;
  const my = isMyTurn(s, store.ui);
  const opts = safe(() => buildOptions(s, u), BUILDING_LIST.map((b) => ({ building: b.id, error: 'Unavailable' as string | null })));
  const errOf = (id: BuildingId): string | null => optionError(opts, (o) => o.building === id, my);
  const okCount = BUILDING_LIST.filter((b) => !errOf(b.id)).length;
  const seat = fs.castleId != null ? s.buildings[String(fs.castleId)] : undefined;
  const oldCastle = seat && seat.type === 'castle' && seat.owner === f ? seat : undefined;
  const moveWarning = !oldCastle ? null
    : oldCastle.buildLeft > 0 && !oldCastle.upgrading
      ? `Your unfinished castle will be torn down now; the new seat needs ${BUILDINGS.castle.buildPoints} build points.`
      : `Your current castle (level ${oldCastle.level}) will be demolished now; the new seat needs ${BUILDINGS.castle.buildPoints} build points.`;

  const build = async (id: BuildingId) => {
    if (id === 'castle' && moveWarning && !confirmCastle) { setConfirmCastle(true); return; }
    setConfirmCastle(false);
    const r = await act(store, { type: 'build', unit: u.id, building: id });
    if (r.ok && store.ui.modal === 'build') store.closeModal();
  };

  return (
    <Modal size="xl" title="Construct" icon={<Icon k="items/tools.png" size={40} />} onClose={() => store.closeModal()}
      sub={<span>{u.name} on {tdef?.name ?? 'unknown ground'}{tile?.deposit ? ` (${tile.deposit} deposit)` : ''} · {okCount} building{okCount === 1 ? '' : 's'} possible here · construction progresses at the end of each turn while a builder stays on the site</span>}>
      <div class="build-groups">
        {GROUPS.map((g) => (
          <div class="item-group" key={g.name}>
            <div class="group-title">{g.name}</div>
            <div class="build-grid">
              {g.ids.map((id) => {
                const d = BUILDINGS[id];
                const err = errOf(id);
                const locked = (d.unlock && !fs.techs.includes(d.unlock)) || (!!d.unlockSkill && !u.actives.includes(d.unlockSkill));
                const req = d.unlock ? TECHS[d.unlock].name : d.unlockSkill ? `${ACTIVES[d.unlockSkill].name} skill` : null;
                return (
                  <button type="button" key={id} class={cls('build-card', err && 'is-disabled', locked && 'locked')} aria-disabled={!!err}
                    onClick={err ? undefined : () => void build(id)}
                    {...tip(<TipCard icon={<Icon k={d.icon} size={40} />} title={d.name} sub={`Terrain: ${d.terrains.map((t) => TERRAIN[t].name).join(', ')}${d.deposit ? ` · needs ${d.deposit} deposit` : ''}`}>
                      {d.description}
                      {req && <div class={cls('tip-note', locked ? 't-bad' : 't-good')}>Requires {req}</div>}
                      {d.recruits && (
                        <div class="tip-note">Recruits: {d.recruits.map((p, i) => {
                          const miss = presetTechs(p).filter((x) => !fs.techs.includes(x));
                          return <span key={p} class={miss.length ? 't-bad' : undefined}>{i > 0 ? ', ' : ''}{PRESETS[p].name}{miss.length ? ` (needs ${miss.map((x) => TECHS[x].name).join(', ')})` : ''}</span>;
                        })}</div>
                      )}
                      {id === 'castle' && moveWarning && <div class="tip-note t-bad">{moveWarning}</div>}
                      {err ? <div class="tip-note t-bad">{err}</div>
                        : <div class="tip-note t-gold">{id === 'castle' && moveWarning ? (confirmCastle ? 'Click again to confirm the move' : 'Click, then click again to confirm') : 'Click to start construction'}</div>}
                    </TipCard>)}>
                    <span class="bc-icon"><Icon k={d.icon} size={52} dim={!!locked} />{locked && <span class="bc-lock"><Sym name="lock" /></span>}</span>
                    <span class="bc-main">
                      <span class="bc-name">{d.name}</span>
                      <Cost cost={d.cost} have={fs.resources} compact />
                      <span class="bc-row"><Output out={d.output} empty={d.armory ? 'Armory' : d.defense ? `+${d.defense[0]}% def` : '—'} /><span class="bc-pts" {...tip('Build points (one builder adds ~1 per turn)')}><Sym name="hammer" />{d.buildPoints}</span></span>
                      {err && <span class="bc-err">{err}</span>}
                      {!err && id === 'castle' && confirmCastle && moveWarning && <span class="bc-err">{moveWarning} Click again to confirm.</span>}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </Modal>
  );
}
