'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Icon } from '@/components/ui/Icon';
import { FileField } from '@/components/ui/FileField';
import { apiFetch, SessionExpired } from '@/lib/client-api';

export interface ClientOption { id: string; name: string; email: string | null }

export const ATTACH_ACCEPT = '.pdf,.doc,.docx,.xls,.xlsx,.csv,.txt,.png,.jpg,.jpeg,.gif,.webp,.zip';
export const ATTACH_HINT = 'PDF, Word, Excel, CSV, TXT, images, ZIP · 5 files · 10 MB each · 20 MB total';

interface Props {
  clients: ClientOption[];
  initial: { clientId?: string; to?: string; subject?: string; body?: string };
  lockedClient?: boolean;
}

export function ComposeForm({ clients, initial, lockedClient = false }: Props) {
  const router = useRouter();
  const [clientId, setClientId] = useState(initial.clientId ?? '');
  const [to, setTo] = useState(initial.to ?? '');
  const [cc, setCc] = useState('');
  const [subject, setSubject] = useState(initial.subject ?? '');
  const [body, setBody] = useState(initial.body ?? '');
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const chooseClient = (id: string) => {
    setClientId(id);
    const c = clients.find((x) => x.id === id);
    if (c?.email && !to.trim()) setTo(c.email);
  };

  async function send(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    setBusy(true);
    try {
      const fd = new FormData();
      fd.set('clientId', clientId);
      fd.set('to', to);
      fd.set('cc', cc);
      fd.set('subject', subject);
      fd.set('body', body);
      for (const f of files) fd.append('files', f);
      const { res, body: b } = await apiFetch('/api/mail/messages', { method: 'POST', body: fd });
      if (!res.ok) { setErr(typeof b.error === 'string' ? b.error : 'Could not send the message.'); return; }
      router.push(`/inbox/${b.threadId}`);
      router.refresh();
    } catch (e) {
      if (!(e instanceof SessionExpired)) setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={send} className="card stack">
      <label className="f"><span className="lbl">Client</span>
        {lockedClient ? (
          <>
            <input type="hidden" name="clientId" value={clientId} />
            <input value={clients[0]?.name ?? ''} readOnly />
          </>
        ) : (
          <select name="clientId" value={clientId} onChange={(e) => chooseClient(e.target.value)} required>
            <option value="" disabled>Choose a client…</option>
            {clients.map((c) => <option key={c.id} value={c.id}>{c.name}{c.email ? ` · ${c.email}` : ''}</option>)}
          </select>
        )}
      </label>
      <div className="formgrid">
        <label className="f"><span className="lbl">To <small>the client’s address</small></span>
          <input name="to" value={to} onChange={(e) => setTo(e.target.value)} type="text" inputMode="email" required /></label>
        <label className="f"><span className="lbl">Cc <small>optional</small></span>
          <input name="cc" value={cc} onChange={(e) => setCc(e.target.value)} type="text" inputMode="email" /></label>
        <label className="f full"><span className="lbl">Subject</span>
          <input name="subject" value={subject} onChange={(e) => setSubject(e.target.value)} maxLength={250} required /></label>
        <label className="f full"><span className="lbl">Message</span>
          <textarea name="body" value={body} onChange={(e) => setBody(e.target.value)} rows={12} maxLength={20000} required /></label>
      </div>
      <FileField label="Attachments" hint={ATTACH_HINT} accept={ATTACH_ACCEPT} files={files} onChange={setFiles} />
      {err && <p className="ferr" role="alert">{err}</p>}
      <div className="formactions">
        <button className="btn primary" disabled={busy || !clientId}>
          <Icon name="send" size={16} /> {busy ? 'Sending…' : 'Send message'}
        </button>
      </div>
      <p className="hint">The client sees the company Gmail; their reply comes back to you inside this conversation.</p>
    </form>
  );
}
