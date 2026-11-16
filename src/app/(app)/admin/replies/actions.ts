'use server';

import { revalidatePath } from 'next/cache';
import { getCurrentUser } from '@/lib/auth/session';
import { actionError } from '@/lib/action-error';
import { assignReply, discardReply } from '@/lib/replies';

export type ActState = { error?: string; ok?: string };

export async function assign(replyId: string, boqId: string): Promise<ActState> {
  const u = await getCurrentUser();
  if (!u) return { error: 'Please sign in again.' };
  try {
    await assignReply(u, replyId, boqId);
    revalidatePath('/admin/replies');
    return { ok: 'Assigned. The BOQ owner has been notified.' };
  } catch (e) {
    return { error: actionError(e) };
  }
}

export async function discard(replyId: string): Promise<ActState> {
  const u = await getCurrentUser();
  if (!u) return { error: 'Please sign in again.' };
  try {
    await discardReply(u, replyId);
    revalidatePath('/admin/replies');
    return { ok: 'Discarded.' };
  } catch (e) {
    return { error: actionError(e) };
  }
}
