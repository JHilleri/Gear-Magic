// Empower (Ashen Covenant, DESIGN §2): spend dark energy on the selected unit's elite augments.
import type { EliteId } from '../../core/types';
import { ELITE_UPKEEP, ELITES } from '../../data/elites';
import { rankedName } from '../../data/ranks';
import { canEmpower, eliteRank, empowerSiteError, nextEliteCost, raisesElites } from '../../sim/elites';
import { ELITE_ORDER } from '../../sim/houses';
import { effectiveStats } from '../../sim/units';
import { Btn, TipCard } from '../common';
import { act, useUi } from '../ctx';
import { Icon, ResIcon } from '../icons';
import { tip } from '../tooltip';
import { cls, fmt, isMyTurn, safe, selectedUnitId, unitById, viewerOf } from '../util';
import { Modal } from './Modal';

export function EmpowerModal() {
  const { store } = useUi();
  const s = store.state!;
  const f = viewerOf(s);
  const u = unitById(s, selectedUnitId(s, store.ui));
  if (!u || u.faction !== f || !raisesElites(f)) {
    return (
      <Modal size="sm" title="Empower" onClose={() => store.closeModal()}>
        <div class="empty-note">Select one of your units standing on your castle or a mage tower.</div>
      </Modal>
    );
  }
  const fs = s.factions[f];
  const my = isMyTurn(s, store.ui);
  const site = safe(() => empowerSiteError(s, u), null);
  const stats = safe(() => effectiveStats(s, u), u.base);
  const buy = (e: EliteId) => void act(store, { type: 'empower', unit: u.id, elite: e });
  return (
    <Modal size="md" title={`Empower ${u.name}`} icon={<ResIcon r="dark" size={40} />} onClose={() => store.closeModal()}
      sub={<span>Dark energy <b>{fmt(Math.floor(fs.resources.dark ?? 0))}</b> · earned only by killing · each rank adds {ELITE_UPKEEP} mana upkeep a turn{site ? <> · <span class="t-bad">{site}</span></> : ''}</span>}>
      <div class="elite-grid">
        {ELITE_ORDER.map((e) => {
          const def = ELITES[e];
          const rank = eliteRank(u, e);
          const cost = nextEliteCost(u, e);
          const err = !my ? 'Not your turn' : safe(() => canEmpower(s, u, e), 'Unavailable');
          return (
            <div key={e} class={cls('elite-card', rank > 0 && 'owned')}
              {...tip(<TipCard icon={<Icon k={def.icon} size={36} />} title={rankedName(def.name, rank + 1)}>{def.description}</TipCard>)}>
              <Icon k={def.icon} size={48} />
              <div class="elite-main">
                <b>{rank > 0 ? rankedName(def.name, rank) : def.name}</b>
                <span class="t-dim">{def.description}</span>
                <span class="elite-now">{rank > 0 ? `Rank ${rank}: +${def.per * rank}` : 'Not yet raised'} · now {fmt(stats[def.stat])}</span>
              </div>
              <Btn small primary disabled={!!err} reason={err} title={`Raise to rank ${rank + 1} for ${cost} dark energy`}
                onClick={() => buy(e)}>
                <ResIcon r="dark" size={16} /> {cost}
              </Btn>
            </div>
          );
        })}
      </div>
    </Modal>
  );
}
