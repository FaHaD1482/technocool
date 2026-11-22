import Link from 'next/link';
import { pageCount, pageHref, pageNumbers } from '@/lib/paging';
import { Icon } from './Icon';

/**
 * "51–100 of 312" with Previous / numbered pages / Next. Links keep every other filter in the URL.
 * `compact` is the Gmail-style "1–50 of 312 ‹ ›" used in the mail list header.
 */
export function Pager({ path, params, page, size, total, compact = false }: {
  path: string; params: Record<string, string | undefined>; page: number; size: number; total: number; compact?: boolean;
}) {
  const last = pageCount(total, size);
  const from = total === 0 ? 0 : (page - 1) * size + 1;
  const to = Math.min(total, page * size);
  const n = (x: number) => x.toLocaleString('en-US');
  const range = total === 0 ? '0 of 0'
    : from > total ? `Page ${n(page)} is past the end · ${n(total)} in all`
    : `${n(from)}–${n(to)} of ${n(total)}`;
  const prev = page > 1 ? pageHref(path, params, page - 1) : null;
  const next = page < last ? pageHref(path, params, page + 1) : null;

  const arrow = (href: string | null, dir: 'prev' | 'next') => {
    const label = dir === 'prev' ? 'Newer / previous page' : 'Older / next page';
    const icon = <Icon name="chevron" size={18} style={{ transform: `rotate(${dir === 'prev' ? 90 : -90}deg)` }} />;
    return href
      ? <Link className="pg-arrow" href={href} aria-label={label} title={label}>{icon}</Link>
      : <span className="pg-arrow" aria-disabled="true">{icon}</span>;
  };

  if (compact) {
    return (
      <nav className="pager compact" aria-label="Pages">
        <span className="pg-range">{range}</span>
        {arrow(prev, 'prev')}
        {arrow(next, 'next')}
      </nav>
    );
  }
  if (total <= size && page === 1) return total ? <p className="pager-note">{range}</p> : null;

  return (
    <nav className="pager" aria-label="Pages">
      <span className="pg-range">{range}</span>
      <span className="pg-links">
        {prev ? <Link className="btn small" href={prev}>Previous</Link> : <span className="btn small" aria-disabled="true">Previous</span>}
        {pageNumbers(page, last).map((n, i) => n === null
          ? <span key={`gap-${i}`} className="pg-gap">…</span>
          : <Link key={n} className={`pg-num${n === page ? ' on' : ''}`} href={pageHref(path, params, n)}
              aria-current={n === page ? 'page' : undefined}>{n}</Link>)}
        {next ? <Link className="btn small" href={next}>Next</Link> : <span className="btn small" aria-disabled="true">Next</span>}
      </span>
    </nav>
  );
}
