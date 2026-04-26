-- Gemini Family Pipeline account DB schema
-- Idempotent: CREATE TABLE IF NOT EXISTS + CREATE INDEX IF NOT EXISTS

CREATE TABLE IF NOT EXISTS hosts (
  id                BIGSERIAL PRIMARY KEY,
  email             TEXT NOT NULL UNIQUE,
  password          TEXT NOT NULL,
  recovery_email    TEXT,
  totp_secret       TEXT,
  notes             TEXT,
  disabled          BOOLEAN NOT NULL DEFAULT FALSE,
  -- Multi-tenant ownership (see common/worker-id.js). All read paths filter
  -- on this column; writes stamp it from the current install. NULL means
  -- "legacy / unowned" — boot-time stamping claims any pre-existing rows for
  -- the first install that boots after the migration lands.
  owner_worker_id   TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
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
    'removed_from_family',
    'join_failed_region',
    'sold'
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
  antigravity     JSONB,

  -- See hosts.owner_worker_id — same per-install ownership semantics.
  owner_worker_id TEXT,

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
  id              BIGSERIAL PRIMARY KEY,
  started_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at     TIMESTAMPTZ,
  launched_by     TEXT NOT NULL,
  stages          TEXT NOT NULL,
  host_filter     JSONB,
  concurrency     INT,
  pid             INT,
  -- Per-install identity. Multiple users share this DB; each install has a
  -- stable UUID written to ~/.auto_chrome/worker_id.json. Used to isolate
  -- "current run" / cancel / pid-based reaping per machine.
  worker_id       TEXT,
  -- Updated by the orchestrator every ~10s while running. The boot reaper /
  -- cancel route uses staleness as the cross-machine liveness signal (pid is
  -- machine-local and meaningless for foreign rows).
  last_heartbeat_at TIMESTAMPTZ,
  status          TEXT NOT NULL DEFAULT 'running'
                    CHECK (status IN ('running','completed','failed','cancelled')),
  error           TEXT,
  stats           JSONB
);

-- Idempotent column adds for existing DBs (schema was rolled out without these
-- columns originally). Must run BEFORE the index creation since the index
-- references columns that may not yet exist on a pre-existing table.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'pipeline_runs'
  ) THEN
    ALTER TABLE pipeline_runs ADD COLUMN IF NOT EXISTS worker_id TEXT;
    ALTER TABLE pipeline_runs ADD COLUMN IF NOT EXISTS last_heartbeat_at TIMESTAMPTZ;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_runs_worker_status ON pipeline_runs(worker_id, status);

-- Multi-tenant ownership migration for hosts and members. Idempotent — adds
-- the column if missing, leaves existing data untouched. Boot-time stamping
-- in server.js claims any rows where owner_worker_id IS NULL for the
-- starting install (one-time migration of pre-multi-tenant data).
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'hosts'
  ) THEN
    ALTER TABLE hosts ADD COLUMN IF NOT EXISTS owner_worker_id TEXT;
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'members'
  ) THEN
    ALTER TABLE members ADD COLUMN IF NOT EXISTS owner_worker_id TEXT;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_hosts_owner   ON hosts(owner_worker_id);
CREATE INDEX IF NOT EXISTS idx_members_owner ON members(owner_worker_id);

-- Migrations for existing DBs (idempotent: safe to run on fresh DBs too).
-- The CREATE TABLE IF NOT EXISTS above won't update a pre-existing members
-- table's status CHECK constraint, so we drop+re-add here to pick up any new
-- allowed values (e.g. 'join_failed_region' added for manual region-mismatch
-- tagging).
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'members'
  ) THEN
    ALTER TABLE members DROP CONSTRAINT IF EXISTS members_status_check;
    ALTER TABLE members ADD CONSTRAINT members_status_check CHECK (status IN (
      'new',
      'invite_pending',
      'invite_failed',
      'joined',
      'accept_failed',
      'oauth_failed',
      'done',
      'abandoned',
      'removed_from_family',
      'join_failed_region',
      'sold'
    ));
  END IF;
END $$;
