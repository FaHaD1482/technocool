'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { logout } from '@/app/actions';
import { useFocusTrap } from '@/components/ui/Dialog';
import { ThemeToggle } from './ThemeToggle';
import { Icon, type IconName } from '@/components/ui/Icon';

export interface NavItem {
  href: string;
  label: string;
  icon: IconName;
  badge?: number;
  group?: 'main' | 'admin';
}

export interface ShellUser { fullName: string; role: string }

const NAV_KEY = 'hvac-nav';

/**
 * The signed-in shell: a collapsible rail (desktop), a top bar, and an off-canvas menu below 900px.
 * `data-nav` lives on <html> so the fixed dock in the BOQ editor can offset itself with the same value.
 */
export function AppShell({ items, user, bell, banner, children }: {
  items: NavItem[]; user: ShellUser; bell: ReactNode; banner?: ReactNode; children: ReactNode;
}) {
  const path = usePathname();
  const [open, setOpen] = useState(true);
  const [drawer, setDrawer] = useState(false);

  useEffect(() => {
    const saved = localStorage.getItem(NAV_KEY);
    setOpen(saved !== 'closed');
  }, []);

  useEffect(() => { setDrawer(false); }, [path]);

  const toggle = () => {
    const next = !open;
    setOpen(next);
    try { localStorage.setItem(NAV_KEY, next ? 'open' : 'closed'); } catch { /* private mode */ }
    document.documentElement.dataset.nav = next ? 'open' : 'closed';
  };

  const isCurrent = (href: string) => path === href || path.startsWith(href + '/');
  const main = items.filter((i) => (i.group ?? 'main') === 'main');
  const admin = items.filter((i) => i.group === 'admin');

  const link = (i: NavItem) => (
    <Link key={i.href} href={i.href} className="nav-item" title={i.label} aria-current={isCurrent(i.href) ? 'page' : undefined}>
      <Icon name={i.icon} />
      <span className="nav-label">{i.label}</span>
      {!!i.badge && <span className="badge-n hot">{i.badge > 99 ? '99+' : i.badge}</span>}
    </Link>
  );

  const nav = (
    <nav className="nav" aria-label="Main">
      <div className="nav-group">{main.map(link)}</div>
      {admin.length > 0 && (
        <div className="nav-group">
          <div className="nav-group-title">Admin</div>
          {admin.map(link)}
        </div>
      )}
    </nav>
  );

  const account = (
    <div className="sidebar-foot">
      <Link href="/account" className="who">
        <b>{user.fullName}</b>
        <small>{user.role || 'No role'}</small>
      </Link>
      <form action={logout}>
        <button className="btn small ghost" type="submit" title="Sign out">
          <Icon name="logout" size={15} />
          <span className="nav-label">Sign out</span>
        </button>
      </form>
    </div>
  );

  return (
    <div className="shell">
      <a className="skip" href="#content">Skip to content</a>

      <aside className="sidebar">
        <div className="sidebar-head">
          <Link href="/boqs" className="brandmark"><span className="logo">BQ</span><b>HVAC BOQ</b></Link>
          <button className="ib nav-collapse" type="button" onClick={toggle}
            aria-label={open ? 'Collapse menu' : 'Expand menu'} aria-expanded={open} title={open ? 'Collapse menu' : 'Expand menu'}>
            <Icon name="menu" />
          </button>
        </div>
        {nav}
        {account}
      </aside>

      <div className="shell-body">
        <header className="topbar">
          <button className="ib nav-open" type="button" onClick={() => setDrawer(true)} aria-label="Open menu" aria-expanded={drawer}>
            <Icon name="menu" />
          </button>
          <Link href="/boqs" className="brandmark topbar-brand"><span className="logo">BQ</span><b>HVAC BOQ</b></Link>
          <div className="topbar-actions">
            <ThemeToggle />
            {bell}
          </div>
        </header>
        {banner}
        {/* A div, not <main>: every page renders its own <main>, and nesting them is invalid HTML. */}
        <div id="content">{children}</div>
      </div>

      {drawer && (
        <NavSheet onClose={() => setDrawer(false)}>
          <div className="nav-sheet-head">
            <Link href="/boqs" className="brandmark"><span className="logo">BQ</span><b>HVAC BOQ</b></Link>
            <button className="x" type="button" onClick={() => setDrawer(false)} aria-label="Close menu">×</button>
          </div>
          {nav}
          {account}
        </NavSheet>
      )}
    </div>
  );
}

/** The off-canvas menu: mounted only while open, so the focus trap applies exactly then. */
function NavSheet({ onClose, children }: { onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLElement>(null);
  useFocusTrap(ref, { onClose });
  return (
    <div className="nav-drawer">
      <div className="scrim" onClick={onClose} />
      <aside ref={ref} className="nav-sheet" role="dialog" aria-modal="true" aria-label="Menu" tabIndex={-1}>
        {children}
      </aside>
    </div>
  );
}
