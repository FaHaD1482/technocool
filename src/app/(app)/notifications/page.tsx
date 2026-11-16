import { requireUser } from '@/lib/auth/session';
import { listNotifications } from '@/lib/replies';
import { Icon, type IconName } from '@/components/ui/Icon';
import { fmtDateTime } from '@/lib/format';
import { markAllRead, openNotification } from './actions';

export const metadata = { title: 'Notifications' };

const ICON: Record<string, IconName> = {
  reply_received: 'mail', reply_unmatched: 'inbox', send_succeeded: 'check', send_failed: 'alert', gmail_disconnected: 'alert', boq_assigned: 'boq',
  message_received: 'inbox', message_sent: 'send', message_failed: 'alert',
};

export default async function NotificationsPage() {
  const u = await requireUser();
  const items = await listNotifications(u.id);
  const unread = items.filter((n) => !n.readAt).length;
  return (
    <main className="wrap page page-narrow">
      <div className="pagehead">
        <div><h1>Notifications</h1><p>{unread ? `${unread} unread` : 'All caught up.'}</p></div>
        {unread > 0 && <form action={markAllRead}><button className="btn">Mark all read</button></form>}
      </div>
      {items.length === 0 ? (
        <div className="card empty-state"><h2>Nothing yet</h2><p>Client replies to your BOQs and send results show up here.</p></div>
      ) : (
        <div className="scroller notes">
          {items.map((n) => (
            <form key={n.id} action={openNotification.bind(null, n.id)} className={`note${n.readAt ? '' : ' unread'}`}>
              <span className="dot" aria-hidden="true" />
              <span aria-hidden="true" className="note-icon"><Icon name={ICON[n.type] ?? 'bell'} size={16} /></span>
              <button className="open txt" type="submit">
                <b>{n.title}</b>
                {n.body && <small>{n.body}</small>}
                <small style={{ display: 'block' }}>{fmtDateTime(n.createdAt)}{n.readAt ? '' : ' · unread'}</small>
              </button>
            </form>
          ))}
        </div>
      )}
    </main>
  );
}
