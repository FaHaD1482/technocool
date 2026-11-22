'use client';

import Link from 'next/link';
import { useActionState, useState } from 'react';
import { ClientPicker } from '@/components/ui/ClientPicker';
import { createBoq, type NewBoqState } from './actions';

interface Props {
  /** Whether any client exists; the picker itself searches the server as you type. */
  hasClients: boolean;
  brands: { id: number; name: string; fullName: string }[];
  canAddClient: boolean;
}

export function NewBoqForm({ hasClients, brands, canAddClient }: Props) {
  const [state, action, pending] = useActionState<NewBoqState, FormData>(createBoq, {});
  const f = state.fields ?? {};
  const [mode, setMode] = useState<'existing' | 'new'>(
    (f.clientMode as 'existing' | 'new') ?? (hasClients || !canAddClient ? 'existing' : 'new'));

  return (
    <form action={action} className="card stack" style={{ gap: 18, maxWidth: 760 }}>
      <section className="stack">
        <h2>1 · Client</h2>
        {canAddClient ? (
          <div className="choice" role="radiogroup" aria-label="Client">
            <label><input type="radio" name="clientMode" value="existing" checked={mode === 'existing'} onChange={() => setMode('existing')} disabled={!hasClients} /> Existing client</label>
            <label><input type="radio" name="clientMode" value="new" checked={mode === 'new'} onChange={() => setMode('new')} /> New client</label>
          </div>
        ) : (
          <input type="hidden" name="clientMode" value="existing" />
        )}
        {mode === 'existing' ? (
          <div className="f"><span className="lbl">Client <small>type to search</small></span>
            {/* key: a failed submit re-mounts it with the chosen client restored by id. */}
            <ClientPicker key={f.clientId ?? 'none'} name="clientId" initialId={f.clientId || undefined} required />
          </div>
        ) : (
          <div className="formgrid">
            <label className="f full"><span className="lbl">Client / company name</span><input name="clientName" defaultValue={f.clientName} required /></label>
            <label className="f"><span className="lbl">Contact person</span><input name="contactPerson" defaultValue={f.contactPerson} /></label>
            <label className="f"><span className="lbl">Phone</span><input name="clientPhone" defaultValue={f.clientPhone} inputMode="tel" /></label>
            <label className="f full"><span className="lbl">E-mail <small>the BOQ will be sent here</small></span><input name="clientEmail" type="email" defaultValue={f.clientEmail} /></label>
          </div>
        )}
      </section>

      <section className="stack">
        <h2>2 · Project</h2>
        <div className="formgrid">
          <label className="f full"><span className="lbl">Project name</span><input name="projectName" defaultValue={f.projectName} placeholder="e.g. 4-storey office" required /></label>
          <label className="f full"><span className="lbl">Site address</span><input name="siteAddress" defaultValue={f.siteAddress} placeholder="e.g. Gulshan, Dhaka" /></label>
          <label className="f full"><span className="lbl">BOQ title <small>optional</small></span><input name="title" defaultValue={f.title} placeholder="e.g. VRF system, floors 1-4" /></label>
        </div>
      </section>

      <section className="stack">
        <h2>3 · Equipment brand</h2>
        <p className="hint">You can switch brands inside the BOQ later to compare totals.</p>
        <div className="choice" role="radiogroup" aria-label="Brand">
          {brands.map((b, i) => (
            <label key={b.id}><input type="radio" name="brandId" value={b.id} defaultChecked={f.brandId ? f.brandId === String(b.id) : i === 0} /> {b.fullName}</label>
          ))}
        </div>
      </section>

      {state.error && <p className="alert err" role="alert">{state.error}</p>}
      <div className="formactions">
        <Link href="/boqs" className="btn">Cancel</Link>
        <button className="btn primary" disabled={pending}>{pending ? 'Creating…' : 'Create BOQ'}</button>
      </div>
    </form>
  );
}
