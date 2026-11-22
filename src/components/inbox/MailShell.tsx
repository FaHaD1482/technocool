'use client';

import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import { createContext, Suspense, useContext, useEffect, useState, type ReactNode } from 'react';
import { Icon, type IconName } from '@/components/ui/Icon';
import { ComposeForm } from './ComposeForm';

const ComposeCtx = createContext<(() => void) | null>(null);

/** Opens the floating compose window from anywhere inside the mail pages (e.g. an empty-state button). */
export function useCompose() {
  return useContext(ComposeCtx);
}

export function ComposeButton({ className = 'btn primary', children }: { className?: string; children: ReactNode }) {
  const open = useCompose();
  if (!open) return <Link className={className} href="/inbox/new">{children}</Link>;
  return <button type="button" className={className} onClick={open}>{children}</button>;
}

const FOLDERS: { v: string; label: string; icon: IconName }[] = [
  { v: 'all', label: 'Inbox', icon: 'inbox' },
  { v: 'unread', label: 'Unread', icon: 'unread' },
  { v: 'boq', label: 'BOQ mail', icon: 'boq' },
  { v: 'general', label: 'Official mail', icon: 'mail' },
];

function Folders({ unread }: { unread: number }) {
  const path = usePathname();
  const sp = useSearchParams();
  const current = path === '/inbox' ? (sp.get('filter') ?? 'all') : null;
  return (
    <nav className="m-folders" aria-label="Mail folders">
      {FOLDERS.map((f) => (
        <Link key={f.v} href={f.v === 'all' ? '/inbox' : `/inbox?filter=${f.v}`} className="m-folder"
          aria-current={current === f.v ? 'page' : undefined}>
          <Icon name={f.icon} size={18} />
          <span>{f.label}</span>
          {(f.v === 'all' || f.v === 'unread') && unread > 0 && <b className="m-count">{unread}</b>}
        </Link>
      ))}
    </nav>
  );
}

/**
 * The Gmail-like frame around every mail page: a Compose button and folders on the left, the page on the right,
 * and the compose window floating bottom-right. On phones the folders become a scrolling chip row and Compose a
 * round button, like the Gmail app.
 */
export function MailShell({ unread, banner, children }: {
  unread: number; banner?: ReactNode; children: ReactNode;
}) {
  const path = usePathname();
  const [compose, setCompose] = useState(false);
  const [key, setKey] = useState(0);
  const open = () => { setKey((k) => k + 1); setCompose(true); };
  const onNewPage = path === '/inbox/new';

  // The full-page composer replaces the floating one.
  useEffect(() => { if (onNewPage) setCompose(false); }, [onNewPage]);

  return (
    <ComposeCtx.Provider value={open}>
      <div className="mail">
        <aside className="m-side">
          <button type="button" className="m-compose-btn" onClick={open} disabled={onNewPage}>
            <Icon name="pencil" size={20} /> Compose
          </button>
          <Suspense fallback={null}><Folders unread={unread} /></Suspense>
        </aside>
        <main className="m-main">
          {banner}
          {children}
        </main>
      </div>
      {!onNewPage && (
        <button type="button" className="m-fab" onClick={open} aria-label="Compose" hidden={compose}>
          <Icon name="pencil" size={22} /> <span>Compose</span>
        </button>
      )}
      {compose && (
        <div className="m-float">
          <ComposeForm key={key} initial={{}} variant="float" onClose={() => setCompose(false)} />
        </div>
      )}
    </ComposeCtx.Provider>
  );
}
