-- =====================================================================
--  HVAC BOQ Builder: sending (file 5)
--    * e-mail templates in company settings (edited by the admin on the Gmail page)
--    * queue timing on boq_emails (retry with back-off, stuck-send detection)
-- =====================================================================
BEGIN;

ALTER TABLE company_settings
  ADD COLUMN IF NOT EXISTS email_subject_template text NOT NULL DEFAULT 'Price offer: {project}',
  ADD COLUMN IF NOT EXISTS email_body_template text NOT NULL DEFAULT
'Dear {contact},

Please find attached our price offer {code} for {project}.
{currency_note}

Please reply to this e-mail if you have any questions.

Best regards,
{sender_name}
{sender_designation}
{company}',
  ADD COLUMN IF NOT EXISTS email_from_name text;           -- display name on outgoing mail; NULL = company name
COMMENT ON COLUMN company_settings.email_body_template IS
  'Placeholders: {contact} {client} {project} {code} {boq_no} {revision} {currency_note} {sender_name} {sender_designation} {sender_phone} {company}';

ALTER TABLE boq_emails
  ADD COLUMN IF NOT EXISTS not_before  timestamptz NOT NULL DEFAULT now(),   -- retry back-off
  ADD COLUMN IF NOT EXISTS claimed_at  timestamptz,                         -- worker picked it up
  ADD COLUMN IF NOT EXISTS from_addr   citext;                              -- mailbox it went out from

DROP INDEX IF EXISTS boq_emails_queue_idx;
CREATE INDEX IF NOT EXISTS boq_emails_queue_idx ON boq_emails (not_before) WHERE status = 'queued';

COMMIT;
