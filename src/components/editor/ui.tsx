'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

export const ICON = {
  edit: <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M13.3 3.6a1.7 1.7 0 0 1 2.4 0l.7.7a1.7 1.7 0 0 1 0 2.4l-8.6 8.6-3.5.8.8-3.5z" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" /></svg>,
  remove: <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5.5 10h9" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /><circle cx="10" cy="10" r="7" fill="none" stroke="currentColor" strokeWidth="1.5" /></svg>,
  del: <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 6h12M8 6V4.5h4V6M6 6l.8 10h6.4L14 6M8.6 9v4.5M11.4 9v4.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>,
};

/** Accept only digits and one dot while typing (commas and spaces are dropped). */
export function numInput(raw: string): string | null {
  const v = raw.replace(/[,\s]/g, '');
  return v === '' || /^\d*\.?\d*$/.test(v) ? v : null;
}
/** "5." -> "5", "" -> fallback. */
export function normNum(v: string | null | undefined, fallback: string | null): string | null {
  if (v === null || v === undefined) return fallback;
  const t = v.trim().replace(/\.$/, '');
  if (!/^\d+(\.\d+)?$/.test(t)) return fallback;
  return t.replace(/^0+(?=\d)/, '');   // "007" -> "7", keeps "0.5"
}

export function useToast() {
  const [msg, setMsg] = useState<{ text: string; action?: { label: string; run: () => void } } | null>(null);
  const t = useRef<ReturnType<typeof setTimeout> | null>(null);
  const show = useCallback((text: string, action?: { label: string; run: () => void }, ms = 6000) => {
    if (t.current) clearTimeout(t.current);
    setMsg({ text, action });
    t.current = setTimeout(() => setMsg(null), ms);
  }, []);
  const node = msg ? (
    <div className="toast" role="status">
      <span>{msg.text}</span>
      {msg.action && <button type="button" onClick={() => { msg.action!.run(); setMsg(null); }}>{msg.action.label}</button>}
    </div>
  ) : null;
  return { show, node };
}

/** Close a popover/menu on outside click or Escape. */
export function useDismiss(open: boolean, close: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) close(); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [open, close]);
  return ref;
}
