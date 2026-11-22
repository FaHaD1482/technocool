'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Icon } from '@/components/ui/Icon';
import { ClientPicker, type ClientOption } from '@/components/ui/ClientPicker';
import { apiFetch, SessionExpired } from '@/lib/client-api';
import { AttachButton, AttachChips } from './Attachments';

export { ATTACH_ACCEPT, ATTACH_HINT } from './Attachments';
export type { ClientOption };

interface Props {
  /** The client to start with (from a BOQ or client link), or none: the user searches for one. */
  client?: ClientOption | null;
  initial: { to?: string; subject?: string; body?: string };
  lockedClient?: boolean;
  /** 'float' = Gmail's bottom-right compose window; 'page' = the full-size compose on /inbox/new. */
  variant?: 'float' | 'page';
  onClose?: () => void;
}

/**
 * Gmail-style "New Message": a dark title bar, borderless Client / To / Cc / Subject lines, a large body,
 * and a toolbar with a blue Send button, attach and discard. Sending posts to the same API as before.
 */
export function ComposeForm({ client = null, initial, lockedClient = false, variant = 'page', onClose }: Props) {
  const router = useRouter();
  const [picked, setPicked] = useState<ClientOption | null>(client);
  const clientId = picked?.id ?? '';
  const [to, setTo] = useState(initial.to ?? client?.email ?? '');
  const [cc, setCc] = useState('');
  const [showCc, setShowCc] = useState(false);
  const [subject, setSubject] = useState(initial.subject ?? '');
  const [body, setBody] = useState(initial.body ?? '');
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [min, setMin] = useState(false);

  const chooseClient = (c: ClientOption | null) => {
    const prevEmail = picked?.email ?? '';
    setPicked(c);
    // Like picking a Gmail contact: fill To with the client's address unless a custom address was typed.
    if (c?.email && (!to.trim() || to.trim() === prevEmail)) setTo(c.email);
  };

  const dirty = !!(body.trim() || files.length || (subject.trim() && subject !== (initial.subject ?? '')));
  const close = () => {
    if (dirty && !window.confirm('Discard this message?')) return;
    if (onClose) onClose();
    else router.push('/inbox');
  };

  async function send(e: React.FormEvent) {
    e.preventDefault();
    if (!clientId) { setErr('Choose the client this message is for.'); return; }
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
      onClose?.();
      router.push(`/inbox/${b.threadId}`);
      router.refresh();
    } catch (e) {
      if (!(e instanceof SessionExpired)) setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const title = subject.trim() || 'New Message';

  return (
    <form onSubmit={send} className={`m-compose ${variant}${min ? ' min' : ''}`} aria-label="New message">
      <div className="m-compose-bar">
        <button type="button" className="m-compose-title" onClick={() => variant === 'float' && setMin(!min)}
          aria-expanded={!min}>{title}</button>
        {variant === 'float' && (
          <button type="button" className="m-icon light" onClick={() => setMin(!min)}
            aria-label={min ? 'Restore' : 'Minimise'} title={min ? 'Restore' : 'Minimise'}>
            <Icon name="minus" size={16} />
          </button>
        )}
        <button type="button" className="m-icon light" onClick={close} disabled={busy} aria-label="Close" title="Close">
          <Icon name="close" size={16} />
        </button>
      </div>

      {!min && (
        <>
          <div className="m-line">
            <span className="m-line-lbl">Client</span>
            {lockedClient && client ? (
              <span className="m-line-static">{client.name}</span>
            ) : (
              <ClientPicker value={client} onChange={chooseClient} required className="m-cpick"
                placeholder="Search clients by name or e-mail" autoFocus={variant === 'float'} />
            )}
          </div>
          <div className="m-line">
            <span className="m-line-lbl">To</span>
            <input value={to} onChange={(e) => setTo(e.target.value)} type="text" inputMode="email" required
              aria-label="To" placeholder="client@example.com" />
            {!showCc && <button type="button" className="m-cc" onClick={() => setShowCc(true)}>Cc</button>}
          </div>
          {showCc && (
            <div className="m-line">
              <span className="m-line-lbl">Cc</span>
              <input value={cc} onChange={(e) => setCc(e.target.value)} type="text" inputMode="email" aria-label="Cc"
                autoFocus placeholder="Separate addresses with commas" />
            </div>
          )}
          <div className="m-line">
            <input value={subject} onChange={(e) => setSubject(e.target.value)} maxLength={250} required
              aria-label="Subject" placeholder="Subject" />
          </div>
          <textarea className="m-body" value={body} onChange={(e) => setBody(e.target.value)} maxLength={20000} required
            aria-label="Message" placeholder="Write your message…" />

          <AttachChips files={files} onChange={setFiles} />
          {err && <p className="ferr m-err" role="alert">{err}</p>}

          <div className="m-toolbar">
            <button className="m-send" disabled={busy}>
              {busy ? 'Sending…' : 'Send'} <Icon name="send" size={15} />
            </button>
            <AttachButton files={files} onChange={setFiles} />
            <span className="m-toolbar-note">From the company Gmail · replies come back here</span>
            <button type="button" className="m-icon m-discard" onClick={close} disabled={busy}
              aria-label="Discard draft" title="Discard draft">
              <Icon name="trash" size={18} />
            </button>
          </div>
        </>
      )}
    </form>
  );
}
