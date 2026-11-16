'use client';

import { useActionState } from 'react';
import { PasswordInput } from '@/components/ui/PasswordInput';
import { login, type LoginState } from './actions';

export function LoginForm({ next }: { next?: string }) {
  const [state, action, pending] = useActionState<LoginState, FormData>(login, {});
  return (
    <form action={action} className="authcard" noValidate>
      <div>
        <div className="brandmark" style={{ marginBottom: 14 }}><span className="logo">BQ</span><b>HVAC BOQ</b></div>
        <h1>Sign in</h1>
        <p className="hint">Use the account your admin gave you.</p>
      </div>
      <input type="hidden" name="next" value={next ?? ''} />
      <label className="f"><span className="lbl">E-mail</span>
        <input name="email" type="email" autoComplete="username" defaultValue={state.email} required autoFocus />
      </label>
      <label className="f"><span className="lbl">Password</span>
        <PasswordInput name="password" autoComplete="current-password" required />
      </label>
      {state.error && <p className="ferr" role="alert">{state.error}</p>}
      <button className="btn primary" disabled={pending}>{pending ? 'Signing in…' : 'Sign in'}</button>
      <p className="hint">Forgot your password? Ask the admin to reset it.</p>
    </form>
  );
}
