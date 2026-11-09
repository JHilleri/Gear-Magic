// Small building blocks shared by panels and modals.
import type { ComponentChildren } from 'preact';
import type { ResourceCost, ResourceId, Resources } from '../core/types';
import { ResIcon, Sym } from './icons';
import { tip, type TipContent } from './tooltip';
import { cls, costEntries, fmt, RESOURCE_NAMES, signed } from './util';

export function Kbd({ k }: { k: string }) {
  return <kbd class="kbd">{k}</kbd>;
}

/** Resource cost chips; amounts the faction cannot afford are flagged red. */
export function Cost({ cost, have, mult = 1, empty = 'Free', compact }: { cost: ResourceCost; have?: Resources; mult?: number; empty?: string; compact?: boolean }) {
  const entries = costEntries(cost);
  if (entries.length === 0) return <span class="cost cost-free">{empty}</span>;
  return (
    <span class={cls('cost', compact && 'compact')}>
      {entries.map(([r, n]) => {
        const amount = n * mult;
        const short = have ? (have[r] ?? 0) < amount - 1e-9 : false;
        return (
          <span class={cls('cost-chip', short && 'short')} key={r} {...tip(`${fmt(amount)} ${RESOURCE_NAMES[r]}${short ? ` (you have ${fmt(have![r] ?? 0)})` : ''}`)}>
            <ResIcon r={r} size={16} />
            <b>{fmt(amount)}</b>
          </span>
        );
      })}
    </span>
  );
}

/** Per-turn output chips (+3 food). */
export function Output({ out, empty = '—' }: { out: ResourceCost; empty?: string }) {
  const entries = costEntries(out);
  if (entries.length === 0) return <span class="output output-none">{empty}</span>;
  return (
    <span class="output">
      {entries.map(([r, n]) => (
        <span class={cls('cost-chip', n < 0 ? 'neg' : 'pos')} key={r} {...tip(`${signed(n)} ${RESOURCE_NAMES[r]} per turn`)}>
          <ResIcon r={r} size={16} />
          <b>{signed(n)}</b>
        </span>
      ))}
    </span>
  );
}

export function Bar({ value, max, kind, label, children, tipContent }: {
  value: number; max: number; kind: 'hp' | 'xp' | 'mana' | 'build' | 'research'; label?: string; children?: ComponentChildren; tipContent?: TipContent;
}) {
  const frac = max > 0 ? Math.max(0, Math.min(1, value / max)) : 0;
  const hpTone = kind === 'hp' ? (frac > 0.6 ? 'good' : frac > 0.3 ? 'mid' : 'low') : '';
  return (
    <div class={cls('bar', `bar-${kind}`, hpTone)} {...tip(tipContent)}>
      <div class="bar-track">
        {children ?? <div class="bar-fill" style={{ width: `${frac * 100}%` }} />}
      </div>
      {label != null && <span class="bar-label">{label}</span>}
    </div>
  );
}

export function Btn({ children, onClick, disabled, primary, danger, small, title, reason, detail, hotkey, class: klass, glow, icon }: {
  children?: ComponentChildren; onClick?: () => void; disabled?: boolean; primary?: boolean; danger?: boolean; small?: boolean;
  /** Tooltip: `title`, then optional `detail` content, then `reason` (why it is disabled) in red. */
  title?: string; reason?: string | null; detail?: ComponentChildren; hotkey?: string; class?: string; glow?: boolean; icon?: string;
}) {
  const tipText: TipContent | null = reason || detail
    ? <span><b>{title ?? ''}</b>{detail}{reason ? <>{title && !detail ? <br /> : null}<span class="t-bad">{reason}</span></> : null}</span>
    : title ?? null;
  return (
    // No native `disabled`: disabled controls swallow hover events and the tooltip explaining
    // *why* the action is unavailable would never show.
    <button
      type="button"
      class={cls('btn', primary && 'btn-primary', danger && 'btn-danger', small && 'btn-small', glow && 'btn-glow', disabled && 'is-disabled', klass)}
      aria-disabled={disabled}
      onClick={disabled ? undefined : onClick}
      {...tip(tipText)}
    >
      {icon && <Sym name={icon} />}
      {children && <span class="btn-text">{children}</span>}
      {hotkey && <Kbd k={hotkey} />}
    </button>
  );
}

export function SectionTitle({ children, right }: { children: ComponentChildren; right?: ComponentChildren }) {
  return (
    <div class="section-title">
      <span class="section-rule" />
      <span class="section-text">{children}</span>
      <span class="section-rule" />
      {right && <span class="section-right">{right}</span>}
    </div>
  );
}

/** A tooltip body with a title line, optional subtitle and free content. */
export function TipCard({ title, sub, children, icon }: { title: ComponentChildren; sub?: ComponentChildren; children?: ComponentChildren; icon?: ComponentChildren }) {
  return (
    <div class="tipcard">
      <div class="tipcard-head">
        {icon}
        <div>
          <div class="tipcard-title">{title}</div>
          {sub && <div class="tipcard-sub">{sub}</div>}
        </div>
      </div>
      {children && <div class="tipcard-body">{children}</div>}
    </div>
  );
}

export function resourceTitle(r: ResourceId): string {
  return RESOURCE_NAMES[r];
}

/** Segmented control (radio buttons). */
export function Segmented<T extends string | number>({ value, options, onChange }: { value: T; options: { value: T; label: ComponentChildren; hint?: string }[]; onChange: (v: T) => void }) {
  return (
    <div class="segmented" role="radiogroup">
      {options.map((o) => (
        <button type="button" role="radio" aria-checked={o.value === value} key={String(o.value)}
          class={cls('seg', o.value === value && 'on')} onClick={() => onChange(o.value)} {...tip(o.hint)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Toggle({ value, onChange, label }: { value: boolean; onChange: (v: boolean) => void; label?: string }) {
  return (
    <button type="button" role="switch" aria-checked={value} aria-label={label} class={cls('toggle', value && 'on')} onClick={() => onChange(!value)}>
      <span class="toggle-knob" />
    </button>
  );
}

/** Stops game hotkeys (Space, Tab, letters) from firing while typing in a field. */
export const stopKeys = {
  onKeyDown: (e: KeyboardEvent) => { if (e.key !== 'Escape') e.stopPropagation(); },
  onKeyUp: (e: KeyboardEvent) => { if (e.key !== 'Escape') e.stopPropagation(); },
};
