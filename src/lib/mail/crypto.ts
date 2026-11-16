/**
 * AES-256-GCM for the Gmail refresh token and the OAuth client secret. The key comes from GMAIL_TOKEN_KEY
 * (32 bytes, base64) and never touches the database or the code. Stored layout: iv(12) | auth tag(16) | ciphertext.
 * The AAD binds a ciphertext to its column, so it cannot be copied into another column or table.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const TOKEN_AAD = 'hvac-boq:mail_accounts:refresh_token';

/**
 * A key/decryption problem (missing, wrong length, or a different key than the one used to encrypt) — never a
 * transient network error. The worker treats it like a revoked token: pause sending and ask for a reconnect.
 */
export class SecretError extends Error {}

function key(raw = process.env.GMAIL_TOKEN_KEY): Buffer {
  if (!raw) throw new SecretError('GMAIL_TOKEN_KEY is not set (npm run gen-secret).');
  const k = Buffer.from(raw, 'base64');
  if (k.length !== 32) throw new SecretError('GMAIL_TOKEN_KEY must be 32 bytes, base64-encoded.');
  return k;
}

export function encryptSecret(plain: string, rawKey?: string, aad = TOKEN_AAD): Buffer {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key(rawKey), iv);
  c.setAAD(Buffer.from(aad));
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]);
}

export function decryptSecret(blob: Buffer, rawKey?: string, aad = TOKEN_AAD): string {
  if (blob.length < 29) throw new SecretError('The encrypted value is too short to be valid.');
  try {
    const d = createDecipheriv('aes-256-gcm', key(rawKey), blob.subarray(0, 12));
    d.setAAD(Buffer.from(aad));
    d.setAuthTag(blob.subarray(12, 28));
    return Buffer.concat([d.update(blob.subarray(28)), d.final()]).toString('utf8');
  } catch (e) {
    if (e instanceof SecretError) throw e;
    throw new SecretError('The stored value cannot be decrypted with the current GMAIL_TOKEN_KEY. Press Reconnect on the Gmail page.');
  }
}
