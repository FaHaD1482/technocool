'use client';

import { useState } from 'react';
import { Confirm } from '@/components/ui/Confirm';
import { disconnectGmail } from './actions';

/** Disconnecting stops mail silently, so it asks first. */
export function DisconnectButton() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button className="btn reset" type="button" onClick={() => setOpen(true)}>Disconnect</button>
      {open && (
        <Confirm title="Disconnect the company Gmail?" confirmLabel="Disconnect" danger onClose={() => setOpen(false)}
          onConfirm={async () => { await disconnectGmail(); setOpen(false); }}>
          Sending stops immediately: anything queued waits until you reconnect, and client replies are no longer read.
          The Google access token is revoked too.
        </Confirm>
      )}
    </>
  );
}
