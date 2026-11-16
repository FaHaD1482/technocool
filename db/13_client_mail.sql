-- General client mail: conversations (threads) + outbound messages, so employees can write to clients and reply
-- without ever touching the company Gmail. BOQ sends stay in boq_emails and simply link to their thread.
BEGIN;

CREATE TABLE IF NOT EXISTS mail_threads (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind            text NOT NULL DEFAULT 'general' CHECK (kind IN ('general', 'boq')),
  subject         text NOT NULL,
  client_id       uuid REFERENCES clients(id) ON DELETE SET NULL,
  owner_user_id   uuid REFERENCES app_users(id) ON DELETE SET NULL,
  boq_id          uuid REFERENCES boqs(id) ON DELETE SET NULL,
  boq_no          text,
  tag             text NOT NULL,
  gmail_thread_id text,
  last_message_at timestamptz NOT NULL DEFAULT now(),
  created_by      uuid REFERENCES app_users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS mail_threads_tag_idx   ON mail_threads (lower(tag));
CREATE UNIQUE INDEX IF NOT EXISTS mail_threads_boq_idx   ON mail_threads (boq_no) WHERE kind = 'boq';
CREATE INDEX IF NOT EXISTS mail_threads_owner_idx  ON mail_threads (owner_user_id, last_message_at DESC);
CREATE INDEX IF NOT EXISTS mail_threads_gmail_idx  ON mail_threads (gmail_thread_id) WHERE gmail_thread_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS mail_threads_client_idx ON mail_threads (client_id, last_message_at DESC);

CREATE TABLE IF NOT EXISTS mail_messages (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id        uuid NOT NULL REFERENCES mail_threads(id) ON DELETE CASCADE,
  sent_by          uuid NOT NULL REFERENCES app_users(id) ON DELETE RESTRICT,
  client_id        uuid REFERENCES clients(id) ON DELETE SET NULL,
  to_addrs         text[] NOT NULL CHECK (cardinality(to_addrs) BETWEEN 1 AND 10),
  cc_addrs         text[] NOT NULL DEFAULT '{}',
  subject          text NOT NULL,
  body_text        text NOT NULL,
  attachments      jsonb NOT NULL DEFAULT '[]',
  reply_to         citext NOT NULL,
  rfc_message_id   text UNIQUE,
  in_reply_to      text,
  references_hdr   text,
  from_addr        citext,
  status           text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'sending', 'sent', 'failed')),
  attempts         integer NOT NULL DEFAULT 0,
  last_error       text,
  not_before       timestamptz NOT NULL DEFAULT now(),
  claimed_at       timestamptz,
  queued_at        timestamptz NOT NULL DEFAULT now(),
  sent_at          timestamptz,
  gmail_message_id text UNIQUE,
  gmail_thread_id  text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mail_messages_sent CHECK (status <> 'sent' OR (gmail_message_id IS NOT NULL AND sent_at IS NOT NULL)),
  CONSTRAINT mail_messages_addrs_lower CHECK (to_addrs::text = lower(to_addrs::text) AND cc_addrs::text = lower(cc_addrs::text))
);
CREATE INDEX IF NOT EXISTS mail_messages_thread_idx ON mail_messages (thread_id, sent_at DESC);
CREATE INDEX IF NOT EXISTS mail_messages_queue_idx  ON mail_messages (not_before) WHERE status = 'queued';
CREATE INDEX IF NOT EXISTS mail_messages_gmail_idx  ON mail_messages (gmail_thread_id) WHERE gmail_thread_id IS NOT NULL;

-- BOQ sends join the conversation view without changing how they are queued or sent.
ALTER TABLE boq_emails ADD COLUMN IF NOT EXISTS thread_id uuid REFERENCES mail_threads(id) ON DELETE SET NULL;

-- Inbound replies can belong to a conversation instead of only to a BOQ.
ALTER TABLE inbound_messages ADD COLUMN IF NOT EXISTS thread_id uuid REFERENCES mail_threads(id) ON DELETE SET NULL;
ALTER TABLE inbound_messages ADD COLUMN IF NOT EXISTS thread_message_id uuid REFERENCES mail_messages(id) ON DELETE SET NULL;

-- New match methods for the conversation rules (the old CHECK was created inline in 04, so find it by shape).
ALTER TABLE inbound_messages DROP CONSTRAINT IF EXISTS inbound_messages_match_method_check;
DO $$
DECLARE c text;
BEGIN
  -- guard against an older PostgreSQL naming the column check differently; only the value list contains "= ANY"
  FOR c IN SELECT conname FROM pg_constraint
            WHERE conrelid = 'inbound_messages'::regclass AND contype = 'c'
              AND pg_get_constraintdef(oid) LIKE '%match_method = ANY%'
  LOOP
    EXECUTE format('ALTER TABLE inbound_messages DROP CONSTRAINT %I', c);
  END LOOP;
END $$;
ALTER TABLE inbound_messages ADD CONSTRAINT inbound_messages_match_method_check
  CHECK (match_method IS NULL OR match_method IN
    ('thread', 'header', 'plus_tag', 'subject_code', 'sender', 'manual', 'thread_tag', 'thread_header'));

-- Notifications: conversation link + new types.
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS thread_id uuid REFERENCES mail_threads(id) ON DELETE CASCADE;
ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_type_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_type_check CHECK (type IN
  ('reply_received', 'reply_unmatched', 'send_succeeded', 'send_failed', 'gmail_disconnected', 'boq_assigned',
   'message_received', 'message_sent', 'message_failed'));

-- Permissions: employees may write to clients; admin/manager may read every conversation.
INSERT INTO permissions (code, module, description) VALUES
  ('mail.send',     'mail', 'Write to clients and reply to their messages'),
  ('mail.view_all', 'mail', 'See every employee''s client conversations')
ON CONFLICT (code) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_code)
SELECT r.id, v.p
FROM roles r
JOIN (VALUES
  ('admin', 'mail.send'), ('admin', 'mail.view_all'),
  ('manager', 'mail.send'), ('manager', 'mail.view_all'),
  ('estimator', 'mail.send')
) AS v(role, p) ON v.role = r.code
ON CONFLICT DO NOTHING;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['mail_threads', 'mail_messages'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I_updated_at ON %I', t, t);
    EXECUTE format('CREATE TRIGGER %I_updated_at BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION trg_set_updated_at()', t, t);
    EXECUTE format('DROP TRIGGER IF EXISTS %I_audit ON %I', t, t);
    EXECUTE format('CREATE TRIGGER %I_audit AFTER INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION trg_audit_row()', t, t);
  END LOOP;
END $$;

COMMIT;
