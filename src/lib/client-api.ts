/**
 * Browser-side fetch for the app's own JSON/form endpoints.
 *
 * A 401 means the session expired (cookie gone, or an admin disabled the account): the right answer is the
 * sign-in page, not "something went wrong". Without this the user got a generic error and kept clicking.
 */

export class SessionExpired extends Error {
  constructor() { super('Your session expired. Taking you to the sign-in page…'); }
}

function goToLogin() {
  const here = window.location.pathname + window.location.search;
  const next = here.startsWith('/login') ? '' : `?next=${encodeURIComponent(here)}`;
  window.location.assign(`/login${next}`);
}

/** Returns the parsed body whether the response was ok or not, so callers can read `error`. */
export async function apiFetch(url: string, init?: RequestInit): Promise<{ res: Response; body: Record<string, unknown> }> {
  const res = await fetch(url, init);
  if (res.status === 401) {
    goToLogin();
    throw new SessionExpired();
  }
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { res, body };
}

/** For callers that only want the error message, or null when the request succeeded. */
export function errorOf(body: Record<string, unknown>, fallback: string): string | null {
  return typeof body.error === 'string' ? body.error : fallback;
}
