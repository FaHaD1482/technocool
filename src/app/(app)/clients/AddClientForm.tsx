'use client';

import { useActionState, useEffect, useRef } from 'react';
import { addClient, type ClientState } from './actions';

export function AddClientForm() {
  const [state, action, pending] = useActionState<ClientState, FormData>(addClient, {});
  const form = useRef<HTMLFormElement>(null);
  useEffect(() => { if (state.ok) form.current?.reset(); }, [state]);
  return (
    <form ref={form} action={action} className="card stack">
      <h2>Add client</h2>
      <div className="formgrid">
        <label className="f full"><span className="lbl">Client / company name</span><input name="name" required /></label>
        <label className="f"><span className="lbl">Contact person</span><input name="contactPerson" /></label>
        <label className="f"><span className="lbl">Phone</span><input name="phone" inputMode="tel" /></label>
        <label className="f full"><span className="lbl">E-mail <small>BOQs are sent here</small></span><input name="email" type="email" /></label>
        <label className="f full"><span className="lbl">Address</span><input name="address" /></label>
      </div>
      {state.error && <p className="ferr" role="alert">{state.error}</p>}
      {state.ok && <p className="fok" role="status">{state.ok}</p>}
      <div className="formactions"><button className="btn primary" disabled={pending}>{pending ? 'Adding…' : 'Add client'}</button></div>
    </form>
  );
}
