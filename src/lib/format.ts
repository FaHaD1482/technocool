/**
 * All human-readable dates go through here, so every screen shows the same timezone and format.
 * `Intl` is used directly (not a library) and the timezone is explicit: without it the server renders in UTC
 * and the browser in local time, which showed the same e-mail with two different timestamps.
 */
export const TIME_ZONE = 'Asia/Dhaka';

type Dateish = Date | string | number | null | undefined;

function toDate(v: Dateish): Date | null {
  if (v === null || v === undefined || v === '') return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

const DAY_MONTH_YEAR = new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: TIME_ZONE });
const DAY_MONTH_TIME = new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: TIME_ZONE });
const FULL = new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: TIME_ZONE });
const TIME = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: TIME_ZONE });

/** 05 Nov 2026 */
export function fmtDate(v: Dateish, fallback = '—'): string {
  const d = toDate(v);
  return d ? DAY_MONTH_YEAR.format(d) : fallback;
}

/** 05 Nov, 14:30 */
export function fmtDateTime(v: Dateish, fallback = '—'): string {
  const d = toDate(v);
  return d ? DAY_MONTH_TIME.format(d) : fallback;
}

/** 05 Nov 2026, 14:30 */
export function fmtDateTimeFull(v: Dateish, fallback = '—'): string {
  const d = toDate(v);
  return d ? FULL.format(d) : fallback;
}

/** 14:30 */
export function fmtTime(v: Dateish, fallback = '—'): string {
  const d = toDate(v);
  return d ? TIME.format(d) : fallback;
}
