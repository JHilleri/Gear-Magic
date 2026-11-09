// Modal shell: dimmed backdrop, parchment sheet with ornate frame, header and optional footer.
import type { ComponentChildren } from 'preact';
import { useEffect, useRef } from 'preact/hooks';
import { cls } from '../util';

export function Modal({ title, sub, icon, onClose, children, footer, size = 'md', parchment = true, class: klass, closable = true }: {
  title: ComponentChildren; sub?: ComponentChildren; icon?: ComponentChildren; onClose?: () => void; children: ComponentChildren;
  footer?: ComponentChildren; size?: 'sm' | 'md' | 'lg' | 'xl'; parchment?: boolean; class?: string; closable?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  // Focus the sheet so keyboard users land inside it (and Space doesn't end the turn).
  useEffect(() => { ref.current?.focus({ preventScroll: true }); }, []);
  return (
    <div class="modal-backdrop" onMouseDown={(e) => { if (closable && onClose && e.target === e.currentTarget) onClose(); }}>
      <div ref={ref} tabIndex={-1} class={cls('modal', `modal-${size}`, parchment ? 'parchment' : 'iron', klass)} role="dialog" aria-modal="true">
        <div class="modal-frame" aria-hidden="true"><i /><i /><i /><i /></div>
        <div class="modal-head">
          {icon && <span class="modal-icon">{icon}</span>}
          <div class="modal-titles">
            <h2>{title}</h2>
            {sub && <div class="modal-sub">{sub}</div>}
          </div>
          {closable && onClose && <button type="button" class="modal-close" onClick={onClose} aria-label="Close">×</button>}
        </div>
        <div class="modal-body">{children}</div>
        {footer && <div class="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}
