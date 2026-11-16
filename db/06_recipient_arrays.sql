-- =====================================================================
--  File 6: recipient lists as text[] instead of citext[].
--  node-postgres cannot parse citext[] (an extension type), so lists came back as "{a,b}" strings.
--  The app lower-cases every address before storing it, so text[] loses nothing.
-- =====================================================================
BEGIN;
ALTER TABLE boq_emails ALTER COLUMN to_addrs TYPE text[] USING to_addrs::text[];
ALTER TABLE boq_emails ALTER COLUMN cc_addrs TYPE text[] USING cc_addrs::text[];
ALTER TABLE boq_emails ADD CONSTRAINT boq_emails_addrs_lower
  CHECK (to_addrs::text = lower(to_addrs::text) AND cc_addrs::text = lower(cc_addrs::text));
COMMIT;
