-- Login throttling that survives restarts and works across instances (the old limiter was an in-memory Map).
BEGIN;

CREATE TABLE IF NOT EXISTS login_attempts (
  id         bigserial PRIMARY KEY,
  ip         text,
  email      citext,
  ok         boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS login_attempts_ip_idx    ON login_attempts (ip, created_at DESC) WHERE ok = false;
CREATE INDEX IF NOT EXISTS login_attempts_email_idx ON login_attempts (email, created_at DESC) WHERE ok = false;
CREATE INDEX IF NOT EXISTS login_attempts_created_idx ON login_attempts (created_at);

COMMIT;
