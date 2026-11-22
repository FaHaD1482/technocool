'use client';

import { useState } from 'react';
import { Icon } from '@/components/ui/Icon';
import { fmtMailDate, fmtMailFull } from '@/lib/format';
import { EMAIL_STATUS, labelOf } from '@/lib/labels';
import type { TimelineItem } from '@/lib/mail/messages';
import { Avatar } from './Avatar';

/** Splits off the quoted earlier mail ("On … wrote:" and "> " lines) so it can hide behind "•••" like Gmail. */
function splitQuote(body: string | null): { main: string; quoted: string } {
  const text = body ?? '';
  const marks = [text.search(/(^|\n)On \S[^\n]{0,200}(\n[^\n]{0,200})?\s*wrote:/), text.search(/(^|\n)>/)].filter((i) => i > 0);
  if (!marks.length) return { main: text, quoted: '' };
  const at = Math.min(...marks);
  return { main: text.slice(0, at).trimEnd(), quoted: text.slice(at).replace(/^\n/, '') };
}

const oneLine = (s: string | null) => splitQuote(s).main.replace(/\s+/g, ' ').trim().slice(0, 140);

function Body({ text }: { text: string | null }) {
  const [show, setShow] = useState(false);
  const { main, quoted } = splitQuote(text);
  return (
    <>
      <div className="m-msg-text">{main || (quoted ? '' : '(no text)')}</div>
      {quoted && (
        <>
          <button type="button" className="m-dots" onClick={() => setShow(!show)}
            aria-expanded={show} title={show ? 'Hide quoted text' : 'Show trimmed content'}>•••</button>
          {show && <div className="m-msg-text m-quoted">{quoted}</div>}
        </>
      )}
    </>
  );
}

/**
 * The conversation like Gmail: oldest first, every message but the newest collapsed to one line.
 * Click a collapsed message to open it; "Expand all" opens every one.
 */
export function ThreadItems({ items, clientName, clientEmail }: {
  items: TimelineItem[]; clientName: string; clientEmail: string | null;
}) {
  const last = items[items.length - 1]?.id;
  const [open, setOpen] = useState<Set<string>>(() => new Set(last ? [last] : []));
  if (!items.length) return <p className="hint m-pad">No messages in this conversation yet.</p>;

  const toggle = (id: string) => setOpen((s) => {
    const n = new Set(s);
    if (n.has(id)) n.delete(id); else n.add(id);
    return n;
  });
  const allOpen = items.every((m) => open.has(m.id));
  const now = new Date();

  return (
    <div className="m-thread">
      {items.length > 2 && (
        <div className="m-thread-tools">
          <button type="button" className="linkbtn" onClick={() => setOpen(allOpen ? new Set(last ? [last] : []) : new Set(items.map((m) => m.id)))}>
            {allOpen ? 'Collapse all' : 'Expand all'}
          </button>
        </div>
      )}
      {items.map((m) => {
        const incoming = m.direction === 'in';
        const name = incoming ? (m.fromName ?? m.fromAddr ?? clientName) : (m.sender ?? 'Company');
        const isOpen = open.has(m.id);
        const status = !incoming && m.status && m.status !== 'sent' ? labelOf(EMAIL_STATUS, m.status) : null;
        return (
          <article key={m.id} className={`m-msg${isOpen ? ' open' : ''}${incoming ? ' in' : ' out'}`}>
            <button type="button" className="m-msg-head" onClick={() => toggle(m.id)} aria-expanded={isOpen}>
              <Avatar name={name} size={40} />
              <span className="m-msg-who">
                <b>{name}</b>
                {isOpen ? (
                  <small>
                    {incoming
                      ? <>{m.fromAddr && <>&lt;{m.fromAddr}&gt; </>}to company Gmail</>
                      : <>via company Gmail · to {clientEmail ?? clientName}</>}
                  </small>
                ) : (
                  <small className="m-msg-snip">{oneLine(m.body) || (m.files.length ? `${m.files.length} attachment(s)` : '(no text)')}</small>
                )}
              </span>
              <span className="m-msg-meta">
                {status && <span className={`chip ${m.status === 'failed' ? 'rejected' : 'draft'}`}>{status}</span>}
                {m.files.length > 0 && <Icon name="paperclip" size={15} />}
                <time dateTime={m.at} title={fmtMailFull(m.at)}>{isOpen ? fmtMailFull(m.at) : fmtMailDate(m.at, now)}</time>
              </span>
            </button>
            {isOpen && (
              <div className="m-msg-body">
                <Body text={m.body} />
                {m.files.length > 0 && (
                  <div className="m-files">
                    <small className="m-files-title">{m.files.length} attachment{m.files.length > 1 ? 's' : ''}</small>
                    <div className="m-files-grid">
                      {m.files.map((f) => (
                        <a key={f.href} className="m-file" href={f.href} download title={f.note ?? f.filename}>
                          <Icon name="file" size={22} />
                          <span className="m-file-name">{f.filename}</span>
                          {f.size ? <small>{Math.max(1, Math.round(f.size / 1024))} KB</small> : null}
                        </a>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
          </article>
        );
      })}
    </div>
  );
}
