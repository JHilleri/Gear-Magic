// Global hover tooltip: any element spreads `{...tip(content)}`; one floating layer renders it,
// positioned next to the anchor and clamped to the viewport.
import type { ComponentChildren } from 'preact';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';

export type TipContent = ComponentChildren | (() => ComponentChildren);

interface TipState { content: TipContent; anchor: HTMLElement; side: 'auto' | 'right' | 'left' | 'top' | 'bottom' }

let current: TipState | null = null;
/** Tooltip waiting out the show delay (its content follows re-renders too). */
let pending: TipState | null = null;
let showTimer = 0;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((fn) => fn());

export function showTip(content: TipContent, anchor: HTMLElement, side: TipState['side'] = 'auto'): void {
  window.clearTimeout(showTimer);
  pending = { content, anchor, side };
  // Small delay avoids flicker when the pointer sweeps across a row of icons.
  showTimer = window.setTimeout(() => { current = pending; pending = null; emit(); }, current ? 0 : 90);
}
export function hideTip(): void {
  window.clearTimeout(showTimer);
  pending = null;
  if (current) { current = null; emit(); }
}

/**
 * The anchor re-rendered: a tooltip showing for it takes the new content (a button whose text
 * changes under a still cursor, e.g. End Turn → Enemy Turn), or goes when there is none now.
 */
function refreshFor(el: HTMLElement, content: TipContent | null, side: TipState['side']): void {
  if (current && current.anchor === el) {
    if (content == null) hideTip();
    else if (current.content !== content || current.side !== side) { current = { content, anchor: el, side }; emit(); }
  } else if (pending && pending.anchor === el) {
    if (content == null) hideTip();
    else pending = { content, anchor: el, side };
  }
}

/** Event handlers that attach a tooltip to any element. */
export function tip(content: TipContent | null | undefined | false, side: TipState['side'] = 'auto') {
  const c = content == null || content === false ? null : content;
  // A fresh ref callback runs on every render of the anchor (Preact calls it with null, then the element).
  const ref = (el: unknown) => { if (el instanceof HTMLElement) refreshFor(el, c, side); };
  if (c === null) return { ref };
  return {
    ref,
    onMouseEnter: (e: MouseEvent) => showTip(c, e.currentTarget as HTMLElement, side),
    onMouseLeave: hideTip,
  };
}

export function TooltipLayer() {
  const [, setTick] = useState(0);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const fn = () => setTick((t) => t + 1);
    listeners.add(fn);
    const hide = () => hideTip();
    window.addEventListener('blur', hide);
    return () => { listeners.delete(fn); window.removeEventListener('blur', hide); };
  }, []);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !current) return;
    const a = current.anchor.getBoundingClientRect();
    const t = el.getBoundingClientRect();
    const vw = window.innerWidth, vh = window.innerHeight, m = 8;
    const fits = {
      right: a.right + m + t.width < vw,
      left: a.left - m - t.width > 0,
      bottom: a.bottom + m + t.height < vh,
      top: a.top - m - t.height > 0,
    };
    let side = current.side;
    if (side === 'auto' || !fits[side]) side = fits.bottom ? 'bottom' : fits.top ? 'top' : fits.right ? 'right' : 'left';
    let x: number, y: number;
    if (side === 'bottom' || side === 'top') {
      x = a.left + a.width / 2 - t.width / 2;
      y = side === 'bottom' ? a.bottom + m : a.top - m - t.height;
    } else {
      x = side === 'right' ? a.right + m : a.left - m - t.width;
      y = a.top + a.height / 2 - t.height / 2;
    }
    x = Math.max(m, Math.min(vw - t.width - m, x));
    y = Math.max(m, Math.min(vh - t.height - m, y));
    el.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
    el.style.opacity = '1';
  });

  // The anchor may disappear without a mouseleave (panel re-render, modal closed).
  if (current && !current.anchor.isConnected) current = null;
  if (!current) return null;
  const c = current.content;
  return (
    <div class="tooltip" ref={ref} style={{ opacity: 0 }} role="tooltip">
      {typeof c === 'function' ? (c as () => ComponentChildren)() : c}
    </div>
  );
}
