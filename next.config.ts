import type { NextConfig } from 'next';
import { PHASE_DEVELOPMENT_SERVER } from 'next/constants';

const base: NextConfig = {
  poweredByHeader: false,
  // Node-only libraries: load them with plain require on the server, never bundle them.
  serverExternalPackages: ['pg', 'exceljs', '@node-rs/argon2'],
};

/**
 * A strict CSP for the shipped app: only our own origin, no plugins, no framing, no eval.
 * Development adds `eval` and a websocket because the framework's HMR needs them; production does not.
 */
export default function config(phase: string): NextConfig {
  const dev = phase === PHASE_DEVELOPMENT_SERVER;
  const csp = [
    "default-src 'self'",
    "base-uri 'none'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "style-src 'self' 'unsafe-inline'",
    `script-src 'self' 'unsafe-inline'${dev ? " 'unsafe-eval'" : ''}`,
    `connect-src 'self'${dev ? ' ws: wss:' : ''}`,
    "worker-src 'self' blob:",
  ].join('; ');

  const securityHeaders = [
    { key: 'Content-Security-Policy', value: csp },
    { key: 'X-Frame-Options', value: 'DENY' },
    { key: 'X-Content-Type-Options', value: 'nosniff' },
    { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
    { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=()' },
    { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
    // Only meaningful over HTTPS; harmless (and ignored) on http://localhost.
    { key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains' },
  ];

  return {
    ...base,
    async headers() {
      return [{ source: '/:path*', headers: securityHeaders }];
    },
  };
}
