// Pause menu and end-of-game screen.
import { useState } from 'preact/hooks';
import type { FactionId } from '../../core/types';
import { FACTIONS } from '../../data/factions';
import { describeSave, type SaveMeta, type SaveSlot } from '../../game/session';
import { Btn } from '../common';
import { useUi } from '../ctx';
import { Emblem } from '../icons';
import { buildingsOwned, cls, plural, unitsOwned, viewerOf } from '../util';
import { useImage } from '../screens/Screens';
import { Modal } from './Modal';

/** One row per save slot, with its own Load button. */
function SaveSlots({ onLoad }: { onLoad: (slot: SaveSlot) => void }) {
  const { store } = useUi();
  const saves = store.ui.saves;
  const rows: { slot: SaveSlot; label: string; meta: SaveMeta | null }[] = [
    { slot: 'manual', label: 'Manual save', meta: saves.manual },
    { slot: 'auto', label: 'Autosave', meta: saves.auto },
  ];
  return (
    <div class="save-slots">
      {rows.map(({ slot, label, meta }) => (
        <div key={slot} class={cls('save-slot', !meta && 'empty')}>
          {meta ? <Emblem faction={meta.faction} size={26} /> : <span class="save-slot-blank" />}
          <span class="save-slot-main">
            <b>{slot === 'manual' && meta?.auto ? 'Earlier autosave' : label}</b>
            <small>{meta ? `${describeSave(meta)} · ${FACTIONS[meta.faction]?.name ?? meta.faction}` : slot === 'manual' ? 'Empty — Save game (Ctrl+S) writes here' : 'Empty — written at the start of each of your turns'}</small>
          </span>
          <Btn small primary={!!meta} disabled={!meta} reason={meta ? null : 'Nothing saved here'} onClick={() => onLoad(slot)}>Load</Btn>
        </div>
      ))}
    </div>
  );
}

export function MenuModal() {
  const { store } = useUi();
  const ui = store.ui;
  const [confirm, setConfirm] = useState<'quit' | 'load' | null>(null);
  const inGame = !!store.state && ui.screen === 'game';
  const [saved, setSaved] = useState(false);

  if (confirm === 'load') {
    return (
      <Modal size="sm" title="Load a saved game" onClose={() => setConfirm(null)} footer={<Btn onClick={() => setConfirm(null)}>Cancel</Btn>}>
        <SaveSlots onLoad={(slot) => {
          setConfirm(null);
          // A successful load closes this menu (and may open a pending level-up).
          if (!store.loadGame(slot)) store.toast('No saved game could be loaded', 'bad');
        }} />
        {inGame && <p class="confirm-text t-dim">The current game will be replaced.</p>}
      </Modal>
    );
  }

  if (confirm === 'quit') {
    return (
      <Modal size="sm" title="Quit to title?" onClose={() => setConfirm(null)}
        footer={<>
          <Btn onClick={() => setConfirm(null)}>Cancel</Btn>
          <Btn primary danger onClick={() => {
            setConfirm(null);
            // Quitting autosaves the game, even during the enemy turn (controller.quitToTitle).
            store.quitToTitle();
          }}>Quit</Btn>
        </>}>
        <p class="confirm-text">{store.state?.gameOver ? 'The war is over; the finished game is not kept.'
          : 'Your game will be saved; you can continue it from the title screen.'}</p>
      </Modal>
    );
  }

  const saveLabel = saved && ui.saves.manual ? `Saved (round ${ui.saves.manual.round})` : 'Save game';
  return (
    <Modal size="sm" class="menu-modal" title="Aether & Iron" sub={inGame && store.state ? `Round ${store.state.round}` : undefined} onClose={() => store.closeModal()}>
      <div class="menu-list">
        <Btn primary onClick={() => store.closeModal()} hotkey="Esc">Resume</Btn>
        {inGame && store.state?.gameOver && <Btn icon="star" onClick={() => store.openModal('end')}>Results</Btn>}
        {inGame && <Btn icon="check" onClick={() => { store.saveGame(); setSaved(true); }} disabled={!!store.state?.gameOver} reason={store.state?.gameOver ? 'The game is over' : null}>{saveLabel}</Btn>}
        <Btn icon="upgrade" disabled={!ui.hasSave} reason={!ui.hasSave ? 'No saved game' : null} onClick={() => setConfirm('load')}>Load game</Btn>
        <Btn icon="menu" onClick={() => store.openModal('settings')}>Settings</Btn>
        <Btn icon="help" onClick={() => store.openModal('help')} hotkey="H">Help</Btn>
        {inGame && <Btn danger icon="castle" onClick={() => setConfirm('quit')}>Quit to title</Btn>}
      </div>
    </Modal>
  );
}

export function EndModal() {
  const { store } = useUi();
  const s = store.state;
  const ui = store.ui;
  const viewer = s ? viewerOf(s) : 'valen';
  const won = !!s && s.winner === viewer;
  const art = useImage(won ? '/assets/ui/victory.jpg' : '/assets/ui/defeat.jpg');
  const [loadOpen, setLoadOpen] = useState(false);
  if (!s) return null;
  const winner = s.winner ? FACTIONS[s.winner] : null;
  const slayer = s.factions[viewer]?.eliminatedBy ?? null;
  const rows: FactionId[] = [...s.turnOrder];
  const fell = slayer && slayer !== 'neutral' ? `Your leader was slain by ${FACTIONS[slayer].name} in round ${s.round}.`
    : slayer === 'neutral' ? `Your leader fell to the beasts of the wilds in round ${s.round}.`
      : `Your leader fell in round ${s.round}.`;
  return (
    <div class={cls('end-screen', won ? 'victory' : 'defeat')}>
      <div class="end-art" style={art ? { backgroundImage: `url(${art})` } : undefined} />
      <div class="end-vignette" />
      <div class="end-content">
        <div class="end-kicker">{won ? 'The realm is yours' : 'Your house has fallen'}</div>
        <h1 class="end-title">{won ? 'Victory' : 'Defeat'}</h1>
        <div class="end-sub">
          {won ? `Every rival leader has been slain after ${plural(s.round, 'round')}.`
            : <>{fell}{winner ? ` ${winner.name} stands alone.` : ''}</>}
        </div>
        <table class="end-table">
          <thead>
            <tr><th>Faction</th><th>Status</th><th>Kills</th><th>Losses</th><th>Built</th><th>Techs</th><th>Spells</th><th>Army</th><th>Holdings</th></tr>
          </thead>
          <tbody>
            {rows.map((f) => {
              const fs = s.factions[f];
              const fd = FACTIONS[f];
              if (!fs) return null;
              const status = s.winner === f ? 'Victorious' : !won && f === slayer ? 'Slew your leader' : fs.alive ? 'Survived' : 'Eliminated';
              return (
                <tr key={f} class={cls(f === viewer && 'me', !fs.alive && 'dead')} style={{ '--fc': fd.color } as Record<string, string>}>
                  <td class="et-faction"><Emblem faction={f} size={22} /><span>{fd.name}{f === viewer ? ' (you)' : ''}</span></td>
                  <td class={s.winner === f ? 't-gold' : fs.alive && !(!won && f === slayer) ? '' : 't-bad'}
                    title={!fs.alive && fs.eliminatedBy ? `Destroyed by ${FACTIONS[fs.eliminatedBy].name}` : undefined}>{status}</td>
                  <td>{fs.stats.kills}</td>
                  <td>{fs.stats.lost}</td>
                  <td>{fs.stats.built}</td>
                  <td>{fs.techs.length}</td>
                  <td>{fs.stats.spellsCast}</td>
                  <td>{unitsOwned(s, f).length}</td>
                  <td>{buildingsOwned(s, f).length}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <div class="end-actions">
          <Btn onClick={() => store.closeModal()} icon="eye">View the map</Btn>
          {!won && ui.saves.auto && (
            <Btn primary icon="upgrade" onClick={() => store.retryLastTurn()}
              title="Play your last turn again from its start (the same moves meet the same dice)">Retry last turn</Btn>
          )}
          {!won && ui.hasSave && <Btn icon="upgrade" onClick={() => setLoadOpen(!loadOpen)}>Load a save</Btn>}
          <Btn primary={won || !ui.saves.auto} onClick={() => { store.quitToTitle(); store.openModal('newgame'); }} icon="star">New game</Btn>
          <Btn onClick={() => store.quitToTitle()} icon="castle">Title screen</Btn>
        </div>
        {loadOpen && !won && <div class="end-load"><SaveSlots onLoad={(slot) => { if (!store.loadGame(slot)) store.toast('No saved game could be loaded', 'bad'); }} /></div>}
      </div>
    </div>
  );
}
