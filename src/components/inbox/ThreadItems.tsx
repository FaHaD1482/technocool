import { Icon } from '@/components/ui/Icon';
import { fmtDateTime } from '@/lib/format';
import { EMAIL_STATUS, labelOf } from '@/lib/labels';
import type { TimelineItem } from '@/lib/mail/messages';

/** The conversation timeline: outbound mail and client replies, oldest first. */
export function ThreadItems({ items }: { items: TimelineItem[] }) {
  if (!items.length) return <p className="hint">No messages in this conversation yet.</p>;
  return (
    <div className="replies">
      {items.map((m) => (
        <article key={m.id} className={`reply ${m.direction === 'in' ? 'incoming' : 'outgoing'}`}>
          <div className="rh">
            <b>{m.direction === 'in' ? (m.fromName ?? m.fromAddr ?? 'Client') : `Sent${m.sender ? ` by ${m.sender}` : ''}`}</b>
            <small className="hint">
              {fmtDateTime(m.at)}
              {m.direction === 'out' && m.status && m.status !== 'sent' ? ` · ${labelOf(EMAIL_STATUS, m.status)}` : ''}
            </small>
          </div>
          {m.subject && <small className="hint">{m.subject}</small>}
          <pre className="body">{m.body || '(no text)'}</pre>
          {m.files.length > 0 && (
            <div className="files">
              {m.files.map((f) => (
                <a key={f.href} href={f.href} download title={f.note ?? undefined}>
                  <Icon name="paperclip" size={13} /> {f.filename}{f.size ? ` · ${Math.round(f.size / 1024)} KB` : ''}
                </a>
              ))}
            </div>
          )}
        </article>
      ))}
    </div>
  );
}
