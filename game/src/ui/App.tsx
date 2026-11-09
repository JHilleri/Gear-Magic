// Root of the Preact DOM overlay.
import { render } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import type { GameStore, ModalId } from '../game/store';
import type { AssetLibrary } from '../render/types';
import { FACTIONS } from '../data/factions';
import { Ctx, useUi } from './ctx';
import { AiIndicator, EffectPreviewTooltip, EndTurnBox, EventLog, ForecastTooltip, HoverChip, installPointerTracking, ModeHint, NoticeBanner, Toasts, TurnBanner } from './hud/Overlays';
import { Minimap } from './hud/Minimap';
import { TilePanel } from './hud/TilePanel';
import { TopBar } from './hud/TopBar';
import { UnitPanel } from './hud/UnitPanel';
import { CommandBar } from './hud/CommandBar';
import { BuildModal } from './modals/Build';
import { EquipModal } from './modals/Equip';
import { ForgeModal } from './modals/Forge';
import { HelpModal } from './modals/Help';
import { LevelUpModal } from './modals/LevelUp';
import { EndModal, MenuModal } from './modals/Menu';
import { RecruitModal } from './modals/Recruit';
import { ResearchModal } from './modals/Research';
import { SettingsModal } from './modals/Settings';
import { SpellbookModal } from './modals/Spellbook';
import { UnitSheetModal } from './modals/UnitSheet';
import { LoadingScreen, NewGameModal, TitleScreen, useImage } from './screens/Screens';
import { hideTip, TooltipLayer } from './tooltip';
import { assetUrl, cls, viewerOf } from './util';
import './styles.css';

/** Modals that need a running game. */
const GAME_MODALS = new Set<ModalId>(['research', 'spellbook', 'forge', 'recruit', 'levelup', 'equip', 'build', 'end', 'unitsheet']);

function ModalHost() {
  const { store } = useUi();
  const m = store.ui.modal;
  if (!m) return null;
  if (GAME_MODALS.has(m) && !store.state) return null;
  switch (m) {
    case 'menu': return <MenuModal />;
    case 'newgame': return <NewGameModal />;
    case 'research': return <ResearchModal />;
    case 'spellbook': return <SpellbookModal />;
    case 'forge': return <ForgeModal />;
    case 'recruit': return <RecruitModal />;
    case 'levelup': return <LevelUpModal />;
    case 'equip': return <EquipModal />;
    case 'build': return <BuildModal />;
    case 'help': return <HelpModal />;
    case 'settings': return <SettingsModal />;
    case 'end': return <EndModal />;
    case 'unitsheet': return <UnitSheetModal />;
    default: return null;
  }
}

function Hud() {
  const { store } = useUi();
  const s = store.state;
  if (!s) return null;
  const busy = store.ui.busy;
  return (
    <div class={cls('hud', busy && 'busy')}>
      <TopBar />
      <div class="hud-left">
        <UnitPanel />
      </div>
      <div class="hud-right">
        <TilePanel />
      </div>
      <EventLog />
      <CommandBar />
      <div class="hud-br">
        <EndTurnBox />
        <Minimap />
      </div>
      <ModeHint />
      <AiIndicator />
      <TurnBanner />
      <NoticeBanner />
      <ForecastTooltip />
      <EffectPreviewTooltip />
      <HoverChip />
    </div>
  );
}

function App({ store }: { store: GameStore }) {
  const [, setTick] = useState(0);
  const ui = store.ui;

  // Re-render on store changes, coalesced to one render per animation frame. The timeout
  // fallback keeps the DOM current while the tab is hidden (rAF is paused there).
  useEffect(() => {
    let raf = 0, timer = 0, pending = false;
    const flush = () => {
      if (!pending) return;
      pending = false;
      cancelAnimationFrame(raf);
      window.clearTimeout(timer);
      setTick((t) => t + 1);
    };
    const un = store.subscribe(() => {
      if (pending) return;
      pending = true;
      raf = requestAnimationFrame(flush);
      timer = window.setTimeout(flush, 60);
    });
    return () => { un(); cancelAnimationFrame(raf); window.clearTimeout(timer); };
  }, [store]);

  useEffect(() => installPointerTracking(), []);

  // Esc closes the open modal here (capture phase, so the controller does not also treat
  // the same key press as "open menu"). The end screen is not dismissed by Esc.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.repeat) return;
      const m = store.ui.modal;
      if (!m || m === 'end') return;
      e.preventDefault();
      e.stopImmediatePropagation();
      hideTip();
      store.closeModal();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [store]);

  // Hide hover tooltips whenever the modal changes (anchors vanish mid-hover).
  useEffect(() => { hideTip(); }, [ui.modal, ui.screen]);

  // Parchment texture for modal sheets; the CSS gradient stands in until (or unless) it loads.
  const parchment = useImage(assetUrl('ui/parchment.jpg'));
  const s = store.state;
  const player = s ? FACTIONS[viewerOf(s)] : null;
  const vars: Record<string, string> = {};
  if (parchment) vars['--parchment-img'] = `url(${parchment})`;
  if (player) { vars['--player'] = player.color; vars['--player-accent'] = player.accent; }
  return (
    <div class={cls('ui-root', `screen-${ui.screen}`, ui.modal && 'has-modal', parchment && 'has-parchment')} style={vars}>
      {ui.screen === 'loading' && <LoadingScreen />}
      {ui.screen === 'title' && <TitleScreen />}
      {ui.screen === 'game' && <Hud />}
      <ModalHost />
      <Toasts />
      <TooltipLayer />
    </div>
  );
}

export function mountUi(root: HTMLElement, store: GameStore, assets: () => AssetLibrary | null): void {
  root.classList.add('ui-mount');
  render(
    <Ctx.Provider value={{ store, assets }}>
      <App store={store} />
    </Ctx.Provider>,
    root,
  );
}
