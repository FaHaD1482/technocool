/**
 * Minimal Google OAuth + Gmail REST client (no SDK). Used by the OAuth callback (web) and the worker.
 * Scopes: gmail.send to send, gmail.readonly to read the real Message-ID of a sent mail and (phase 5) replies.
 */
import { createHash, randomBytes } from 'node:crypto';

export const GMAIL_SCOPES = ['https://www.googleapis.com/auth/gmail.send', 'https://www.googleapis.com/auth/gmail.readonly'];
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const API = 'https://gmail.googleapis.com/gmail/v1/users/me';
const UPLOAD = 'https://gmail.googleapis.com/upload/gmail/v1/users/me';

export interface OAuthConfig { clientId: string; clientSecret: string; redirectUri: string }

/** The refresh token no longer works (revoked, password changed, testing-mode expiry). Sending must pause. */
export class GmailAuthError extends Error {}
/** Google answered with an error that may pass (rate limit, 5xx). */
export class GmailApiError extends Error {
  constructor(message: string, public status: number, public retryable: boolean) { super(message); }
}

type Fetch = typeof fetch;

export interface GmailMessageRef { id: string; threadId: string; labelIds?: string[] }
export interface GmailPart {
  partId?: string; mimeType?: string; filename?: string;
  headers?: { name: string; value: string }[];
  body?: { size?: number; data?: string; attachmentId?: string };
  parts?: GmailPart[];
}
export interface GmailMessage extends GmailMessageRef { snippet?: string; internalDate?: string; sizeEstimate?: number; payload?: GmailPart }

// ---------- OAuth (connect once) ----------
export function newPkce() {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge, state: randomBytes(24).toString('base64url') };
}

export function authorizeUrl(cfg: OAuthConfig, state: string, challenge: string, loginHint?: string) {
  const u = new URL(AUTH_URL);
  u.search = new URLSearchParams({
    client_id: cfg.clientId, redirect_uri: cfg.redirectUri, response_type: 'code', scope: GMAIL_SCOPES.join(' '),
    access_type: 'offline', prompt: 'consent', state, code_challenge: challenge, code_challenge_method: 'S256',
    ...(loginHint ? { login_hint: loginHint } : {}),
  }).toString();
  return u.toString();
}

export async function exchangeCode(cfg: OAuthConfig, code: string, verifier: string, f: Fetch = fetch) {
  const res = await f(TOKEN_URL, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ code, client_id: cfg.clientId, client_secret: cfg.clientSecret, redirect_uri: cfg.redirectUri, grant_type: 'authorization_code', code_verifier: verifier }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Google refused the sign-in: ${body.error_description ?? body.error ?? res.status}`);
  return { accessToken: body.access_token as string, refreshToken: (body.refresh_token as string | undefined) ?? null, scope: String(body.scope ?? '').split(' ').filter(Boolean) };
}

export async function revokeToken(token: string, f: Fetch = fetch) {
  await f(`${REVOKE_URL}?token=${encodeURIComponent(token)}`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }).catch(() => {});
}

// ---------- Gmail API ----------
export class GmailClient {
  private token: { value: string; exp: number } | null = null;

  constructor(private cfg: Pick<OAuthConfig, 'clientId' | 'clientSecret'>, private refreshToken: string, private f: Fetch = fetch, accessToken?: string) {
    if (accessToken) this.token = { value: accessToken, exp: Date.now() + 50 * 60_000 };
  }

  async accessToken(): Promise<string> {
    if (this.token && this.token.exp > Date.now() + 60_000) return this.token.value;
    const res = await this.f(TOKEN_URL, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: this.cfg.clientId, client_secret: this.cfg.clientSecret, refresh_token: this.refreshToken, grant_type: 'refresh_token' }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (body.error === 'invalid_grant' || body.error === 'unauthorized_client' || res.status === 401) {
        throw new GmailAuthError(`Gmail access was revoked or expired (${body.error_description ?? body.error}). The admin must reconnect.`);
      }
      throw new GmailApiError(`Token refresh failed: ${body.error ?? res.status}`, res.status, res.status >= 500 || res.status === 429);
    }
    this.token = { value: body.access_token, exp: Date.now() + Number(body.expires_in ?? 3600) * 1000 };
    return this.token.value;
  }

  private async call(url: string, init: RequestInit = {}): Promise<any> {
    const res = await this.f(url, { ...init, headers: { ...(init.headers ?? {}), Authorization: `Bearer ${await this.accessToken()}` } });
    const body = await res.json().catch(() => ({}));
    if (res.ok) return body;
    const msg = body.error?.message ?? res.statusText;
    if (res.status === 401) { this.token = null; throw new GmailAuthError(`Gmail rejected the access token: ${msg}`); }
    if (res.status === 403 && /insufficient|scope/i.test(msg)) throw new GmailAuthError(`Gmail permission missing: ${msg}. Reconnect and allow all requested access.`);
    throw new GmailApiError(`Gmail error ${res.status}: ${msg}`, res.status, res.status === 429 || res.status >= 500 || /rate|quota/i.test(msg));
  }

  profile(): Promise<{ emailAddress: string; historyId: string }> {
    return this.call(`${API}/profile`);
  }

  /** Upload endpoint: accepts the raw message as-is (up to 35 MB). */
  send(raw: Buffer): Promise<{ id: string; threadId: string }> {
    return this.call(`${UPLOAD}/messages/send?uploadType=media`, { method: 'POST', headers: { 'Content-Type': 'message/rfc822' }, body: new Uint8Array(raw) });
  }

  /** Files the message into an existing Gmail thread, so the client sees a normal reply chain. */
  sendInThread(raw: Buffer, threadId: string): Promise<{ id: string; threadId: string }> {
    return this.call(`${API}/messages/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ raw: raw.toString('base64url'), threadId }),
    });
  }

  /** New messages since a history id. Throws GmailApiError(404) when the id is too old (then do a full resync). */
  history(startHistoryId: string, pageToken?: string): Promise<{ history?: { messagesAdded?: { message: GmailMessageRef }[] }[]; historyId: string; nextPageToken?: string }> {
    const q = new URLSearchParams({ startHistoryId, historyTypes: 'messageAdded', labelId: 'INBOX', maxResults: '500', ...(pageToken ? { pageToken } : {}) });
    return this.call(`${API}/history?${q}`);
  }

  listMessages(q: string, pageToken?: string): Promise<{ messages?: GmailMessageRef[]; nextPageToken?: string }> {
    const p = new URLSearchParams({ q, maxResults: '200', ...(pageToken ? { pageToken } : {}) });
    return this.call(`${API}/messages?${p}`);
  }

  /** Was this exact Message-ID already delivered? Used to reconcile a send that was interrupted mid-flight. */
  async findByMessageId(messageId: string): Promise<{ id: string; threadId: string } | null> {
    const r = await this.listMessages(`rfc822msgid:${messageId}`);
    const m = r.messages?.[0];
    return m ? { id: m.id, threadId: m.threadId } : null;
  }

  /** format=metadata reads only the headers we name (no body), format=full reads everything. */
  getMessage(id: string, format: 'metadata' | 'full', metadataHeaders: string[] = []): Promise<GmailMessage> {
    const p = new URLSearchParams({ format });
    for (const h of metadataHeaders) p.append('metadataHeaders', h);
    return this.call(`${API}/messages/${encodeURIComponent(id)}?${p}`);
  }

  async attachment(messageId: string, attachmentId: string): Promise<Buffer> {
    const a = await this.call(`${API}/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`);
    return Buffer.from(String(a.data ?? ''), 'base64url');
  }

  /** Pub/Sub push for INBOX changes; must be renewed at least every 7 days. */
  watch(topicName: string): Promise<{ historyId: string; expiration: string }> {
    return this.call(`${API}/watch`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ topicName, labelIds: ['INBOX'], labelFilterBehavior: 'INCLUDE' }) });
  }

  /** Gmail may replace our Message-ID, so read back what was really sent. */
  async headers(id: string, names: string[]): Promise<Record<string, string>> {
    const q = names.map((n) => `metadataHeaders=${encodeURIComponent(n)}`).join('&');
    const m = await this.call(`${API}/messages/${encodeURIComponent(id)}?format=metadata&${q}`);
    const out: Record<string, string> = {};
    for (const h of m.payload?.headers ?? []) out[String(h.name).toLowerCase()] = h.value;
    return out;
  }
}
