// DOM input → controller: pointer hover/click on the map (with click-vs-drag detection),
// keyboard shortcuts (DESIGN §10), camera keys fed to renderer.keyState, edge panning, and
// automatic UI button sounds.
import type { GameController } from './controller';
import { CAMERA_CODES, cameraKeyNames, edgePanKeys, isClickGesture, isTypingTarget, keyToCommand } from './interaction';
import { playSfx } from '../audio/sfx';

const DRAG_THRESHOLD = 6;
/** How often (ms) the hover hex is re-picked when the camera moved under a still pointer. */
const CAMERA_POLL_MS = 100;

/**
 * Is the element under the pointer "the map"? True for the canvas itself and for
 * transparent full-viewport containers of the HUD (so a pass-through UI wrapper does not
 * swallow map input). Panels, modals and anything with a background are UI.
 */
function makeMapTargetTest(canvas: HTMLCanvasElement): (el: EventTarget | null) => boolean {
  const cache = new WeakMap<Element, { at: number; map: boolean }>();
  return (target) => {
    if (target === canvas) return true;
    if (!(target instanceof Element)) return false;
    const now = performance.now();
    const hit = cache.get(target);
    if (hit && now - hit.at < 500) return hit.map;
    let map = false;
    if (target.id === 'ui-root' || target.id === 'game-root') map = true;
    else if (target instanceof HTMLElement && !isTypingTarget(target) && !target.closest('button, a, input, select, textarea, [role="button"], [role="dialog"]')) {
      const r = target.getBoundingClientRect();
      if (r.width >= window.innerWidth * 0.95 && r.height >= window.innerHeight * 0.95) {
        const cs = getComputedStyle(target);
        const transparentBg = cs.backgroundImage === 'none' &&
          (cs.backgroundColor === 'transparent' || /^rgba\(\s*0,\s*0,\s*0,\s*0\s*\)$/.test(cs.backgroundColor));
        map = transparentBg && !cs.backdropFilter?.includes('blur');
      }
    }
    cache.set(target, { at: now, map });
    return map;
  };
}

export function attachInput(canvas: HTMLCanvasElement, ctl: GameController): () => void {
  const isMap = makeMapTargetTest(canvas);
  const keys = ctl.renderer.keyState;
  /** Names each physical key added to keyState (removed again on keyup). */
  const held = new Map<string, string[]>();
  let edgeKeys: string[] = [];
  let down: { id: number; x: number; y: number; button: number; dragged: boolean } | null = null;
  let pendingMove: { x: number; y: number; map: boolean } | null = null;
  let moveRaf = 0;
  /** Last pointer position on the map, and the camera it was picked under. */
  let lastPointer: { x: number; y: number; map: boolean } | null = null;
  let camSig = '';
  let lastHoverButton: Element | null = null;

  const inGame = () => ctl.ui.screen === 'game' && !!ctl.state;
  const nativeEdgePan = 'edgePan' in ctl.renderer;
  const rendererDragging = () => !!(ctl.renderer as { isDragging?: boolean }).isDragging;

  const isHeldByKeyboard = (name: string) => {
    for (const names of held.values()) if (names.includes(name)) return true;
    return false;
  };

  const setEdge = (next: string[]) => {
    for (const k of edgeKeys) if (!next.includes(k) && !isHeldByKeyboard(k)) keys.delete(k);
    for (const k of next) keys.add(k);
    edgeKeys = next;
  };

  const releaseAll = () => {
    for (const names of held.values()) for (const n of names) keys.delete(n);
    held.clear();
    setEdge([]);
    keys.clear();
    ctl.setShift(false);
  };

  /** Screen positions of two fixed hexes: changes whenever the camera pans, rotates or zooms. */
  const cameraSignature = (): string => {
    try {
      const a = ctl.renderer.hexToScreen({ q: 0, r: 0 });
      const b = ctl.renderer.hexToScreen({ q: 2, r: 4 });
      return `${Math.round(a.x * 2)},${Math.round(a.y * 2)},${Math.round(b.x * 2)},${Math.round(b.y * 2)}`;
    } catch {
      return '';
    }
  };

  // ── pointer ──
  const processMove = () => {
    moveRaf = 0;
    const m = pendingMove;
    pendingMove = null;
    if (!m) return;
    lastPointer = m;
    if (!inGame()) { ctl.hover(null); return; }
    if (!m.map) { ctl.hover(null); return; }
    let h = null;
    try { h = ctl.renderer.pickHex(m.x, m.y); } catch { h = null; }
    camSig = cameraSignature();
    ctl.hover(h);
  };

  // Keys, edge pan, minimap jumps and focus glides move the camera without a pointermove: keep
  // the hover hex (outline, path preview, forecast) under the cursor. Skipped while busy or under
  // a window, as the controller ignores hover then; the change is picked up afterwards.
  const cameraPoll = window.setInterval(() => {
    const m = lastPointer;
    if (!m || !m.map || moveRaf || !inGame() || ctl.ui.busy || ctl.ui.modal || document.hidden || down?.dragged) return;
    const sig = cameraSignature();
    if (!sig || sig === camSig) return;
    camSig = sig;
    let h = null;
    try { h = ctl.renderer.pickHex(m.x, m.y); } catch { h = null; }
    ctl.hover(h);
  }, CAMERA_POLL_MS);

  const onPointerMove = (e: PointerEvent) => {
    if (down && e.pointerId === down.id && !down.dragged && !isClickGesture(e.clientX - down.x, e.clientY - down.y, DRAG_THRESHOLD)) {
      down.dragged = true;
    }
    pendingMove = { x: e.clientX, y: e.clientY, map: isMap(e.target) };
    if (!moveRaf) moveRaf = requestAnimationFrame(processMove);
    // Edge panning (only with a mouse; touch has no hover). The renderer's camera does it
    // natively when it exposes `edgePan` (the controller forwards the setting).
    if (!nativeEdgePan && e.pointerType === 'mouse' && ctl.ui.settings.edgePan && inGame() && !ctl.ui.modal && document.hasFocus()) {
      setEdge(edgePanKeys(e.clientX, e.clientY, window.innerWidth, window.innerHeight));
    } else if (edgeKeys.length) {
      setEdge([]);
    }
  };

  const onPointerDown = (e: PointerEvent) => {
    if (!isMap(e.target)) { down = null; return; }
    down = { id: e.pointerId, x: e.clientX, y: e.clientY, button: e.button, dragged: false };
  };

  const onPointerUp = (e: PointerEvent) => {
    const d = down;
    down = null;
    if (!d || d.id !== e.pointerId || d.button !== e.button || d.dragged || rendererDragging()) return;
    if (!isClickGesture(e.clientX - d.x, e.clientY - d.y, DRAG_THRESHOLD)) return;
    if (!isMap(e.target) || !inGame()) return;
    if (e.button !== 0 && e.button !== 2) return; // middle button = camera only
    let h = null;
    try { h = ctl.renderer.pickHex(e.clientX, e.clientY); } catch { h = null; }
    ctl.click(h, e.button === 2 ? 'right' : 'left');
  };

  const onPointerCancel = () => { down = null; };

  const onContextMenu = (e: MouseEvent) => {
    if (isTypingTarget(e.target as HTMLElement | null)) return;
    e.preventDefault();
  };

  const onMouseOut = (e: MouseEvent) => {
    if (e.relatedTarget === null) { // left the window
      setEdge([]);
      lastPointer = null;
      ctl.hover(null);
    }
  };

  // ── keyboard ──
  const onKeyDown = (e: KeyboardEvent) => {
    const target = e.target as HTMLElement | null;
    if (isTypingTarget(target)) return;
    if (e.key === 'Shift') ctl.setShift(true);

    if (CAMERA_CODES.has(e.code) && !e.ctrlKey && !e.metaKey && !e.altKey) {
      if (inGame() && !ctl.ui.modal) {
        const names = cameraKeyNames(e);
        for (const n of names) keys.add(n);
        held.set(e.code, names);
        if (e.code.startsWith('Arrow') || e.code.startsWith('Page')) e.preventDefault();
      }
      return;
    }

    // Tab inside an open window moves keyboard focus between its buttons.
    if (e.code === 'Tab' && ctl.ui.modal) return;
    const cmd = keyToCommand(e);
    if (!cmd) {
      if (e.repeat && e.code === 'Tab') e.preventDefault(); // a held Tab must not wander into browser chrome
      return;
    }
    // Let focused buttons handle their own activation keys.
    if ((e.code === 'Space' || e.code === 'Enter' || e.code === 'NumpadEnter') && target && target.closest('button, a, [role="button"]')) return;
    if (cmd === 'endTurn' || cmd === 'nextUnit' || cmd === 'debug' || cmd === 'save' || cmd === 'help') e.preventDefault();
    ctl.command(cmd);
  };

  const onKeyUp = (e: KeyboardEvent) => {
    if (e.key === 'Shift') ctl.setShift(false);
    const names = held.get(e.code);
    if (names) {
      held.delete(e.code);
      for (const n of names) if (!edgeKeys.includes(n)) keys.delete(n);
    }
  };

  const onBlur = () => releaseAll();
  const onVisibility = () => { if (document.hidden) releaseAll(); };

  // ── UI sounds: every button click / hover gets feedback without the UI wiring it ──
  const onDocClick = (e: MouseEvent) => {
    const el = (e.target as Element | null)?.closest?.('button, [role="button"], a');
    if (el && !(el as HTMLButtonElement).disabled && el.getAttribute('aria-disabled') !== 'true') playSfx('click');
    // Mouse clicks must not leave focus on the button, or Space would re-press it instead of
    // ending the turn. Keyboard activation (detail 0) keeps focus for accessibility.
    if (el instanceof HTMLElement && e.detail > 0) setTimeout(() => { if (document.activeElement === el) el.blur(); }, 0);
  };
  const onDocOver = (e: PointerEvent) => {
    if (e.pointerType !== 'mouse') return;
    const el = (e.target as Element | null)?.closest?.('button, [role="button"]') ?? null;
    if (el === lastHoverButton) return;
    lastHoverButton = el;
    if (el && !(el as HTMLButtonElement).disabled) playSfx('hover');
  };

  window.addEventListener('pointermove', onPointerMove, { passive: true });
  window.addEventListener('pointerdown', onPointerDown, { passive: true });
  window.addEventListener('pointerup', onPointerUp, { passive: true });
  window.addEventListener('pointercancel', onPointerCancel, { passive: true });
  window.addEventListener('contextmenu', onContextMenu);
  document.addEventListener('mouseout', onMouseOut);
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('blur', onBlur);
  document.addEventListener('visibilitychange', onVisibility);
  document.addEventListener('click', onDocClick, true);
  document.addEventListener('pointerover', onDocOver, { passive: true });

  return () => {
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerdown', onPointerDown);
    window.removeEventListener('pointerup', onPointerUp);
    window.removeEventListener('pointercancel', onPointerCancel);
    window.removeEventListener('contextmenu', onContextMenu);
    document.removeEventListener('mouseout', onMouseOut);
    window.removeEventListener('keydown', onKeyDown);
    window.removeEventListener('keyup', onKeyUp);
    window.removeEventListener('blur', onBlur);
    document.removeEventListener('visibilitychange', onVisibility);
    document.removeEventListener('click', onDocClick, true);
    document.removeEventListener('pointerover', onDocOver);
    if (moveRaf) cancelAnimationFrame(moveRaf);
    window.clearInterval(cameraPoll);
    releaseAll();
  };
}
