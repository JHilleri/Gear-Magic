// Forge & stockpile: craft items into the faction stockpile.
import { useState } from 'preact/hooks';
import type { BuildingInstanceId, EquipSlot, ItemDef, ItemId } from '../../core/types';
import { ITEM_LIST } from '../../data/items';
import { TECH_LIST, TECHS } from '../../data/research';
import { craftOptions } from '../../sim/actions';
import { Cost, TipCard } from '../common';
import { act, useUi } from '../ctx';
import { Icon, Sym } from '../icons';
import { tip } from '../tooltip';
import { buildingById, buildingsOwned, cls, formatStatDelta, isComplete, isMyTurn, safe, viewerOf } from '../util';
import { Modal } from './Modal';

const GROUPS: { slot: EquipSlot; name: string }[] = [
  { slot: 'main', name: 'Weapons & Tools' },
  { slot: 'off', name: 'Off hand' },
  { slot: 'body', name: 'Armor' },
  { slot: 'trinket', name: 'Trinkets' },
  { slot: 'mount', name: 'Mounts' },
];

/** One-line summary of what an item does. */
export function itemSummary(def: ItemDef): string {
  const parts: string[] = [];
  if (def.attack) parts.push(`${def.attack.kind === 'melee' ? 'Melee' : def.attack.kind === 'ranged' ? 'Ranged' : 'Magic'} ${def.attack.base}×${def.attack.strikes}${def.attack.range > 1 ? ` R${def.attack.range}` : ''}`);
  if (def.stats) { const s = formatStatDelta(def.stats); if (s) parts.push(s); }
  if (def.terrainDefense) parts.push(`+${def.terrainDefense}% defense`);
  if (def.manaPerTurn) parts.push(`+${def.manaPerTurn} mana/turn`);
  if (def.regen) parts.push(`regen ${def.regen}`);
  if (def.magicDamageMult) parts.push(`+${Math.round((def.magicDamageMult - 1) * 100)}% magic dmg`);
  if (def.attack?.firststrike) parts.push('first strike');
  if (def.attack?.vsMounted) parts.push(`+${Math.round((def.attack.vsMounted - 1) * 100)}% vs mounted`);
  if (def.mount) parts.push('charge', 'no mountains');
  if (def.canBuild) parts.push('builds');
  if (def.twoHanded) parts.push('two-handed');
  return parts.join(' · ');
}

export function ForgeModal() {
  const { store } = useUi();
  const s = store.state!;
  const ui = store.ui;
  const f = viewerOf(s);
  const fs = s.factions[f];
  const forges = buildingsOwned(s, f).filter((b) => b.type === 'forge' && isComplete(b));
  const [pick, setPick] = useState<BuildingInstanceId | null>(null);
  const initial = ui.forgeSite != null && forges.some((b) => b.id === ui.forgeSite) ? ui.forgeSite : forges[0]?.id ?? null;
  const forgeId = pick != null && forges.some((b) => b.id === pick) ? pick : initial;
  const forge = buildingById(s, forgeId);
  const my = isMyTurn(s, ui);
  const left = forge ? Math.max(0, forge.level + 1 - forge.craftedThisTurn) : 0;
  const opts = forge ? safe(() => craftOptions(s, forge.id), [] as { item: ItemId; error: string | null }[]) : [];
  const errOf = (id: ItemId): string | null => {
    if (!forge) return forges.length === 0 ? 'Build a Forge to craft items' : 'Select a forge';
    if (!my) return 'Not your turn';
    const o = opts.find((x) => x.item === id);
    return o ? o.error : null;
  };
  const stock = ITEM_LIST.filter((d) => (fs.stockpile[d.id] ?? 0) > 0);
  const totalStock = stock.reduce((a, d) => a + (fs.stockpile[d.id] ?? 0), 0);

  return (
    <Modal size="xl" title="Forge & Stockpile" icon={<Icon k="buildings/forge.png" size={40} />} onClose={() => store.closeModal()}
      sub={forge ? <span>Forge level {forge.level} · <b>{left}</b> craft{left === 1 ? '' : 's'} left this turn</span> : <span>{forges.length ? 'Choose a forge' : 'You have no completed Forge'}</span>}>
      <div class="forge-layout">
        <div class="forge-catalog">
          {forges.length > 1 && (
            <div class="forge-picker">
              <span>Forge:</span>
              {forges.map((b, i) => (
                <button type="button" key={b.id} class={cls('seg', b.id === forgeId && 'on')} onClick={() => setPick(b.id)}>
                  #{i + 1} · Lv {b.level} · {Math.max(0, b.level + 1 - b.craftedThisTurn)} left
                </button>
              ))}
            </div>
          )}
          {GROUPS.map((g) => (
            <div class="item-group" key={g.slot}>
              <div class="group-title">{g.name}</div>
              <div class="item-grid">
                {ITEM_LIST.filter((d) => d.slot === g.slot).map((d) => {
                  const unlocked = !d.unlock || fs.techs.includes(d.unlock);
                  const err = !unlocked ? `Requires ${TECHS[d.unlock!].name}` : errOf(d.id);
                  const count = fs.stockpile[d.id] ?? 0;
                  return (
                    <button type="button" key={d.id} class={cls('item-card', !unlocked && 'locked', err && 'is-disabled')} aria-disabled={!!err}
                      onClick={err ? undefined : () => void act(store, { type: 'craft', forge: forge!.id, item: d.id })}
                      {...tip(<TipCard icon={<Icon k={d.icon} size={40} />} title={d.name} sub={itemSummary(d)}>
                        {d.description}{err ? <div class="tip-note t-bad">{err}</div> : <div class="tip-note t-gold">Click to craft one into the stockpile</div>}
                      </TipCard>)}>
                      <span class="ic-icon"><Icon k={d.icon} size={44} dim={!unlocked} />{count > 0 && <span class="count-badge">{count}</span>}</span>
                      <span class="ic-main">
                        <span class="ic-name">{d.name}{!unlocked && <Sym name="lock" />}</span>
                        <span class="ic-sum">{itemSummary(d)}</span>
                        <Cost cost={d.cost} have={fs.resources} compact />
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
        <div class="stockpile">
          <div class="group-title">Stockpile <span class="t-dim">({totalStock})</span></div>
          {stock.length === 0 && <div class="empty-note">Empty. Crafted items wait here until a unit equips them at an armory (castle, house, forge, training ground or mage tower).</div>}
          {stock.map((d) => (
            <div class="stock-row" key={d.id} {...tip(<TipCard icon={<Icon k={d.icon} size={36} />} title={d.name} sub={itemSummary(d)}>{d.description}</TipCard>, 'left')}>
              <Icon k={d.icon} size={32} />
              <span class="sr-name">{d.name}</span>
              <span class="sr-count">×{fs.stockpile[d.id]}</span>
            </div>
          ))}
          <div class="stock-hint t-dim">Unlocked by research: {TECH_LIST.filter((t) => t.unlocksItems?.length && !fs.techs.includes(t.id)).length} item techs remaining.</div>
        </div>
      </div>
    </Modal>
  );
}
