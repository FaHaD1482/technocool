'use client';

import { useId, useState, type ReactNode } from 'react';
import { Dialog } from './Dialog';

/**
 * A yes/no dialog for anything that cannot be undone from the UI: disable an account, reset a password,
 * disconnect the mailbox, discard a reply. Server-side permission checks still apply — this only stops
 * accidents.
 */
export function Confirm({ title, confirmLabel, danger = false, onConfirm, onClose, children }: {
  title: string;
  confirmLabel: string;
  danger?: boolean;
  /** Return an error message to keep the dialog open, or nothing to close it. */
  onConfirm: () => Promise<string | null | void> | string | null | void;
  onClose: () => void;
  children?: ReactNode;
}) {
  const id = useId();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    setError(null);
    setBusy(true);
    try {
      const message = await onConfirm();
      if (message) setError(message);
    } catch (e) {
      setError((e as Error).message || 'That did not work. Try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog labelledBy={id} onClose={onClose} busy={busy} width={460}>
      <div className="dh">
        <h2 id={id}>{title}</h2>
        <button className="x" type="button" onClick={onClose} disabled={busy} aria-label="Close">×</button>
      </div>
      <div className="hint" style={{ margin: 0 }}>{children}</div>
      {error && <p className="ferr" role="alert">{error}</p>}
      <div className="formactions" style={{ borderTop: '1px solid var(--line)', paddingTop: 12 }}>
        <button className="btn" type="button" onClick={onClose} disabled={busy}>Cancel</button>
        <button className={`btn ${danger ? 'danger' : 'primary'}`} type="button" onClick={run} disabled={busy} data-autofocus>
          {busy ? 'Working…' : confirmLabel}
        </button>
      </div>
    </Dialog>
  );
}
