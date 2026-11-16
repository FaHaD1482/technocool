/**
 * The words and chip colours the app uses for the same concepts, in one place.
 *
 * Before this, "queued" was "Waiting" on the Gmail page, "Waiting to send" in the send log and nothing at all
 * in a conversation. Repeating the maps also meant a new status could be added in one screen and missed in
 * another. Import from here instead of re-declaring a map.
 */

/** BOQ lifecycle. The chip class matches the CSS chip modifiers. */
export const BOQ_STATUS: Record<string, { label: string; chip: string }> = {
  draft: { label: 'Draft', chip: 'draft' },
  sent: { label: 'Sent', chip: 'sent' },
  accepted: { label: 'Accepted', chip: 'accepted' },
  rejected: { label: 'Rejected', chip: 'rejected' },
  superseded: { label: 'Old revision', chip: 'off' },
  in_review: { label: 'In review', chip: 'draft' },
  approved: { label: 'Approved', chip: 'accepted' },
};

/** Outgoing mail: a row in boq_emails or mail_messages. */
export const EMAIL_STATUS: Record<string, { label: string; chip: string }> = {
  queued: { label: 'Waiting to send', chip: 'sent' },
  sending: { label: 'Sending…', chip: 'sent' },
  sent: { label: 'Sent', chip: 'accepted' },
  failed: { label: 'Failed', chip: 'rejected' },
};

/** A status the database knows but this build does not: show it rather than an empty cell. */
export const labelOf = (map: Record<string, { label: string }>, code: string | null | undefined) =>
  (code && map[code]?.label) || code || '—';

export const chipOf = (map: Record<string, { chip: string }>, code: string | null | undefined) =>
  (code && map[code]?.chip) || 'off';

export type RoleCode = 'admin' | 'manager' | 'estimator' | 'viewer';

/** Role vocabulary. `hint` is what the person picking a role reads. */
export const ROLES: Record<RoleCode, { label: string; hint: string }> = {
  admin: { label: 'Administrator', hint: 'Everything, incl. users and Gmail' },
  manager: { label: 'Manager', hint: 'All BOQs, clients and price lists' },
  estimator: { label: 'Estimator', hint: 'Builds and sends own BOQs; sees only own BOQs' },
  viewer: { label: 'Viewer', hint: 'Read-only, no costs' },
};

/** Select order: least privileged last, so the list reads like the permission ladder. */
export const ROLE_CODES: RoleCode[] = ['estimator', 'manager', 'admin', 'viewer'];

export const roleLabel = (code: string | null | undefined) =>
  (code && ROLES[code as RoleCode]?.label) || code || 'No role';
