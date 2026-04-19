# Account DB + Management UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace file-based `hosts.txt` / `members.txt` / `failed.json` with a remote Postgres DB + local Fastify server + static UI for account CRUD and pipeline status visualization. Also fixes the stage 2 email-matching false-positive bug.

**Architecture:** Single Node process hosting a Fastify server on `127.0.0.1:3000`. Browser UI polls DB via JSON API. Pipeline orchestration is a pure module callable from both the UI (`child_process.fork`) and CLI (`run_pipeline.sh`). All state lives in Postgres — DB is the only source of truth, reconciled against the Google family page at each run.

**Tech Stack:** Node.js ≥ 18, Fastify v5, `pg` v8, Alpine.js (CDN), Tailwind (CDN). No TypeScript, no build step, no ORM.

**Reference spec:** `docs/superpowers/specs/2026-04-19-account-db-and-ui-design.md`

**Phase overview:** The plan is split into 6 phases. Each phase leaves the repo in a green state (tests pass, existing CLI still works). You can commit after each phase and pause for review.

- Phase 1: DB schema + query modules (Tasks 1-8)
- Phase 2: Fastify server + CRUD API (Tasks 9-15)
- Phase 3: Static UI pages (Tasks 16-20)
- Phase 4: Orchestrator + stage rewrites + bug fix (Tasks 21-28)
- Phase 5: CLI integration + txt migration (Tasks 29-31)
- Phase 6: Test coverage + manual e2e (Tasks 32-35)

---

## Prerequisites

Before starting Task 1, verify:

- Node.js ≥ 18: `node --version`
- Postgres reachable: `PGPASSWORD='123Hxh' psql -h 104.194.91.23 -p 5444 -U root -d auto_chrome -c '\dt'` (should output `Did not find any relations.`)
- Working dir: `/usr/src/workspace/github/QQhuxuhui/auto_chrome`
- Git branch: `dev` (or a feature branch off `dev`)
- Chrome GUI available (`DISPLAY` is set) — only needed for Phase 6 manual e2e

Create a `.env` at repo root (not committed; `.gitignore` already covers `.env`):

```
PG_HOST=104.194.91.23
PG_PORT=5444
PG_USER=root
PG_PASSWORD=123Hxh
PG_DATABASE=auto_chrome
```

Add `public/` and `.env` to `.gitignore` if not already there.

---

## Phase 1 — DB Schema + Query Modules

### Task 1: Install pg, set up env loading

**Files:**
- Modify: `src/package.json`
- Modify: `.gitignore`

- [ ] **Step 1: Install pg**

Run:
```bash
cd src && npm install pg@^8.13.0 --save --no-fund --no-audit
```

Expected: `pg` appears in `src/package.json` dependencies.

- [ ] **Step 2: Verify .env is gitignored**

Run:
```bash
grep -F ".env" .gitignore
```

If it doesn't appear, append:
```bash
printf '\n.env\n' >> .gitignore
```

- [ ] **Step 3: Verify the .env file exists with DB creds**

Expected contents (create if missing):
```
PG_HOST=104.194.91.23
PG_PORT=5444
PG_USER=root
PG_PASSWORD=123Hxh
PG_DATABASE=auto_chrome
```

- [ ] **Step 4: Commit**

```bash
git add src/package.json src/package-lock.json .gitignore
git commit -m "chore(db): add pg dependency + .env scaffolding"
```

---

### Task 2: Write the schema SQL

**Files:**
- Create: `src/db/schema.sql`

- [ ] **Step 1: Write schema.sql**

Create `src/db/schema.sql` with exactly:

```sql
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
```

- [ ] **Step 2: Commit**

```bash
git add src/db/schema.sql
git commit -m "feat(db): add schema DDL for hosts/members/events/pipeline_runs"
```

---

### Task 3: Create init-db script and run it

**Files:**
- Create: `scripts/init-db.js`
- Modify: `src/package.json` (add script)

- [ ] **Step 1: Write scripts/init-db.js**

Create `scripts/init-db.js`:

```javascript
#!/usr/bin/env node
require('dotenv').config({ path: require('path').resolve(__dirname, '..', '.env') });
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

async function main() {
    const cfg = {
        host: process.env.PG_HOST,
        port: parseInt(process.env.PG_PORT, 10) || 5432,
        user: process.env.PG_USER,
        password: process.env.PG_PASSWORD,
        database: process.env.PG_DATABASE,
    };
    for (const k of ['host', 'user', 'password', 'database']) {
        if (!cfg[k]) {
            console.error(`PG_${k.toUpperCase()} missing in .env`);
            process.exit(1);
        }
    }
    const schemaPath = path.resolve(__dirname, '..', 'src', 'db', 'schema.sql');
    const sql = fs.readFileSync(schemaPath, 'utf-8');

    const client = new Client(cfg);
    await client.connect();
    try {
        await client.query(sql);
        console.log('Schema applied OK.');
        const { rows } = await client.query(
            "SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename"
        );
        console.log('Tables:', rows.map(r => r.tablename).join(', '));
    } finally {
        await client.end();
    }
}

main().catch(e => {
    console.error('init-db failed:', e.message);
    process.exit(1);
});
```

- [ ] **Step 2: Add npm script**

Edit `src/package.json` scripts section — add `"db:init": "node ../scripts/init-db.js"`:

```json
{
  "scripts": {
    "start": "node auth.js",
    "server": "node server.js",
    "db:init": "node ../scripts/init-db.js",
    "test:stage3": "node --test 3_sub2api.test.js",
    "test:stage3-local": "node --test 3_local_oauth.test.js",
    "test": "node --test 3_sub2api.test.js 3_local_oauth.test.js"
  }
}
```

- [ ] **Step 3: Run init**

```bash
cd src && npm run db:init
```

Expected output:
```
Schema applied OK.
Tables: events, hosts, members, pipeline_runs
```

- [ ] **Step 4: Verify directly**

```bash
PGPASSWORD='123Hxh' psql -h 104.194.91.23 -p 5444 -U root -d auto_chrome -c '\dt'
```

Expected: 4 tables listed.

- [ ] **Step 5: Commit**

```bash
git add scripts/init-db.js src/package.json
git commit -m "feat(db): add init-db script + npm run db:init"
```

---

### Task 4: pg Pool singleton

**Files:**
- Create: `src/db/index.js`

- [ ] **Step 1: Write src/db/index.js**

```javascript
/**
 * pg Pool singleton + query helper.
 * All DB access in this project goes through this module.
 */
require('dotenv').config({ path: require('path').resolve(__dirname, '..', '..', '.env') });
const { Pool } = require('pg');

const pool = new Pool({
    host: process.env.PG_HOST,
    port: parseInt(process.env.PG_PORT, 10) || 5432,
    user: process.env.PG_USER,
    password: process.env.PG_PASSWORD,
    database: process.env.PG_DATABASE,
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
});

pool.on('error', (err) => {
    console.error('[db] unexpected pool error:', err.message);
});

async function query(text, params) {
    const res = await pool.query(text, params);
    return res;
}

async function tx(fn) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const out = await fn(client);
        await client.query('COMMIT');
        return out;
    } catch (e) {
        try { await client.query('ROLLBACK'); } catch (_) { }
        throw e;
    } finally {
        client.release();
    }
}

async function close() {
    await pool.end();
}

module.exports = { pool, query, tx, close };
```

- [ ] **Step 2: Smoke test the pool**

Create a throwaway test. Run:

```bash
cd src && node -e "const db=require('./db'); db.query('SELECT 1 as x').then(r=>{console.log(r.rows);return db.close();})"
```

Expected output: `[ { x: 1 } ]`

- [ ] **Step 3: Commit**

```bash
git add src/db/index.js
git commit -m "feat(db): add pg Pool singleton + query/tx helpers"
```

---

### Task 5: Hosts query module (TDD)

**Files:**
- Create: `src/db/hosts.js`
- Create: `src/db/hosts.test.js`

- [ ] **Step 1: Write failing tests**

Create `src/db/hosts.test.js`:

```javascript
const test = require('node:test');
const assert = require('node:assert');
const db = require('./index');
const hosts = require('./hosts');

test.before(async () => {
    await db.query('DELETE FROM hosts WHERE email LIKE $1', ['test-host-%@example.com']);
});

test.after(async () => {
    await db.query('DELETE FROM hosts WHERE email LIKE $1', ['test-host-%@example.com']);
    await db.close();
});

test('upsertHost inserts new row', async () => {
    const result = await hosts.upsertHost({
        email: 'test-host-1@example.com',
        password: 'pw1',
        recovery_email: 'r@example.com',
        totp_secret: 'SECRET1',
    });
    assert.equal(result.inserted, true);
    assert.ok(result.host.id);
    assert.equal(result.host.email, 'test-host-1@example.com');
});

test('upsertHost skips duplicate email', async () => {
    await hosts.upsertHost({ email: 'test-host-2@example.com', password: 'pw' });
    const result = await hosts.upsertHost({ email: 'test-host-2@example.com', password: 'other' });
    assert.equal(result.inserted, false);
    assert.equal(result.skipped, true);
});

test('listHosts returns slot_used and slot_free', async () => {
    await hosts.upsertHost({ email: 'test-host-3@example.com', password: 'pw' });
    const rows = await hosts.listHosts({ search: 'test-host-3' });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].slot_used, 0);
    assert.equal(rows[0].slot_free, 5);
});

test('updateHost changes fields', async () => {
    const { host } = await hosts.upsertHost({ email: 'test-host-4@example.com', password: 'pw' });
    const updated = await hosts.updateHost(host.id, { disabled: true, notes: 'off' });
    assert.equal(updated.disabled, true);
    assert.equal(updated.notes, 'off');
});

test('deleteHost removes the row', async () => {
    const { host } = await hosts.upsertHost({ email: 'test-host-5@example.com', password: 'pw' });
    await hosts.deleteHost(host.id);
    const got = await hosts.getHostById(host.id);
    assert.equal(got, null);
});
```

- [ ] **Step 2: Run tests — expect fail**

```bash
cd src && node --test db/hosts.test.js
```

Expected: FAIL with "Cannot find module './hosts'"

- [ ] **Step 3: Implement src/db/hosts.js**

```javascript
/**
 * Host (母号) query module.
 * Slot counts derived live from members table (see spec §3).
 */
const db = require('./index');

const SLOT_STATUSES = ['invite_pending', 'accept_failed', 'oauth_failed', 'joined', 'done'];
const FAMILY_CAP = 5;

function mapRow(row) {
    if (!row) return null;
    return {
        id: row.id,
        email: row.email,
        password: row.password,
        recovery_email: row.recovery_email,
        totp_secret: row.totp_secret,
        notes: row.notes,
        disabled: row.disabled,
        created_at: row.created_at,
        updated_at: row.updated_at,
        slot_used: row.slot_used !== undefined ? Number(row.slot_used) : undefined,
        slot_free: row.slot_used !== undefined ? FAMILY_CAP - Number(row.slot_used) : undefined,
    };
}

async function listHosts({ disabled, search, page = 1, pageSize = 500 } = {}) {
    const params = [SLOT_STATUSES];
    const where = ['TRUE'];
    if (disabled === 0 || disabled === '0' || disabled === false) {
        where.push('h.disabled = false');
    } else if (disabled === 1 || disabled === '1' || disabled === true) {
        where.push('h.disabled = true');
    }
    if (search) {
        params.push(`%${search}%`);
        where.push(`h.email ILIKE $${params.length}`);
    }
    const offset = (page - 1) * pageSize;
    params.push(pageSize, offset);
    const sql = `
        SELECT h.*,
               COALESCE((SELECT COUNT(*) FROM members m
                          WHERE m.host_id = h.id AND m.status = ANY($1)), 0) AS slot_used
        FROM hosts h
        WHERE ${where.join(' AND ')}
        ORDER BY h.id ASC
        LIMIT $${params.length - 1} OFFSET $${params.length}
    `;
    const { rows } = await db.query(sql, params);
    return rows.map(mapRow);
}

async function getHostById(id) {
    const sql = `
        SELECT h.*,
               COALESCE((SELECT COUNT(*) FROM members m
                          WHERE m.host_id = h.id AND m.status = ANY($2)), 0) AS slot_used
        FROM hosts h
        WHERE h.id = $1
    `;
    const { rows } = await db.query(sql, [id, SLOT_STATUSES]);
    return rows[0] ? mapRow(rows[0]) : null;
}

async function upsertHost({ email, password, recovery_email, totp_secret, notes, disabled }) {
    const sql = `
        INSERT INTO hosts (email, password, recovery_email, totp_secret, notes, disabled)
        VALUES ($1, $2, $3, $4, $5, COALESCE($6, false))
        ON CONFLICT (email) DO NOTHING
        RETURNING *
    `;
    const { rows } = await db.query(sql, [
        email, password, recovery_email || null, totp_secret || null,
        notes || null, disabled || false,
    ]);
    if (rows.length === 0) {
        const existing = await db.query('SELECT * FROM hosts WHERE email = $1', [email]);
        return { inserted: false, skipped: true, host: mapRow(existing.rows[0]) };
    }
    return { inserted: true, skipped: false, host: mapRow(rows[0]) };
}

async function updateHost(id, patch) {
    const allowed = ['password', 'recovery_email', 'totp_secret', 'notes', 'disabled'];
    const sets = [];
    const params = [];
    for (const k of allowed) {
        if (patch[k] !== undefined) {
            params.push(patch[k]);
            sets.push(`${k} = $${params.length}`);
        }
    }
    if (sets.length === 0) return getHostById(id);
    sets.push(`updated_at = NOW()`);
    params.push(id);
    const sql = `UPDATE hosts SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING *`;
    const { rows } = await db.query(sql, params);
    return rows[0] ? mapRow(rows[0]) : null;
}

async function deleteHost(id) {
    await db.query('DELETE FROM hosts WHERE id = $1', [id]);
}

module.exports = {
    listHosts,
    getHostById,
    upsertHost,
    updateHost,
    deleteHost,
    SLOT_STATUSES,
    FAMILY_CAP,
};
```

- [ ] **Step 4: Run tests — expect pass**

```bash
cd src && node --test db/hosts.test.js
```

Expected: `pass 5`

- [ ] **Step 5: Commit**

```bash
git add src/db/hosts.js src/db/hosts.test.js
git commit -m "feat(db): add hosts query module + tests"
```

---

### Task 6: Members query module (TDD)

**Files:**
- Create: `src/db/members.js`
- Create: `src/db/members.test.js`

- [ ] **Step 1: Write failing tests**

Create `src/db/members.test.js`:

```javascript
const test = require('node:test');
const assert = require('node:assert');
const db = require('./index');
const hosts = require('./hosts');
const members = require('./members');

let hostId;

test.before(async () => {
    await db.query('DELETE FROM members WHERE email LIKE $1', ['test-mem-%@example.com']);
    await db.query('DELETE FROM hosts   WHERE email LIKE $1', ['test-mem-host-%@example.com']);
    const { host } = await hosts.upsertHost({ email: 'test-mem-host-1@example.com', password: 'hp' });
    hostId = host.id;
});

test.after(async () => {
    await db.query('DELETE FROM members WHERE email LIKE $1', ['test-mem-%@example.com']);
    await db.query('DELETE FROM hosts   WHERE email LIKE $1', ['test-mem-host-%@example.com']);
    await db.close();
});

test('upsertMember inserts with default status=new', async () => {
    const r = await members.upsertMember({ email: 'test-mem-1@example.com', password: 'pw' });
    assert.equal(r.inserted, true);
    assert.equal(r.member.status, 'new');
    assert.equal(r.member.fail_count, 0);
});

test('transitionToInvitePending sets host_id + invited_at', async () => {
    const { member } = await members.upsertMember({ email: 'test-mem-2@example.com', password: 'pw' });
    const updated = await members.transitionToInvitePending(member.id, hostId);
    assert.equal(updated.status, 'invite_pending');
    assert.equal(updated.host_id, hostId);
    assert.ok(updated.invited_at);
});

test('transitionToFailed increments fail_count and clears host when releaseHost=true', async () => {
    const { member } = await members.upsertMember({ email: 'test-mem-3@example.com', password: 'pw' });
    await members.transitionToInvitePending(member.id, hostId);
    const updated = await members.transitionToFailed(member.id, {
        newStatus: 'invite_failed',
        error: 'boom',
        releaseHost: true,
    });
    assert.equal(updated.status, 'invite_failed');
    assert.equal(updated.fail_count, 1);
    assert.equal(updated.host_id, null);
    assert.equal(updated.last_error, 'boom');
});

test('transitionToFailed promotes to abandoned after 3 fails', async () => {
    const { member } = await members.upsertMember({ email: 'test-mem-4@example.com', password: 'pw' });
    await members.transitionToInvitePending(member.id, hostId);
    await members.transitionToFailed(member.id, { newStatus: 'invite_failed', error: 'e1', releaseHost: true });
    await members.transitionToFailed(member.id, { newStatus: 'invite_failed', error: 'e2', releaseHost: true });
    const third = await members.transitionToFailed(member.id, { newStatus: 'invite_failed', error: 'e3', releaseHost: true });
    assert.equal(third.status, 'abandoned');
    assert.equal(third.fail_count, 3);
});

test('transitionToJoined sets joined_at', async () => {
    const { member } = await members.upsertMember({ email: 'test-mem-5@example.com', password: 'pw' });
    await members.transitionToInvitePending(member.id, hostId);
    const updated = await members.transitionToJoined(member.id);
    assert.equal(updated.status, 'joined');
    assert.ok(updated.joined_at);
});

test('transitionToDone sets token and done_at', async () => {
    const { member } = await members.upsertMember({ email: 'test-mem-6@example.com', password: 'pw' });
    await members.transitionToInvitePending(member.id, hostId);
    await members.transitionToJoined(member.id);
    const updated = await members.transitionToDone(member.id, 'REFRESH_TOKEN_XYZ', {});
    assert.equal(updated.status, 'done');
    assert.equal(updated.token, 'REFRESH_TOKEN_XYZ');
    assert.ok(updated.done_at);
});

test('resetMember clears state back to new', async () => {
    const { member } = await members.upsertMember({ email: 'test-mem-7@example.com', password: 'pw' });
    await members.transitionToInvitePending(member.id, hostId);
    await members.transitionToFailed(member.id, { newStatus: 'invite_failed', error: 'x', releaseHost: true });
    const reset = await members.resetMember(member.id);
    assert.equal(reset.status, 'new');
    assert.equal(reset.fail_count, 0);
    assert.equal(reset.host_id, null);
    assert.equal(reset.last_error, null);
});

test('listMembersForStage returns stage 1 work items', async () => {
    const { member: m1 } = await members.upsertMember({ email: 'test-mem-8a@example.com', password: 'pw' });
    const { member: m2 } = await members.upsertMember({ email: 'test-mem-8b@example.com', password: 'pw' });
    await members.transitionToInvitePending(m1.id, hostId);
    await members.transitionToFailed(m1.id, { newStatus: 'invite_failed', error: 'x', releaseHost: true });
    // m2 stays 'new'
    const work = await members.listMembersForStage(1);
    const emails = work.map(m => m.email);
    assert.ok(emails.includes('test-mem-8a@example.com'));
    assert.ok(emails.includes('test-mem-8b@example.com'));
});
```

- [ ] **Step 2: Run tests — expect fail**

```bash
cd src && node --test db/members.test.js
```

Expected: FAIL.

- [ ] **Step 3: Implement src/db/members.js**

```javascript
/**
 * Member (子号) query module.
 * Implements the state-machine transitions from spec §3.
 */
const db = require('./index');

const ABANDON_THRESHOLD = 3;

function mapRow(row) {
    if (!row) return null;
    return { ...row };
}

async function listMembers({ status, hostId, search, hasToken, page = 1, pageSize = 500 } = {}) {
    const params = [];
    const where = ['TRUE'];
    if (status) {
        const arr = Array.isArray(status) ? status : String(status).split(',').map(s => s.trim()).filter(Boolean);
        params.push(arr);
        where.push(`status = ANY($${params.length})`);
    }
    if (hostId) {
        params.push(hostId);
        where.push(`host_id = $${params.length}`);
    }
    if (search) {
        params.push(`%${search}%`);
        where.push(`email ILIKE $${params.length}`);
    }
    if (hasToken !== undefined) {
        if (hasToken === true || hasToken === 1 || hasToken === '1') {
            where.push(`token IS NOT NULL`);
        } else {
            where.push(`token IS NULL`);
        }
    }
    const offset = (page - 1) * pageSize;
    params.push(pageSize, offset);
    const sql = `
        SELECT * FROM members
        WHERE ${where.join(' AND ')}
        ORDER BY id ASC
        LIMIT $${params.length - 1} OFFSET $${params.length}
    `;
    const { rows } = await db.query(sql, params);
    return rows.map(mapRow);
}

async function getMemberById(id) {
    const { rows } = await db.query('SELECT * FROM members WHERE id = $1', [id]);
    return rows[0] ? mapRow(rows[0]) : null;
}

async function upsertMember({ email, password, recovery_email, totp_secret, notes }) {
    const sql = `
        INSERT INTO members (email, password, recovery_email, totp_secret, notes)
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (email) DO NOTHING
        RETURNING *
    `;
    const { rows } = await db.query(sql, [
        email, password, recovery_email || null, totp_secret || null, notes || null,
    ]);
    if (rows.length === 0) {
        const existing = await db.query('SELECT * FROM members WHERE email = $1', [email]);
        return { inserted: false, skipped: true, member: mapRow(existing.rows[0]) };
    }
    return { inserted: true, skipped: false, member: mapRow(rows[0]) };
}

async function updateMember(id, patch) {
    const allowed = ['password', 'recovery_email', 'totp_secret', 'notes'];
    const sets = [];
    const params = [];
    for (const k of allowed) {
        if (patch[k] !== undefined) {
            params.push(patch[k]);
            sets.push(`${k} = $${params.length}`);
        }
    }
    if (sets.length === 0) return getMemberById(id);
    sets.push(`updated_at = NOW()`);
    params.push(id);
    const sql = `UPDATE members SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING *`;
    const { rows } = await db.query(sql, params);
    return rows[0] ? mapRow(rows[0]) : null;
}

async function deleteMember(id) {
    await db.query('DELETE FROM members WHERE id = $1', [id]);
}

async function transitionToInvitePending(memberId, hostId) {
    const sql = `
        UPDATE members
        SET status = 'invite_pending', host_id = $2, invited_at = NOW(), updated_at = NOW()
        WHERE id = $1
        RETURNING *
    `;
    const { rows } = await db.query(sql, [memberId, hostId]);
    return mapRow(rows[0]);
}

async function transitionToJoined(memberId) {
    const sql = `
        UPDATE members
        SET status = 'joined', joined_at = NOW(), updated_at = NOW()
        WHERE id = $1
        RETURNING *
    `;
    const { rows } = await db.query(sql, [memberId]);
    return mapRow(rows[0]);
}

async function transitionToDone(memberId, token, tokenMeta) {
    const sql = `
        UPDATE members
        SET status = 'done', token = $2, token_meta = $3, done_at = NOW(), updated_at = NOW()
        WHERE id = $1
        RETURNING *
    `;
    const { rows } = await db.query(sql, [memberId, token, tokenMeta || {}]);
    return mapRow(rows[0]);
}

async function transitionToFailed(memberId, { newStatus, error, releaseHost }) {
    const sql = `
        UPDATE members
        SET status = CASE WHEN fail_count + 1 >= $4 THEN 'abandoned' ELSE $2 END,
            fail_count = fail_count + 1,
            last_error = $3,
            last_error_at = NOW(),
            host_id = CASE WHEN $5 THEN NULL ELSE host_id END,
            updated_at = NOW()
        WHERE id = $1
        RETURNING *
    `;
    const { rows } = await db.query(sql, [memberId, newStatus, error || null, ABANDON_THRESHOLD, !!releaseHost]);
    return mapRow(rows[0]);
}

async function markRemovedFromFamily(memberId) {
    const sql = `
        UPDATE members
        SET status = 'removed_from_family', host_id = NULL, updated_at = NOW()
        WHERE id = $1
        RETURNING *
    `;
    const { rows } = await db.query(sql, [memberId]);
    return mapRow(rows[0]);
}

async function resetMember(memberId) {
    const sql = `
        UPDATE members
        SET status = 'new',
            host_id = NULL,
            fail_count = 0,
            last_error = NULL,
            last_error_at = NULL,
            invited_at = NULL,
            joined_at = NULL,
            done_at = NULL,
            updated_at = NOW()
        WHERE id = $1
        RETURNING *
    `;
    const { rows } = await db.query(sql, [memberId]);
    return mapRow(rows[0]);
}

async function abandonMember(memberId) {
    const sql = `
        UPDATE members
        SET status = 'abandoned', host_id = NULL, updated_at = NOW()
        WHERE id = $1
        RETURNING *
    `;
    const { rows } = await db.query(sql, [memberId]);
    return mapRow(rows[0]);
}

async function listMembersForStage(stage) {
    const s = String(stage);
    let sql;
    if (s === '1') {
        sql = `
            SELECT * FROM members
            WHERE status IN ('new','invite_failed') AND fail_count < $1
            ORDER BY created_at ASC
        `;
    } else if (s === '2') {
        sql = `
            SELECT * FROM members
            WHERE status = 'invite_pending' AND host_id IS NOT NULL
            ORDER BY invited_at ASC NULLS FIRST
        `;
    } else if (s === '3') {
        sql = `
            SELECT * FROM members
            WHERE status IN ('joined','oauth_failed') AND fail_count < $1
            ORDER BY joined_at ASC NULLS LAST, updated_at ASC
        `;
    } else {
        throw new Error(`listMembersForStage: invalid stage ${stage}`);
    }
    const params = (s === '2') ? [] : [ABANDON_THRESHOLD];
    const { rows } = await db.query(sql, params);
    return rows.map(mapRow);
}

async function countByStatus() {
    const { rows } = await db.query(
        'SELECT status, COUNT(*)::int AS n FROM members GROUP BY status'
    );
    const out = {};
    for (const r of rows) out[r.status] = r.n;
    return out;
}

module.exports = {
    listMembers,
    getMemberById,
    upsertMember,
    updateMember,
    deleteMember,
    transitionToInvitePending,
    transitionToJoined,
    transitionToDone,
    transitionToFailed,
    markRemovedFromFamily,
    resetMember,
    abandonMember,
    listMembersForStage,
    countByStatus,
    ABANDON_THRESHOLD,
};
```

- [ ] **Step 4: Run tests — expect pass**

```bash
cd src && node --test db/members.test.js
```

Expected: `pass 8`

- [ ] **Step 5: Commit**

```bash
git add src/db/members.js src/db/members.test.js
git commit -m "feat(db): add members query module + state transitions + tests"
```

---

### Task 7: Events module

**Files:**
- Create: `src/db/events.js`
- Create: `src/db/events.test.js`

- [ ] **Step 1: Write tests**

Create `src/db/events.test.js`:

```javascript
const test = require('node:test');
const assert = require('node:assert');
const db = require('./index');
const events = require('./events');
const members = require('./members');
const hosts = require('./hosts');

let memberId, hostId;
test.before(async () => {
    await db.query("DELETE FROM events WHERE message LIKE 'test-evt-%'");
    await db.query("DELETE FROM members WHERE email LIKE 'test-evt-%@example.com'");
    await db.query("DELETE FROM hosts   WHERE email LIKE 'test-evt-%@example.com'");
    const { host } = await hosts.upsertHost({ email: 'test-evt-host@example.com', password: 'p' });
    hostId = host.id;
    const { member } = await members.upsertMember({ email: 'test-evt-mem@example.com', password: 'p' });
    memberId = member.id;
});
test.after(async () => {
    await db.query("DELETE FROM events WHERE member_id = $1", [memberId]);
    await db.query("DELETE FROM members WHERE id = $1", [memberId]);
    await db.query("DELETE FROM hosts   WHERE id = $1", [hostId]);
    await db.close();
});

test('logEvent inserts a row', async () => {
    const e = await events.logEvent({
        memberId, hostId, runId: null,
        stage: 'stage1', eventType: 'start', message: 'test-evt-log',
    });
    assert.ok(e.id);
    assert.equal(e.event_type, 'start');
});

test('listEventsForMember returns DESC order', async () => {
    await events.logEvent({ memberId, stage: 'stage1', eventType: 'start', message: 'test-evt-1' });
    await events.logEvent({ memberId, stage: 'stage1', eventType: 'success', message: 'test-evt-2' });
    const rows = await events.listEventsForMember(memberId, 10);
    assert.ok(rows.length >= 2);
    const top = rows.filter(r => (r.message || '').startsWith('test-evt-')).slice(0, 2);
    assert.equal(top[0].message, 'test-evt-2');
});
```

- [ ] **Step 2: Run — expect fail**

```bash
cd src && node --test db/events.test.js
```

- [ ] **Step 3: Implement src/db/events.js**

```javascript
/**
 * Events audit log.
 */
const db = require('./index');

async function logEvent({ memberId, hostId, runId, stage, eventType, message }) {
    const sql = `
        INSERT INTO events (member_id, host_id, run_id, stage, event_type, message)
        VALUES ($1, $2, $3, $4, $5, $6)
        RETURNING *
    `;
    const { rows } = await db.query(sql, [
        memberId || null, hostId || null, runId || null,
        stage || null, eventType, message || null,
    ]);
    return rows[0];
}

async function listEventsForMember(memberId, limit = 50) {
    const sql = `
        SELECT * FROM events
        WHERE member_id = $1
        ORDER BY created_at DESC, id DESC
        LIMIT $2
    `;
    const { rows } = await db.query(sql, [memberId, limit]);
    return rows;
}

async function listEventsForRun(runId, limit = 500) {
    const sql = `
        SELECT * FROM events
        WHERE run_id = $1
        ORDER BY created_at ASC, id ASC
        LIMIT $2
    `;
    const { rows } = await db.query(sql, [runId, limit]);
    return rows;
}

module.exports = { logEvent, listEventsForMember, listEventsForRun };
```

- [ ] **Step 4: Run — expect pass**

```bash
cd src && node --test db/events.test.js
```

- [ ] **Step 5: Commit**

```bash
git add src/db/events.js src/db/events.test.js
git commit -m "feat(db): add events log module + tests"
```

---

### Task 8: Pipeline runs module

**Files:**
- Create: `src/db/runs.js`
- Create: `src/db/runs.test.js`

- [ ] **Step 1: Write tests**

Create `src/db/runs.test.js`:

```javascript
const test = require('node:test');
const assert = require('node:assert');
const db = require('./index');
const runs = require('./runs');

const testIds = [];
test.after(async () => {
    if (testIds.length) {
        await db.query('DELETE FROM events WHERE run_id = ANY($1)', [testIds]);
        await db.query('DELETE FROM pipeline_runs WHERE id = ANY($1)', [testIds]);
    }
    await db.close();
});

test('createRun inserts with status=running', async () => {
    const r = await runs.createRun({
        launched_by: 'cli', stages: '1,2,3', host_filter: [], concurrency: 1,
    });
    testIds.push(r.id);
    assert.equal(r.status, 'running');
    assert.equal(r.launched_by, 'cli');
});

test('getCurrentRun returns null when no running run', async () => {
    // make sure no lingering running test runs
    await db.query("UPDATE pipeline_runs SET status='cancelled', finished_at=NOW() WHERE status='running'");
    const r = await runs.getCurrentRun();
    assert.equal(r, null);
});

test('updateRunStatus marks completed', async () => {
    const r = await runs.createRun({ launched_by: 'cli', stages: '1', host_filter: null, concurrency: 1 });
    testIds.push(r.id);
    const done = await runs.updateRunStatus(r.id, 'completed', { stats: { stage1: { ok: 2, ng: 0 } } });
    assert.equal(done.status, 'completed');
    assert.ok(done.finished_at);
    assert.equal(done.stats.stage1.ok, 2);
});

test('listRuns returns rows', async () => {
    const list = await runs.listRuns(10);
    assert.ok(Array.isArray(list));
});
```

- [ ] **Step 2: Run — expect fail**

```bash
cd src && node --test db/runs.test.js
```

- [ ] **Step 3: Implement src/db/runs.js**

```javascript
/**
 * Pipeline runs module.
 */
const db = require('./index');

async function createRun({ launched_by, stages, host_filter, concurrency, pid }) {
    const sql = `
        INSERT INTO pipeline_runs (launched_by, stages, host_filter, concurrency, pid)
        VALUES ($1, $2, $3, $4, $5)
        RETURNING *
    `;
    const { rows } = await db.query(sql, [
        launched_by, stages, host_filter || [], concurrency || 1, pid || null,
    ]);
    return rows[0];
}

async function getCurrentRun() {
    const { rows } = await db.query(
        "SELECT * FROM pipeline_runs WHERE status='running' ORDER BY id DESC LIMIT 1"
    );
    return rows[0] || null;
}

async function getRunById(id) {
    const { rows } = await db.query('SELECT * FROM pipeline_runs WHERE id = $1', [id]);
    return rows[0] || null;
}

async function updateRunStatus(id, status, extras = {}) {
    const { stats, error, pid } = extras;
    const sql = `
        UPDATE pipeline_runs
        SET status = $2,
            finished_at = CASE WHEN $2 IN ('completed','failed','cancelled') THEN NOW() ELSE finished_at END,
            stats = COALESCE($3, stats),
            error = COALESCE($4, error),
            pid = COALESCE($5, pid)
        WHERE id = $1
        RETURNING *
    `;
    const { rows } = await db.query(sql, [
        id, status, stats || null, error || null, pid || null,
    ]);
    return rows[0];
}

async function setRunPid(id, pid) {
    await db.query('UPDATE pipeline_runs SET pid = $2 WHERE id = $1', [id, pid]);
}

async function listRuns(limit = 50) {
    const sql = `SELECT * FROM pipeline_runs ORDER BY id DESC LIMIT $1`;
    const { rows } = await db.query(sql, [limit]);
    return rows;
}

module.exports = { createRun, getCurrentRun, getRunById, updateRunStatus, setRunPid, listRuns };
```

- [ ] **Step 4: Run — expect pass**

```bash
cd src && node --test db/runs.test.js
```

- [ ] **Step 5: Commit**

```bash
git add src/db/runs.js src/db/runs.test.js
git commit -m "feat(db): add pipeline_runs module + tests"
```

---

## Phase 2 — Fastify Server + CRUD API

### Task 9: Install fastify deps + Server bootstrap

**Files:**
- Modify: `src/package.json`
- Create: `src/server.js`

- [ ] **Step 1: Install deps**

```bash
cd src && npm install fastify@^5.0.0 @fastify/static@^8.0.0 --save --no-fund --no-audit
```

- [ ] **Step 2: Write src/server.js (minimal bootstrap)**

```javascript
/**
 * Fastify server — local account management UI + API.
 * Bind to 127.0.0.1 only (no auth).
 */
require('dotenv').config({ path: require('path').resolve(__dirname, '..', '.env') });
const path = require('path');
const Fastify = require('fastify');

const PORT = parseInt(process.env.SERVER_PORT, 10) || 3000;
const HOST = process.env.SERVER_HOST || '127.0.0.1';

async function build() {
    const app = Fastify({
        logger: { level: 'info' },
        disableRequestLogging: false,
    });

    await app.register(require('@fastify/static'), {
        root: path.resolve(__dirname, '..', 'public'),
        prefix: '/public/',
    });

    app.get('/', async (_req, reply) => reply.sendFile('index.html'));
    app.get('/accounts', async (_req, reply) => reply.sendFile('accounts.html'));
    app.get('/runs', async (_req, reply) => reply.sendFile('runs.html'));

    app.get('/api/ping', async () => ({ ok: true, ts: new Date().toISOString() }));

    // Routes will be registered in subsequent tasks.

    app.setErrorHandler((err, _req, reply) => {
        app.log.error(err);
        const code = err.statusCode && err.statusCode >= 400 ? err.statusCode : 500;
        reply.code(code).send({ error: err.message });
    });

    return app;
}

async function start() {
    const app = await build();
    try {
        await app.listen({ port: PORT, host: HOST });
        app.log.info(`HTTP ready on http://${HOST}:${PORT}`);
    } catch (e) {
        app.log.error(e);
        process.exit(1);
    }
}

if (require.main === module) start();

module.exports = { build };
```

- [ ] **Step 3: Smoke test**

```bash
cd src && node -e "require('./server').build().then(app => app.inject({method:'GET',url:'/api/ping'})).then(r => { console.log(r.statusCode, r.body); process.exit(0); })"
```

Expected: `200 {"ok":true,"ts":"..."}`

- [ ] **Step 4: Make sure `public/` exists with placeholder files (routes 404 otherwise)**

```bash
mkdir -p /usr/src/workspace/github/QQhuxuhui/auto_chrome/public
cd /usr/src/workspace/github/QQhuxuhui/auto_chrome
printf '<!doctype html><title>placeholder</title><h1>dashboard placeholder</h1>' > public/index.html
printf '<!doctype html><title>placeholder</title><h1>accounts placeholder</h1>' > public/accounts.html
printf '<!doctype html><title>placeholder</title><h1>runs placeholder</h1>' > public/runs.html
```

- [ ] **Step 5: Commit**

```bash
git add src/package.json src/package-lock.json src/server.js public/
git commit -m "feat(server): fastify bootstrap + static routing skeleton"
```

---

### Task 10: Hosts routes + integration test

**Files:**
- Create: `src/routes/hosts.js`
- Create: `src/routes/hosts.test.js`
- Modify: `src/server.js`

- [ ] **Step 1: Write tests**

Create `src/routes/hosts.test.js`:

```javascript
const test = require('node:test');
const assert = require('node:assert');
const { build } = require('../server');
const db = require('../db');

let app;
test.before(async () => {
    app = await build();
    await db.query("DELETE FROM hosts WHERE email LIKE 'api-host-%@example.com'");
});
test.after(async () => {
    await db.query("DELETE FROM hosts WHERE email LIKE 'api-host-%@example.com'");
    await app.close();
    await db.close();
});

test('POST /api/hosts/bulk inserts from lines string', async () => {
    const r = await app.inject({
        method: 'POST', url: '/api/hosts/bulk',
        payload: { lines: 'api-host-1@example.com:pw1\napi-host-2@example.com:pw2' },
    });
    assert.equal(r.statusCode, 200);
    const body = JSON.parse(r.body);
    assert.equal(body.inserted, 2);
    assert.equal(body.skipped, 0);
});

test('POST /api/hosts/bulk skips duplicates', async () => {
    const r = await app.inject({
        method: 'POST', url: '/api/hosts/bulk',
        payload: { lines: 'api-host-1@example.com:pw1' },
    });
    const body = JSON.parse(r.body);
    assert.equal(body.inserted, 0);
    assert.equal(body.skipped, 1);
});

test('GET /api/hosts returns list with slot fields', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/hosts?search=api-host' });
    assert.equal(r.statusCode, 200);
    const list = JSON.parse(r.body);
    assert.ok(Array.isArray(list));
    for (const h of list) {
        assert.ok('slot_used' in h);
        assert.ok('slot_free' in h);
    }
});

test('PATCH /api/hosts/:id updates disabled flag', async () => {
    const list = await app.inject({ method: 'GET', url: '/api/hosts?search=api-host-1' })
        .then(r => JSON.parse(r.body));
    const id = list[0].id;
    const r = await app.inject({ method: 'PATCH', url: `/api/hosts/${id}`, payload: { disabled: true } });
    assert.equal(r.statusCode, 200);
    const b = JSON.parse(r.body);
    assert.equal(b.disabled, true);
});

test('DELETE /api/hosts/:id removes the host', async () => {
    const list = await app.inject({ method: 'GET', url: '/api/hosts?search=api-host-2' })
        .then(r => JSON.parse(r.body));
    const id = list[0].id;
    const r = await app.inject({ method: 'DELETE', url: `/api/hosts/${id}` });
    assert.equal(r.statusCode, 204);
});
```

- [ ] **Step 2: Run — expect fail**

```bash
cd src && node --test routes/hosts.test.js
```

- [ ] **Step 3: Implement src/routes/hosts.js**

```javascript
const hosts = require('../db/hosts');
const { parseAccounts } = require('../common/state');

module.exports = async function routes(app) {
    app.get('/api/hosts', async (req) => {
        const { disabled, search, page, pageSize } = req.query;
        return hosts.listHosts({
            disabled,
            search,
            page: page ? parseInt(page, 10) : undefined,
            pageSize: pageSize ? parseInt(pageSize, 10) : undefined,
        });
    });

    app.post('/api/hosts/bulk', async (req, reply) => {
        const { lines, accounts } = req.body || {};
        let items = [];
        if (typeof lines === 'string' && lines.trim()) {
            items = parseLinesToAccounts(lines);
        } else if (Array.isArray(accounts)) {
            items = accounts;
        } else {
            return reply.code(400).send({ error: 'either `lines` or `accounts` is required' });
        }
        const out = { inserted: 0, skipped: 0, errors: [] };
        for (const it of items) {
            try {
                const r = await hosts.upsertHost({
                    email: it.email,
                    password: it.password || it.pass,
                    recovery_email: it.recovery_email || it.recovery,
                    totp_secret: it.totp_secret,
                    notes: it.notes,
                });
                if (r.inserted) out.inserted++;
                else out.skipped++;
            } catch (e) {
                out.errors.push({ email: it.email, error: e.message });
            }
        }
        return out;
    });

    app.patch('/api/hosts/:id', async (req, reply) => {
        const id = parseInt(req.params.id, 10);
        const row = await hosts.updateHost(id, req.body || {});
        if (!row) return reply.code(404).send({ error: 'not found' });
        return row;
    });

    app.delete('/api/hosts/:id', async (req, reply) => {
        const id = parseInt(req.params.id, 10);
        await hosts.deleteHost(id);
        reply.code(204).send();
    });
};

function parseLinesToAccounts(text) {
    // Reuse common/state.js parseAccounts via a temp file? No — parseAccounts reads from file.
    // Easier: split to lines and parse each with the same rules.
    // We replicate the minimal parsing here to avoid a file dance.
    const lines = text.split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith('#'));
    const out = [];
    for (const line of lines) {
        const normalized = line.replace(/\uff1a/g, ':');
        // Split on ':' (support 2-4 fields: email:pass[:recovery[:totp]])
        const parts = normalized.split(':').map(s => s.trim());
        if (parts.length < 2) continue;
        const email = parts[0];
        const password = parts[1];
        if (!email.includes('@')) continue;
        const recovery = parts[2] || '';
        const totpRaw = parts.slice(3).join(':');
        let totp_secret = '';
        const m = (totpRaw || '').match(/^[A-Za-z2-7]+/);
        if (m && m[0].length >= 16) totp_secret = m[0];
        out.push({ email, password, recovery_email: recovery || null, totp_secret: totp_secret || null });
    }
    return out;
}

module.exports.parseLinesToAccounts = parseLinesToAccounts;
```

**Why we inline a minimal parser** instead of delegating fully to `common/state.js#parseAccounts`: that function reads from a file path. A full refactor of `parseAccounts` to accept strings is outside the scope of this task. The inline parser handles the common `email:pass:recovery:totp` format which is what bulk upload accepts. `common/state.js` is still used by `scripts/migrate-txt.js` (Task 31) where it reads txt files directly.

- [ ] **Step 4: Register the route module in server.js**

Edit `src/server.js` — between the static register and the `app.get('/api/ping')` line, add:

```javascript
    await app.register(require('./routes/hosts'));
```

So the relevant section reads:

```javascript
    await app.register(require('@fastify/static'), {
        root: path.resolve(__dirname, '..', 'public'),
        prefix: '/public/',
    });

    await app.register(require('./routes/hosts'));

    app.get('/', async (_req, reply) => reply.sendFile('index.html'));
```

- [ ] **Step 5: Run — expect pass**

```bash
cd src && node --test routes/hosts.test.js
```

- [ ] **Step 6: Commit**

```bash
git add src/routes/hosts.js src/routes/hosts.test.js src/server.js
git commit -m "feat(api): POST/GET/PATCH/DELETE /api/hosts + bulk upload"
```

---

### Task 11: Members routes + tests

**Files:**
- Create: `src/routes/members.js`
- Create: `src/routes/members.test.js`
- Modify: `src/server.js`

- [ ] **Step 1: Write tests**

Create `src/routes/members.test.js`:

```javascript
const test = require('node:test');
const assert = require('node:assert');
const { build } = require('../server');
const db = require('../db');

let app;
test.before(async () => {
    app = await build();
    await db.query("DELETE FROM members WHERE email LIKE 'api-mem-%@example.com'");
});
test.after(async () => {
    await db.query("DELETE FROM members WHERE email LIKE 'api-mem-%@example.com'");
    await app.close();
    await db.close();
});

test('POST /api/members/bulk inserts', async () => {
    const r = await app.inject({
        method: 'POST', url: '/api/members/bulk',
        payload: { lines: 'api-mem-1@example.com:pw1\napi-mem-2@example.com:pw2' },
    });
    const b = JSON.parse(r.body);
    assert.equal(b.inserted, 2);
});

test('GET /api/members filters by status', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/members?status=new&search=api-mem' });
    assert.equal(r.statusCode, 200);
    const list = JSON.parse(r.body);
    assert.ok(list.every(m => m.status === 'new'));
});

test('GET /api/members/:id includes events array', async () => {
    const list = await app.inject({ method: 'GET', url: '/api/members?search=api-mem-1' })
        .then(r => JSON.parse(r.body));
    const id = list[0].id;
    const r = await app.inject({ method: 'GET', url: `/api/members/${id}` });
    assert.equal(r.statusCode, 200);
    const body = JSON.parse(r.body);
    assert.ok(Array.isArray(body.events));
    assert.equal(body.id, id);
});

test('PATCH /api/members/:id?action=reset clears state', async () => {
    const list = await app.inject({ method: 'GET', url: '/api/members?search=api-mem-2' })
        .then(r => JSON.parse(r.body));
    const id = list[0].id;
    const r = await app.inject({ method: 'PATCH', url: `/api/members/${id}?action=reset`, payload: {} });
    const b = JSON.parse(r.body);
    assert.equal(b.status, 'new');
});

test('PATCH /api/members/:id?action=abandon', async () => {
    const list = await app.inject({ method: 'GET', url: '/api/members?search=api-mem-1' })
        .then(r => JSON.parse(r.body));
    const id = list[0].id;
    const r = await app.inject({ method: 'PATCH', url: `/api/members/${id}?action=abandon`, payload: {} });
    const b = JSON.parse(r.body);
    assert.equal(b.status, 'abandoned');
});
```

- [ ] **Step 2: Run — expect fail**

```bash
cd src && node --test routes/members.test.js
```

- [ ] **Step 3: Implement src/routes/members.js**

```javascript
const members = require('../db/members');
const events = require('../db/events');
const { parseLinesToAccounts } = require('./hosts');

module.exports = async function routes(app) {
    app.get('/api/members', async (req) => {
        const { status, host_id, search, has_token, page, pageSize } = req.query;
        return members.listMembers({
            status,
            hostId: host_id ? parseInt(host_id, 10) : undefined,
            search,
            hasToken: has_token !== undefined ? (has_token === '1' || has_token === 'true') : undefined,
            page: page ? parseInt(page, 10) : undefined,
            pageSize: pageSize ? parseInt(pageSize, 10) : undefined,
        });
    });

    app.get('/api/members/:id', async (req, reply) => {
        const id = parseInt(req.params.id, 10);
        const m = await members.getMemberById(id);
        if (!m) return reply.code(404).send({ error: 'not found' });
        const evts = await events.listEventsForMember(id, 50);
        return { ...m, events: evts };
    });

    app.post('/api/members/bulk', async (req, reply) => {
        const { lines, accounts } = req.body || {};
        let items = [];
        if (typeof lines === 'string' && lines.trim()) {
            items = parseLinesToAccounts(lines);
        } else if (Array.isArray(accounts)) {
            items = accounts;
        } else {
            return reply.code(400).send({ error: 'either `lines` or `accounts` is required' });
        }
        const out = { inserted: 0, skipped: 0, errors: [] };
        for (const it of items) {
            try {
                const r = await members.upsertMember({
                    email: it.email,
                    password: it.password || it.pass,
                    recovery_email: it.recovery_email || it.recovery,
                    totp_secret: it.totp_secret,
                    notes: it.notes,
                });
                if (r.inserted) out.inserted++;
                else out.skipped++;
            } catch (e) {
                out.errors.push({ email: it.email, error: e.message });
            }
        }
        return out;
    });

    app.patch('/api/members/:id', async (req, reply) => {
        const id = parseInt(req.params.id, 10);
        const action = req.query.action;
        if (action === 'reset') return members.resetMember(id);
        if (action === 'abandon') return members.abandonMember(id);
        const row = await members.updateMember(id, req.body || {});
        if (!row) return reply.code(404).send({ error: 'not found' });
        return row;
    });

    app.delete('/api/members/:id', async (req, reply) => {
        const id = parseInt(req.params.id, 10);
        await members.deleteMember(id);
        reply.code(204).send();
    });
};
```

- [ ] **Step 4: Register in server.js**

Add to `src/server.js` after the hosts register line:

```javascript
    await app.register(require('./routes/members'));
```

- [ ] **Step 5: Run — expect pass**

```bash
cd src && node --test routes/members.test.js
```

- [ ] **Step 6: Commit**

```bash
git add src/routes/members.js src/routes/members.test.js src/server.js
git commit -m "feat(api): members CRUD + bulk + reset/abandon actions"
```

---

### Task 12: Status route (dashboard aggregate)

**Files:**
- Create: `src/routes/status.js`
- Create: `src/routes/status.test.js`
- Modify: `src/server.js`

- [ ] **Step 1: Write tests**

Create `src/routes/status.test.js`:

```javascript
const test = require('node:test');
const assert = require('node:assert');
const { build } = require('../server');
const db = require('../db');

let app;
test.before(async () => { app = await build(); });
test.after(async () => { await app.close(); await db.close(); });

test('GET /api/status returns aggregate', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/status' });
    assert.equal(r.statusCode, 200);
    const b = JSON.parse(r.body);
    assert.ok('byStatus' in b);
    assert.ok('hosts' in b);
    assert.ok('currentRun' in b);
    assert.ok(typeof b.hosts.total === 'number');
    assert.ok(typeof b.hosts.freeSlotsTotal === 'number');
});
```

- [ ] **Step 2: Run — expect fail**

- [ ] **Step 3: Implement src/routes/status.js**

```javascript
const members = require('../db/members');
const hosts = require('../db/hosts');
const runs = require('../db/runs');

module.exports = async function routes(app) {
    app.get('/api/status', async () => {
        const [byStatus, allHosts, currentRun] = await Promise.all([
            members.countByStatus(),
            hosts.listHosts({ pageSize: 10000 }),
            runs.getCurrentRun(),
        ]);
        const total = allHosts.length;
        const disabled = allHosts.filter(h => h.disabled).length;
        const usable = allHosts.filter(h => !h.disabled);
        const withFreeSlot = usable.filter(h => h.slot_free > 0).length;
        const freeSlotsTotal = usable.reduce((s, h) => s + (h.slot_free || 0), 0);
        return {
            byStatus,
            hosts: { total, disabled, withFreeSlot, freeSlotsTotal },
            currentRun,
        };
    });
};
```

- [ ] **Step 4: Register in server.js**

```javascript
    await app.register(require('./routes/status'));
```

- [ ] **Step 5: Run — expect pass**

- [ ] **Step 6: Commit**

```bash
git add src/routes/status.js src/routes/status.test.js src/server.js
git commit -m "feat(api): GET /api/status dashboard aggregate"
```

---

### Task 13: Pipeline route (start/cancel/list)

**Files:**
- Create: `src/routes/pipeline.js`
- Create: `src/routes/pipeline.test.js`
- Modify: `src/server.js`

- [ ] **Step 1: Write tests**

Create `src/routes/pipeline.test.js`. Note: the actual orchestrator fork is tested in Phase 4 — here we only test that the route persists a run row and refuses concurrent starts.

```javascript
const test = require('node:test');
const assert = require('node:assert');
const { build } = require('../server');
const db = require('../db');

let app;
test.before(async () => {
    app = await build();
    await db.query("UPDATE pipeline_runs SET status='cancelled' WHERE status='running'");
});
test.after(async () => { await app.close(); await db.close(); });

test('GET /api/pipeline/runs returns array', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/pipeline/runs' });
    assert.equal(r.statusCode, 200);
    const b = JSON.parse(r.body);
    assert.ok(Array.isArray(b));
});

test('POST /api/pipeline/start with dryRun creates a run row', async () => {
    const r = await app.inject({
        method: 'POST', url: '/api/pipeline/start',
        payload: { stages: '1', hostFilter: [], concurrency: 1, dryRun: true },
    });
    assert.equal(r.statusCode, 200);
    const b = JSON.parse(r.body);
    assert.ok(b.runId);
    assert.equal(b.dryRun, true);
    // cleanup
    await db.query('UPDATE pipeline_runs SET status=$2 WHERE id=$1', [b.runId, 'cancelled']);
    await db.query('UPDATE pipeline_runs SET finished_at=NOW() WHERE id=$1', [b.runId]);
});

test('POST /api/pipeline/start refuses concurrent run', async () => {
    const seed = await db.query(
        "INSERT INTO pipeline_runs (launched_by, stages, host_filter, concurrency, status) VALUES ('ui','1','[]',1,'running') RETURNING id"
    );
    const seedId = seed.rows[0].id;
    try {
        const r = await app.inject({
            method: 'POST', url: '/api/pipeline/start',
            payload: { stages: '1', hostFilter: [], concurrency: 1, dryRun: true },
        });
        assert.equal(r.statusCode, 409);
    } finally {
        await db.query("UPDATE pipeline_runs SET status='cancelled', finished_at=NOW() WHERE id=$1", [seedId]);
    }
});

test('POST /api/pipeline/runs/:id/cancel on non-running returns 400', async () => {
    const seed = await db.query(
        "INSERT INTO pipeline_runs (launched_by, stages, host_filter, concurrency, status, finished_at) VALUES ('ui','1','[]',1,'completed',NOW()) RETURNING id"
    );
    const r = await app.inject({ method: 'POST', url: `/api/pipeline/runs/${seed.rows[0].id}/cancel` });
    assert.equal(r.statusCode, 400);
    await db.query('DELETE FROM pipeline_runs WHERE id=$1', [seed.rows[0].id]);
});
```

- [ ] **Step 2: Run — expect fail**

- [ ] **Step 3: Implement src/routes/pipeline.js**

```javascript
const path = require('path');
const { fork } = require('child_process');
const runs = require('../db/runs');
const events = require('../db/events');

const activeChildren = new Map();  // runId -> child_process

module.exports = async function routes(app) {
    app.post('/api/pipeline/start', async (req, reply) => {
        const { stages = '1,2,3', hostFilter = [], concurrency = 1, dryRun = false } = req.body || {};
        const current = await runs.getCurrentRun();
        if (current) return reply.code(409).send({ error: `run #${current.id} already running`, runId: current.id });

        const run = await runs.createRun({
            launched_by: 'ui',
            stages,
            host_filter: hostFilter,
            concurrency,
        });

        if (dryRun) {
            return { runId: run.id, pid: null, dryRun: true };
        }

        const orchestratorPath = path.resolve(__dirname, '..', 'orchestrator.js');
        const args = [
            '--run-id', String(run.id),
            '--stages', stages,
            '--concurrency', String(concurrency),
        ];
        if (Array.isArray(hostFilter) && hostFilter.length) {
            args.push('--hosts', hostFilter.join(','));
        }
        const child = fork(orchestratorPath, args, {
            stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
            detached: false,
        });
        activeChildren.set(run.id, child);
        await runs.setRunPid(run.id, child.pid);

        child.on('exit', (code, signal) => {
            activeChildren.delete(run.id);
            app.log.info(`orchestrator run #${run.id} exited code=${code} signal=${signal}`);
        });

        return { runId: run.id, pid: child.pid, dryRun: false };
    });

    app.post('/api/pipeline/runs/:id/cancel', async (req, reply) => {
        const id = parseInt(req.params.id, 10);
        const run = await runs.getRunById(id);
        if (!run) return reply.code(404).send({ error: 'not found' });
        if (run.status !== 'running') {
            return reply.code(400).send({ error: `run is ${run.status}` });
        }
        const child = activeChildren.get(id);
        if (child) {
            child.kill('SIGTERM');
            setTimeout(() => {
                if (activeChildren.has(id)) {
                    try { child.kill('SIGKILL'); } catch (_) { }
                }
            }, 30000).unref();
        } else if (run.pid) {
            try { process.kill(run.pid, 'SIGTERM'); } catch (_) { }
        }
        return { cancelRequested: true };
    });

    app.get('/api/pipeline/runs', async () => runs.listRuns(50));

    app.get('/api/pipeline/runs/:id', async (req, reply) => {
        const id = parseInt(req.params.id, 10);
        const run = await runs.getRunById(id);
        if (!run) return reply.code(404).send({ error: 'not found' });
        const evts = await events.listEventsForRun(id, 500);
        return { ...run, events: evts };
    });
};
```

- [ ] **Step 4: Register in server.js**

```javascript
    await app.register(require('./routes/pipeline'));
```

- [ ] **Step 5: Run — expect pass**

```bash
cd src && node --test routes/pipeline.test.js
```

- [ ] **Step 6: Commit**

```bash
git add src/routes/pipeline.js src/routes/pipeline.test.js src/server.js
git commit -m "feat(api): pipeline start/cancel/runs with child_process fork"
```

---

### Task 14: Migration + Ops routes

**Files:**
- Create: `src/routes/migrate.js`
- Create: `src/routes/ops.js`
- Modify: `src/server.js`

- [ ] **Step 1: Write src/routes/migrate.js**

```javascript
const fs = require('fs');
const path = require('path');
const { parseAccounts } = require('../common/state');
const hostsDb = require('../db/hosts');
const membersDb = require('../db/members');

module.exports = async function routes(app) {
    app.post('/api/migrate/txt', async (req, reply) => {
        const { hostsPath, membersPath } = req.body || {};
        const root = path.resolve(__dirname, '..', '..');
        const hp = hostsPath || path.join(root, 'hosts.txt');
        const mp = membersPath || path.join(root, 'members.txt');
        const out = { hosts: null, members: null };

        if (fs.existsSync(hp)) {
            const accts = parseAccounts(hp);
            let inserted = 0, skipped = 0;
            for (const a of accts) {
                const r = await hostsDb.upsertHost({
                    email: a.email, password: a.pass,
                    recovery_email: a.recovery || null,
                    totp_secret: a.totp_secret || null,
                });
                if (r.inserted) inserted++; else skipped++;
            }
            out.hosts = { path: hp, inserted, skipped, total: accts.length };
        } else {
            out.hosts = { path: hp, missing: true };
        }

        if (fs.existsSync(mp)) {
            const accts = parseAccounts(mp);
            let inserted = 0, skipped = 0;
            for (const a of accts) {
                const r = await membersDb.upsertMember({
                    email: a.email, password: a.pass,
                    recovery_email: a.recovery || null,
                    totp_secret: a.totp_secret || null,
                });
                if (r.inserted) inserted++; else skipped++;
            }
            out.members = { path: mp, inserted, skipped, total: accts.length };
        } else {
            out.members = { path: mp, missing: true };
        }

        return out;
    });

    app.get('/api/migrate/detect', async () => {
        const root = path.resolve(__dirname, '..', '..');
        const hp = path.join(root, 'hosts.txt');
        const mp = path.join(root, 'members.txt');
        const result = { hosts: null, members: null };
        if (fs.existsSync(hp)) {
            const accts = parseAccounts(hp);
            const dbHosts = await hostsDb.listHosts({ pageSize: 10000 });
            result.hosts = { path: hp, fileCount: accts.length, dbCount: dbHosts.length, shouldImport: dbHosts.length < accts.length };
        }
        if (fs.existsSync(mp)) {
            const accts = parseAccounts(mp);
            const dbMembers = await membersDb.listMembers({ pageSize: 10000 });
            result.members = { path: mp, fileCount: accts.length, dbCount: dbMembers.length, shouldImport: dbMembers.length < accts.length };
        }
        return result;
    });
};
```

- [ ] **Step 2: Write src/routes/ops.js**

```javascript
/**
 * Ops endpoints — reconcile, etc.
 * Reconcile launches a one-shot fork of orchestrator.js with --reconcile-only flag.
 */
const path = require('path');
const { fork } = require('child_process');
const runs = require('../db/runs');

module.exports = async function routes(app) {
    app.post('/api/reconcile', async (req, reply) => {
        const { hostIds = [] } = req.body || {};
        const current = await runs.getCurrentRun();
        if (current) return reply.code(409).send({ error: `run #${current.id} already running` });

        const run = await runs.createRun({
            launched_by: 'ui',
            stages: 'reconcile',
            host_filter: hostIds,
            concurrency: 1,
        });

        const orchestratorPath = path.resolve(__dirname, '..', 'orchestrator.js');
        const args = [
            '--run-id', String(run.id),
            '--reconcile-only',
        ];
        if (hostIds.length) args.push('--host-ids', hostIds.join(','));

        const child = fork(orchestratorPath, args, {
            stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
        });
        await runs.setRunPid(run.id, child.pid);
        return { runId: run.id, pid: child.pid };
    });
};
```

- [ ] **Step 3: Register both in server.js**

Add after existing register calls:

```javascript
    await app.register(require('./routes/migrate'));
    await app.register(require('./routes/ops'));
```

- [ ] **Step 4: Smoke test migrate detect**

```bash
cd src && node -e "require('./server').build().then(app => app.inject({method:'GET',url:'/api/migrate/detect'})).then(r => { console.log(r.statusCode, r.body); process.exit(0); })"
```

Expected: `200 {...}` showing the current txt file vs DB counts.

- [ ] **Step 5: Commit**

```bash
git add src/routes/migrate.js src/routes/ops.js src/server.js
git commit -m "feat(api): migrate/txt + migrate/detect + reconcile endpoints"
```

---

### Task 15: Phase 2 integration smoke test

**Files:**
- Start server, hit endpoints manually, verify, stop.

- [ ] **Step 1: Start server in background**

```bash
cd src && npm run server > /tmp/server.log 2>&1 &
echo $! > /tmp/server.pid
sleep 2
cat /tmp/server.log
```

Expected: `HTTP ready on http://127.0.0.1:3000`.

- [ ] **Step 2: Test endpoints**

```bash
curl -s http://127.0.0.1:3000/api/ping
echo
curl -s http://127.0.0.1:3000/api/status | head -c 200
echo
curl -s http://127.0.0.1:3000/api/hosts | head -c 200
echo
curl -s http://127.0.0.1:3000/api/members | head -c 200
echo
curl -s http://127.0.0.1:3000/api/migrate/detect
```

All should return valid JSON.

- [ ] **Step 3: Stop server**

```bash
kill $(cat /tmp/server.pid) && rm -f /tmp/server.pid
```

- [ ] **Step 4: No commit** — smoke test only.

---

## Phase 3 — Static UI

### Task 16: Shared CSS + JS utilities

**Files:**
- Create: `public/css/app.css`
- Create: `public/js/app.js`

- [ ] **Step 1: Write public/css/app.css**

```css
/* App-level overrides on top of Tailwind CDN */
body {
    font-family: 'Inter', system-ui, -apple-system, sans-serif;
    background: #0a0a0f;
    color: #e5e7eb;
}
.card {
    background: linear-gradient(135deg, rgba(30,30,50,0.8), rgba(20,20,35,0.9));
    border: 1px solid rgba(100,100,150,0.2);
    backdrop-filter: blur(10px);
    border-radius: 12px;
}
.card:hover {
    border-color: rgba(100,100,200,0.4);
}
.mono { font-family: 'JetBrains Mono', ui-monospace, monospace; }
.pill { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 12px; }
.pill.new { background: #1e293b; color: #94a3b8; }
.pill.invite_pending { background: #1e40af; color: #bfdbfe; }
.pill.invite_failed, .pill.accept_failed, .pill.oauth_failed { background: #7f1d1d; color: #fecaca; }
.pill.joined { background: #166534; color: #bbf7d0; }
.pill.done { background: #14532d; color: #a7f3d0; }
.pill.abandoned { background: #44403c; color: #d6d3d1; }
.pill.removed_from_family { background: #581c87; color: #e9d5ff; }
.drawer {
    position: fixed; top: 0; right: 0; height: 100vh; width: min(560px, 100%);
    background: #0a0a0f; border-left: 1px solid rgba(100,100,150,0.3);
    transform: translateX(100%); transition: transform 240ms ease;
    overflow-y: auto; z-index: 50; padding: 16px;
}
.drawer.open { transform: translateX(0); }
.backdrop { position: fixed; inset: 0; background: rgba(0,0,0,0.5); z-index: 40; display: none; }
.backdrop.open { display: block; }
table.data { width: 100%; border-collapse: collapse; }
table.data th, table.data td { padding: 8px 10px; text-align: left; border-bottom: 1px solid rgba(100,100,150,0.15); font-size: 14px; }
table.data th { color: #9ca3af; font-weight: 600; }
```

- [ ] **Step 2: Write public/js/app.js**

```javascript
// Shared UI helpers. Loaded by all pages.
window.App = (function () {
    async function api(method, url, body) {
        const opts = { method, headers: {} };
        if (body !== undefined) {
            opts.headers['Content-Type'] = 'application/json';
            opts.body = JSON.stringify(body);
        }
        const r = await fetch(url, opts);
        if (r.status === 204) return null;
        const ct = r.headers.get('content-type') || '';
        const data = ct.includes('application/json') ? await r.json() : await r.text();
        if (!r.ok) {
            const msg = (data && data.error) || `HTTP ${r.status}`;
            throw new Error(msg);
        }
        return data;
    }
    function timeago(iso) {
        if (!iso) return '';
        const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
        if (s < 60) return `${s}s ago`;
        if (s < 3600) return `${Math.floor(s / 60)}m ago`;
        if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
        return `${Math.floor(s / 86400)}d ago`;
    }
    function shortToken(t) {
        if (!t) return '—';
        return t.length > 10 ? t.slice(0, 8) + '…' : t;
    }
    async function copyText(s) {
        try { await navigator.clipboard.writeText(s); return true; }
        catch (_) { return false; }
    }
    return { api, timeago, shortToken, copyText };
})();
```

- [ ] **Step 3: Commit**

```bash
git add public/css/app.css public/js/app.js
git commit -m "feat(ui): shared css + app.js (fetch wrapper, timeago, copy)"
```

---

### Task 17: Dashboard page (`/`)

**Files:**
- Overwrite: `public/index.html`

- [ ] **Step 1: Write public/index.html**

```html
<!doctype html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Gemini Family Pipeline — Dashboard</title>
    <script src="https://cdn.jsdelivr.net/npm/@tailwindcss/browser@4"></script>
    <script src="https://cdn.jsdelivr.net/npm/alpinejs@3.x.x/dist/cdn.min.js" defer></script>
    <link rel="stylesheet" href="/public/css/app.css">
</head>
<body class="p-6">
<nav class="mb-6 flex gap-3 items-center">
    <span class="text-lg font-semibold">Gemini Family Pipeline</span>
    <div class="flex-1"></div>
    <a href="/" class="px-3 py-1 rounded hover:bg-slate-800 font-medium">Dashboard</a>
    <a href="/accounts" class="px-3 py-1 rounded hover:bg-slate-800">Accounts</a>
    <a href="/runs" class="px-3 py-1 rounded hover:bg-slate-800">Runs</a>
</nav>

<main x-data="dashboard()" x-init="load(); interval = setInterval(load, 3000)"
      @beforeunload.window="clearInterval(interval)" class="space-y-6">

    <section class="card p-4" x-show="status.currentRun">
        <h2 class="text-lg font-semibold mb-2">Current Run</h2>
        <template x-if="status.currentRun">
            <div class="space-y-2">
                <div class="text-sm">
                    #<span x-text="status.currentRun.id"></span>
                    · stages <span x-text="status.currentRun.stages"></span>
                    · pid <span x-text="status.currentRun.pid || '—'"></span>
                    · started <span x-text="App.timeago(status.currentRun.started_at)"></span>
                </div>
                <pre class="mono text-xs p-2 bg-black/40 rounded"
                     x-text="JSON.stringify(status.currentRun.stats || {}, null, 2)"></pre>
                <button @click="cancelRun(status.currentRun.id)"
                        class="px-3 py-1 bg-red-900 hover:bg-red-800 rounded text-sm">Cancel</button>
            </div>
        </template>
    </section>

    <section class="grid grid-cols-2 gap-4">
        <div class="card p-4">
            <h3 class="font-semibold mb-2">Member Status</h3>
            <ul class="text-sm space-y-1">
                <template x-for="s in ['new','invite_pending','joined','done','invite_failed','accept_failed','oauth_failed','abandoned','removed_from_family']" :key="s">
                    <li class="flex justify-between">
                        <span x-text="s" class="mono"></span>
                        <span x-text="status.byStatus[s] || 0"></span>
                    </li>
                </template>
            </ul>
        </div>
        <div class="card p-4">
            <h3 class="font-semibold mb-2">Host Capacity</h3>
            <ul class="text-sm space-y-1">
                <li class="flex justify-between"><span>total</span><span x-text="status.hosts.total"></span></li>
                <li class="flex justify-between"><span>disabled</span><span x-text="status.hosts.disabled"></span></li>
                <li class="flex justify-between"><span>with free slot</span><span x-text="status.hosts.withFreeSlot"></span></li>
                <li class="flex justify-between"><span>free slots total</span><span x-text="status.hosts.freeSlotsTotal"></span></li>
            </ul>
        </div>
    </section>

    <section class="card p-4">
        <button @click="openStart = true"
                class="px-4 py-2 bg-emerald-700 hover:bg-emerald-600 rounded font-medium">
            ▶ Start Pipeline
        </button>
    </section>

    <!-- Start dialog -->
    <div x-show="openStart" class="backdrop open" @click="openStart = false"></div>
    <div x-show="openStart" class="drawer open" @click.stop>
        <h2 class="text-lg font-semibold mb-4">Start Pipeline</h2>
        <div class="space-y-4">
            <div>
                <div class="text-sm mb-1">Stages</div>
                <label class="mr-3"><input type="checkbox" x-model="form.stages1"> 1 Invite</label>
                <label class="mr-3"><input type="checkbox" x-model="form.stages2"> 2 Accept</label>
                <label><input type="checkbox" x-model="form.stages3"> 3 OAuth</label>
            </div>
            <div>
                <div class="text-sm mb-1">Hosts</div>
                <label class="block"><input type="radio" name="hm" x-model="form.hostMode" value="auto"> Auto (all hosts with free slot)</label>
                <label class="block"><input type="radio" name="hm" x-model="form.hostMode" value="select"> Select specific</label>
                <div x-show="form.hostMode === 'select'" class="ml-4 mt-2 max-h-40 overflow-y-auto text-sm">
                    <template x-for="h in hostsList" :key="h.id">
                        <label class="block"><input type="checkbox" :value="h.email" x-model="form.selectedHosts">
                            <span x-text="h.email" class="mono"></span>
                            (<span x-text="h.slot_free"></span>/5)
                        </label>
                    </template>
                </div>
            </div>
            <div>
                <label class="text-sm">Concurrency
                    <select x-model.number="form.concurrency" class="ml-2 bg-slate-800 px-2 py-1 rounded">
                        <option>1</option><option>2</option><option>3</option><option>4</option><option>5</option>
                    </select>
                </label>
            </div>
            <div class="flex gap-2 pt-2">
                <button @click="openStart = false" class="px-3 py-1 bg-slate-700 rounded">Cancel</button>
                <button @click="submitStart()" class="px-3 py-1 bg-emerald-700 rounded">Start</button>
            </div>
            <div x-show="error" class="text-red-400 text-sm" x-text="error"></div>
        </div>
    </div>
</main>

<script>
function dashboard() {
    return {
        status: { byStatus: {}, hosts: { total: 0, disabled: 0, withFreeSlot: 0, freeSlotsTotal: 0 }, currentRun: null },
        openStart: false,
        hostsList: [],
        form: { stages1: true, stages2: true, stages3: true, hostMode: 'auto', selectedHosts: [], concurrency: 1 },
        error: '',
        interval: null,
        async load() {
            try {
                this.status = await App.api('GET', '/api/status');
                if (this.openStart && !this.hostsList.length) {
                    this.hostsList = await App.api('GET', '/api/hosts?disabled=0');
                }
            } catch (e) { console.error(e); }
        },
        async submitStart() {
            this.error = '';
            const stages = [];
            if (this.form.stages1) stages.push('1');
            if (this.form.stages2) stages.push('2');
            if (this.form.stages3) stages.push('3');
            if (!stages.length) { this.error = 'select at least one stage'; return; }
            const hostFilter = this.form.hostMode === 'select' ? this.form.selectedHosts : [];
            try {
                await App.api('POST', '/api/pipeline/start', {
                    stages: stages.join(','),
                    hostFilter,
                    concurrency: this.form.concurrency,
                });
                this.openStart = false;
                this.load();
            } catch (e) { this.error = e.message; }
        },
        async cancelRun(id) {
            if (!confirm(`Cancel run #${id}?`)) return;
            try {
                await App.api('POST', `/api/pipeline/runs/${id}/cancel`);
                this.load();
            } catch (e) { alert(e.message); }
        },
    };
}
</script>
<script src="/public/js/app.js"></script>
</body>
</html>
```

- [ ] **Step 2: Manual verify**

Start server:
```bash
cd src && npm run server > /tmp/server.log 2>&1 &
echo $! > /tmp/server.pid
sleep 2
```

Open `http://127.0.0.1:3000/` in browser. Expect: dashboard renders; "Member Status" and "Host Capacity" cards show numbers (zeros if DB empty); "Start Pipeline" button visible.

Stop server:
```bash
kill $(cat /tmp/server.pid) && rm -f /tmp/server.pid
```

- [ ] **Step 3: Commit**

```bash
git add public/index.html
git commit -m "feat(ui): dashboard page with status polling + start dialog"
```

---

### Task 18: Accounts page (Hosts + Members tabs)

**Files:**
- Overwrite: `public/accounts.html`

- [ ] **Step 1: Write public/accounts.html**

```html
<!doctype html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <title>Accounts — Gemini Family Pipeline</title>
    <script src="https://cdn.jsdelivr.net/npm/@tailwindcss/browser@4"></script>
    <script src="https://cdn.jsdelivr.net/npm/alpinejs@3.x.x/dist/cdn.min.js" defer></script>
    <link rel="stylesheet" href="/public/css/app.css">
</head>
<body class="p-6">
<nav class="mb-6 flex gap-3 items-center">
    <span class="text-lg font-semibold">Gemini Family Pipeline</span>
    <div class="flex-1"></div>
    <a href="/" class="px-3 py-1 rounded hover:bg-slate-800">Dashboard</a>
    <a href="/accounts" class="px-3 py-1 rounded hover:bg-slate-800 font-medium">Accounts</a>
    <a href="/runs" class="px-3 py-1 rounded hover:bg-slate-800">Runs</a>
</nav>

<main x-data="accounts()" x-init="load()" class="space-y-4">
    <!-- Migration banner -->
    <div x-show="migrate && (migrate.hosts?.shouldImport || migrate.members?.shouldImport)"
         class="card p-4 border-amber-500/50 bg-amber-950/30">
        🔔 检测到本地 txt 文件 &nbsp;(hosts: <span x-text="migrate?.hosts?.fileCount ?? 0"></span>,
        members: <span x-text="migrate?.members?.fileCount ?? 0"></span>)
        <button @click="doImport()" class="ml-3 px-3 py-1 bg-amber-700 hover:bg-amber-600 rounded">从 txt 导入</button>
    </div>

    <div class="flex gap-2 border-b border-slate-700">
        <button @click="tab='hosts'" :class="tab==='hosts' ? 'text-white font-semibold border-b-2 border-emerald-500' : 'text-slate-400'" class="px-4 py-2">Hosts</button>
        <button @click="tab='members'" :class="tab==='members' ? 'text-white font-semibold border-b-2 border-emerald-500' : 'text-slate-400'" class="px-4 py-2">Members</button>
    </div>

    <!-- Hosts tab -->
    <section x-show="tab==='hosts'">
        <div class="flex gap-2 mb-3">
            <button @click="openBulk='hosts'" class="px-3 py-1 bg-slate-700 rounded">+ 批量导入</button>
            <input x-model="hostSearch" @input.debounce.300ms="loadHosts()" placeholder="搜索 email"
                   class="px-3 py-1 bg-slate-800 rounded flex-1">
        </div>
        <table class="data card">
            <thead><tr><th>email</th><th>slot</th><th>disabled</th><th>actions</th></tr></thead>
            <tbody>
                <template x-for="h in hosts" :key="h.id">
                    <tr>
                        <td class="mono" x-text="h.email"></td>
                        <td><span x-text="`${h.slot_used} / 5`"></span></td>
                        <td>
                            <input type="checkbox" :checked="h.disabled" @change="toggleDisabled(h)">
                        </td>
                        <td>
                            <button @click="deleteHost(h)" class="text-red-400 text-sm">Delete</button>
                        </td>
                    </tr>
                </template>
                <tr x-show="!hosts.length"><td colspan="4" class="text-center text-slate-500 py-4">no hosts</td></tr>
            </tbody>
        </table>
    </section>

    <!-- Members tab -->
    <section x-show="tab==='members'">
        <div class="flex gap-2 mb-3">
            <button @click="openBulk='members'" class="px-3 py-1 bg-slate-700 rounded">+ 批量导入</button>
            <select x-model="memberStatusFilter" @change="loadMembers()" class="px-2 py-1 bg-slate-800 rounded">
                <option value="">全部状态</option>
                <template x-for="s in ['new','invite_pending','invite_failed','joined','accept_failed','oauth_failed','done','abandoned','removed_from_family']" :key="s">
                    <option :value="s" x-text="s"></option>
                </template>
            </select>
            <input x-model="memberSearch" @input.debounce.300ms="loadMembers()" placeholder="搜索 email"
                   class="px-3 py-1 bg-slate-800 rounded flex-1">
        </div>
        <table class="data card">
            <thead><tr><th>email</th><th>status</th><th>host</th><th>fail</th><th>token</th><th>actions</th></tr></thead>
            <tbody>
                <template x-for="m in members" :key="m.id">
                    <tr>
                        <td class="mono" x-text="m.email"></td>
                        <td><span class="pill" :class="m.status" x-text="m.status"></span></td>
                        <td class="mono text-xs">
                            <span x-text="m.status === 'done' ? hostEmailById(m.host_id) : '—'"></span>
                        </td>
                        <td x-text="m.fail_count"></td>
                        <td>
                            <template x-if="m.token">
                                <span>
                                    <span class="mono text-xs" x-text="App.shortToken(m.token)"></span>
                                    <button @click="copyToken(m)" class="ml-1 text-xs text-blue-400">Copy</button>
                                </span>
                            </template>
                            <template x-if="!m.token"><span>—</span></template>
                        </td>
                        <td class="space-x-2 text-sm">
                            <button @click="openDetail(m)" class="text-blue-400">Detail</button>
                            <button @click="resetMember(m)" class="text-yellow-400">Reset</button>
                            <button @click="abandonMember(m)" class="text-orange-400">Abandon</button>
                            <button @click="deleteMember(m)" class="text-red-400">Delete</button>
                        </td>
                    </tr>
                </template>
                <tr x-show="!members.length"><td colspan="6" class="text-center text-slate-500 py-4">no members</td></tr>
            </tbody>
        </table>
    </section>

    <!-- Bulk upload modal -->
    <div x-show="openBulk" class="backdrop open" @click="openBulk=''"></div>
    <div x-show="openBulk" class="drawer open" @click.stop>
        <h2 class="text-lg font-semibold mb-4">批量导入 <span class="mono text-base" x-text="openBulk"></span></h2>
        <p class="text-sm text-slate-400 mb-2">格式: <span class="mono">email:pass:recovery:totp</span>（recovery / totp 可选）。重复 email 跳过。</p>
        <textarea x-model="bulkText" rows="12" class="w-full bg-slate-900 p-2 mono text-sm rounded"
                  placeholder="abc@gmail.com:pw1:rec@example.com:TOTP123..."></textarea>
        <div class="mt-3 flex gap-2">
            <button @click="openBulk=''" class="px-3 py-1 bg-slate-700 rounded">Cancel</button>
            <button @click="submitBulk()" class="px-3 py-1 bg-emerald-700 rounded">上传</button>
        </div>
        <div x-show="bulkResult" class="mt-3 text-sm">
            <pre class="mono text-xs p-2 bg-black/40 rounded" x-text="JSON.stringify(bulkResult, null, 2)"></pre>
        </div>
    </div>

    <!-- Member detail drawer -->
    <div x-show="detailOpen" class="backdrop open" @click="detailOpen=false"></div>
    <div x-show="detailOpen" class="drawer open" @click.stop>
        <template x-if="detail">
            <div class="space-y-3">
                <h2 class="text-lg font-semibold mono" x-text="detail.email"></h2>
                <div class="text-sm space-y-1">
                    <div>status: <span class="pill" :class="detail.status" x-text="detail.status"></span></div>
                    <div>fail_count: <span x-text="detail.fail_count"></span></div>
                    <div>invited_at: <span class="mono" x-text="detail.invited_at || '—'"></span></div>
                    <div>joined_at: <span class="mono" x-text="detail.joined_at || '—'"></span></div>
                    <div>done_at: <span class="mono" x-text="detail.done_at || '—'"></span></div>
                    <div>last_error: <span class="mono text-red-400" x-text="detail.last_error || '—'"></span></div>
                    <div class="text-xs text-slate-500">Current host (internal): <span class="mono" x-text="hostEmailById(detail.host_id)"></span></div>
                </div>
                <div>
                    <div class="text-sm font-semibold mb-1">Token</div>
                    <textarea readonly class="w-full bg-slate-900 p-2 mono text-xs rounded" rows="3" x-text="detail.token || ''"></textarea>
                </div>
                <div>
                    <div class="text-sm font-semibold mb-1">Events</div>
                    <ul class="text-xs space-y-1 max-h-80 overflow-y-auto">
                        <template x-for="e in detail.events" :key="e.id">
                            <li class="mono">
                                <span x-text="new Date(e.created_at).toLocaleString()"></span>
                                · <span x-text="e.stage || '-'"></span>
                                · <span x-text="e.event_type"></span>
                                · <span class="text-slate-400" x-text="e.message || ''"></span>
                            </li>
                        </template>
                    </ul>
                </div>
                <div class="flex gap-2 pt-2">
                    <button @click="detailOpen=false" class="px-3 py-1 bg-slate-700 rounded">Close</button>
                </div>
            </div>
        </template>
    </div>
</main>

<script>
function accounts() {
    return {
        tab: 'hosts',
        hosts: [],
        hostMap: {},
        members: [],
        migrate: null,
        hostSearch: '',
        memberSearch: '',
        memberStatusFilter: '',
        openBulk: '',
        bulkText: '',
        bulkResult: null,
        detailOpen: false,
        detail: null,
        async load() {
            await Promise.all([this.loadHosts(), this.loadMembers(), this.loadMigrate()]);
        },
        async loadHosts() {
            const q = this.hostSearch ? `?search=${encodeURIComponent(this.hostSearch)}` : '';
            this.hosts = await App.api('GET', `/api/hosts${q}`);
            this.hostMap = {};
            for (const h of this.hosts) this.hostMap[h.id] = h.email;
        },
        async loadMembers() {
            const q = new URLSearchParams();
            if (this.memberSearch) q.set('search', this.memberSearch);
            if (this.memberStatusFilter) q.set('status', this.memberStatusFilter);
            const qs = q.toString() ? `?${q.toString()}` : '';
            this.members = await App.api('GET', `/api/members${qs}`);
        },
        async loadMigrate() {
            try { this.migrate = await App.api('GET', '/api/migrate/detect'); }
            catch (_) { this.migrate = null; }
        },
        hostEmailById(id) {
            if (!id) return '—';
            return this.hostMap[id] || `#${id}`;
        },
        async submitBulk() {
            const url = this.openBulk === 'hosts' ? '/api/hosts/bulk' : '/api/members/bulk';
            try {
                this.bulkResult = await App.api('POST', url, { lines: this.bulkText });
                await (this.openBulk === 'hosts' ? this.loadHosts() : this.loadMembers());
                this.bulkText = '';
            } catch (e) { alert(e.message); }
        },
        async doImport() {
            try {
                const r = await App.api('POST', '/api/migrate/txt', {});
                alert(`hosts: ${JSON.stringify(r.hosts)}\nmembers: ${JSON.stringify(r.members)}`);
                await this.load();
            } catch (e) { alert(e.message); }
        },
        async toggleDisabled(h) {
            try { await App.api('PATCH', `/api/hosts/${h.id}`, { disabled: !h.disabled }); await this.loadHosts(); }
            catch (e) { alert(e.message); }
        },
        async deleteHost(h) {
            if (!confirm(`Delete host ${h.email}?`)) return;
            try { await App.api('DELETE', `/api/hosts/${h.id}`); await this.loadHosts(); }
            catch (e) { alert(e.message); }
        },
        async openDetail(m) {
            try {
                this.detail = await App.api('GET', `/api/members/${m.id}`);
                this.detailOpen = true;
            } catch (e) { alert(e.message); }
        },
        async copyToken(m) {
            const ok = await App.copyText(m.token);
            alert(ok ? 'copied' : 'copy failed');
        },
        async resetMember(m) {
            if (!confirm(`Reset ${m.email}?`)) return;
            try { await App.api('PATCH', `/api/members/${m.id}?action=reset`, {}); await this.loadMembers(); }
            catch (e) { alert(e.message); }
        },
        async abandonMember(m) {
            if (!confirm(`Abandon ${m.email}?`)) return;
            try { await App.api('PATCH', `/api/members/${m.id}?action=abandon`, {}); await this.loadMembers(); }
            catch (e) { alert(e.message); }
        },
        async deleteMember(m) {
            if (!confirm(`Delete ${m.email}?`)) return;
            try { await App.api('DELETE', `/api/members/${m.id}`); await this.loadMembers(); }
            catch (e) { alert(e.message); }
        },
    };
}
</script>
<script src="/public/js/app.js"></script>
</body>
</html>
```

- [ ] **Step 2: Manual verify**

Start server, open `/accounts`. Expect: migration banner visible (if txt files still exist), Hosts tab shows empty table, Members tab switches fine, 批量导入 dialog opens.

Try bulk upload with 1-2 emails. Refresh and confirm they appear.

- [ ] **Step 3: Commit**

```bash
git add public/accounts.html
git commit -m "feat(ui): accounts page with hosts/members tabs + bulk + drawer"
```

---

### Task 19: Runs page (`/runs`)

**Files:**
- Overwrite: `public/runs.html`

- [ ] **Step 1: Write public/runs.html**

```html
<!doctype html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <title>Runs — Gemini Family Pipeline</title>
    <script src="https://cdn.jsdelivr.net/npm/@tailwindcss/browser@4"></script>
    <script src="https://cdn.jsdelivr.net/npm/alpinejs@3.x.x/dist/cdn.min.js" defer></script>
    <link rel="stylesheet" href="/public/css/app.css">
</head>
<body class="p-6">
<nav class="mb-6 flex gap-3 items-center">
    <span class="text-lg font-semibold">Gemini Family Pipeline</span>
    <div class="flex-1"></div>
    <a href="/" class="px-3 py-1 rounded hover:bg-slate-800">Dashboard</a>
    <a href="/accounts" class="px-3 py-1 rounded hover:bg-slate-800">Accounts</a>
    <a href="/runs" class="px-3 py-1 rounded hover:bg-slate-800 font-medium">Runs</a>
</nav>

<main x-data="runsPage()" x-init="load(); interval = setInterval(load, 3000)"
      @beforeunload.window="clearInterval(interval)" class="space-y-4">

    <table class="data card">
        <thead><tr><th>#</th><th>status</th><th>stages</th><th>launched_by</th><th>started</th><th>duration</th><th>stats</th><th></th></tr></thead>
        <tbody>
            <template x-for="r in runs" :key="r.id">
                <tr :class="r.status === 'running' ? 'bg-blue-950/30' : ''">
                    <td x-text="r.id"></td>
                    <td><span class="pill" x-text="r.status"></span></td>
                    <td class="mono" x-text="r.stages"></td>
                    <td class="text-xs" x-text="r.launched_by"></td>
                    <td class="text-xs" x-text="App.timeago(r.started_at)"></td>
                    <td class="text-xs" x-text="duration(r)"></td>
                    <td class="mono text-xs truncate max-w-xs" x-text="r.stats ? JSON.stringify(r.stats) : '—'"></td>
                    <td><button @click="openRun(r)" class="text-blue-400 text-sm">events</button></td>
                </tr>
            </template>
        </tbody>
    </table>

    <div x-show="drawerOpen" class="backdrop open" @click="drawerOpen=false"></div>
    <div x-show="drawerOpen" class="drawer open" @click.stop>
        <template x-if="current">
            <div>
                <h2 class="text-lg font-semibold">Run #<span x-text="current.id"></span></h2>
                <div class="text-sm text-slate-400 mb-2" x-text="current.status + ' · ' + (current.stages || '')"></div>
                <ul class="text-xs space-y-1 max-h-[70vh] overflow-y-auto">
                    <template x-for="e in current.events" :key="e.id">
                        <li class="mono">
                            <span x-text="new Date(e.created_at).toLocaleTimeString()"></span>
                            · <span x-text="e.stage || '-'"></span>
                            · <span x-text="e.event_type"></span>
                            · <span class="text-slate-400" x-text="e.message || ''"></span>
                        </li>
                    </template>
                </ul>
                <button @click="drawerOpen=false" class="mt-3 px-3 py-1 bg-slate-700 rounded">Close</button>
            </div>
        </template>
    </div>
</main>

<script>
function runsPage() {
    return {
        runs: [], drawerOpen: false, current: null, interval: null,
        async load() {
            try { this.runs = await App.api('GET', '/api/pipeline/runs'); } catch (_) { }
        },
        duration(r) {
            if (!r.started_at) return '—';
            const start = new Date(r.started_at).getTime();
            const end = r.finished_at ? new Date(r.finished_at).getTime() : Date.now();
            const s = Math.floor((end - start) / 1000);
            if (s < 60) return `${s}s`;
            if (s < 3600) return `${Math.floor(s/60)}m ${s%60}s`;
            return `${Math.floor(s/3600)}h ${Math.floor(s%3600/60)}m`;
        },
        async openRun(r) {
            try {
                this.current = await App.api('GET', `/api/pipeline/runs/${r.id}`);
                this.drawerOpen = true;
            } catch (e) { alert(e.message); }
        },
    };
}
</script>
<script src="/public/js/app.js"></script>
</body>
</html>
```

- [ ] **Step 2: Manual verify**

Start server, open `/runs`. Expect: empty table if no runs yet, or list prior runs. Click "events" → drawer opens.

- [ ] **Step 3: Commit**

```bash
git add public/runs.html
git commit -m "feat(ui): runs history page with event drawer"
```

---

### Task 20: Phase 3 end-to-end smoke

- [ ] **Step 1: Start server, manually walk through all 3 pages**

```bash
cd src && npm run server > /tmp/server.log 2>&1 &
echo $! > /tmp/server.pid
sleep 2
```

Then in browser:
1. `/` — dashboard shows status; Start dialog opens but don't submit yet
2. `/accounts` — migration banner OR tabs work; bulk upload test small batch succeeds
3. `/runs` — empty or showing test rows from Phase 2

- [ ] **Step 2: Stop server**

```bash
kill $(cat /tmp/server.pid) && rm -f /tmp/server.pid
```

- [ ] **Step 3: No commit**

---

## Phase 4 — Orchestrator + Stage Rewrites + Bug Fix

### Task 21: pickHost pure function (TDD)

**Files:**
- Create: `src/orchestrator/pick-host.js`
- Create: `src/orchestrator/pick-host.test.js`

- [ ] **Step 1: Write tests**

```javascript
// src/orchestrator/pick-host.test.js
const test = require('node:test');
const assert = require('node:assert');
const { pickHost } = require('./pick-host');

function H(id, email, slot_used = 0, disabled = false) {
    return { id, email, slot_used, slot_free: 5 - slot_used, disabled, created_at: new Date(id * 1000).toISOString() };
}

test('pickHost picks host with fewest slot_used', () => {
    const hosts = [H(1, 'a@x', 4), H(2, 'b@x', 1), H(3, 'c@x', 3)];
    const h = pickHost(hosts, []);
    assert.equal(h.id, 2);
});

test('pickHost tie-breaks by created_at ASC', () => {
    const hosts = [H(2, 'b@x', 1), H(1, 'a@x', 1)];
    const h = pickHost(hosts, []);
    assert.equal(h.id, 1);
});

test('pickHost skips full hosts', () => {
    const hosts = [H(1, 'a@x', 5), H(2, 'b@x', 4)];
    const h = pickHost(hosts, []);
    assert.equal(h.id, 2);
});

test('pickHost skips disabled hosts', () => {
    const hosts = [H(1, 'a@x', 0, true), H(2, 'b@x', 3)];
    const h = pickHost(hosts, []);
    assert.equal(h.id, 2);
});

test('pickHost restricts to filter list when non-empty', () => {
    const hosts = [H(1, 'a@x', 0), H(2, 'b@x', 0), H(3, 'c@x', 0)];
    const h = pickHost(hosts, ['b@x']);
    assert.equal(h.id, 2);
});

test('pickHost returns null when no candidates', () => {
    const hosts = [H(1, 'a@x', 5), H(2, 'b@x', 5)];
    const h = pickHost(hosts, []);
    assert.equal(h, null);
});

test('pickHost returns null when filter matches nothing with slots', () => {
    const hosts = [H(1, 'a@x', 0), H(2, 'b@x', 5)];
    const h = pickHost(hosts, ['b@x']);
    assert.equal(h, null);
});
```

- [ ] **Step 2: Run — expect fail**

```bash
cd src && node --test orchestrator/pick-host.test.js
```

- [ ] **Step 3: Implement**

```javascript
// src/orchestrator/pick-host.js
/**
 * Spread strategy: prefer hosts with FEWEST used slots.
 * See spec §6 "Host 分配".
 */
function pickHost(hosts, hostFilter) {
    const filter = (hostFilter || []).map(s => String(s).toLowerCase());
    const candidates = hosts.filter(h => {
        if (h.disabled) return false;
        if ((h.slot_free || 0) <= 0) return false;
        if (filter.length && !filter.includes(String(h.email).toLowerCase())) return false;
        return true;
    });
    if (!candidates.length) return null;
    candidates.sort((a, b) => {
        const su = (a.slot_used || 0) - (b.slot_used || 0);
        if (su !== 0) return su;
        return new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
    });
    return candidates[0];
}

module.exports = { pickHost };
```

- [ ] **Step 4: Run — expect pass**

- [ ] **Step 5: Commit**

```bash
git add src/orchestrator/pick-host.js src/orchestrator/pick-host.test.js
git commit -m "feat(orchestrator): pickHost spread strategy + tests"
```

---

### Task 22: Stage 2 email matcher (TDD + bug fix)

**Files:**
- Create: `src/stages/stage2-matcher.js`
- Create: `src/stages/stage2-matcher.test.js`

- [ ] **Step 1: Write tests — cover the bug we found**

```javascript
// src/stages/stage2-matcher.test.js
const test = require('node:test');
const assert = require('node:assert');
const { isInviteRow, findAcceptLinkInRows } = require('./stage2-matcher');

test('matches genuine family invite row', () => {
    const row = {
        text: 'unread google bond has invited you to their family group family/join/ABC',
        hrefs: ['https://myaccount.google.com/family/join/ABC'],
    };
    assert.equal(isInviteRow(row), true);
});

test('rejects welcome to google one email', () => {
    const row = {
        text: "unread, google one, welcome to google one, luis, apr 18, you've been added to bo",
        hrefs: ['https://one.google.com/home'],
    };
    assert.equal(isInviteRow(row), false);
});

test('rejects host-side "X joined your family group" notification', () => {
    const row = {
        text: 'unread, google, your new family group member, apr 18, luis buderus joined your family',
        hrefs: ['https://notifications.googleapis.com/email/redirect?t=foo'],
    };
    assert.equal(isInviteRow(row), false);
});

test('rejects "you have been added to X family" confirmation', () => {
    const row = {
        text: "google, you've been added to bond's family group",
        hrefs: ['https://one.google.com/home'],
    };
    assert.equal(isInviteRow(row), false);
});

test('accepts row where link contains family/join even without keyword', () => {
    const row = {
        text: 'gmail notification apr 18',
        hrefs: ['https://myaccount.google.com/family/join/XYZ'],
    };
    assert.equal(isInviteRow(row), true);
});

test('findAcceptLinkInRows picks the first invite row', () => {
    const rows = [
        { text: 'welcome to google one, bo...', hrefs: ['https://one.google.com/home'] },
        { text: 'bond invited you to family', hrefs: ['https://myaccount.google.com/family/join/ABC'] },
    ];
    const link = findAcceptLinkInRows(rows);
    assert.equal(link, 'https://myaccount.google.com/family/join/ABC');
});
```

- [ ] **Step 2: Run — expect fail**

```bash
cd src && node --test stages/stage2-matcher.test.js
```

- [ ] **Step 3: Implement**

```javascript
// src/stages/stage2-matcher.js
/**
 * Stage 2 invite-email matcher. Pure functions (no DOM access)
 * so they can be unit-tested. Adapters in 2_accept.js feed them
 * { text, hrefs } extracted from Gmail rows.
 *
 * Fix for bug surfaced 2026-04-19:
 *   Old matcher used loose keywords like 'google one' / 'family group'
 *   which false-matched welcome-after-join emails and host-side
 *   "X joined your family group" notifications. Fix: require
 *   family/join URL OR strong invite keywords AND explicitly
 *   exclude confirmation phrases.
 */

const INVITE_URL_MARKERS = ['family/join', 'families.google.com/join', 'one.google.com/family/join'];

const EXCLUDE_PHRASES = [
    'welcome to google one',
    "you've been added to",
    'you have been added to',
    'joined your family',
    'your new family group member',
    '你已加入',
    '加入了你的家庭组',
    '欢迎加入 google one',
];

const STRONG_INVITE_KEYWORDS = [
    'invited you to',
    'wants to add you',
    'invitation to join',
    'join the family',
    '邀请你加入',
    'a invité',
    'te invitó',
    'ha invitado',
    'zaprasza cię',
];

function normalize(s) {
    return (s || '').toLowerCase();
}

function hasAny(haystack, needles) {
    const hay = normalize(haystack);
    return needles.some(n => hay.includes(n));
}

function isInviteRow(row) {
    const text = normalize(row && row.text);
    const hrefs = (row && row.hrefs) || [];
    if (!text && !hrefs.length) return false;

    if (EXCLUDE_PHRASES.some(p => text.includes(p))) return false;

    for (const h of hrefs) {
        const hl = normalize(h);
        if (INVITE_URL_MARKERS.some(m => hl.includes(m))) return true;
    }

    if (STRONG_INVITE_KEYWORDS.some(k => text.includes(k))) {
        if (hrefs.some(h => /google\.com/i.test(h) || /googleusercontent\.com/i.test(h))) return true;
    }

    return false;
}

function findAcceptLinkInRows(rows) {
    for (const row of rows || []) {
        if (!isInviteRow(row)) continue;
        for (const h of row.hrefs || []) {
            if (INVITE_URL_MARKERS.some(m => normalize(h).includes(m))) return h;
        }
        if (row.hrefs && row.hrefs.length) return row.hrefs[0];
    }
    return null;
}

module.exports = {
    isInviteRow,
    findAcceptLinkInRows,
    INVITE_URL_MARKERS,
    EXCLUDE_PHRASES,
    STRONG_INVITE_KEYWORDS,
};
```

- [ ] **Step 4: Run — expect pass**

```bash
cd src && node --test stages/stage2-matcher.test.js
```

Expected: `pass 6`.

- [ ] **Step 5: Commit**

```bash
git add src/stages/stage2-matcher.js src/stages/stage2-matcher.test.js
git commit -m "fix(stage2): tighten invite-email matcher + unit tests

Previously matched welcome/notification emails due to loose
'google one' / 'family group' keywords. Now requires either
family/join URL or strong invite phrase AND explicitly rejects
post-join confirmation emails."
```

---

### Task 23: Reconcile module (scrape Google family page)

**Files:**
- Create: `src/stages/reconcile.js`

Note: The reconcile scraper interacts with Google UI; we test it manually in Phase 6. For now the module exports a function that takes a Puppeteer page and returns the family member emails; DB reconciliation logic is tested via mocking.

- [ ] **Step 1: Write src/stages/reconcile.js**

```javascript
/**
 * Reconcile: fetch Google family members for a host, diff with DB, patch states.
 *
 * Exposed:
 *   scrapeFamilyMembers(page, wlog) -> [{ email, displayName }]
 *   reconcileAgainstDB(hostRecord, membersFromGoogle, db) -> { changes: [] }
 *   reconcileHost(hostRecord, browser, db, wlog) -> full flow
 */
const { sleep, newPage, clearBrowserSession } = require('../common/chrome');
const { googleLogin } = require('../common/google-login');
const membersDb = require('../db/members');
const eventsDb = require('../db/events');

const FAMILY_URL = 'https://myaccount.google.com/family/details?utm_source=g1web&utm_medium=default';

async function scrapeFamilyMembers(page, wlog) {
    await page.goto(FAMILY_URL, { waitUntil: 'networkidle2', timeout: 30000 }).catch(e =>
        wlog && wlog.warn(`family page load: ${e.message}`));
    await sleep(2000);

    // Find elements that look like member rows on the family details page.
    // Google Family UI renders email text inside each member row; exact DOM
    // classes are unstable — rely on text extraction + email regex filter.
    const emails = await page.evaluate(() => {
        const EMAIL_RE = /([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/g;
        const text = document.body ? document.body.innerText : '';
        const hits = new Set();
        let m;
        while ((m = EMAIL_RE.exec(text)) !== null) hits.add(m[1].toLowerCase());
        return Array.from(hits);
    }).catch(() => []);
    return emails;
}

async function reconcileAgainstDB(hostRecord, googleEmails, runId) {
    const changes = [];
    const all = await membersDb.listMembers({ hostId: hostRecord.id, pageSize: 10000 });
    const googleSet = new Set(googleEmails.map(e => e.toLowerCase()));

    for (const m of all) {
        const emailLower = (m.email || '').toLowerCase();
        const inFamily = googleSet.has(emailLower);

        if (inFamily && m.status === 'invite_pending') {
            await membersDb.transitionToJoined(m.id);
            await eventsDb.logEvent({
                memberId: m.id, hostId: hostRecord.id, runId,
                stage: 'reconcile', eventType: 'note',
                message: 'invite_pending → joined via family page',
            });
            changes.push({ id: m.id, from: 'invite_pending', to: 'joined' });
        } else if (!inFamily && (m.status === 'joined' || m.status === 'done')) {
            await membersDb.markRemovedFromFamily(m.id);
            await eventsDb.logEvent({
                memberId: m.id, hostId: hostRecord.id, runId,
                stage: 'reconcile', eventType: 'note',
                message: `${m.status} → removed_from_family (not in google family)`,
            });
            changes.push({ id: m.id, from: m.status, to: 'removed_from_family' });
        }
    }
    return { changes };
}

async function reconcileHost(hostRecord, browser, runId, wlog) {
    if (hostRecord.disabled) {
        wlog && wlog.info(`reconcile: skip disabled host ${hostRecord.email}`);
        return { changes: [] };
    }
    await clearBrowserSession(browser, wlog);
    const page = await newPage(browser);
    try {
        wlog && wlog.info(`reconcile: login host ${hostRecord.email}`);
        await page.goto('https://accounts.google.com/signin', { waitUntil: 'networkidle2', timeout: 30000 }).catch(() => { });
        await googleLogin(page, {
            email: hostRecord.email,
            pass: hostRecord.password,
            recovery: hostRecord.recovery_email || '',
            totp_secret: hostRecord.totp_secret || undefined,
        }, wlog);
        await sleep(2000);
        const emails = await scrapeFamilyMembers(page, wlog);
        wlog && wlog.info(`reconcile: host ${hostRecord.email} has ${emails.length} family members`);
        return reconcileAgainstDB(hostRecord, emails, runId);
    } finally {
        await page.close().catch(() => { });
        await clearBrowserSession(browser, wlog);
    }
}

module.exports = { scrapeFamilyMembers, reconcileAgainstDB, reconcileHost, FAMILY_URL };
```

- [ ] **Step 2: Commit**

```bash
git add src/stages/reconcile.js
git commit -m "feat(stages): reconcile module — scrape family page + diff DB"
```

---

### Task 24: Stage 1 rewrite (DB-backed main)

**Files:**
- Modify: `src/1_invite.js` (rewrite `main()` only; keep `inviteGroup` and helpers)

- [ ] **Step 1: Read the existing file structure**

Run:
```bash
cd src && grep -n '^async function main' 1_invite.js
```

Expected output: `1041:async function main() {` (or similar). Note line number.

- [ ] **Step 2: Replace the `main()` function**

Open `src/1_invite.js`, find `async function main()` at line ~1041 and replace **everything from the start of that function through the `main().catch(...)` block at the end of the file** with:

```javascript
// ============ main — DB-backed orchestrator entry ============
const hostsDb = require('./db/hosts');
const membersDb = require('./db/members');
const eventsDb = require('./db/events');
const { pickHost } = require('./orchestrator/pick-host');

let _workers = [];
function cleanupWorkers(workers) {
    const keep = (process.env.KEEP_BROWSER_OPEN || '').toLowerCase() === 'true';
    for (const w of workers) {
        if (keep) { try { w.browser.disconnect(); } catch (_) { } }
        else { try { w.browser.close(); } catch (_) { } try { w.proc.kill(); } catch (_) { } }
    }
}

async function runStage1({ runId, hostFilter = [], concurrency = 1 }) {
    const chromePath = findChrome();
    if (!chromePath) throw new Error('Chrome not found');

    const [work, allHosts] = await Promise.all([
        membersDb.listMembersForStage(1),
        hostsDb.listHosts({ pageSize: 10000 }),
    ]);

    log(`Stage1: ${work.length} pending members, ${allHosts.length} hosts`);
    if (!work.length) return { ok: 0, ng: 0 };

    // Assign members to hosts up-front (single-pass, respecting slot_free).
    // pickHost mutates slot_used ephemerally so we clone.
    const cloned = allHosts.map(h => ({ ...h }));
    const assignments = [];
    for (const m of work) {
        const h = pickHost(cloned, hostFilter);
        if (!h) break;
        assignments.push({ member: m, host: h });
        h.slot_used += 1;
        h.slot_free -= 1;
    }
    log(`Stage1: assigned ${assignments.length} invitations`);
    if (!assignments.length) return { ok: 0, ng: 0 };

    // Group assignments by host for batch inviteGroup() calls.
    const byHost = new Map();
    for (const a of assignments) {
        if (!byHost.has(a.host.id)) byHost.set(a.host.id, { host: a.host, members: [] });
        byHost.get(a.host.id).members.push(a.member);
    }

    // Launch workers (one Chrome per worker).
    const workers = _workers = [];
    for (let w = 0; w < Math.min(concurrency, byHost.size); w++) {
        const chrome = await launchRealChrome(chromePath, w);
        workers.push({ id: w, ...chrome });
        if (w < concurrency - 1) await sleep(rand(2000, 3000));
    }

    const groupQueue = Array.from(byHost.values());
    let groupIdx = 0;
    const stats = { ok: 0, ng: 0 };

    async function workerFn(worker) {
        const wlog = createWorkerLogger(worker.id);
        while (true) {
            const idx = groupIdx++;
            if (idx >= groupQueue.length) break;
            const { host, members } = groupQueue[idx];
            const memberEmails = members.map(m => m.email);

            // Mark invite_pending up-front so UI sees progress
            for (const m of members) {
                await membersDb.transitionToInvitePending(m.id, host.id);
                await eventsDb.logEvent({ memberId: m.id, hostId: host.id, runId, stage: 'stage1', eventType: 'start' });
            }

            try {
                const alive = await isChromeAlive(worker);
                if (!alive) await restartChrome(chromePath, worker);

                const hostAccount = {
                    idx: host.id, email: host.email, pass: host.password,
                    recovery: host.recovery_email || '',
                    totp_secret: host.totp_secret || undefined,
                };
                const groupState = { groupId: host.id, host: hostAccount, members: members.map(m => ({ email: m.email, pass: m.password })) };
                const ok = await inviteGroup(groupState, hostAccount, memberEmails, worker.browser, worker.id);

                if (ok) {
                    stats.ok += members.length;
                    for (const m of members) {
                        await eventsDb.logEvent({ memberId: m.id, hostId: host.id, runId, stage: 'stage1', eventType: 'success' });
                    }
                } else {
                    throw new Error('inviteGroup returned falsy');
                }
            } catch (e) {
                wlog.error(`Stage1 host=${host.email} failed: ${e.message}`);
                stats.ng += members.length;
                for (const m of members) {
                    await membersDb.transitionToFailed(m.id, { newStatus: 'invite_failed', error: e.message, releaseHost: true });
                    await eventsDb.logEvent({ memberId: m.id, hostId: host.id, runId, stage: 'stage1', eventType: 'fail', message: e.message });
                }
                if (/Protocol error|Target closed|Session closed/i.test(e.message || '')) {
                    try { await restartChrome(chromePath, worker); } catch (_) { }
                }
            }
            await sleep(rand(1000, 2000));
        }
    }

    await Promise.all(workers.map(w => workerFn(w)));
    cleanupWorkers(workers);
    log(`Stage1 done: OK=${stats.ok} FAIL=${stats.ng}`, 'SUCCESS');
    return stats;
}

process.on('SIGINT', () => { cleanupWorkers(_workers); process.exit(130); });
process.on('SIGTERM', () => { cleanupWorkers(_workers); process.exit(143); });

module.exports = { runStage1 };

if (require.main === module) {
    runStage1({ runId: null, concurrency: 1 })
        .then(() => process.exit(0))
        .catch(e => { log(`Fatal: ${e.message}`, 'ERROR'); process.exit(1); });
}
```

- [ ] **Step 3: Syntax check**

```bash
cd src && node --check 1_invite.js
```

Expected: no output.

- [ ] **Step 4: Dry-run with zero members in DB**

```bash
cd src && node -e "require('./1_invite').runStage1({runId:null,concurrency:1}).then(r=>{console.log('done',r); require('./db').close();})"
```

Expected: `Stage1: 0 pending members, 0 hosts` then `done { ok: 0, ng: 0 }`. Exit clean.

- [ ] **Step 5: Commit**

```bash
git add src/1_invite.js
git commit -m "feat(stage1): DB-backed runStage1 + assignment + event logging

Keep inviteGroup() and browser helpers untouched. Replace main()
with DB-driven work queue; per-host batch preserved to match
existing inviteGroup signature."
```

---

### Task 25: Stage 2 rewrite + plug the matcher fix

**Files:**
- Modify: `src/2_accept.js`

- [ ] **Step 1: Patch the email-scan block to use the new matcher**

In `src/2_accept.js`, find the `emailFound = await page.evaluate((keywords) => {...}, searchKeywords)` block (~line 298). Replace it with code that extracts row text AND row href list, then passes to the matcher:

Open `src/2_accept.js`. Near the top of the file (after existing requires), add:

```javascript
const { isInviteRow, findAcceptLinkInRows } = require('./stages/stage2-matcher');
```

Then find the block starting `// 方法2：直接在页面中查找邀请邮件` and the subsequent `emailFound = await page.evaluate(...)`. Replace it (keeping the rest of the function) with:

```javascript
            // Scan inbox rows, extract { text, hrefs }, delegate to pure matcher.
            const rowData = await page.evaluate(() => {
                const rows = document.querySelectorAll('tr.zA, tr.zE, div[role="row"], tr[draggable="true"]');
                const out = [];
                for (const row of rows) {
                    const r = row.getBoundingClientRect();
                    if (r.width < 200 || r.height < 20) continue;
                    const text = (row.textContent || '').trim();
                    if (!text) continue;
                    if (text.toLowerCase().includes('promotions') && text.toLowerCase().includes('social')) continue;
                    const hrefs = [];
                    for (const a of row.querySelectorAll('a[href]')) {
                        const h = a.getAttribute('data-saferedirecturl') || a.getAttribute('href') || '';
                        if (h) hrefs.push(h);
                    }
                    out.push({ text, hrefs });
                }
                return out;
            }).catch(() => []);

            const matched = rowData.find(r => isInviteRow(r));
            const emailFound = matched ? matched.text.substring(0, 80) : null;
```

Keep the rest of the flow (clicking row, waiting for body, accept-link scan) as-is. The accept-link extraction inside the opened email still uses the existing logic since that operates on `<a>` tags in the message body (different from the inbox scan).

- [ ] **Step 2: Rewrite main() at end of file**

Find `async function main()` (~line 806). Replace from `async function main()` through the final `main().catch(...)` with:

```javascript
// ============ main — DB-backed ============
const membersDb = require('./db/members');
const eventsDb  = require('./db/events');

let _workers2 = [];
function cleanupWorkers2(workers) {
    const keep = (process.env.KEEP_BROWSER_OPEN || '').toLowerCase() === 'true';
    for (const w of workers) {
        if (keep) { try { w.browser.disconnect(); } catch (_) { } }
        else { try { w.browser.close(); } catch (_) { } try { w.proc.kill(); } catch (_) { } }
    }
}

async function runStage2({ runId, concurrency = 1 } = {}) {
    const chromePath = findChrome();
    if (!chromePath) throw new Error('Chrome not found');

    const work = await membersDb.listMembersForStage(2);
    log(`Stage2: ${work.length} pending acceptances`);
    if (!work.length) return { ok: 0, ng: 0 };

    const workers = _workers2 = [];
    for (let w = 0; w < Math.min(concurrency, work.length); w++) {
        const chrome = await launchRealChrome(chromePath, w);
        workers.push({ id: w, ...chrome });
        if (w < concurrency - 1) await sleep(rand(2000, 3000));
    }

    let idx = 0;
    const stats = { ok: 0, ng: 0 };

    async function workerFn(worker) {
        const wlog = createWorkerLogger(worker.id);
        while (true) {
            const i = idx++;
            if (i >= work.length) break;
            const m = work[i];
            const memberAccount = {
                idx: m.id, email: m.email, pass: m.password,
                recovery: m.recovery_email || '',
                totp_secret: m.totp_secret || undefined,
            };

            await eventsDb.logEvent({ memberId: m.id, hostId: m.host_id, runId, stage: 'stage2', eventType: 'start' });
            try {
                const alive = await isChromeAlive(worker);
                if (!alive) await restartChrome(chromePath, worker);

                const hardTimeout = parseInt(process.env.ACCEPT_HARD_TIMEOUT_MS, 10) ||
                    (INVITE_WAIT_TIMEOUT * 1000 + 300000);
                const ok = await Promise.race([
                    acceptInvite(memberAccount, worker.browser, worker.id),
                    new Promise((_, rej) => setTimeout(() => rej(new Error(`hard_timeout ${hardTimeout}ms`)), hardTimeout)),
                ]);

                if (ok) {
                    await membersDb.transitionToJoined(m.id);
                    await eventsDb.logEvent({ memberId: m.id, hostId: m.host_id, runId, stage: 'stage2', eventType: 'success' });
                    stats.ok++;
                } else {
                    throw new Error('acceptInvite returned falsy');
                }
            } catch (e) {
                wlog.error(`Stage2 [${m.email}]: ${e.message}`);
                await membersDb.transitionToFailed(m.id, { newStatus: 'accept_failed', error: e.message, releaseHost: false });
                await eventsDb.logEvent({ memberId: m.id, hostId: m.host_id, runId, stage: 'stage2', eventType: 'fail', message: e.message });
                stats.ng++;
                if (/hard_timeout|Protocol error|Session closed|Target closed/i.test(e.message || '')) {
                    try { await restartChrome(chromePath, worker); } catch (_) { }
                }
            }
            await sleep(rand(1000, 2000));
        }
    }

    await Promise.all(workers.map(w => workerFn(w)));
    cleanupWorkers2(workers);
    log(`Stage2 done: OK=${stats.ok} FAIL=${stats.ng}`, 'SUCCESS');
    return stats;
}

process.on('SIGINT',  () => { cleanupWorkers2(_workers2); process.exit(130); });
process.on('SIGTERM', () => { cleanupWorkers2(_workers2); process.exit(143); });

module.exports = { runStage2, acceptInvite };

if (require.main === module) {
    runStage2({ runId: null, concurrency: 1 })
        .then(() => process.exit(0))
        .catch(e => { log(`Fatal: ${e.message}`, 'ERROR'); process.exit(1); });
}
```

- [ ] **Step 3: Syntax + matcher unit tests still pass**

```bash
cd src && node --check 2_accept.js && node --test stages/stage2-matcher.test.js
```

- [ ] **Step 4: Dry-run**

```bash
cd src && node -e "require('./2_accept').runStage2({runId:null,concurrency:1}).then(r=>{console.log(r); require('./db').close();})"
```

Expected: `Stage2: 0 pending acceptances` → `{ ok: 0, ng: 0 }`.

- [ ] **Step 5: Commit**

```bash
git add src/2_accept.js
git commit -m "feat(stage2): DB-backed runStage2 + apply matcher fix to inbox scan"
```

---

### Task 26: Stage 3 rewrite

**Files:**
- Modify: `src/3_local_oauth.js` (rewrite main())

- [ ] **Step 1: Peek existing main to find the per-member oauth function**

```bash
cd src && grep -n '^async function\|^function main' 3_local_oauth.js
```

Note the name of the per-member function (e.g., `performOAuth`, `oauthOne`, or similar — record it).

- [ ] **Step 2: Inspect the per-member function's signature and return value**

Read the function body. The key information: it takes a member account, returns either `{ token, ... }` (refresh token) or throws.

Assume the function is named `oauthOne(memberAccount, browser, workerId)` and returns an object with `refresh_token`. If the actual name differs, substitute it throughout.

- [ ] **Step 3: Replace main() with DB-backed version**

Find `async function main()` and everything after (through the final `main().catch(...)`). Replace with:

```javascript
// ============ main — DB-backed ============
const membersDb = require('./db/members');
const eventsDb  = require('./db/events');

let _workers3 = [];
function cleanupWorkers3(workers) {
    const keep = (process.env.KEEP_BROWSER_OPEN || '').toLowerCase() === 'true';
    for (const w of workers) {
        if (keep) { try { w.browser.disconnect(); } catch (_) { } }
        else { try { w.browser.close(); } catch (_) { } try { w.proc.kill(); } catch (_) { } }
    }
}

async function runStage3({ runId, concurrency = 1 } = {}) {
    const chromePath = findChrome();
    if (!chromePath) throw new Error('Chrome not found');

    const work = await membersDb.listMembersForStage(3);
    log(`Stage3: ${work.length} pending oauth`);
    if (!work.length) return { ok: 0, ng: 0 };

    const workers = _workers3 = [];
    for (let w = 0; w < Math.min(concurrency, work.length); w++) {
        const chrome = await launchRealChrome(chromePath, w);
        workers.push({ id: w, ...chrome });
        if (w < concurrency - 1) await sleep(rand(2000, 3000));
    }

    let idx = 0;
    const stats = { ok: 0, ng: 0 };

    async function workerFn(worker) {
        const wlog = createWorkerLogger(worker.id);
        while (true) {
            const i = idx++;
            if (i >= work.length) break;
            const m = work[i];
            const memberAccount = {
                idx: m.id, email: m.email, pass: m.password,
                recovery: m.recovery_email || '',
                totp_secret: m.totp_secret || undefined,
            };

            await eventsDb.logEvent({ memberId: m.id, hostId: m.host_id, runId, stage: 'stage3', eventType: 'start' });
            try {
                const result = await oauthOne(memberAccount, worker.browser, worker.id);
                const token = result && (result.refresh_token || result.token);
                if (!token) throw new Error('no refresh_token returned');
                await membersDb.transitionToDone(m.id, token, result || {});
                await eventsDb.logEvent({ memberId: m.id, hostId: m.host_id, runId, stage: 'stage3', eventType: 'success' });
                stats.ok++;
            } catch (e) {
                wlog.error(`Stage3 [${m.email}]: ${e.message}`);
                await membersDb.transitionToFailed(m.id, { newStatus: 'oauth_failed', error: e.message, releaseHost: false });
                await eventsDb.logEvent({ memberId: m.id, hostId: m.host_id, runId, stage: 'stage3', eventType: 'fail', message: e.message });
                stats.ng++;
                if (/Protocol error|Session closed|Target closed/i.test(e.message || '')) {
                    try { await restartChrome(chromePath, worker); } catch (_) { }
                }
            }
            await sleep(rand(1000, 2000));
        }
    }

    await Promise.all(workers.map(w => workerFn(w)));
    cleanupWorkers3(workers);
    log(`Stage3 done: OK=${stats.ok} FAIL=${stats.ng}`, 'SUCCESS');
    return stats;
}

process.on('SIGINT',  () => { cleanupWorkers3(_workers3); process.exit(130); });
process.on('SIGTERM', () => { cleanupWorkers3(_workers3); process.exit(143); });

module.exports = { runStage3 };

if (require.main === module) {
    runStage3({ runId: null, concurrency: 1 })
        .then(() => process.exit(0))
        .catch(e => { log(`Fatal: ${e.message}`, 'ERROR'); process.exit(1); });
}
```

**Note:** If the per-member function is NOT named `oauthOne`, add a line near the top of the new main section:

```javascript
const oauthOne = /* whatever the existing function is named */;
```

- [ ] **Step 4: Syntax + dry-run**

```bash
cd src && node --check 3_local_oauth.js
cd src && node -e "require('./3_local_oauth').runStage3({runId:null,concurrency:1}).then(r=>{console.log(r); require('./db').close();})"
```

- [ ] **Step 5: Commit**

```bash
git add src/3_local_oauth.js
git commit -m "feat(stage3): DB-backed runStage3 + token/meta persistence"
```

---

### Task 27: Orchestrator module

**Files:**
- Create: `src/orchestrator.js`

- [ ] **Step 1: Write src/orchestrator.js**

```javascript
#!/usr/bin/env node
/**
 * Orchestrator — runnable as child_process.fork from server, OR directly
 * from CLI (run_pipeline.sh).
 *
 * Flags:
 *   --run-id <N>       : pipeline_runs.id (required)
 *   --stages "1,2,3"   : comma-separated stages
 *   --hosts "a@x,b@x"  : optional host email filter
 *   --concurrency <N>  : worker count (default 1)
 *   --reconcile-only   : skip stages, run reconcile only
 *   --host-ids "1,2"   : only for --reconcile-only, restrict host IDs
 */
require('dotenv').config({ path: require('path').resolve(__dirname, '..', '.env') });
const { log } = require('./common/logger');
const { findChrome, launchRealChrome } = require('./common/chrome');
const hostsDb = require('./db/hosts');
const runsDb  = require('./db/runs');
const eventsDb = require('./db/events');
const db = require('./db');

const { runStage1 } = require('./1_invite');
const { runStage2 } = require('./2_accept');
const { runStage3 } = require('./3_local_oauth');
const { reconcileHost } = require('./stages/reconcile');

function parseFlags(argv) {
    const out = {};
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (!a.startsWith('--')) continue;
        const key = a.slice(2);
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith('--')) {
            out[key] = next;
            i++;
        } else {
            out[key] = true;
        }
    }
    return out;
}

async function runReconcilePhase({ runId, hostFilter, hostIds }) {
    const chromePath = findChrome();
    if (!chromePath) throw new Error('Chrome not found');

    let targetHosts;
    if (hostIds && hostIds.length) {
        targetHosts = [];
        for (const id of hostIds) {
            const h = await hostsDb.getHostById(id);
            if (h) targetHosts.push(h);
        }
    } else if (hostFilter && hostFilter.length) {
        const all = await hostsDb.listHosts({ pageSize: 10000 });
        targetHosts = all.filter(h => hostFilter.map(s => s.toLowerCase()).includes(h.email.toLowerCase()));
    } else {
        targetHosts = (await hostsDb.listHosts({ pageSize: 10000 })).filter(h => !h.disabled);
    }

    log(`Reconcile: ${targetHosts.length} host(s)`);
    const totalChanges = [];
    for (const host of targetHosts) {
        const chrome = await launchRealChrome(chromePath, 0);
        try {
            const wlog = require('./common/logger').createWorkerLogger(0);
            const { changes } = await reconcileHost(host, chrome.browser, runId, wlog);
            totalChanges.push(...changes);
        } catch (e) {
            log(`Reconcile host ${host.email} failed: ${e.message}`, 'WARN');
        } finally {
            try { chrome.browser.close(); } catch (_) { }
            try { chrome.proc.kill(); } catch (_) { }
        }
    }
    log(`Reconcile: ${totalChanges.length} state change(s)`);
    return totalChanges;
}

async function main() {
    const flags = parseFlags(process.argv.slice(2));
    const runId = flags['run-id'] ? parseInt(flags['run-id'], 10) : null;
    if (!runId) { log('orchestrator: --run-id is required', 'ERROR'); process.exit(2); }

    const stages = (flags.stages || '1,2,3').split(',').map(s => s.trim()).filter(Boolean);
    const hostFilter = flags.hosts ? flags.hosts.split(',').map(s => s.trim()).filter(Boolean) : [];
    const concurrency = flags.concurrency ? parseInt(flags.concurrency, 10) : 1;
    const reconcileOnly = !!flags['reconcile-only'];
    const hostIds = flags['host-ids'] ? flags['host-ids'].split(',').map(s => parseInt(s, 10)).filter(Boolean) : [];

    const stats = { reconcile: null, stage1: null, stage2: null, stage3: null };
    let finalStatus = 'completed';
    let finalError = null;

    const onSig = (sig) => {
        log(`orchestrator: received ${sig}, will update run to cancelled then exit`);
        runsDb.updateRunStatus(runId, 'cancelled').catch(() => { })
            .finally(() => process.exit(sig === 'SIGTERM' ? 143 : 130));
    };
    process.on('SIGTERM', () => onSig('SIGTERM'));
    process.on('SIGINT',  () => onSig('SIGINT'));

    try {
        if (reconcileOnly) {
            stats.reconcile = await runReconcilePhase({ runId, hostFilter, hostIds });
        } else {
            stats.reconcile = await runReconcilePhase({ runId, hostFilter });
            if (stages.includes('1')) stats.stage1 = await runStage1({ runId, hostFilter, concurrency });
            if (stages.includes('2')) stats.stage2 = await runStage2({ runId, concurrency });
            if (stages.includes('3')) stats.stage3 = await runStage3({ runId, concurrency });
        }
    } catch (e) {
        finalStatus = 'failed';
        finalError = e.message;
        log(`orchestrator: ${e.message}`, 'ERROR');
        if (e.stack) console.error(e.stack);
    }

    await runsDb.updateRunStatus(runId, finalStatus, {
        stats: {
            reconcile: Array.isArray(stats.reconcile) ? { changes: stats.reconcile.length } : null,
            stage1: stats.stage1, stage2: stats.stage2, stage3: stats.stage3,
        },
        error: finalError,
    });
    await db.close();
    process.exit(finalStatus === 'completed' ? 0 : 1);
}

if (require.main === module) {
    main().catch(e => {
        log(`orchestrator fatal: ${e.message}`, 'ERROR');
        process.exit(1);
    });
}

module.exports = { parseFlags, runReconcilePhase };
```

- [ ] **Step 2: Syntax check**

```bash
cd src && node --check orchestrator.js
```

- [ ] **Step 3: Dry-run (no accounts, no Chrome needed if work is empty)**

```bash
cd src && PG_HOST=104.194.91.23 node -e "
const db = require('./db');
const runs = require('./db/runs');
(async () => {
    await db.query(\"UPDATE pipeline_runs SET status='cancelled' WHERE status='running'\");
    const r = await runs.createRun({ launched_by:'cli', stages:'1,2,3', host_filter:[], concurrency:1 });
    console.log('runId=', r.id);
    await db.close();
})();
"
```

Note the runId; then:

```bash
cd src && node orchestrator.js --run-id <RUN_ID> --stages 1,2,3 --concurrency 1
```

Expected: reconcile attempts (if any hosts), then `Stage1: 0 pending members` etc., finally `updateRunStatus completed`. Should exit 0. Note — this may launch Chrome briefly for any hosts in DB. If you want a truly dry run, DELETE from hosts first or use `--stages <empty>`.

- [ ] **Step 4: Commit**

```bash
git add src/orchestrator.js
git commit -m "feat(orchestrator): main entry + reconcile phase + stage dispatch"
```

---

### Task 28: Common/state.js cleanup

**Files:**
- Modify: `src/common/state.js`

- [ ] **Step 1: Remove failed.json-related exports (but keep parseAccounts/buildGroups)**

Edit `src/common/state.js`. Delete `addFailedRecord`, `loadFailedUnsafe`, `saveFailedUnsafe`, `failedMutex`, `AsyncMutex` usage for failed records. Keep `parseAccounts` and `buildGroups`. Remove export of `addFailedRecord`.

The final `module.exports` should be:

```javascript
module.exports = {
    AsyncMutex,
    parseAccounts,
    buildGroups,
};
```

Remove the `FAILED_FILE` reference too.

- [ ] **Step 2: Search for remaining `addFailedRecord` callers — verify none broken**

```bash
cd src && grep -n 'addFailedRecord' -r . --include='*.js'
```

Expected: only matches should be in commits, not in live code. If any `.js` file still imports it, edit that file to remove the call (since stage transitions now write to `events` table).

- [ ] **Step 3: Syntax + tests**

```bash
cd src && node --check common/state.js && node --test db/hosts.test.js db/members.test.js db/events.test.js db/runs.test.js stages/stage2-matcher.test.js orchestrator/pick-host.test.js routes/hosts.test.js routes/members.test.js routes/status.test.js routes/pipeline.test.js
```

All should pass.

- [ ] **Step 4: Commit**

```bash
git add src/common/state.js src/1_invite.js src/2_accept.js src/3_local_oauth.js
git commit -m "refactor(state): drop addFailedRecord/failed.json — events table replaces it"
```

---

## Phase 5 — CLI Integration + txt Migration

### Task 29: run_pipeline.sh — create run row before dispatch

**Files:**
- Modify: `run_pipeline.sh`

- [ ] **Step 1: Read the current stage-dispatch block (lines ~84-127)**

```bash
sed -n '80,130p' run_pipeline.sh
```

- [ ] **Step 2: Replace the run_stage function + invocation loop**

In `run_pipeline.sh`, find the block:

```bash
run_stage() {
    case "$1" in
        1) ...
        ...
    esac
}

if [[ "$RUN_ALL" == "1" ]]; then
    ...
else
    for s in $STAGE; do ...; done
fi
```

Replace it with:

```bash
STAGES_ARG="1,2,3"
if [[ "$RUN_ALL" != "1" ]]; then
    # join requested stages with commas
    STAGES_ARG="$(echo "$STAGE" | tr ' ' ',' | sed 's/,,*/,/g; s/^,//; s/,$//')"
fi

# Insert pipeline_runs row; capture the generated ID.
# NOTE: assumes .env has valid PG creds; psql must be available.
RUN_ID="$(
    set -o pipefail
    PGPASSWORD="$(grep -E '^PG_PASSWORD=' "$ROOT/.env" | cut -d= -f2)" \
    psql -h "$(grep -E '^PG_HOST=' "$ROOT/.env" | cut -d= -f2)" \
         -p "$(grep -E '^PG_PORT=' "$ROOT/.env" | cut -d= -f2)" \
         -U "$(grep -E '^PG_USER=' "$ROOT/.env" | cut -d= -f2)" \
         -d "$(grep -E '^PG_DATABASE=' "$ROOT/.env" | cut -d= -f2)" \
         -t -A -c "INSERT INTO pipeline_runs (launched_by, stages, host_filter, concurrency) VALUES ('cli', '$STAGES_ARG', '[]'::jsonb, 1) RETURNING id;"
)"

if [[ -z "$RUN_ID" ]]; then
    echo " ERROR: could not create pipeline_runs row"
    exit 1
fi

echo " Created pipeline_runs id=$RUN_ID"
echo " ---- Running Orchestrator: stages=$STAGES_ARG ----"
node src/orchestrator.js --run-id "$RUN_ID" --stages "$STAGES_ARG" --concurrency 1 "${EXTRA_ARGS[@]}"
RC=$?

cd "$ROOT"
echo
echo " ==========================================================="
echo "   Pipeline finished (exit $RC)."
echo " ==========================================================="
echo
exit $RC
```

Delete the original `run_stage()` function and the `if/else for s in $STAGE` loop — they're replaced.

- [ ] **Step 3: Test dry-run (clean DB state)**

Clear any running runs:
```bash
PGPASSWORD='123Hxh' psql -h 104.194.91.23 -p 5444 -U root -d auto_chrome \
  -c "UPDATE pipeline_runs SET status='cancelled', finished_at=NOW() WHERE status='running';"
```

Run:
```bash
./run_pipeline.sh --stage "2"
```

Expected: creates a run row, orchestrator fires, finishes with "Stage2: 0 pending acceptances" (if members DB is empty). No stack traces.

- [ ] **Step 4: Commit**

```bash
git add run_pipeline.sh
git commit -m "feat(cli): run_pipeline.sh creates pipeline_runs row + invokes orchestrator"
```

---

### Task 30: scripts/migrate-txt.js (CLI migration)

**Files:**
- Create: `scripts/migrate-txt.js`
- Modify: `src/package.json` (add script)

- [ ] **Step 1: Write scripts/migrate-txt.js**

```javascript
#!/usr/bin/env node
require('dotenv').config({ path: require('path').resolve(__dirname, '..', '.env') });
const fs = require('fs');
const path = require('path');
const { parseAccounts } = require('../src/common/state');
const hosts = require('../src/db/hosts');
const members = require('../src/db/members');
const db = require('../src/db');

async function importFile(file, table) {
    if (!fs.existsSync(file)) { console.log(`${file}: missing, skipping`); return; }
    const accts = parseAccounts(file);
    let inserted = 0, skipped = 0, failed = 0;
    for (const a of accts) {
        try {
            const r = await (table === 'hosts'
                ? hosts.upsertHost({ email: a.email, password: a.pass, recovery_email: a.recovery || null, totp_secret: a.totp_secret || null })
                : members.upsertMember({ email: a.email, password: a.pass, recovery_email: a.recovery || null, totp_secret: a.totp_secret || null }));
            if (r.inserted) inserted++; else skipped++;
        } catch (e) {
            failed++;
            console.error(`  ${a.email}: ${e.message}`);
        }
    }
    console.log(`${file}: inserted=${inserted} skipped=${skipped} failed=${failed} (total=${accts.length})`);
}

async function main() {
    const root = path.resolve(__dirname, '..');
    await importFile(path.join(root, 'hosts.txt'), 'hosts');
    await importFile(path.join(root, 'members.txt'), 'members');
    await db.close();
}

main().catch(e => { console.error(e); process.exit(1); });
```

- [ ] **Step 2: Add npm script**

Edit `src/package.json`:

```json
"scripts": {
    "start": "node auth.js",
    "server": "node server.js",
    "db:init": "node ../scripts/init-db.js",
    "db:migrate-txt": "node ../scripts/migrate-txt.js",
    ...
}
```

- [ ] **Step 3: Run migration (production run, one-shot)**

```bash
cd src && npm run db:migrate-txt
```

Expected output:
```
.../hosts.txt: inserted=1 skipped=0 failed=0 (total=1)
.../members.txt: inserted=N skipped=0 failed=0 (total=N)
```

(Exact N depends on current `members.txt` content.)

- [ ] **Step 4: Verify via UI**

Start server, open `/accounts`, switch to Members tab — rows should appear.

- [ ] **Step 5: Rename txt to .bak (don't delete)**

```bash
mv /usr/src/workspace/github/QQhuxuhui/auto_chrome/hosts.txt   /usr/src/workspace/github/QQhuxuhui/auto_chrome/hosts.txt.bak
mv /usr/src/workspace/github/QQhuxuhui/auto_chrome/members.txt /usr/src/workspace/github/QQhuxuhui/auto_chrome/members.txt.bak
```

Also add to `.gitignore`:
```bash
printf 'hosts.txt.bak\nmembers.txt.bak\n' >> .gitignore
```

- [ ] **Step 6: Commit**

```bash
git add scripts/migrate-txt.js src/package.json .gitignore
git commit -m "feat(migrate): scripts/migrate-txt.js + npm run db:migrate-txt"
```

Then commit the file rename:
```bash
git add -A
git commit -m "chore: retire hosts.txt / members.txt (renamed to .bak)"
```

---

### Task 31: Update failed.json handling (passive)

**Files:**
- No code changes. `failed.json` stays on disk as historical; orchestrator doesn't write it (we removed `addFailedRecord`).

- [ ] **Step 1: Verify orchestrator doesn't touch failed.json**

```bash
cd src && grep -rn "failed.json\|FAILED_FILE" . --include='*.js' | grep -v node_modules | grep -v '.test.js'
```

Expected: no matches (or only matches in test files).

- [ ] **Step 2: No commit** — this task is a check only.

---

## Phase 6 — Tests + Manual E2E

### Task 32: Run all unit + integration tests

- [ ] **Step 1: Run full test suite**

```bash
cd src && node --test \
    db/hosts.test.js db/members.test.js db/events.test.js db/runs.test.js \
    routes/hosts.test.js routes/members.test.js routes/status.test.js routes/pipeline.test.js \
    stages/stage2-matcher.test.js orchestrator/pick-host.test.js \
    3_sub2api.test.js 3_local_oauth.test.js
```

Expected: all pass. Note count.

- [ ] **Step 2: Fix anything that breaks**

If failures appear, address them task-by-task and commit fixes as `fix(<area>): <message>`.

- [ ] **Step 3: No commit unless fixes needed.**

---

### Task 33: Manual e2e — Stage 1 only (single host + 1 member)

**Prerequisite:** DB has at least 1 host and 1 member in status `new`. Host must be a real functioning Google account that can create/manage a family group. Chrome GUI must be available.

- [ ] **Step 1: Launch UI; confirm dashboard**

```bash
cd src && npm run server > /tmp/server.log 2>&1 &
sleep 2
```

Open http://127.0.0.1:3000/ — expect to see 1 host + 1 member in Capacity and Status cards.

- [ ] **Step 2: Start Stage 1 only via UI**

Click `▶ Start Pipeline`. Uncheck Stage 2 and Stage 3. Leave Hosts=Auto, Concurrency=1. Click Start.

- [ ] **Step 3: Monitor**

Watch the Dashboard — Current Run card appears. Watch stats update. Also tail orchestrator logs:
```bash
tail -f /tmp/server.log
```

- [ ] **Step 4: Verify DB state after completion**

Wait for run to disappear from Current Run (run status → `completed`). Switch to Members tab — the test member's status should be `invite_pending` (Google sent the invite). `host_id` populated.

Check directly:
```bash
PGPASSWORD='123Hxh' psql -h 104.194.91.23 -p 5444 -U root -d auto_chrome \
  -c "SELECT email, status, host_id, fail_count, last_error FROM members ORDER BY id DESC LIMIT 5;"
```

- [ ] **Step 5: Cleanup**

```bash
kill %1 2>/dev/null; rm -f /tmp/server.pid
```

- [ ] **Step 6: Only commit if fixes were needed during e2e.**

---

### Task 34: Manual e2e — Stages 2 and 3

**Prerequisite:** A member in `invite_pending` state from Task 33.

- [ ] **Step 1: Run stage 2 via UI**

Start server, open UI, click Start Pipeline with ONLY Stage 2 checked.

Monitor run. Expect: the member's Gmail is logged into, invite email is opened (from family/join URL — **not** welcome emails — verifying the matcher fix), accept is clicked.

After completion: member status should be `joined`.

- [ ] **Step 2: Run stage 3 via UI**

With member in `joined`, start pipeline with Stage 3 only.

Expect: OAuth flow completes, member moves to `done`, `token` column populated on UI.

- [ ] **Step 3: Verify token is usable**

Click Copy on the token. Paste somewhere to confirm it's a non-empty refresh-token-shaped string.

- [ ] **Step 4: Check binding visibility**

In Members table, the `host` column should now show the host email (since status=done). Earlier (during invite_pending/joined), it showed `—` per the spec.

- [ ] **Step 5: Document findings**

If anything unexpected surfaces, open issues, or note in a follow-up commit.

---

### Task 35: Phase 6 wrap + final commit

- [ ] **Step 1: Run full test suite one last time**

```bash
cd src && node --test db/*.test.js routes/*.test.js stages/*.test.js orchestrator/*.test.js
```

All green.

- [ ] **Step 2: Git log check**

```bash
git log --oneline main..HEAD | head -40
```

Expect ~30 commits spanning the 6 phases.

- [ ] **Step 3: Update README or write a short HOWTO (only if user explicitly requests).**

Not required by default.

- [ ] **Step 4: Summary commit (optional)**

No new file. The plan itself is committed. Done.

---

## Self-review checklist

Run through this mentally before handing off:

- ✅ Every task lists exact file paths
- ✅ Every code step has complete code (not "similar to X")
- ✅ DB migrations are idempotent (`CREATE IF NOT EXISTS`)
- ✅ Unit tests precede implementation (TDD for db/*, routes/*, matcher, pickHost)
- ✅ State-machine transitions tested for all 9 statuses (new, invite_pending, invite_failed, joined, accept_failed, oauth_failed, done, abandoned, removed_from_family)
- ✅ Email matcher covers both false-positive cases discovered in the stage 2 monitor (welcome email + host notification)
- ✅ fail_count threshold = 3 (Task 6 member test)
- ✅ Slot semantics C = pending + final (hosts.js SLOT_STATUSES)
- ✅ pickHost spread strategy (Task 21 tests)
- ✅ host_id cleared only on stage 1 fail, not on stage 2/3 fail (Task 25/26)
- ✅ UI token column shows 8 chars + Copy; host column shows only on done (Task 18)
- ✅ Migration banner (Task 18)
- ✅ child_process.fork for pipeline isolation (Task 13)
- ✅ SIGTERM → SIGKILL escalation (Task 13: 30s timeout per spec §6)
- ✅ Only one run allowed concurrent (Task 13 test)
- ✅ CLI still works (Task 29: run_pipeline.sh writes its own pipeline_runs row)
- ✅ Reconcile module scrapes family page + patches DB (Task 23)
- ✅ Orchestrator runs reconcile before stages (Task 27)
- ✅ txt migration script + UI button both exist (Tasks 14, 30)

Any gaps → add a new task and re-commit this plan.
