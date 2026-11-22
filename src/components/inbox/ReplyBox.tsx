'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Icon } from '@/components/ui/Icon';
import { apiFetch, SessionExpired } from '@/lib/client-api';
import { AttachButton, AttachChips } from './Attachments';
import { Avatar } from './Avatar';

/**
 * Gmail's reply: a "Reply" button under the conversation that opens an inline reply card.
 * It goes out in the same Gmail thread and the answer returns to this conversation.
 */
export function ReplyBox({ threadId, clientId, to, subject, replyToInboundId, me }: {
  threadId: string; clientId: string; to: string; subject: string; replyToInboundId?: string; me: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [body, setBody] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  const discard = () => {
    if ((body.trim() || files.length) && !window.confirm('Discard this reply?')) return;
    setBody(''); setFiles([]); setErr(null); setOpen(false);
  };

  async function send(e: React.FormEvent) {
    e.preventDefault();
    setErr(null); setOk(null); setBusy(true);
    try {
      const fd = new FormData();
      fd.set('clientId', clientId);
      fd.set('to', to);
      fd.set('subject', subject);
      fd.set('body', body);
      fd.set('threadId', threadId);
      if (replyToInboundId) fd.set('replyToInboundId', replyToInboundId);
      for (const f of files) fd.append('files', f);
      const { res, body: b } = await apiFetch('/api/mail/messages', { method: 'POST', body: fd });
      if (!res.ok) { setErr(typeof b.error === 'string' ? b.error : 'Could not send the reply.'); return; }
      setBody(''); setFiles([]); setOpen(false);
      setOk('Message queued. It appears above as soon as it is sent.');
      router.refresh();
    } catch (e) {
      if (!(e instanceof SessionExpired)) setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <div className="m-reply-actions">
        {ok && <p className="fok" role="status">{ok}</p>}
        <button type="button" className="m-pill" onClick={() => { setOk(null); setOpen(true); }}>
          <Icon name="reply" size={18} /> Reply
        </button>
      </div>
    );
  }

  return (
    <form onSubmit={send} className="m-reply">
      <Avatar name={me} size={40} />
      <div className="m-reply-card">
        <div className="m-reply-to"><Icon name="reply" size={16} /> <span>{to}</span></div>
        <textarea className="m-body" value={body} onChange={(e) => setBody(e.target.value)} maxLength={20000} required
          autoFocus aria-label="Reply" placeholder="Write your reply…" />
        <AttachChips files={files} onChange={setFiles} />
        {err && <p className="ferr m-err" role="alert">{err}</p>}
        <div className="m-toolbar">
          <button className="m-send" disabled={busy}>{busy ? 'Sending…' : 'Send'} <Icon name="send" size={15} /></button>
          <AttachButton files={files} onChange={setFiles} />
          <span className="m-toolbar-note" />
          <button type="button" className="m-icon m-discard" onClick={discard} disabled={busy} aria-label="Discard reply" title="Discard reply">
            <Icon name="trash" size={18} />
          </button>
        </div>
      </div>
    </form>
  );
}
