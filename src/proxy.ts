import { NextResponse, type NextRequest } from 'next/server';

/**
 * Optimistic checks only (the real checks run on the server in every page, action and route):
 *  1. No session cookie -> send pages to /login, answer APIs with 401.
 *  2. CSRF: a state-changing request must come from our own origin.
 *  3. A hard cap on upload bodies, so one request cannot buffer hundreds of MB into memory.
 */
const PUBLIC = ['/login', '/forbidden', '/api/health'];
// Called by Google Pub/Sub (no session, no Origin); the route checks its own secret token.
const MACHINE = ['/api/integrations/gmail/push'];
const MAX_BODY_BYTES = 25 * 1024 * 1024;   // attachments: 5 × 10 MB, plus MIME overhead

export function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;
  const method = req.method.toUpperCase();
  if (MACHINE.includes(pathname)) return NextResponse.next();

  if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) {
    const origin = req.headers.get('origin');
    const allowed = new Set([req.nextUrl.origin, process.env.APP_URL].filter(Boolean));
    if (!origin || !allowed.has(origin)) {
      return NextResponse.json({ error: 'Request blocked (origin check).' }, { status: 403 });
    }

    const length = Number(req.headers.get('content-length') ?? '0');
    if (Number.isFinite(length) && length > MAX_BODY_BYTES) {
      return NextResponse.json({ error: 'That request is too large.' }, { status: 413 });
    }
  }

  const hasSession = req.cookies.has('hvac_session');
  if (!hasSession && !PUBLIC.some((p) => pathname === p || pathname.startsWith(p + '/'))) {
    if (pathname.startsWith('/api/')) return NextResponse.json({ error: 'Please sign in.' }, { status: 401 });
    const url = new URL('/login', req.url);
    if (pathname !== '/') url.searchParams.set('next', pathname + req.nextUrl.search);
    return NextResponse.redirect(url);
  }
  return NextResponse.next();
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|icon.svg).*)'],
};
