'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Icon } from '@/components/ui/Icon';
import { FileField } from '@/components/ui/FileField';
import { apiFetch, SessionExpired } from '@/lib/client-api';
import { ATTACH_ACCEPT, ATTACH_HINT } from './ComposeForm';

/** Reply inside a conversation. It goes out in the same Gmail thread and returns to the same inbox. */
export function ReplyBox({ threadId, clientId, to, subject, replyToInboundId }: {
  threadId: string; clientId: string; to: string; subject: string; replyToInboundId?: string;
}) {
  const router = useRouter();
  const [body, setBody] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

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
      setBody(''); setFiles([]);
      setOk('Reply queued — it will appear here as soon as it is sent.');
      router.refresh();
    } catch (e) {
      if (!(e instanceof SessionExpired)) setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={send} className="card stack">
      <h2>Reply</h2>
      <label className="f"><span className="lbl">Message</span>
        <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={6} maxLength={20000} required /></label>
      <FileField label="Attachments" hint={ATTACH_HINT} accept={ATTACH_ACCEPT} files={files} onChange={setFiles} />
      {err && <p className="ferr" role="alert">{err}</p>}
      {ok && <p className="fok" role="status">{ok}</p>}
      <div className="formactions">
        <button className="btn primary" disabled={busy}>
          <Icon name="reply" size={16} /> {busy ? 'Sending…' : 'Send reply'}
        </button>
      </div>
    </form>
  );
}
