import 'server-only';
import { hash, verify } from '@node-rs/argon2';
import { ARGON2_OPTIONS } from './password-options';

export const hashPassword = (pw: string) => hash(pw, ARGON2_OPTIONS);

// Verifying against a dummy hash when the user does not exist keeps response time the same,
// so the login form does not reveal which e-mail addresses have accounts.
let dummy: Promise<string> | null = null;
export async function verifyPassword(stored: string | null, pw: string): Promise<boolean> {
  if (!stored) {
    dummy ??= hash('not-a-real-password', ARGON2_OPTIONS);
    await verify(await dummy, pw).catch(() => false);
    return false;
  }
  try {
    return await verify(stored, pw);
  } catch {
    return false;
  }
}

/** Minimum rules: 10+ characters, not only letters or only digits. */
export function passwordProblem(pw: string): string | null {
  if (pw.length < 10) return 'Use at least 10 characters.';
  if (pw.length > 200) return 'That password is too long.';
  if (/^[a-zA-Z]+$/.test(pw) || /^\d+$/.test(pw)) return 'Mix letters with numbers or symbols.';
  return null;
}
