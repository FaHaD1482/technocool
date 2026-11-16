-- Worker heartbeat: the admin page (and /api/health) can tell "idle" from "dead".
BEGIN;

CREATE TABLE IF NOT EXISTS worker_status (
  id           smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  started_at   timestamptz NOT NULL DEFAULT now(),
  state        text NOT NULL DEFAULT 'running',   -- running | stopped
  detail       text
);

COMMIT;
