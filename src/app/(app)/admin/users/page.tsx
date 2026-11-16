import { can, requirePermission } from '@/lib/auth/session';
import { query } from '@/lib/db';
import { UsersClient, type UserRow } from './UsersClient';

export const metadata = { title: 'Users' };

export default async function UsersPage() {
  const me = await requirePermission('iam.users.view');
  const { rows } = await query(`
    SELECT u.id, u.email, u.full_name, u.designation, u.is_active, u.last_login_at, (u.locked_until > now()) AS locked,
           (SELECT r.code FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = u.id ORDER BY r.id LIMIT 1) AS role,
           (SELECT count(*) FROM boqs b WHERE b.owner_user_id = u.id AND b.deleted_at IS NULL AND b.status <> 'superseded') AS boqs
    FROM app_users u ORDER BY u.is_active DESC, lower(u.full_name)`);
  const users: UserRow[] = rows.map((r) => ({
    id: r.id, email: r.email, fullName: r.full_name, designation: r.designation, role: r.role,
    isActive: r.is_active, lastLogin: r.last_login_at?.toISOString() ?? null, locked: !!r.locked, boqs: r.boqs,
  }));
  return (
    <main className="wrap page">
      <div className="pagehead"><div><h1>Users</h1><p>Employees sign in with their own account. Only the admin connects the company Gmail.</p></div></div>
      <UsersClient users={users} me={me.id} canManage={can(me, 'iam.users.manage')} />
    </main>
  );
}
