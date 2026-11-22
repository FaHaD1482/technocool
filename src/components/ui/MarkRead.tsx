'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

/**
 * Marks a conversation or a BOQ's replies read **after** the page is shown, in a POST. Rendering a GET must not
 * write: a prefetch or a crawler used to be able to clear someone's notification badge.
 * `refresh` re-renders the server parts afterwards, so unread counts (mail sidebar, bell) drop at once.
 */
export function MarkRead({ threadId, boqId, refresh = false }: { threadId?: string; boqId?: string; refresh?: boolean }) {
  const router = useRouter();
  useEffect(() => {
    const body = threadId ? { threadId } : { boqId };
    void fetch('/api/notifications/read', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), keepalive: true,
    }).then((r) => { if (refresh && r.ok) router.refresh(); })
      .catch(() => { /* the badge simply stays until the next visit */ });
    // router is stable; re-running on it would post twice.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadId, boqId, refresh]);
  return null;
}
