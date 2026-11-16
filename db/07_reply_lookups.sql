-- =====================================================================
--  File 7: lookups used when matching client replies
-- =====================================================================
BEGIN;
CREATE INDEX IF NOT EXISTS clients_email_idx        ON clients (email) WHERE deleted_at IS NULL AND email IS NOT NULL;
CREATE INDEX IF NOT EXISTS boq_emails_boqno_idx     ON boq_emails (boq_no, revision) WHERE status = 'sent';
CREATE INDEX IF NOT EXISTS boq_emails_to_idx        ON boq_emails USING gin (to_addrs) WHERE status = 'sent';
CREATE INDEX IF NOT EXISTS inbound_thread_idx       ON inbound_messages (gmail_thread_id);
COMMENT ON COLUMN inbound_messages.attachments IS '[{filename, mimeType, size, path}] — files copied into private storage at match time; path is relative to STORAGE_DIR';
COMMIT;
