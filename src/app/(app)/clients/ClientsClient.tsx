'use client';

import { useActionState, useEffect, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Dialog } from '@/components/ui/Dialog';
import { deleteClient, updateClient, type ClientState } from './actions';

export interface ClientRow {
  id: string;
  name: string;
  contact_person: string | null;
  email: string | null;
  phone: string | null;
  address: string | null;
  projects: number;
}

export function ClientsClient({ rows, canManage }: { rows: ClientRow[]; canManage: boolean }) {
  const router = useRouter();
  const [editing, setEditing] = useState<ClientRow | null>(null);
  const [removing, setRemoving] = useState<ClientRow | null>(null);
  const [msg, setMsg] = useState<ClientState>({});

  const done = (state: ClientState) => {
    setEditing(null);
    setRemoving(null);
    setMsg(state);
    router.refresh();
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, minWidth: 0 }}>
      {msg.error && <p className="alert err" role="alert">{msg.error}</p>}
      {msg.ok && <p className="alert ok" role="status">{msg.ok}</p>}
      <div className="scroller">
        <table className="list">
          <thead><tr><th>Client</th><th>E-mail</th><th>Phone</th><th className="n">Projects</th>{canManage && <th className="n">Actions</th>}</tr></thead>
          <tbody>
            {rows.length === 0 && <tr><td colSpan={canManage ? 5 : 4} className="empty-state">No clients yet.</td></tr>}
            {rows.map((c) => (
              <tr key={c.id}>
                <td><b>{c.name}</b>{c.contact_person && <span className="sub">{c.contact_person}</span>}</td>
                <td>{c.email ?? <span className="chip off">No e-mail</span>}</td>
                <td>{c.phone ?? '—'}</td>
                <td className="n">{c.projects}</td>
                {canManage && (
                  <td className="n" style={{ whiteSpace: 'nowrap' }}>
                    <button className="btn small" type="button" onClick={() => setEditing(c)}>Edit</button>{' '}
                    <button className="btn small reset" type="button" onClick={() => setRemoving(c)}>Delete</button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {editing && <EditClient client={editing} onClose={() => setEditing(null)} onSaved={done} />}
      {removing && <RemoveClient client={removing} onClose={() => setRemoving(null)} onRemoved={done} />}
    </div>
  );
}

function EditClient({ client, onClose, onSaved }: { client: ClientRow; onClose: () => void; onSaved: (s: ClientState) => void }) {
  const [state, action, pending] = useActionState<ClientState, FormData>(updateClient, {});
  useEffect(() => { if (state.ok) onSaved(state); }, [state]);   // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <Dialog labelledBy="editClientTitle" onClose={onClose} busy={pending} width={620}>
        <div className="dh"><h2 id="editClientTitle">Edit client</h2>
          <button className="x" type="button" onClick={onClose} disabled={pending} aria-label="Close">×</button></div>
        <form action={action} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <input type="hidden" name="id" value={client.id} />
          <div className="formgrid">
            <label className="f full"><span className="lbl">Client / company name</span><input name="name" defaultValue={client.name} required /></label>
            <label className="f"><span className="lbl">Contact person</span><input name="contactPerson" defaultValue={client.contact_person ?? ''} /></label>
            <label className="f"><span className="lbl">Phone</span><input name="phone" inputMode="tel" defaultValue={client.phone ?? ''} /></label>
            <label className="f full"><span className="lbl">E-mail <small>BOQs are sent here</small></span><input name="email" type="email" defaultValue={client.email ?? ''} /></label>
            <label className="f full"><span className="lbl">Address</span><input name="address" defaultValue={client.address ?? ''} /></label>
          </div>
          {state.error && <p className="ferr" role="alert">{state.error}</p>}
          <div className="formactions" style={{ borderTop: '1px solid var(--line)', paddingTop: 12 }}>
            <button className="btn" type="button" onClick={onClose} disabled={pending}>Cancel</button>
            <button className="btn primary" disabled={pending}>{pending ? 'Saving…' : 'Save changes'}</button>
          </div>
        </form>
    </Dialog>
  );
}

function RemoveClient({ client, onClose, onRemoved }: { client: ClientRow; onClose: () => void; onRemoved: (s: ClientState) => void }) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const remove = () => start(async () => {
    const s = await deleteClient(client.id);
    if (s.error) setError(s.error); else onRemoved(s);
  });

  return (
    <Dialog labelledBy="removeClientTitle" onClose={onClose} busy={pending} width={460}>
        <div className="dh"><h2 id="removeClientTitle">Remove {client.name}?</h2>
          <button className="x" type="button" onClick={onClose} disabled={pending} aria-label="Close">×</button></div>
        <p className="hint" style={{ margin: 0 }}>
          The client disappears from this list and from new BOQs. Its {client.projects} project{client.projects === 1 ? '' : 's'},
          the BOQs already built on them and all sent mail stay exactly as they are.
        </p>
        {error && <p className="ferr" role="alert">{error}</p>}
        <div className="formactions" style={{ borderTop: '1px solid var(--line)', paddingTop: 12 }}>
          <button className="btn" type="button" onClick={onClose} disabled={pending}>Cancel</button>
          <button className="btn danger" type="button" onClick={remove} disabled={pending}>{pending ? 'Removing…' : 'Remove client'}</button>
        </div>
    </Dialog>
  );
}
