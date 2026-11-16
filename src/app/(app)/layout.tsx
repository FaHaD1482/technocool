import Link from 'next/link';
import { AppShell, type NavItem } from '@/components/layout/AppShell';
import { NotificationBell } from '@/components/NotificationBell';
import { can, requireUser } from '@/lib/auth/session';
import { query } from '@/lib/db';
import { roleLabel } from '@/lib/labels';
import { getMailStatus } from '@/lib/mail/account';
import { unreadThreadCount } from '@/lib/mail/threads';
import { unreadCount } from '@/lib/replies';

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const u = await requireUser();
  const canUnmatched = can(u, 'mail.unmatched.manage');
  const canMail = can(u, 'mail.send');
  const [unread, unmatched, mail, mailUnread] = await Promise.all([
    unreadCount(u.id),
    canUnmatched ? query(`SELECT count(*)::int AS n FROM inbound_messages WHERE boq_id IS NULL AND thread_id IS NULL`).then((r) => r.rows[0].n as number) : 0,
    can(u, 'integrations.gmail.manage') ? getMailStatus() : null,
    canMail ? unreadThreadCount(u) : 0,
  ]);

  const nav: NavItem[] = [];
  if (canMail) nav.push({ href: '/inbox', label: 'Inbox', icon: 'inbox', badge: mailUnread });
  nav.push({ href: '/boqs', label: can(u, 'boq.view_all') ? 'All BOQs' : 'My BOQs', icon: 'boq' });
  if (can(u, 'crm.clients.view')) nav.push({ href: '/clients', label: 'Clients', icon: 'clients' });
  if (canUnmatched) nav.push({ href: '/admin/replies', label: 'Unmatched', icon: 'mail', badge: unmatched, group: 'admin' });
  if (can(u, 'iam.users.view')) nav.push({ href: '/admin/users', label: 'Users', icon: 'users', group: 'admin' });
  if (can(u, 'integrations.gmail.manage')) nav.push({ href: '/admin/gmail', label: 'Gmail', icon: 'mail', group: 'admin' });
  if (can(u, 'settings.company.manage')) nav.push({ href: '/admin/settings', label: 'Settings', icon: 'settings', group: 'admin' });

  // Admin banner: sending and replies are paused while the company Gmail is disconnected.
  const gmailDown = mail && (mail.status === 'revoked' || mail.status === 'error');
  const role = u.roles.map(roleLabel).join(', ');

  return (
    <AppShell
      items={nav}
      user={{ fullName: u.fullName, role }}
      bell={<NotificationBell initial={unread} />}
      banner={gmailDown ? (
        <div className="shell-banner">
          <div className="alert err" role="alert">
            <span><b>Gmail is disconnected, so sending BOQs and reading replies are paused.</b> {mail.detail}</span>
            <Link className="btn small" href="/admin/gmail">Reconnect</Link>
          </div>
        </div>
      ) : undefined}
    >
      {children}
    </AppShell>
  );
}
