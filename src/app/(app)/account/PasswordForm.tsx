'use client';

import { useActionState } from 'react';
import { PasswordInput } from '@/components/ui/PasswordInput';
import { changePassword, type PwState } from './actions';

export function PasswordForm() {
  const [state, action, pending] = useActionState<PwState, FormData>(changePassword, {});
  return (
    <form action={action} className="card stack" style={{ maxWidth: 460 }}>
      <h2>Change password</h2>
      <label className="f"><span className="lbl">Current password</span><PasswordInput name="current" autoComplete="current-password" required /></label>
      <label className="f"><span className="lbl">New password <small>10+ characters, not only letters</small></span><PasswordInput name="next" autoComplete="new-password" required /></label>
      <label className="f"><span className="lbl">New password again</span><PasswordInput name="confirm" autoComplete="new-password" required /></label>
      {state.error && <p className="ferr" role="alert">{state.error}</p>}
      {state.ok && <p className="fok" role="status">{state.ok}</p>}
      <div className="formactions"><button className="btn primary" disabled={pending}>{pending ? 'Saving…' : 'Change password'}</button></div>
    </form>
  );
}
