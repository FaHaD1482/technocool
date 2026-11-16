import 'server-only';
import { query, tx } from '@/lib/db';
import { encryptSecret } from './crypto';
import { readConfig, resolveMailbox, resolveOAuthConfig, SECRET_AAD, storedConfig, type Sql } from './config-core';
import type { OAuthConfig } from './gmail';

/**
 * Gmail OAuth client settings for the web app: saved in Admin → Gmail (preferred, no restart needed) or read from
 * GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_REDIRECT_URI in .env.local. See config-core for the shared logic.
 */
const sql: Sql = (text, params) => query(text, params);

export { SECRET_AAD };
export type { MailConfigSource, MailConfigView } from './config-core';

export async function getOAuthConfig(): Promise<OAuthConfig | null> {
  return resolveOAuthConfig(sql);
}

export async function getMailbox(): Promise<string | null> {
  return resolveMailbox(sql);
}

export async function readMailConfig() {
  return readConfig(sql);
}

/** A blank secret keeps the one already stored, so editing the mailbox does not require re-pasting it. */
export async function saveMailConfig(
  userId: string,
  input: { clientId: string; clientSecret: string; mailbox: string; redirectUri: string },
): Promise<void> {
  const r = await storedConfig(sql);
  const enc = input.clientSecret ? encryptSecret(input.clientSecret, undefined, SECRET_AAD) : r?.client_secret_enc ?? null;
  if (!enc) throw new Error('Paste the Google client secret once.');
  await tx(userId, (db) => db.query(
    `INSERT INTO mail_config (id, client_id, client_secret_enc, mailbox, redirect_uri, updated_by)
     VALUES (1, $1, $2, $3, $4, $5)
     ON CONFLICT (id) DO UPDATE SET client_id = EXCLUDED.client_id, client_secret_enc = EXCLUDED.client_secret_enc,
       mailbox = EXCLUDED.mailbox, redirect_uri = EXCLUDED.redirect_uri, updated_by = EXCLUDED.updated_by`,
    [input.clientId, enc, input.mailbox, input.redirectUri, userId]));
  await query(`SELECT pg_notify('boq_mail', 'config')`);
}

export async function clearMailConfig(userId: string): Promise<void> {
  await tx(userId, (db) => db.query('DELETE FROM mail_config WHERE id = 1'));
  await query(`SELECT pg_notify('boq_mail', 'config')`);
}
