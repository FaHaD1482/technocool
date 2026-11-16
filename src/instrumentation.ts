/**
 * Runs once when the Next.js server starts (not during `next build`). Keeps a misconfigured deployment from
 * starting half-working: see src/lib/env.ts.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { assertEnv } = await import('./lib/env');
    assertEnv();
  }
}
