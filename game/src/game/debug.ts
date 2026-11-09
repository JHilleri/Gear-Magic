// F1 debug overlay: FPS / frame time, game counters, hovered tile info and a reveal-map toggle.
// Plain DOM (independent of the Preact UI) so it keeps working even if the UI breaks.
import type { GameState, Hex } from '../core/types';
import { tileIndex, inBounds } from '../core/hex';
import type { GameController } from './controller';

export interface DebugOverlay {
  toggle(): void;
  setHover(state: GameState | null, h: Hex | null): void;
}

export function createDebugOverlay(ctl: GameController): DebugOverlay {
  const el = document.createElement('div');
  el.setAttribute('data-debug-overlay', '');
  Object.assign(el.style, {
    position: 'fixed', left: '50%', bottom: '10px', transform: 'translateX(-50%)', zIndex: '9998', minWidth: '260px',
    padding: '8px 10px', borderRadius: '6px', background: 'rgba(8,10,14,0.82)', color: '#cfe3c8',
    font: '12px/1.45 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', pointerEvents: 'auto',
    border: '1px solid rgba(160,200,140,0.35)', boxShadow: '0 4px 18px rgba(0,0,0,0.45)', display: 'none',
    whiteSpace: 'pre', userSelect: 'none',
  } as Partial<CSSStyleDeclaration>);
  const stats = document.createElement('div');
  const hoverEl = document.createElement('div');
  hoverEl.style.color = '#9fb7d8';
  const label = document.createElement('label');
  Object.assign(label.style, { display: 'flex', gap: '6px', alignItems: 'center', marginTop: '6px', cursor: 'pointer', whiteSpace: 'normal' });
  const box = document.createElement('input');
  box.type = 'checkbox';
  box.addEventListener('change', () => ctl.setRevealMap(box.checked));
  label.append(box, document.createTextNode('Reveal map (fog off)'));
  el.append(stats, hoverEl, label);
  document.body.appendChild(el);

  let visible = false;
  let raf = 0;
  let frames = 0;
  let last = performance.now();
  let worst = 0;
  let prev = last;

  const loop = (now: number) => {
    frames++;
    worst = Math.max(worst, now - prev);
    prev = now;
    if (now - last >= 500) {
      const fps = (frames * 1000) / (now - last);
      const s = ctl.state;
      const lines = [`FPS ${fps.toFixed(0).padStart(3)}  avg ${(1000 / fps).toFixed(1)}ms  worst ${worst.toFixed(1)}ms`];
      if (s) {
        const cur = s.turnOrder[s.currentTurn];
        lines.push(`Round ${s.round} · turn: ${cur}${ctl.ui.busy ? ' · busy' : ''}${ctl.ui.aiThinking ? ` · AI ${ctl.ui.aiThinking}` : ''}`);
        lines.push(`Units ${Object.keys(s.units).length} · Buildings ${Object.keys(s.buildings).length} · seed ${s.settings.seed}`);
        lines.push(`Mode ${ctl.ui.mode.kind} · reach ${ctl.ui.reach.length}`);
      } else {
        lines.push(`Screen ${ctl.ui.screen}`);
      }
      stats.textContent = lines.join('\n');
      frames = 0;
      worst = 0;
      last = now;
    }
    raf = requestAnimationFrame(loop);
  };

  return {
    toggle() {
      visible = !visible;
      el.style.display = visible ? 'block' : 'none';
      box.checked = ctl.revealMap;
      if (visible) { last = performance.now(); prev = last; frames = 0; raf = requestAnimationFrame(loop); }
      else cancelAnimationFrame(raf);
    },
    setHover(state, h) {
      if (!visible) return;
      if (!state || !h || !inBounds(h, state.width, state.height)) { hoverEl.textContent = ''; return; }
      const t = state.tiles[tileIndex(h, state.width)];
      const u = Object.values(state.units).find((x) => x.pos.q === h.q && x.pos.r === h.r);
      const b = t.building !== null ? state.buildings[String(t.building)] : undefined;
      hoverEl.textContent = `Hex ${h.q},${h.r}  ${t.terrain}${t.deposit ? ` (${t.deposit})` : ''}` +
        (b ? `\n${b.type} L${b.level} owner ${b.owner ?? '—'}${b.buildLeft ? ` build ${b.buildLeft}` : ''}` : '') +
        (u ? `\n#${u.id} ${u.name} [${u.faction}] hp ${u.hp} mp ${u.mp}${u.acted ? ' acted' : ''}` : '');
    },
  };
}
