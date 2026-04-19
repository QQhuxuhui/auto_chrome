-- Gemini Family Pipeline account DB schema
-- Idempotent: CREATE TABLE IF NOT EXISTS + CREATE INDEX IF NOT EXISTS

CREATE TABLE IF NOT EXISTS hosts (
  id              BIGSERIAL PRIMARY KEY,
  email           TEXT NOT NULL UNIQUE,
  password        TEXT NOT NULL,
  recovery_email  TEXT,
  totp_secret     TEXT,
  notes           TEXT,
  disabled        BOOLEAN NOT NULL DEFAULT FALSE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS members (
  id              BIGSERIAL PRIMARY KEY,
  email           TEXT NOT NULL UNIQUE,
  password        TEXT NOT NULL,
  recovery_email  TEXT,
  totp_secret     TEXT,
  notes           TEXT,

  status          TEXT NOT NULL DEFAULT 'new' CHECK (status IN (
    'new',
    'invite_pending',
    'invite_failed',
    'joined',
    'accept_failed',
    'oauth_failed',
    'done',
    'abandoned',
    'removed_from_family'
  )),

  host_id         BIGINT REFERENCES hosts(id) ON DELETE SET NULL,

  fail_count      INT NOT NULL DEFAULT 0,
  last_error      TEXT,
  last_error_at   TIMESTAMPTZ,

  invited_at      TIMESTAMPTZ,
  joined_at       TIMESTAMPTZ,
  done_at         TIMESTAMPTZ,

  token           TEXT,
  token_meta      JSONB,

  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_members_status  ON members(status);
CREATE INDEX IF NOT EXISTS idx_members_host    ON members(host_id);

CREATE TABLE IF NOT EXISTS events (
  id          BIGSERIAL PRIMARY KEY,
  member_id   BIGINT REFERENCES members(id) ON DELETE CASCADE,
  host_id     BIGINT REFERENCES hosts(id)   ON DELETE SET NULL,
  run_id      BIGINT,
  stage       TEXT,
  event_type  TEXT NOT NULL,
  message     TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_events_member ON events(member_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_events_run    ON events(run_id);

CREATE TABLE IF NOT EXISTS pipeline_runs (
  id           BIGSERIAL PRIMARY KEY,
  started_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at  TIMESTAMPTZ,
  launched_by  TEXT NOT NULL,
  stages       TEXT NOT NULL,
  host_filter  JSONB,
  concurrency  INT,
  pid          INT,
  status       TEXT NOT NULL DEFAULT 'running'
                 CHECK (status IN ('running','completed','failed','cancelled')),
  error        TEXT,
  stats        JSONB
);
