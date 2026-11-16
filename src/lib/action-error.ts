import 'server-only';
import { ZodError } from 'zod';
import { ApiError } from '@/lib/api';
import { isLockedError } from '@/lib/db';

/**
 * A message that is safe to show in a server action result. Database errors (constraint names, uuid syntax, …) are
 * logged, never returned to the browser.
 */
export function actionError(e: unknown, fallback = 'Something went wrong. Please try again.'): string {
  if (e instanceof ApiError) return e.message;
  if (e instanceof ZodError) return e.issues[0]?.message ?? fallback;
  if (isLockedError(e)) return (e as Error).message;
  console.error('server action failed:', e);
  return fallback;
}
