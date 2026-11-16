-- =====================================================================
--  HVAC BOQ Builder: ownership, sending and replies (file 4)
--  Run after 01-03. Changes from the system plan (Nov 2026):
--    * boqs.owner_user_id      explicit owner, so a BOQ can be reassigned
--    * no approval step         the employee sends directly; drop the approval CHECK
--    * sent BOQs are locked     enforced by triggers, not only by the app
--    * mail_accounts            the boss Gmail connection (encrypted refresh token)
--    * boq_emails               one row per send, with every tracking mark used to match replies
--    * inbound_messages         client replies that matched a sent BOQ (or wait in the Unmatched list)
--    * notifications            per-user in-app notices
--    * 4 new permissions        boq.view_all, boq.send, mail.unmatched.manage, integrations.gmail.manage
-- =====================================================================
BEGIN;

-- ---------------------------------------------------------------------
-- 1. BOQ owner
-- ---------------------------------------------------------------------
ALTER TABLE boqs ADD COLUMN IF NOT EXISTS owner_user_id uuid REFERENCES app_users(id) ON DELETE SET NULL;
UPDATE boqs SET owner_user_id = created_by WHERE owner_user_id IS NULL;
CREATE INDEX IF NOT EXISTS boqs_owner_idx ON boqs (owner_user_id) WHERE deleted_at IS NULL;
COMMENT ON COLUMN boqs.owner_user_id IS 'The employee who owns this BOQ and receives its replies. Every query filters on it unless the user has boq.view_all.';

CREATE OR REPLACE FUNCTION trg_boqs_default_owner() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.owner_user_id := coalesce(NEW.owner_user_id, NEW.created_by, app_current_user_id());
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS boqs_default_owner ON boqs;
CREATE TRIGGER boqs_default_owner BEFORE INSERT ON boqs FOR EACH ROW EXECUTE FUNCTION trg_boqs_default_owner();

-- ---------------------------------------------------------------------
-- 2. No approval step: Send is allowed straight from draft
-- ---------------------------------------------------------------------
ALTER TABLE boqs DROP CONSTRAINT IF EXISTS boqs_approval;

-- ---------------------------------------------------------------------
-- 3. Sent BOQs are locked. To change one, call create_boq_revision().
--    Only status, owner, sent time, cached totals and soft delete may change after draft.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION trg_boqs_lock() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_free text[] := ARRAY['status','sent_at','owner_user_id','total_a_bdt','total_a_usd','total_b_bdt','total_c_bdt',
                         'grand_total_bdt','totals_at','updated_by','updated_at','deleted_at','approved_by','approved_at'];
BEGIN
  IF OLD.status <> 'draft' AND (to_jsonb(NEW) - v_free) IS DISTINCT FROM (to_jsonb(OLD) - v_free) THEN
    RAISE EXCEPTION 'BOQ % R% is % and locked. Create a new revision to change it.', OLD.boq_no, OLD.revision, OLD.status
      USING ERRCODE = 'P0001', HINT = 'boq_locked';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS boqs_lock ON boqs;
CREATE TRIGGER boqs_lock BEFORE UPDATE ON boqs FOR EACH ROW EXECUTE FUNCTION trg_boqs_lock();

CREATE OR REPLACE FUNCTION trg_boq_items_lock() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE v_status text; v_no text; v_rev int;
BEGIN
  SELECT status, boq_no, revision INTO v_status, v_no, v_rev FROM boqs WHERE id = coalesce(NEW.boq_id, OLD.boq_id);
  IF v_status IS NOT NULL AND v_status <> 'draft' THEN
    RAISE EXCEPTION 'BOQ % R% is % and locked. Create a new revision to change it.', v_no, v_rev, v_status
      USING ERRCODE = 'P0001', HINT = 'boq_locked';
  END IF;
  RETURN coalesce(NEW, OLD);
END $$;
DROP TRIGGER IF EXISTS boq_items_lock ON boq_items;
CREATE TRIGGER boq_items_lock BEFORE INSERT OR UPDATE OR DELETE ON boq_items FOR EACH ROW EXECUTE FUNCTION trg_boq_items_lock();

-- A new revision keeps the owner of the BOQ it was copied from (an admin revising it does not take it over).
CREATE OR REPLACE FUNCTION create_boq_revision(p_boq uuid) RETURNS uuid
LANGUAGE plpgsql AS $$
DECLARE v_new uuid := gen_random_uuid();
BEGIN
  INSERT INTO boqs (id, project_id, boq_no, revision, parent_boq_id, title, status, selected_brand_id, exchange_rate,
                    imp_profit_pct, imp_discount_pct, loc_profit_pct, loc_discount_pct, ait_pct, vat_pct, tax_method,
                    tax_base_a, tax_base_b, tax_base_c, add_tax_to_total, offer_currency, offer_note,
                    owner_user_id, created_by, updated_by)
  SELECT v_new, project_id, boq_no, (SELECT max(revision) + 1 FROM boqs x WHERE x.boq_no = b.boq_no), id, title, 'draft',
         selected_brand_id, exchange_rate, imp_profit_pct, imp_discount_pct, loc_profit_pct, loc_discount_pct, ait_pct, vat_pct,
         tax_method, tax_base_a, tax_base_b, tax_base_c, add_tax_to_total, offer_currency, offer_note,
         b.owner_user_id, app_current_user_id(), app_current_user_id()
  FROM boqs b WHERE id = p_boq AND deleted_at IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'BOQ % not found', p_boq; END IF;

  INSERT INTO boq_items (boq_id, line, brand_id, product_id, price_list_id, is_custom, is_edited, group_name, group_lines, type_name,
                         type_lines, description, model, unit, specs, cost, cost_currency, qty, qty_follows_links, profit_pct,
                         discount_pct, default_profit_zero, sort_order)
  SELECT v_new, line, brand_id, product_id, price_list_id, is_custom, is_edited, group_name, group_lines, type_name, type_lines,
         description, model, unit, specs, cost, cost_currency, qty, qty_follows_links, profit_pct, discount_pct, default_profit_zero, sort_order
  FROM boq_items WHERE boq_id = p_boq;

  UPDATE boqs SET status = 'superseded' WHERE id = p_boq AND status <> 'superseded';
  PERFORM refresh_boq_totals(v_new);
  RETURN v_new;
END $$;

-- ---------------------------------------------------------------------
-- 4. Gmail connection (exactly one: the boss mailbox)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS mail_accounts (
  id                 smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  email              citext NOT NULL,
  refresh_token_enc  bytea NOT NULL,                    -- AES-256-GCM: iv(12) | tag(16) | ciphertext; key lives in server secrets only
  scopes             text[] NOT NULL DEFAULT '{}',
  status             text NOT NULL DEFAULT 'connected' CHECK (status IN ('connected','revoked','error')),
  status_detail      text,
  history_id         numeric(20,0),                     -- Gmail historyId (uint64) of the last processed change
  watch_expires_at   timestamptz,                       -- Pub/Sub watch must be renewed before this
  last_sync_at       timestamptz,
  connected_by       uuid REFERENCES app_users(id) ON DELETE SET NULL,
  connected_at       timestamptz NOT NULL DEFAULT now(),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE mail_accounts IS 'The boss Gmail, connected once with OAuth. Only the background worker decrypts the token. No password is ever stored.';

-- ---------------------------------------------------------------------
-- 5. One row per BOQ send
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS boq_emails (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  boq_id            uuid NOT NULL REFERENCES boqs(id) ON DELETE RESTRICT,   -- the exact revision that was sent
  boq_no            text NOT NULL,
  revision          integer NOT NULL,
  sent_by           uuid NOT NULL REFERENCES app_users(id) ON DELETE RESTRICT,
  client_id         uuid REFERENCES clients(id) ON DELETE SET NULL,
  to_addrs          citext[] NOT NULL CHECK (cardinality(to_addrs) BETWEEN 1 AND 10),
  cc_addrs          citext[] NOT NULL DEFAULT '{}',
  subject           text NOT NULL,                     -- carries the code, e.g. [BOQ-2026-0012 R1]
  body_text         text NOT NULL,
  currency_choice   text NOT NULL CHECK (currency_choice IN ('USD','BDT','BOTH')),
  export_ids        uuid[] NOT NULL DEFAULT '{}',      -- boq_exports rows attached (never one with costing)
  tag               text NOT NULL,                     -- plus-address tag, e.g. boq-2026-0012-r1
  reply_to          citext NOT NULL,                   -- e.g. abccompany+boq-2026-0012-r1@gmail.com
  status            text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','sending','sent','failed')),
  attempts          integer NOT NULL DEFAULT 0,
  last_error        text,
  gmail_message_id  text UNIQUE,
  gmail_thread_id   text,
  rfc_message_id    text UNIQUE,                       -- the Message-ID header we set
  queued_at         timestamptz NOT NULL DEFAULT now(),
  sent_at           timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT boq_emails_sent CHECK (status <> 'sent' OR (gmail_message_id IS NOT NULL AND sent_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS boq_emails_boq_idx    ON boq_emails (boq_id);
CREATE INDEX IF NOT EXISTS boq_emails_thread_idx ON boq_emails (gmail_thread_id) WHERE gmail_thread_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS boq_emails_tag_idx    ON boq_emails (lower(tag));
CREATE INDEX IF NOT EXISTS boq_emails_queue_idx  ON boq_emails (queued_at) WHERE status = 'queued';
CREATE INDEX IF NOT EXISTS boq_emails_sent_day_idx ON boq_emails (sent_at) WHERE status = 'sent';

-- ---------------------------------------------------------------------
-- 6. Client replies
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS inbound_messages (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  gmail_message_id  text NOT NULL UNIQUE,
  gmail_thread_id   text NOT NULL,
  rfc_message_id    text,
  in_reply_to       text,
  references_hdr    text,
  from_addr         citext NOT NULL,
  from_name         text,
  to_addrs          text[] NOT NULL DEFAULT '{}',
  cc_addrs          text[] NOT NULL DEFAULT '{}',
  subject           text,
  snippet           text,
  body_text         text,
  body_html         text,                              -- stored for reference, shown only after sanitising
  attachments       jsonb NOT NULL DEFAULT '[]',       -- [{filename, mimeType, size, attachmentId}]
  received_at       timestamptz NOT NULL,
  boq_id            uuid REFERENCES boqs(id) ON DELETE SET NULL,          -- NULL = unmatched
  boq_email_id      uuid REFERENCES boq_emails(id) ON DELETE SET NULL,
  match_method      text CHECK (match_method IN ('thread','header','plus_tag','subject_code','sender','manual')),
  assigned_to       uuid REFERENCES app_users(id) ON DELETE SET NULL,     -- the BOQ owner at match time
  assigned_by       uuid REFERENCES app_users(id) ON DELETE SET NULL,     -- set for a manual assign
  assigned_at       timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT inbound_matched CHECK ((boq_id IS NULL) = (match_method IS NULL))
);
CREATE INDEX IF NOT EXISTS inbound_boq_idx       ON inbound_messages (boq_id, received_at DESC) WHERE boq_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS inbound_unmatched_idx ON inbound_messages (received_at DESC) WHERE boq_id IS NULL;
CREATE INDEX IF NOT EXISTS inbound_assigned_idx  ON inbound_messages (assigned_to, received_at DESC);

-- ---------------------------------------------------------------------
-- 7. Notifications
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS notifications (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             uuid NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  type                text NOT NULL CHECK (type IN ('reply_received','reply_unmatched','send_succeeded','send_failed',
                                                    'gmail_disconnected','boq_assigned')),
  boq_id              uuid REFERENCES boqs(id) ON DELETE CASCADE,
  inbound_message_id  uuid REFERENCES inbound_messages(id) ON DELETE CASCADE,
  title               text NOT NULL,
  body                text,
  read_at             timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS notifications_user_idx   ON notifications (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS notifications_unread_idx ON notifications (user_id) WHERE read_at IS NULL;

-- ---------------------------------------------------------------------
-- 8. Triggers on the new tables; the audit log never stores secrets
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION trg_audit_row() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE v_old jsonb; v_new jsonb; v_id text;
  v_secret text[] := ARRAY['password_hash','refresh_token_enc','refresh_token_hash','token_hash'];
BEGIN
  IF TG_OP IN ('UPDATE','DELETE') THEN v_old := to_jsonb(OLD) - v_secret; END IF;
  IF TG_OP IN ('INSERT','UPDATE') THEN v_new := to_jsonb(NEW) - v_secret; END IF;
  IF TG_OP = 'UPDATE' AND v_old - 'updated_at' = v_new - 'updated_at' THEN RETURN NEW; END IF;   -- nothing really changed
  v_id := coalesce(coalesce(v_new, v_old) ->> 'id',
                   concat_ws(':', coalesce(v_new, v_old) ->> 'price_list_id', coalesce(v_new, v_old) ->> 'product_id',
                                  coalesce(v_new, v_old) ->> 'user_id',       coalesce(v_new, v_old) ->> 'role_id',
                                  coalesce(v_new, v_old) ->> 'permission_code'));   -- tables with two-part keys
  INSERT INTO audit_log (user_id, action, entity, entity_id, old_data, new_data)
  VALUES (app_current_user_id(), TG_OP, TG_TABLE_NAME, v_id, v_old, v_new);
  RETURN coalesce(NEW, OLD);
END $$;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['mail_accounts','boq_emails'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I_updated_at ON %I', t, t);
    EXECUTE format('CREATE TRIGGER %I_updated_at BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION trg_set_updated_at()', t, t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['mail_accounts','boq_emails'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I_audit ON %I', t, t);
    EXECUTE format('CREATE TRIGGER %I_audit AFTER INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION trg_audit_row()', t, t);
  END LOOP;
END $$;

-- ---------------------------------------------------------------------
-- 9. Permissions
-- ---------------------------------------------------------------------
INSERT INTO permissions (code, module, description) VALUES
  ('boq.view_all', 'boq', 'See every BOQ and its replies, not only your own'),
  ('boq.send', 'boq', 'Send a BOQ to the client by email from the company Gmail'),
  ('mail.unmatched.manage', 'mail', 'See client replies that matched no BOQ and assign them'),
  ('integrations.gmail.manage', 'integrations', 'Connect or disconnect the company Gmail account')
ON CONFLICT (code) DO UPDATE SET module = EXCLUDED.module, description = EXCLUDED.description;

INSERT INTO role_permissions (role_id, permission_code)
SELECT r.id, v.perm FROM (VALUES
  ('admin', 'boq.view_all'),
  ('admin', 'boq.send'),
  ('admin', 'mail.unmatched.manage'),
  ('admin', 'integrations.gmail.manage'),
  ('manager', 'boq.view_all'),        -- the manager role already edits any BOQ (boq.edit_any)
  ('manager', 'boq.send'),
  ('estimator', 'boq.send')           -- estimators do NOT get boq.view_all: they see only their own BOQs
) AS v(role_code, perm) JOIN roles r ON r.code = v.role_code
ON CONFLICT DO NOTHING;

-- Fix: the comment named a permission that does not exist.
COMMENT ON FUNCTION user_has_permission IS 'Use in the API before every action, e.g. user_has_permission(:uid, ''boq.costing.view'').';

COMMIT;
