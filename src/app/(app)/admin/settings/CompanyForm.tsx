'use client';

import { useActionState } from 'react';
import { saveCompanySettings, type CompanyState } from './actions';

interface Row {
  company_name: string;
  address: string | null;
  phone: string | null;
  email: string | null;
  vat_reg_no: string | null;
}

export function CompanyForm({ row }: { row: Row }) {
  const [state, action, pending] = useActionState<CompanyState, FormData>(saveCompanySettings, {});
  return (
    <form action={action} className="card stack">
      <h2>Company details</h2>
      <p className="hint">The company name is the default “From” name on BOQ e-mails and fills the <code>{'{company}'}</code> placeholder. A sender name on the Gmail page overrides it.</p>
      <label className="f"><span className="lbl">Company name</span>
        <input name="companyName" defaultValue={row.company_name} maxLength={200} required autoFocus /></label>
      <div className="formgrid">
        <label className="f"><span className="lbl">Phone</span><input name="phone" defaultValue={row.phone ?? ''} inputMode="tel" maxLength={50} /></label>
        <label className="f"><span className="lbl">E-mail</span><input name="email" type="email" defaultValue={row.email ?? ''} maxLength={200} /></label>
        <label className="f"><span className="lbl">VAT / BIN registration</span><input name="vatRegNo" defaultValue={row.vat_reg_no ?? ''} maxLength={50} /></label>
        <label className="f full"><span className="lbl">Address</span><input name="address" defaultValue={row.address ?? ''} maxLength={500} /></label>
      </div>
      {state.error && <p className="ferr" role="alert">{state.error}</p>}
      {state.ok && <p className="fok" role="status">{state.ok}</p>}
      <div className="formactions">
        <button className="btn primary" disabled={pending}>{pending ? 'Saving…' : 'Save settings'}</button>
      </div>
    </form>
  );
}
