-- Gmail OAuth client settings that the admin can enter in the app (Admin → Gmail) instead of editing .env.local.
-- The client secret is encrypted with GMAIL_TOKEN_KEY and is never written to the audit log.
BEGIN;

CREATE TABLE IF NOT EXISTS mail_config (
  id                smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  client_id         text,
  client_secret_enc bytea,          -- AES-256-GCM: iv(12) | tag(16) | ciphertext
  mailbox           citext,         -- the company Gmail; any other account is refused
  redirect_uri      text,           -- optional; defaults to APP_URL + /api/integrations/gmail/callback
  updated_by        uuid REFERENCES app_users(id) ON DELETE SET NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

DROP TRIGGER IF EXISTS mail_config_updated_at ON mail_config;
CREATE TRIGGER mail_config_updated_at BEFORE UPDATE ON mail_config
  FOR EACH ROW EXECUTE FUNCTION trg_set_updated_at();

-- Redefined to add client_secret_enc to the list of columns the audit log must strip.
CREATE OR REPLACE FUNCTION trg_audit_row() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE v_old jsonb; v_new jsonb; v_id text;
  v_secret text[] := ARRAY['password_hash','refresh_token_enc','refresh_token_hash','token_hash','client_secret_enc'];
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

DROP TRIGGER IF EXISTS mail_config_audit ON mail_config;
CREATE TRIGGER mail_config_audit AFTER INSERT OR UPDATE OR DELETE ON mail_config
  FOR EACH ROW EXECUTE FUNCTION trg_audit_row();

COMMIT;
