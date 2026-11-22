/**
 * Offset pagination shared by every list page. The page number comes from `?page=` and is clamped, so a
 * hand-typed or stale URL can never ask the database for a negative or absurd offset.
 */
export const PAGE_SIZE = 50;
const MAX_PAGE = 10_000;

export interface Page { page: number; size: number; offset: number }

export function parsePage(raw: string | string[] | undefined, size = PAGE_SIZE): Page {
  const n = Number.parseInt(Array.isArray(raw) ? (raw[0] ?? '') : (raw ?? ''), 10);
  const page = Number.isFinite(n) && n >= 1 ? Math.min(n, MAX_PAGE) : 1;
  return { page, size, offset: (page - 1) * size };
}

export function pageCount(total: number, size: number): number {
  return Math.max(1, Math.ceil(total / size));
}

/** Builds `/path?a=1&page=2`, keeping the other filters and dropping empty values and page 1. */
export function pageHref(path: string, params: Record<string, string | undefined>, page: number): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) p.set(k, v);
  if (page > 1) p.set('page', String(page));
  const s = p.toString();
  return s ? `${path}?${s}` : path;
}

/** Page links to show: always first and last, the current one with a neighbour each side, gaps as null. */
export function pageNumbers(current: number, last: number): (number | null)[] {
  const want = new Set([1, last, current - 1, current, current + 1].filter((n) => n >= 1 && n <= last));
  const sorted = [...want].sort((a, b) => a - b);
  const out: (number | null)[] = [];
  sorted.forEach((n, i) => {
    if (i > 0 && n - sorted[i - 1]! > 1) out.push(null);
    out.push(n);
  });
  return out;
}

/** Escapes a search term for `ILIKE '%…%'`. */
export const likePattern = (q: string) => `%${q.replace(/[%_\\]/g, '\\$&')}%`;
