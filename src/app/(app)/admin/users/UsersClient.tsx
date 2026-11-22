'use client';

import { useActionState, useId, useState, useTransition } from 'react';
import { Confirm } from '@/components/ui/Confirm';
import { Dialog } from '@/components/ui/Dialog';
import { PasswordInput } from '@/components/ui/PasswordInput';
import { fmtDateTime } from '@/lib/format';
import { ROLES, ROLE_CODES, roleLabel } from '@/lib/labels';
import { addUser, changeRole, resetPassword, setActive, setPassword, type UserState } from './actions';

/** Admin types a password of their choice for a user (the alternative to a generated one-time password). */
function SetPasswordDialog({ user, isMe, onDone, onClose }: {
  user: UserRow; isMe: boolean; onDone: (s: UserState) => void; onClose: () => void;
}) {
  const id = useId();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    setError(null);
    setBusy(true);
    try {
      const s = await setPassword(user.id, String(fd.get('next') ?? ''), String(fd.get('confirm') ?? ''));
      if (s.error) setError(s.error);
      else onDone(s);
    } catch (err) {
      setError((err as Error).message || 'That did not work. Try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog labelledBy={id} onClose={onClose} busy={busy} width={460}>
      <form onSubmit={submit} className="stack">
        <div className="dh">
          <h2 id={id}>Change password for {user.fullName}</h2>
          <button className="x" type="button" onClick={onClose} disabled={busy} aria-label="Close">×</button>
        </div>
        <p className="hint">
          {isMe
            ? 'Your other devices will be signed out. This one stays signed in.'
            : `${user.email} will be signed out everywhere and must sign in with this password. Tell them privately.`}
        </p>
        <label className="f"><span className="lbl">New password <small>10+ characters, not only letters</small></span>
          <PasswordInput name="next" autoComplete="new-password" required data-autofocus /></label>
        <label className="f"><span className="lbl">New password again</span>
          <PasswordInput name="confirm" autoComplete="new-password" required /></label>
        {error && <p className="ferr" role="alert">{error}</p>}
        <div className="formactions" style={{ borderTop: '1px solid var(--line)', paddingTop: 12 }}>
          <button className="btn" type="button" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn primary" disabled={busy}>{busy ? 'Saving…' : 'Change password'}</button>
        </div>
      </form>
    </Dialog>
  );
}

export interface UserRow {
  id: string; email: string; fullName: string; designation: string | null; role: string | null;
  isActive: boolean; lastLogin: string | null; locked: boolean; boqs: number;
}

function Secret({ state }: { state: UserState }) {
  if (!state.error && !state.ok) return null;
  return (
    <div className={`alert ${state.error ? 'err' : 'ok'}`} role="status" style={{ flexDirection: 'column' }}>
      <span>{state.error ?? state.ok}</span>
      {state.password && <code className="mono" style={{ fontSize: 16, userSelect: 'all' }}>{state.password}</code>}
    </div>
  );
}

export function UsersClient({ users, me, canManage }: { users: UserRow[]; me: string; canManage: boolean }) {
  const [addState, addAction, adding] = useActionState<UserState, FormData>(addUser, {});
  const [rowState, setRowState] = useState<UserState>({});
  const [pending, start] = useTransition();
  const [ask, setAsk] = useState<{ kind: 'reset' | 'disable' | 'set'; user: UserRow } | null>(null);
  const run = (fn: () => Promise<UserState>) => start(async () => setRowState(await fn()));

  /** Confirmed actions close the dialog only when the server agrees. */
  const confirmed = async (fn: () => Promise<UserState>) => {
    const state = await fn();
    setRowState(state);
    if (!state.error) setAsk(null);
    return state.error ?? null;
  };

  return (
    <div className="stack" style={{ gap: 16 }}>
      <Secret state={rowState} />
      <div className="scroller">
        <table className="list">
          <thead><tr><th>Name</th><th>Role</th><th>Status</th><th className="n">BOQs</th><th>Last sign-in</th>{canManage && <th className="n">Actions</th>}</tr></thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id}>
                <td><b>{u.fullName}</b>{u.id === me && ' (you)'}<span className="sub">{u.email}{u.designation ? ` · ${u.designation}` : ''}</span></td>
                <td>
                  {canManage ? (
                    <select value={u.role ?? ''} disabled={pending} aria-label={`Role of ${u.fullName}`} onChange={(e) => run(() => changeRole(u.id, e.target.value))}>
                      {!u.role && <option value="">No role</option>}
                      {ROLE_CODES.map((c) => <option key={c} value={c}>{ROLES[c].label}</option>)}
                    </select>
                  ) : roleLabel(u.role)}
                </td>
                <td>{!u.isActive ? <span className="chip off">Disabled</span> : u.locked ? <span className="chip rejected">Locked</span> : <span className="chip accepted">Active</span>}</td>
                <td className="n">{u.boqs}</td>
                <td>{u.lastLogin ? fmtDateTime(u.lastLogin, 'Never') : 'Never'}</td>
                {canManage && (
                  <td className="n" style={{ whiteSpace: 'nowrap' }}>
                    <button className="btn small" disabled={pending} onClick={() => setAsk({ kind: 'set', user: u })}
                      title="Type a new password for this user">Change password</button>{' '}
                    <button className="btn small" disabled={pending} onClick={() => setAsk({ kind: 'reset', user: u })}
                      title="Generate a one-time password">Reset password</button>{' '}
                    {u.id !== me && (
                      u.isActive
                        ? <button className="btn small reset" disabled={pending} onClick={() => setAsk({ kind: 'disable', user: u })}>Disable</button>
                        : <button className="btn small" disabled={pending} onClick={() => run(() => setActive(u.id, true))}>Enable</button>
                    )}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {canManage && (
        <form action={addAction} className="card stack" style={{ maxWidth: 760 }}>
          <h2>Add employee</h2>
          <div className="formgrid">
            <label className="f"><span className="lbl">Full name</span><input name="fullName" required /></label>
            <label className="f"><span className="lbl">E-mail <small>their sign-in, and where reply notices go</small></span><input name="email" type="email" required /></label>
            <label className="f"><span className="lbl">Designation</span><input name="designation" placeholder="e.g. Sales Engineer" /></label>
            <label className="f"><span className="lbl">Role</span>
              <select name="role" defaultValue="estimator">
                {ROLE_CODES.map((c) => <option key={c} value={c}>{ROLES[c].label} · {ROLES[c].hint}</option>)}
              </select>
            </label>
          </div>
          <Secret state={addState} />
          <div className="formactions"><button className="btn primary" disabled={adding}>{adding ? 'Creating…' : 'Create account'}</button></div>
        </form>
      )}

      {ask?.kind === 'reset' && (
        <Confirm title={`Reset the password for ${ask.user.fullName}?`} confirmLabel="Reset password"
          onConfirm={() => confirmed(() => resetPassword(ask.user.id))} onClose={() => setAsk(null)}>
          A new temporary password is generated and shown once. Their current password stops working immediately.
        </Confirm>
      )}

      {ask?.kind === 'set' && (
        <SetPasswordDialog user={ask.user} isMe={ask.user.id === me} onClose={() => setAsk(null)}
          onDone={(s) => { setRowState(s); setAsk(null); }} />
      )}

      {ask?.kind === 'disable' && (
        <Confirm title={`Disable ${ask.user.fullName}?`} confirmLabel="Disable account" danger
          onConfirm={() => confirmed(() => setActive(ask.user.id, false))} onClose={() => setAsk(null)}>
          They are signed out and cannot sign in again until you enable the account. Their BOQs, clients and sent
          mail stay exactly as they are.
        </Confirm>
      )}
    </div>
  );
}
