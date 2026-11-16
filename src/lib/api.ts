import 'server-only';
import { NextResponse } from 'next/server';
import { ZodError } from 'zod';
import { getCurrentUser, type Permission, type SessionUser } from '@/lib/auth/session';
import { isLockedError } from '@/lib/db';

export class ApiError extends Error {
  constructor(public status: number, message: string, public code?: string) { super(message); }
}

export async function apiUser(perm?: Permission): Promise<SessionUser> {
  const u = await getCurrentUser();
  if (!u) throw new ApiError(401, 'Please sign in again.');
  if (perm && !u.permissions.has(perm)) throw new ApiError(403, 'You do not have permission to do that.');
  return u;
}

/** Wraps a route handler: maps known errors to JSON, never leaks stack traces. */
export function handle<A extends unknown[]>(fn: (...args: A) => Promise<Response>) {
  return async (...args: A): Promise<Response> => {
    try {
      return await fn(...args);
    } catch (e) {
      if (e instanceof ApiError) return NextResponse.json({ error: e.message, code: e.code }, { status: e.status });
      if (e instanceof ZodError) return NextResponse.json({ error: 'Some fields are not valid.', issues: e.issues.slice(0, 10) }, { status: 400 });
      if (isLockedError(e)) return NextResponse.json({ error: (e as Error).message, code: 'boq_locked' }, { status: 409 });
      console.error(e);
      return NextResponse.json({ error: 'Something went wrong on the server.' }, { status: 500 });
    }
  };
}
