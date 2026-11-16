'use client';

import { useEffect, useRef, useState } from 'react';
import type { ExportChoice } from '@/lib/boq/types';
import type { SendPreflight } from '@/lib/mail/send';
import { Dialog } from '@/components/ui/Dialog';
import { apiFetch, SessionExpired } from '@/lib/client-api';

interface Props {
  boqId: string;
  flush: () => Promise<boolean>;
  onClose: () => void;
  onQueued: (subject: string) => void;
}

export function SendDialog({ boqId, flush, onClose, onQueued }: Props) {
  const [pre, setPre] = useState<SendPreflight | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [to, setTo] = useState('');
  const [cc, setCc] = useState('');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [currency, setCurrency] = useState<ExportChoice>('BDT');
  const [mode, setMode] = useState<'generated' | 'upload'>('generated');
  const [file, setFile] = useState<File | null>(null);
  const [fileErr, setFileErr] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const first = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      // The files are built from the saved BOQ, so save pending edits first.
      if (!(await flush())) { setLoadErr('Your latest changes could not be saved, so the BOQ cannot be sent yet.'); return; }
      let res: Response, b: Record<string, unknown>;
      try { ({ res, body: b } = await apiFetch(`/api/boqs/${boqId}/send`)); }
      catch (e) { if (alive && !(e instanceof SessionExpired)) setLoadErr((e as Error).message); return; }
      if (!alive) return;
      if (!res.ok) { setLoadErr(typeof b.error === 'string' ? b.error : 'Could not prepare the e-mail.'); return; }
      const pre = b as unknown as SendPreflight;
      setPre(pre); setTo(pre.to); setSubject(pre.subject); setBody(pre.body); setCurrency(pre.currency);
      setTimeout(() => first.current?.focus(), 0);
    })();
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boqId]);

  function pick(f: File | null) {
    setFileErr(null);
    setFile(null);
    if (!f) return;
    if (!/\.xlsx$/i.test(f.name)) { setFileErr('Choose an .xlsx file. In Excel use Save As → Excel Workbook (.xlsx).'); return; }
    if (pre && f.size > pre.maxUploadMb * 1024 * 1024) {
      setFileErr(`That file is ${(f.size / 1024 / 1024).toFixed(1)} MB. Keep it under ${pre.maxUploadMb} MB.`);
      return;
    }
    setFile(f);
  }

  async function downloadFresh() {
    setErr(null);
    if (!(await flush())) { setErr('Your latest changes could not be saved, so the file was not made.'); return; }
    const { res, body } = await apiFetch(`/api/boqs/${boqId}/export`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ currency: currency === 'BOTH' ? 'BDT' : currency, withCosting: false }),
    }).catch(() => ({ res: null, body: {} as Record<string, unknown> }));
    if (!res) return;
    if (!res.ok) { setErr(typeof body.error === 'string' ? body.error : 'Could not make the file.'); return; }
    for (const f of body.files as { id: string }[]) {
      const a = document.createElement('a');
      a.href = `/api/exports/${f.id}`; a.rel = 'noopener';
      document.body.appendChild(a); a.click(); a.remove();
      await new Promise((r) => setTimeout(r, 400));
    }
  }

  async function send() {
    setErr(null);
    if (!to.trim()) { setErr('Add the client’s e-mail address.'); return; }
    if (mode === 'upload' && (!file || !confirmed)) { setErr('Choose the Excel file you edited and confirm it is not the app’s copy.'); return; }
    setBusy(true);
    try {
      let init: RequestInit;
      if (mode === 'upload' && file) {
        const fd = new FormData();
        fd.set('to', to); fd.set('cc', cc); fd.set('subject', subject); fd.set('body', body); fd.set('currency', currency); fd.set('file', file);
        init = { method: 'POST', body: fd };
      } else {
        init = {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ to, cc, subject, body, currency, attachment: 'generated' }),
        };
      }
      const { res, body: b } = await apiFetch(`/api/boqs/${boqId}/send`, init);
      if (!res.ok) { setErr(typeof b.error === 'string' ? b.error : 'Sending failed.'); return; }
      onQueued(String(b.subject));
    } catch (e) {
      if (!(e instanceof SessionExpired)) setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const blockers = pre ? (mode === 'upload' ? pre.blockersUpload : pre.blockers) : [];
  const blocked = blockers.length > 0;
  const ready = mode === 'generated' || (!!file && confirmed);
  return (
    <Dialog labelledBy="sendTitle" onClose={onClose} busy={busy} width={680}>
        <div className="dh"><h2 id="sendTitle">Send BOQ {pre ? <span className="mono" style={{ fontSize: 17 }}>{pre.code}</span> : null}</h2>
          <button className="x" type="button" onClick={onClose} disabled={busy} aria-label="Close">×</button></div>

        {!pre && !loadErr && <p className="hint">Preparing…</p>}
        {loadErr && <p className="alert err" role="alert">{loadErr}</p>}

        {pre && (<>
          {blockers.map((b) => <p key={b} className="alert err" role="alert">{b}</p>)}
          {pre.warnings.map((w) => <p key={w} className="alert warn">{w}</p>)}
          <div className="kv"><span className="hint">From</span><b>{pre.mailbox ?? 'Company Gmail (not connected)'}</b></div>
          <label className="f"><span className="lbl">To <small>separate several with commas</small></span>
            <input ref={first} value={to} onChange={(e) => setTo(e.target.value)} type="text" inputMode="email" autoComplete="off" disabled={blocked || busy} placeholder="client@example.com" /></label>
          <label className="f"><span className="lbl">Cc <small>optional</small></span>
            <input value={cc} onChange={(e) => setCc(e.target.value)} type="text" inputMode="email" autoComplete="off" disabled={blocked || busy} /></label>
          <label className="f"><span className="lbl">Subject <small>{pre.code} is kept so the reply comes back to you</small></span>
            <input value={subject} onChange={(e) => setSubject(e.target.value)} maxLength={250} disabled={blocked || busy} /></label>
          <label className="f"><span className="lbl">Message</span>
            <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={9} maxLength={20000} disabled={blocked || busy} /></label>

          <div className="f"><span className="lbl">Attach Excel</span>
            <div className="choice" role="radiogroup" aria-label="Which file to attach">
              <label><input type="radio" name="sendFile" checked={mode === 'generated'} onChange={() => setMode('generated')} disabled={blocked || busy} />
                Fresh from this BOQ</label>
              <label><input type="radio" name="sendFile" checked={mode === 'upload'} onChange={() => setMode('upload')} disabled={blocked || busy} />
                The Excel I edited myself</label>
            </div>
          </div>

          {mode === 'generated' && (
            <div className="f"><span className="lbl">Currency</span>
              <div className="choice" role="radiogroup" aria-label="Attachment currency">
                {(['BDT', 'USD', 'BOTH'] as const).map((c) => (
                  <label key={c}><input type="radio" name="sendCur" checked={currency === c} onChange={() => setCurrency(c)} disabled={blocked || busy} />
                    {c === 'BOTH' ? 'Both (2 files)' : c}</label>
                ))}
              </div>
            </div>
          )}

          {mode === 'upload' && (
            <div className="f">
              <span className="lbl">Your file <small>one .xlsx, up to {pre.maxUploadMb} MB</small></span>
              <input type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                onChange={(e) => pick(e.currentTarget.files?.[0] ?? null)} disabled={blocked || busy} />
              {file && (
                <span className="filepick">
                  <span className="fname" title={file.name}>{file.name}</span>
                  <small>{(file.size / 1024 / 1024).toFixed(1)} MB</small>
                  <button type="button" className="x" aria-label={`Remove ${file.name}`} disabled={busy}
                    onClick={() => { setFile(null); setConfirmed(false); }}>×</button>
                </span>
              )}
              {fileErr && <p className="ferr" role="alert">{fileErr}</p>}
              <button className="btn small" type="button" onClick={downloadFresh} disabled={busy} style={{ alignSelf: 'flex-start' }}>
                Download a fresh copy to edit
              </button>
              <label className="chk"><input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} disabled={busy} />
                I understand the app cannot check the numbers in this file</label>
            </div>
          )}

          <p className="hint">
            Replies go to {pre.replyTo ?? 'the company Gmail'} and show up inside this BOQ, for you only.
            {mode === 'upload'
              ? ' Your file is sent exactly as uploaded, and the log records that it was edited by hand.'
              : ' After sending, this revision is locked; changes need a new revision.'} Today: {pre.daily.used} of {pre.daily.limit} recipients.
          </p>
          {err && <p className="ferr" role="alert">{err}</p>}
        </>)}

        <div className="formactions" style={{ borderTop: '1px solid var(--line)', paddingTop: 12 }}>
          <button className="btn" type="button" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn primary" type="button" onClick={send} disabled={!pre || blocked || busy || !ready}>
            {busy ? (mode === 'upload' ? 'Uploading…' : 'Preparing files…') : 'Send now'}
          </button>
        </div>
    </Dialog>
  );
}
