'use client';

import { useEffect } from 'react';

/**
 * Marks a conversation or a BOQ's replies read **after** the page is shown, in a POST. Rendering a GET must not
 * write: a prefetch or a crawler used to be able to clear someone's notification badge.
 */
export function MarkRead({ threadId, boqId }: { threadId?: string; boqId?: string }) {
  useEffect(() => {
    const body = threadId ? { threadId } : { boqId };
    void fetch('/api/notifications/read', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), keepalive: true,
    }).catch(() => { /* the badge simply stays until the next visit */ });
  }, [threadId, boqId]);
  return null;
}
