// Settings: audio, display and pacing options (persisted by the store).
import { Segmented, stopKeys, Toggle } from '../common';
import { useUi } from '../ctx';
import { Sym } from '../icons';
import { Modal } from './Modal';

export function SettingsModal() {
  const { store } = useUi();
  const st = store.ui.settings;
  const set = store.setSetting.bind(store);
  return (
    <Modal size="sm" title="Settings" icon={<Sym name="menu" />} onClose={() => store.closeModal()}>
      <div class="settings">
        <div class="set-group">Audio</div>
        <label class="set-row">
          <span><b>Volume</b><small>Master volume for effects and music</small></span>
          <span class="set-ctl range">
            <input type="range" min={0} max={100} step={1} value={Math.round(st.volume * 100)} {...stopKeys}
              onInput={(e) => set('volume', Number((e.currentTarget as HTMLInputElement).value) / 100)} />
            <output>{Math.round(st.volume * 100)}%</output>
          </span>
        </label>
        <div class="set-row">
          <span><b>Ambient music</b><small>Generative background score</small></span>
          <Toggle value={st.music} onChange={(v) => set('music', v)} label="Ambient music" />
        </div>
        <div class="set-group">Display</div>
        <div class="set-row">
          <span><b>Hex grid</b><small>Show thin grid lines (G)</small></span>
          <Toggle value={st.showGrid} onChange={(v) => set('showGrid', v)} label="Hex grid" />
        </div>
        <div class="set-row">
          <span><b>Graphics quality</b><small>Shadows, post-processing and resolution</small></span>
          <Segmented value={st.quality} onChange={(v) => set('quality', v)}
            options={[{ value: 'low', label: 'Fast' }, { value: 'high', label: 'Beautiful' }]} />
        </div>
        <div class="set-group">Gameplay</div>
        <div class="set-row">
          <span><b>Animation speed</b><small>Movement, combat and enemy turns</small></span>
          <Segmented value={st.animSpeed} onChange={(v) => set('animSpeed', v)}
            options={[{ value: 1, label: '1×' }, { value: 2, label: '2×' }, { value: 4, label: '4×' }]} />
        </div>
        <div class="set-row">
          <span><b>Enemy turns</b><small>Nearby: skip distant enemy marches and fights off screen. Space fast-forwards either way.</small></span>
          <Segmented value={st.watchEnemyMoves} onChange={(v) => set('watchEnemyMoves', v)}
            options={[{ value: 'nearby', label: 'Nearby' }, { value: 'all', label: 'Watch all' }]} />
        </div>
        <div class="set-row">
          <span><b>Edge panning</b><small>Move the camera when the cursor touches the screen edge</small></span>
          <Toggle value={st.edgePan} onChange={(v) => set('edgePan', v)} label="Edge panning" />
        </div>
      </div>
    </Modal>
  );
}
