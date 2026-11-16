import { timingSafeEqual } from 'node:crypto';
import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/auth/session';
import { saveConnection } from '@/lib/mail/account';
import { getMailbox, getOAuthConfig } from '@/lib/mail/config';
import { exchangeCode, GMAIL_SCOPES, GmailClient, revokeToken } from '@/lib/mail/gmail';

const back = (q: string) => NextResponse.redirect(new URL(`/admin/gmail?${q}`, process.env.APP_URL));
const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/** Google redirects here after the boss signs in and allows access. */
export async function GET(req: Request) {
  const u = await getCurrentUser();
  if (!u?.permissions.has('integrations.gmail.manage')) return back('error=forbidden');
  const cfg = await getOAuthConfig();
  if (!cfg) return back('error=not_configured');

  const jar = await cookies();
  const raw = jar.get('gmail_oauth')?.value;
  jar.delete({ name: 'gmail_oauth', path: '/api/integrations/gmail' });
  const url = new URL(req.url);
  if (url.searchParams.get('error')) return back(`error=${encodeURIComponent(url.searchParams.get('error')!)}`);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state') ?? '';
  let saved: { state: string; verifier: string; uid: string } | null = null;
  try { saved = raw ? JSON.parse(raw) : null; } catch { saved = null; }
  if (!code || !saved || saved.uid !== u.id || !same(saved.state, state)) return back('error=state');

  try {
    const tok = await exchangeCode(cfg, code, saved.verifier);
    if (!tok.refreshToken) return back('error=no_refresh_token');
    const missing = GMAIL_SCOPES.filter((s) => !tok.scope.includes(s));
    if (missing.length) { await revokeToken(tok.refreshToken); return back('error=scopes'); }
    const profile = await new GmailClient(cfg, tok.refreshToken, fetch, tok.accessToken).profile();
    const expected = (await getMailbox())?.toLowerCase();
    if (expected && profile.emailAddress.toLowerCase() !== expected) {
      await revokeToken(tok.refreshToken);
      return back(`error=wrong_account&got=${encodeURIComponent(profile.emailAddress)}`);
    }
    await saveConnection(u.id, profile.emailAddress.toLowerCase(), tok.refreshToken, tok.scope, profile.historyId ?? null);
    return back('connected=1');
  } catch (e) {
    console.error('gmail connect failed', (e as Error).message);
    return back('error=exchange');
  }
}
