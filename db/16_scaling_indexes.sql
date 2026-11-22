-- Indexes for paginated lists and search, so pages stay fast with tens of thousands of BOQs, clients and mails.
--  * Lists are ordered by date and paged: index the sort column (with the same partial WHERE as the queries).
--  * "Contains" search (ILIKE '%term%') cannot use a btree; pg_trgm GIN indexes make it an index lookup.
--  * Conversations are opened by thread_id on every table that holds messages.
BEGIN;

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- BOQ list: newest first, per owner for estimators, overall for admin / manager.
CREATE INDEX IF NOT EXISTS boqs_updated_idx       ON boqs (updated_at DESC, id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS boqs_owner_updated_idx ON boqs (owner_user_id, updated_at DESC) WHERE deleted_at IS NULL;

-- BOQ list search: BOQ number, title, project and client name.
CREATE INDEX IF NOT EXISTS boqs_boq_no_trgm   ON boqs     USING gin (boq_no gin_trgm_ops);
CREATE INDEX IF NOT EXISTS boqs_title_trgm    ON boqs     USING gin (title gin_trgm_ops);
CREATE INDEX IF NOT EXISTS projects_name_trgm ON projects USING gin (name gin_trgm_ops);

-- Client list / pickers: search by name, e-mail, contact.
CREATE INDEX IF NOT EXISTS clients_name_trgm    ON clients USING gin (name gin_trgm_ops) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS clients_email_trgm   ON clients USING gin (email gin_trgm_ops) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS clients_contact_trgm ON clients USING gin (contact_person gin_trgm_ops) WHERE deleted_at IS NULL;

-- Inbox: everyone's mail (admin / manager) newest first, and subject search.
CREATE INDEX IF NOT EXISTS mail_threads_last_idx     ON mail_threads (last_message_at DESC, id);
CREATE INDEX IF NOT EXISTS mail_threads_subject_trgm ON mail_threads USING gin (subject gin_trgm_ops);

-- Opening a conversation and the list's per-row counts: messages by our thread id.
-- (inbound_thread_idx / boq_emails_thread_idx are on the *Gmail* thread id, not ours.)
CREATE INDEX IF NOT EXISTS inbound_messages_thread_idx ON inbound_messages (thread_id, received_at) WHERE thread_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS boq_emails_thread_id_idx    ON boq_emails (thread_id) WHERE thread_id IS NOT NULL;

-- Unmatched replies page.
CREATE INDEX IF NOT EXISTS inbound_unsorted_idx ON inbound_messages (received_at DESC) WHERE boq_id IS NULL AND thread_id IS NULL;

-- "Unread" badges and filter: a user's unread notifications for a conversation.
CREATE INDEX IF NOT EXISTS notifications_thread_unread_idx ON notifications (thread_id, user_id) WHERE read_at IS NULL;

COMMIT;
