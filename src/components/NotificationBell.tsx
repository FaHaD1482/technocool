'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';

/** Bell with the unread count; refreshes every minute and on every page change. */
export function NotificationBell({ initial }: { initial: number }) {
  const [n, setN] = useState(initial);
  const path = usePathname();
  useEffect(() => {
    let alive = true;
    const load = () => fetch('/api/notifications', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).then((b) => { if (alive && b) setN(b.unread); }).catch(() => {});
    load();
    const t = setInterval(load, 60_000);
    const onFocus = () => load();
    window.addEventListener('focus', onFocus);
    return () => { alive = false; clearInterval(t); window.removeEventListener('focus', onFocus); };
  }, [path]);
  return (
    <Link href="/notifications" className="bell" aria-label={n ? `${n} unread notifications` : 'Notifications'} title="Notifications">
      <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 2.5a5 5 0 0 0-5 5v3l-1.5 2.5h13L15 10.5v-3a5 5 0 0 0-5-5zM8 15.5a2 2 0 0 0 4 0" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" /></svg>
      {n > 0 && <span className="bell-n">{n > 99 ? '99+' : n}</span>}
    </Link>
  );
}
