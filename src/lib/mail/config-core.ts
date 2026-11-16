/**
 * Gmail OAuth client settings, resolution core. Deliberately free of `server-only` and `@/lib/db`, so the
 * background worker (a plain Node process with its own pg pool) can read the same settings as the web app.
 * The client secret is encrypted with GMAIL_TOKEN_KEY, which stays in the environment.
 */
import { decryptSecret } from './crypto';
import type { OAuthConfig } from './gmail';

export const SECRET_AAD = 'hvac-boq:mail_config:client_secret';
const CALLBACK_PATH = '/api/integrations/gmail/callback';

/** Anything that can run a parameterised query: the app's pool, or the worker's. */
export type Sql = (text: string, params?: unknown[]) => Promise<{ rows: unknown[] }>;

export interface StoredConfig {
  client_id: string | null;
  client_secret_enc: Buffer | null;
  mailbox: string | null;
  redirect_uri: string | null;
}

export type MailConfigSource = 'database' | 'env' | 'none';

export interface MailConfigView {
  clientId: string;
  mailbox: string;
  redirectUri: string;
  hasSecret: boolean;
  source: MailConfigSource;
}

export const defaultRedirect = () => `${(process.env.APP_URL ?? '').replace(/\/+$/, '')}${CALLBACK_PATH}`;

export async function storedConfig(sql: Sql): Promise<StoredConfig | null> {
  try {
    const { rows } = await sql(`SELECT client_id, client_secret_enc, mailbox, redirect_uri FROM mail_config WHERE id = 1`);
    return (rows[0] as StoredConfig | undefined) ?? null;
  } catch {
    return null;   // not migrated yet: fall back to the environment
  }
}

export function envConfig(): OAuthConfig | null {
  const { GOOGLE_CLIENT_ID: clientId, GOOGLE_CLIENT_SECRET: clientSecret } = process.env;
  return clientId && clientSecret ? { clientId, clientSecret, redirectUri: process.env.GOOGLE_REDIRECT_URI || defaultRedirect() } : null;
}

export async function resolveOAuthConfig(sql: Sql): Promise<OAuthConfig | null> {
  const r = await storedConfig(sql);
  if (r?.client_id && r.client_secret_enc) {
    try {
      return {
        clientId: r.client_id,
        clientSecret: decryptSecret(r.client_secret_enc, undefined, SECRET_AAD),
        redirectUri: r.redirect_uri || defaultRedirect(),
      };
    } catch {
      // A changed GMAIL_TOKEN_KEY makes the saved secret unreadable: fall through to the environment.
    }
  }
  return envConfig();
}

/** The company Gmail address the app must connect (and refuses any other account). */
export async function resolveMailbox(sql: Sql): Promise<string | null> {
  const r = await storedConfig(sql);
  return r?.mailbox || process.env.GMAIL_ADDRESS || null;
}

/** What the admin form shows. The secret itself is never read back into a page. */
export async function readConfig(sql: Sql): Promise<MailConfigView> {
  const r = await storedConfig(sql);
  const env = envConfig();
  return {
    clientId: r?.client_id ?? process.env.GOOGLE_CLIENT_ID ?? '',
    mailbox: r?.mailbox ?? process.env.GMAIL_ADDRESS ?? '',
    redirectUri: r?.redirect_uri ?? process.env.GOOGLE_REDIRECT_URI ?? defaultRedirect(),
    hasSecret: !!(r?.client_secret_enc || process.env.GOOGLE_CLIENT_SECRET),
    source: r?.client_id && r.client_secret_enc ? 'database' : env ? 'env' : 'none',
  };
}
