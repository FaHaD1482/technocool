'use client';

import { useEffect, useRef, type ReactNode, type RefObject } from 'react';

const FOCUSABLE = [
  'a[href]', 'button:not([disabled])', 'input:not([disabled])', 'select:not([disabled])',
  'textarea:not([disabled])', '[tabindex]:not([tabindex="-1"])',
].join(',');

/**
 * Keyboard and focus behaviour for an overlay: focus moves in, Tab cycles inside, Escape closes,
 * focus returns to the element that opened it, and the page behind does not scroll.
 *
 * `busy` is read through a ref so a long-running action cannot be closed by a stale Escape handler.
 */
export function useFocusTrap(ref: RefObject<HTMLElement | null>, opts: { onClose: () => void; busy?: boolean }) {
  const busy = useRef(opts.busy);
  busy.current = opts.busy;
  const onClose = useRef(opts.onClose);
  onClose.current = opts.onClose;

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const node = ref.current;
    const focusables = () => Array.from(node?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])
      .filter((el) => el.offsetParent !== null || el === document.activeElement);

    (node?.querySelector<HTMLElement>('[data-autofocus]') ?? focusables()[0] ?? node)?.focus();

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (busy.current) return;
        e.stopPropagation();
        onClose.current();
        return;
      }
      if (e.key !== 'Tab' || !node) return;
      const items = focusables();
      if (items.length === 0) { e.preventDefault(); return; }
      const first = items[0];
      const last = items[items.length - 1];
      if (!first || !last) return;
      if (e.shiftKey && (document.activeElement === first || !node.contains(document.activeElement))) {
        e.preventDefault(); last.focus();
      } else if (!e.shiftKey && (document.activeElement === last || !node.contains(document.activeElement))) {
        e.preventDefault(); first.focus();
      }
    };

    document.addEventListener('keydown', onKey, true);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey, true);
      document.body.style.overflow = overflow;
      if (opener && document.contains(opener)) opener.focus();
    };
  }, [ref]);
}

interface DialogProps {
  /** id of the element that names the dialog (a heading inside it). */
  labelledBy?: string;
  /** Used when there is no visible heading. */
  label?: string;
  onClose: () => void;
  busy?: boolean;
  /** Max width in px for the centred variant. */
  width?: number;
  /** `sheet` slides a full-height panel from the right (used by the item editor). */
  variant?: 'center' | 'sheet';
  children: ReactNode;
}

/** The one modal implementation: scrim, escape, focus trap, focus restore. */
export function Dialog({ labelledBy, label, onClose, busy = false, width = 580, variant = 'center', children }: DialogProps) {
  const ref = useRef<HTMLDivElement>(null);
  useFocusTrap(ref, { onClose, busy });

  const a11y = { role: 'dialog' as const, 'aria-modal': true, ...(labelledBy ? { 'aria-labelledby': labelledBy } : { 'aria-label': label }) };
  const panel = variant === 'sheet' ? `dpanel` : `dialog`;
  const close = () => { if (!busy) onClose(); };

  return (
    <div className={variant === 'sheet' ? 'drawer' : 'modal'}>
      <div className="scrim" onClick={close} />
      <div ref={ref} className={panel} tabIndex={-1} {...a11y} style={variant === 'sheet' ? undefined : { width: `min(${width}px, 100%)` }}>
        {children}
      </div>
    </div>
  );
}
