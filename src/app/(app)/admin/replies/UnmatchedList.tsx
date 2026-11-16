'use client';

import { useMemo, useState, useTransition } from 'react';
import { Icon } from '@/components/ui/Icon';
import { Confirm } from '@/components/ui/Confirm';
import { fmtDateTime } from '@/lib/format';
import { splitQuoted } from '@/lib/mail/parse';
import type { Reply } from '@/lib/replies';
import { assign, discard, type ActState } from './actions';

interface Boq { id: string; boq_no: string; revision: number; status: string; project: string; client: string | null; client_email: string | null; owner: string | null }

export function UnmatchedList({ replies, boqs }: { replies: Reply[]; boqs: Boq[] }) {
  const [msg, setMsg] = useState<ActState>({});
  const [pending, start] = useTransition();
  const [discarding, setDiscarding] = useState<Reply | null>(null);
  return (
    <div className="stack">
      {(msg.error || msg.ok) && <p className={`alert ${msg.error ? 'err' : 'ok'}`} role="status">{msg.error ?? msg.ok}</p>}
      {replies.map((r) => <Item key={r.id} r={r} boqs={boqs} pending={pending}
        onAssign={(boqId) => start(async () => setMsg(await assign(r.id, boqId)))}
        onDiscard={() => setDiscarding(r)} />)}

      {discarding && (
        <Confirm title="Discard this mail?" confirmLabel="Discard" danger onClose={() => setDiscarding(null)}
          onConfirm={async () => {
            const state = await discard(discarding.id);
            setMsg(state);
            if (!state.error) setDiscarding(null);
            return state.error ?? null;
          }}>
          It is deleted from this system — it stays in Gmail. Nobody is notified.
        </Confirm>
      )}
    </div>
  );
}

function Item({ r, boqs, pending, onAssign, onDiscard }: { r: Reply; boqs: Boq[]; pending: boolean; onAssign: (id: string) => void; onDiscard: () => void }) {
  const [q, setQ] = useState('');
  const [pick, setPick] = useState('');
  // Suggest BOQs sent to this sender first.
  const sorted = useMemo(() => {
    const from = r.fromAddr.toLowerCase();
    const s = q.trim().toLowerCase();
    return boqs
      .filter((b) => !s || [b.boq_no, b.project, b.client ?? '', b.owner ?? ''].join(' ').toLowerCase().includes(s))
      .sort((a, b) => Number(b.client_email === from) - Number(a.client_email === from))
      .slice(0, 100);
  }, [boqs, q, r.fromAddr]);
  const { fresh, quoted } = splitQuoted(r.bodyText);
  return (
    <article className="reply">
      <div className="rh">
        <span><b>{r.fromName ?? r.fromAddr}</b> {r.fromName && <small className="hint">&lt;{r.fromAddr}&gt;</small>}</span>
        <small className="hint">{fmtDateTime(r.receivedAt)}</small>
      </div>
      <b style={{ fontSize: 14 }}>{r.subject ?? '(no subject)'}</b>
      <pre className="body">{fresh || '(no text)'}</pre>
      {quoted && <details><summary>Show quoted text</summary><pre className="quoted">{quoted}</pre></details>}
      {r.files.length > 0 && (
        <div className="files">{r.files.map((f) => f.available
          ? <a key={f.n} href={`/api/replies/${r.id}/files/${f.n}`} download><Icon name="paperclip" size={13} /> {f.filename}</a>
          : <span key={f.n}><Icon name="paperclip" size={13} /> {f.filename} · {f.note}</span>)}</div>
      )}
      <div className="toolbar" style={{ borderTop: '1px solid var(--line)', paddingTop: 10 }}>
        <label className="search"><span className="sr">Find BOQ</span><input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find BOQ no., project, client, owner" /></label>
        <select value={pick} onChange={(e) => setPick(e.target.value)} aria-label="BOQ to assign to" style={{ padding: '7px 8px', border: '1px solid var(--line)', borderRadius: 6, background: 'var(--surface-2)', maxWidth: 420 }}>
          <option value="">Choose the BOQ…</option>
          {sorted.map((b) => (
            <option key={b.id} value={b.id}>{b.client_email === r.fromAddr.toLowerCase() ? 'Sent to this sender · ' : ''}{b.boq_no} R{b.revision} · {b.project} · {b.client ?? '—'} · {b.owner ?? '—'}</option>
          ))}
        </select>
        <button className="btn primary" disabled={!pick || pending} onClick={() => onAssign(pick)}>Assign</button>
        <button className="btn reset" disabled={pending} onClick={onDiscard}>Discard</button>
      </div>
    </article>
  );
}
