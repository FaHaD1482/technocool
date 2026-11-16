'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth/session';
import { markRead, notificationHref } from '@/lib/replies';

export async function markAllRead() {
  const u = await getCurrentUser();
  if (!u) redirect('/login');
  await markRead(u.id, null);
  revalidatePath('/notifications');
}

/**
 * Mark one notification read and open what it is about. The link is computed on the server from the notification
 * row — the client no longer passes a URL, so it cannot be used as an open redirect.
 */
export async function openNotification(id: string) {
  const u = await getCurrentUser();
  if (!u) redirect('/login');
  const href = await notificationHref(u.id, id);
  await markRead(u.id, id);
  redirect(href ?? '/notifications');
}
