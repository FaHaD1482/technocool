'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import type { EmailSummary } from '@/lib/mail/send';
import { fmtDateTime } from '@/lib/format';
import { EMAIL_STATUS, chipOf, labelOf } from '@/lib/labels';
import { apiFetch } from '@/lib/client-api';

/** Send history of this BOQ; refreshes every 3 s while a send is waiting, then reloads the page once it settles. */
export function SendLog({ boqId, initial, pollKey }: { boqId: string; initial: EmailSummary[]; pollKey: number }) {
  const router = useRouter();
  const [emails, setEmails] = useState(initial);
  const pending = emails.some((e) => e.status === 'queued' || e.status === 'sending');

  useEffect(() => {
    if (!pending && pollKey === 0) return;
    let stop = false;
    const tick = async () => {
      const { res, body: b } = await apiFetch(`/api/boqs/${boqId}/emails`, { cache: 'no-store' }).catch(() => ({ res: null, body: {} as Record<string, unknown> }));
      if (!res?.ok || stop) return;
      const emails = b.emails as EmailSummary[];
      setEmails(emails);
      const still = emails.some((e) => e.status === 'queued' || e.status === 'sending');
      if (!still) { router.refresh(); return; }
      setTimeout(tick, 3000);
    };
    const t = setTimeout(tick, 1500);
    return () => { stop = true; clearTimeout(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boqId, pollKey]);

  if (!emails.length) return null;
  return (
    <div className="box">
      <h3>E-mails</h3>
      {emails.map((e) => (
        <div key={e.id} style={{ display: 'flex', flexDirection: 'column', gap: 3, borderTop: '1px solid var(--line)', paddingTop: 8 }}>
          <div className="kv"><span className={`chip ${chipOf(EMAIL_STATUS, e.status)}`}>{labelOf(EMAIL_STATUS, e.status)}</span><small className="hint">{fmtDateTime(e.sentAt ?? e.queuedAt)}</small></div>
          <span style={{ fontSize: 14 }}>To {e.to.join(', ')}{e.cc.length ? `, cc ${e.cc.join(', ')}` : ''}</span>
          <small className="hint">{e.subject} · {e.currency === 'BOTH' ? 'USD + BDT' : e.currency}{e.sender ? ` · by ${e.sender}` : ''}</small>
          {e.manual && <small className="hint">Sent with the file you edited by hand — the app’s copy may not match it.</small>}
          {e.lastError && e.status !== 'sent' && <small className="ferr">{e.status === 'queued' ? `Will retry: ${e.lastError}` : e.lastError}</small>}
        </div>
      ))}
    </div>
  );
}
