import 'server-only';
import path from 'node:path';
import { z } from 'zod';

const Schema = z.object({
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is missing').refine((v) => /^postgres(ql)?:\/\//.test(v), 'DATABASE_URL must be a postgres:// URL'),
  APP_URL: z.string().url('APP_URL must be a full URL, e.g. https://boq.example.com'),
  GMAIL_TOKEN_KEY: z.string().optional(),
  STORAGE_DIR: z.string().optional(),
  MAIL_DAILY_RECIPIENT_LIMIT: z.string().regex(/^\d+$/, 'must be a whole number').optional(),
  REPLY_POLL_SECONDS: z.string().regex(/^\d+$/, 'must be a whole number').optional(),
});

/**
 * Checked once when the server starts (instrumentation.ts), so a missing or malformed setting fails loudly at boot
 * instead of half-working later (a wrong APP_URL used to silently drop `Secure` from the session cookie).
 */
export function assertEnv() {
  const parsed = Schema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`The environment is not configured:\n${issues}\nSee .env.example and copy it to .env.local.`);
  }

  const key = process.env.GMAIL_TOKEN_KEY?.trim();
  if (key) {
    const bytes = Buffer.from(key, 'base64');
    if (bytes.length !== 32) throw new Error('GMAIL_TOKEN_KEY must be 32 bytes, base64-encoded (npm run gen-secret).');
  }

  if (process.env.NODE_ENV === 'production') {
    if ((process.env.APP_URL ?? '').startsWith('https://') === false) {
      console.warn('[env] APP_URL is not https:// — session cookies will not be marked Secure. Serve the app over HTTPS.');
    }
    if (process.env.STORAGE_DIR && !path.isAbsolute(process.env.STORAGE_DIR)) {
      throw new Error('STORAGE_DIR must be an absolute path in production, so the web app and the worker use the same folder.');
    }
  }

  console.log(`[env] ok — storage: ${path.resolve(process.env.STORAGE_DIR || './storage')}`);
}
