'use client';

import { useEffect, useRef } from 'react';
import Link from 'next/link';
import { Icon } from '@/components/ui/Icon';
import { splitQuoted } from '@/lib/mail/parse';
import { fmtDateTimeFull } from '@/lib/format';
import type { Reply } from '@/lib/replies';

const METHOD: Record<string, string> = {
  thread: 'reply in the same thread', header: 'reply headers', plus_tag: 'reply address', subject_code: 'BOQ code in the subject',
  sender: 'sender (only open BOQ of this client)', manual: 'assigned by the admin',
};

const size = (n: number) => (n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

export function RepliesPanel({ replies, currentRevision }: { replies: Reply[]; currentRevision: number }) {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => { if (location.hash === '#replies') ref.current?.scrollIntoView({ block: 'start' }); }, []);
  if (!replies.length) return null;
  return (
    <section ref={ref} id="replies" className="panel" aria-label="Client replies">
      <div className="phead">
        <h2 style={{ fontSize: 20 }}>Client replies <span className="badge-n">{replies.length}</span></h2>
        <p className="hint">Visible only to the BOQ owner and to admins / managers.</p>
      </div>
      <div className="replies">
        {replies.map((r) => {
          const { fresh, quoted } = splitQuoted(r.bodyText);
          return (
            <article key={r.id} className={`reply${r.unread ? ' unread' : ''}`}>
              <div className="rh">
                <span><b>{r.fromName ?? r.fromAddr}</b> {r.fromName && <small className="hint">&lt;{r.fromAddr}&gt;</small>}</span>
                <small className="hint">
                  {fmtDateTimeFull(r.receivedAt)}
                  {r.revision !== null && <> · to <b className="mono">R{r.revision}</b>{r.revision !== currentRevision ? ' (other revision)' : ''}</>}
                  {r.unread && <> · <span style={{ color: 'var(--accent)', fontWeight: 700 }}>new</span></>}
                </small>
              </div>
              {r.subject && <small className="hint">{r.subject}</small>}
              <pre className="body">{fresh || '(no text)'}</pre>
              {quoted && <details><summary>Show quoted text</summary><pre className="quoted">{quoted}</pre></details>}
              {r.files.length > 0 && (
                <div className="files">
                  {r.files.map((f) => f.available
                    ? <a key={f.n} href={`/api/replies/${r.id}/files/${f.n}`} download><Icon name="paperclip" size={13} /> {f.filename} · {size(f.size)}</a>
                    : <span key={f.n} title={f.note}><Icon name="paperclip" size={13} /> {f.filename} · {f.note ?? 'not stored'}</span>)}
                </div>
              )}
              {r.matchMethod && <small className="hint">Matched by {METHOD[r.matchMethod] ?? r.matchMethod}</small>}
              {r.threadId && (
                <div className="formactions" style={{ justifyContent: 'flex-start' }}>
                  <Link className="btn small" href={`/inbox/${r.threadId}`}>
                    <Icon name="reply" size={14} /> Reply in Inbox
                  </Link>
                </div>
              )}
            </article>
          );
        })}
      </div>
    </section>
  );
}
