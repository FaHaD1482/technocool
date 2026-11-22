'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { apiFetch, SessionExpired } from '@/lib/client-api';

export interface ClientOption { id: string; name: string; email: string | null }

/**
 * Type-ahead client picker. It asks the server for up to 20 matches as you type, so it stays fast with
 * thousands of clients (the old <select> shipped every client to the browser). Keyboard: ↑ ↓ Enter Esc.
 * With `name`, the chosen client's id is submitted in a hidden input of that name.
 */
export function ClientPicker({ value, onChange, name, initialId, required, placeholder = 'Type a client name or e-mail…', className, autoFocus, ariaLabel = 'Client' }: {
  value?: ClientOption | null;
  onChange?: (c: ClientOption | null) => void;
  name?: string;
  /** Pre-select by id (e.g. after a form error) when the caller has no name to show. */
  initialId?: string;
  required?: boolean;
  placeholder?: string;
  className?: string;
  autoFocus?: boolean;
  ariaLabel?: string;
}) {
  const listId = useId();
  const [picked, setPicked] = useState<ClientOption | null>(value ?? null);
  const [text, setText] = useState(value?.name ?? '');
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<ClientOption[]>([]);
  const [active, setActive] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);
  const box = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);

  // The box must hold a client chosen from the list, not just typed text, for the form to submit.
  useEffect(() => {
    input.current?.setCustomValidity(required && !picked && text.trim() ? 'Choose a client from the list.' : '');
  }, [required, picked, text]);

  // Restore a selection the server only gave us by id.
  useEffect(() => {
    if (!initialId || value) return;
    void apiFetch(`/api/clients/search?id=${encodeURIComponent(initialId)}`).then(({ body }) => {
      const c = (Array.isArray(body) ? body[0] : null) as ClientOption | null;
      if (c) { setPicked(c); setText(c.name); onChange?.(c); }
    }).catch(() => { /* leave it empty; the user picks again */ });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialId]);

  // Debounced search while the list is open.
  useEffect(() => {
    if (!open) return;
    const my = ++seq.current;
    const term = picked && text === picked.name ? '' : text;
    setLoading(true); // from the keystroke, so "no match" never flashes during the pause
    const t = setTimeout(async () => {
      try {
        const { res, body } = await apiFetch(`/api/clients/search?q=${encodeURIComponent(term)}`);
        if (my !== seq.current) return; // a newer keystroke already asked again
        if (!res.ok) { setError(typeof body.error === 'string' ? body.error : 'Could not load clients.'); setItems([]); return; }
        setError(null);
        setItems(Array.isArray(body) ? (body as ClientOption[]) : []);
        setActive(0);
      } catch (e) {
        if (!(e instanceof SessionExpired) && my === seq.current) setError('Could not load clients.');
      } finally {
        if (my === seq.current) setLoading(false);
      }
    }, 180);
    return () => clearTimeout(t);
  }, [text, open, picked]);

  // Close when focus or a click goes elsewhere.
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', away);
    return () => document.removeEventListener('mousedown', away);
  }, [open]);

  const choose = (c: ClientOption) => {
    setPicked(c);
    setText(c.name);
    setOpen(false);
    onChange?.(c);
  };

  const onKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setOpen(true); setActive((a) => Math.min(a + 1, Math.max(items.length - 1, 0))); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
    else if (e.key === 'Enter' && open) {
      const c = items[active];
      if (c) { e.preventDefault(); choose(c); }
    } else if (e.key === 'Escape' && open) { e.preventDefault(); e.stopPropagation(); setOpen(false); }
  };

  return (
    <div className={`cpick${className ? ` ${className}` : ''}`} ref={box}>
      {name && <input type="hidden" name={name} value={picked?.id ?? ''} />}
      <input
        type="text" role="combobox" aria-label={ariaLabel} aria-expanded={open} aria-controls={listId} aria-autocomplete="list"
        aria-activedescendant={open && items[active] ? `${listId}-${active}` : undefined}
        value={text} placeholder={placeholder} autoComplete="off" autoFocus={autoFocus}
        ref={input} required={required}
        onFocus={() => setOpen(true)}
        onChange={(e) => {
          setText(e.target.value);
          setOpen(true);
          if (picked) { setPicked(null); onChange?.(null); }
        }}
        onKeyDown={onKey}
      />
      {open && (
        <ul className="cpick-list" id={listId} role="listbox">
          {loading && items.length === 0 && <li className="cpick-note">Searching…</li>}
          {error && <li className="cpick-note err">{error}</li>}
          {!loading && !error && items.length === 0 && <li className="cpick-note">No client matches “{text}”.</li>}
          {items.map((c, i) => (
            <li key={c.id} id={`${listId}-${i}`} role="option" aria-selected={i === active}
              className={i === active ? 'on' : undefined}
              onMouseEnter={() => setActive(i)}
              onMouseDown={(e) => { e.preventDefault(); choose(c); }}>
              <b>{c.name}</b>{c.email && <small>{c.email}</small>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
