'use client';

import { useActionState } from 'react';
import { saveTemplate, type TplState } from './actions';

export function TemplateForm({ fromName, companyName, subject, body }: { fromName: string; companyName: string; subject: string; body: string }) {
  const [state, action, pending] = useActionState<TplState, FormData>(saveTemplate, {});
  return (
    <form action={action} className="card" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <h2>E-mail template</h2>
      <p className="hint">
        Placeholders: <code>{'{contact} {client} {project} {code} {currency_note} {sender_name} {sender_designation} {sender_phone} {company}'}</code>.
        The BOQ code (e.g. [BOQ-2026-0012 R1]) is always added to the subject; it is how replies find their BOQ.
        Employees can edit the text before each send.
      </p>
      <label className="f"><span className="lbl">Sender name <small>shown as “From”; empty = company name ({companyName})</small></span>
        <input name="fromName" defaultValue={fromName} maxLength={100} /></label>
      <label className="f"><span className="lbl">Subject</span><input name="subject" defaultValue={subject} maxLength={200} required /></label>
      <label className="f"><span className="lbl">Message</span><textarea name="body" defaultValue={body} rows={12} maxLength={5000} required /></label>
      {state.error && <p className="ferr" role="alert">{state.error}</p>}
      {state.ok && <p className="fok" role="status">{state.ok}</p>}
      <div className="formactions"><button className="btn primary" disabled={pending}>{pending ? 'Saving…' : 'Save template'}</button></div>
    </form>
  );
}
