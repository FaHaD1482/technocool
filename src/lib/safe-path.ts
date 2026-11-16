/**
 * Only a same-site path may be used for a post-login redirect or a notification link.
 * Blocks absolute URLs, protocol-relative `//host`, the `/\host` browser-normalisation trick and encoded separators.
 */
export function safeInternalPath(raw: unknown, fallback = '/boqs'): string {
  if (typeof raw !== 'string') return fallback;
  const s = raw.trim();
  if (!s.startsWith('/') || s.startsWith('//') || s.startsWith('/\\') || s.includes('\\')) return fallback;
  if (/[\u0000-\u001f]/.test(s) || /%(2f|5c|00)/i.test(s)) return fallback;
  try {
    const u = new URL(s, 'http://internal.invalid');
    if (u.origin !== 'http://internal.invalid') return fallback;
    return `${u.pathname}${u.search}${u.hash}`;
  } catch {
    return fallback;
  }
}
