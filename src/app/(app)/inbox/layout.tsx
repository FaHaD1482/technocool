import type { ReactNode } from 'react';
import { MailShell } from '@/components/inbox/MailShell';
import { can, requirePermission } from '@/lib/auth/session';
import { getMailStatus } from '@/lib/mail/account';
import { unreadThreadCount } from '@/lib/mail/threads';
import './mail.css';

/** Shared Gmail-style frame for the inbox, a conversation and the full-page composer. */
export default async function InboxLayout({ children }: { children: ReactNode }) {
  const u = await requirePermission('mail.send');
  const [mail, unread] = await Promise.all([getMailStatus(), unreadThreadCount(u)]);
  // Gmail admins already get the red "Reconnect" banner from the app shell when it is revoked or failing.
  const shellShowsIt = can(u, 'integrations.gmail.manage') && (mail.status === 'revoked' || mail.status === 'error');
  const banner = !mail.connected && !shellShowsIt ? (
    <p className="alert warn m-banner" role="status">
      <span>
        {mail.status === 'revoked'
          ? 'The company Gmail is disconnected. Ask the admin to reconnect it.'
          : 'The company Gmail is not connected yet. Ask the admin to set it up.'}{' '}
        Nothing can be sent until then.
      </span>
    </p>
  ) : undefined;
  return <MailShell unread={unread} banner={banner}>{children}</MailShell>;
}
