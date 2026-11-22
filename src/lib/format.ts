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

const DAY_KEY = new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit', timeZone: TIME_ZONE });
const MAIL_TIME = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', timeZone: TIME_ZONE });
const MAIL_DAY = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: TIME_ZONE });
const MAIL_OLD = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: TIME_ZONE });
const MAIL_FULL = new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: TIME_ZONE });

/** Gmail-style list date: "3:45 PM" today, "Nov 9" this year, "9 Nov 2025" before that. */
export function fmtMailDate(v: Dateish, now: Date = new Date()): string {
  const d = toDate(v);
  if (!d) return '';
  const day = DAY_KEY.format(d);
  const today = DAY_KEY.format(now);
  if (day === today) return MAIL_TIME.format(d);
  if (day.slice(0, 4) === today.slice(0, 4)) return MAIL_DAY.format(d);
  return MAIL_OLD.format(d);
}

/** "Sat, Nov 21, 2026, 3:45 PM" — the full date on an opened message. */
export function fmtMailFull(v: Dateish): string {
  const d = toDate(v);
  return d ? MAIL_FULL.format(d) : '';
}
