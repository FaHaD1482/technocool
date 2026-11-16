/**
 * Small helpers shared by the server actions, so every form reports failures the same way.
 */
import type { ZodError } from 'zod';

/** The message the user sees when validation fails. Zod always produces at least one issue, but say something sane anyway. */
export function firstIssue(error: ZodError, fallback = 'Some fields are not valid.'): string {
  return error.issues[0]?.message ?? fallback;
}
