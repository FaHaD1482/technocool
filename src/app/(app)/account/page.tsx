import { requireUser } from '@/lib/auth/session';
import { PasswordForm } from './PasswordForm';

export const metadata = { title: 'My account' };

export default async function AccountPage() {
  const u = await requireUser();
  return (
    <main className="wrap page page-narrow">
      <div className="pagehead"><div><h1>My account</h1><p>Your sign-in details and password.</p></div></div>
      <div className="card stack">
        <div className="kv"><span className="hint">Name</span><b>{u.fullName}</b></div>
        <div className="kv"><span className="hint">E-mail</span><b>{u.email}</b></div>
        <div className="kv"><span className="hint">Role</span><b>{u.roles.join(', ') || 'No role'}</b></div>
        {u.designation && <div className="kv"><span className="hint">Designation</span><b>{u.designation}</b></div>}
      </div>
      <PasswordForm />
    </main>
  );
}
