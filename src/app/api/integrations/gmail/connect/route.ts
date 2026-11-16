import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { apiUser, handle } from '@/lib/api';
import { getMailbox, getOAuthConfig } from '@/lib/mail/config';
import { authorizeUrl, newPkce } from '@/lib/mail/gmail';

const OAUTH_COOKIE = 'gmail_oauth';

/**
 * Admin only: starts Google sign-in for the boss Gmail (PKCE + state, stored in a short-lived httpOnly cookie).
 * Deliberately a form POST: a GET that sets a cookie can be triggered by any link on another site.
 */
export const POST = handle(async () => {
  const u = await apiUser('integrations.gmail.manage');
  const cfg = await getOAuthConfig();
  if (!cfg) return NextResponse.redirect(new URL('/admin/gmail?error=not_configured', process.env.APP_URL));
  const { verifier, challenge, state } = newPkce();
  (await cookies()).set(OAUTH_COOKIE, JSON.stringify({ state, verifier, uid: u.id }), {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production' || (process.env.APP_URL ?? '').startsWith('https://'),
    sameSite: 'lax', path: '/api/integrations/gmail', maxAge: 600,
  });
  return NextResponse.redirect(authorizeUrl(cfg, state, challenge, (await getMailbox()) ?? undefined));
});
