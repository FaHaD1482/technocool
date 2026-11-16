'use client';

import { useCallback, useEffect, useState } from 'react';
import { useDismiss } from '@/components/editor/ui';
import { Icon, type IconName } from '@/components/ui/Icon';

type Mode = 'light' | 'dark' | 'system';

const KEY = 'hvac-theme';
const listeners = new Set<(m: Mode) => void>();

const isMode = (v: string | null): v is Mode => v === 'light' || v === 'dark' || v === 'system';

/** data-theme absent means "follow the operating system" (see globals.css). */
function apply(mode: Mode) {
  const el = document.documentElement;
  if (mode === 'system') delete el.dataset.theme;
  else el.dataset.theme = mode;
}

const OPTIONS = [
  { v: 'light', label: 'Light', icon: 'sun' },
  { v: 'dark', label: 'Dark', icon: 'moon' },
  { v: 'system', label: 'Match system', icon: 'monitor' },
] as const satisfies readonly { v: Mode; label: string; icon: IconName }[];
const SYSTEM = OPTIONS[2];

/** One icon button + a small menu, so three theme options fit on a phone without crowding the top bar. */
export function ThemeToggle() {
  const [mode, setMode] = useState<Mode>('system');
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const ref = useDismiss(open, close);

  useEffect(() => {
    const saved = localStorage.getItem(KEY);
    setMode(isMode(saved) ? saved : 'system');
    const fn = (m: Mode) => setMode(m);
    listeners.add(fn);
    return () => { listeners.delete(fn); };
  }, []);

  const choose = (m: Mode) => {
    try { localStorage.setItem(KEY, m); } catch { /* private mode */ }
    apply(m);
    listeners.forEach((fn) => fn(m));
    setOpen(false);
  };

  const current = OPTIONS.find((o) => o.v === mode) ?? SYSTEM;

  return (
    <div className="theme-menu" ref={ref}>
      <button className="ib theme-btn" type="button" aria-haspopup="menu" aria-expanded={open}
        aria-label={`Colour theme: ${current.label}`} title={`Colour theme: ${current.label}`}
        onClick={() => setOpen((o) => !o)}>
        <Icon name={current.icon} size={18} />
      </button>
      {open && (
        <div className="menu-list theme-list" role="menu" aria-label="Colour theme">
          {OPTIONS.map((o) => (
            <button key={o.v} type="button" role="menuitemradio" aria-checked={mode === o.v}
              className="theme-item" onClick={() => choose(o.v)}>
              <Icon name={o.icon} size={15} />
              <span>{o.label}</span>
              {mode === o.v && <Icon name="check" size={14} className="theme-check" />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
