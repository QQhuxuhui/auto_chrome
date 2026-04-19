# Antigravity-Manager 集成实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 auto_chrome 产出的子号 refresh_token 推送到 Antigravity-Manager 平台；双向同步平台封禁状态；被封禁的账号自动从 Google family 移除并删平台记录。

**Architecture:** 新增 HTTP 客户端（src/common/antigravity.js）+ 同步模块（src/sync/antigravity-sync.js）+ Fastify 路由（src/routes/antigravity.js）。Server 挂 5 分钟 setInterval 定时同步。orchestrator 的 reconcile 阶段扩展：抓完 Google family 后，对 `antigravity.disabled=true` 且还在 family 的成员登录 host 后点击移除按钮 + DELETE 平台记录。

**Tech Stack:** Node.js 18+ 原生 fetch、pg、fastify、alpine.js/tailwind（复用现有 UI 栈）。无新 npm 依赖。

**Reference spec:** `docs/superpowers/specs/2026-04-19-antigravity-integration-design.md`

**Phases:**
- Phase 1 · 基础设施（Tasks 1-4）：schema、HTTP 客户端、sync 模块、路由
- Phase 2 · 调度 + 集成（Tasks 5-6）：server setInterval、reconcile 扩展
- Phase 3 · UI（Tasks 7-9）：仪表盘同步卡片、Members 表平台状态列、详情抽屉
- Phase 4 · e2e（Task 10）：手动端到端验证

---

## Prerequisites

- `.env` 追加两行：
  ```
  ANTIGRAVITY_URL=http://104.194.91.23:8045
  ANTIGRAVITY_API_KEY=123Abc!@#
  ```
- Server 当前应该是停的（避免 setInterval 冲突）；如果在跑：
  ```bash
  ps aux | grep 'node.*server' | grep -v grep
  # kill <PID>
  ```

---

## Phase 1 · 基础设施

### Task 1: 加 antigravity JSONB 列 + 写入 schema.sql

**Files:**
- Modify: `src/db/schema.sql` — 在 members 表定义里加一列
- Create: `scripts/antigravity-migration.js` — 一次性 migration 脚本

- [ ] **Step 1: 修改 schema.sql**

Open `src/db/schema.sql`. 找到 `CREATE TABLE IF NOT EXISTS members (` 块，在最后的 `created_at` 列之前、`token_meta` 行之后，添加这一行：

```sql
  token_meta      JSONB,
  antigravity     JSONB,

  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
```

这样新环境 `db:init` 时会直接包含这列。

- [ ] **Step 2: 写 migration 脚本（已存在环境用）**

Create `scripts/antigravity-migration.js`:

```javascript
#!/usr/bin/env node
require('dotenv').config({ path: require('path').resolve(__dirname, '..', '.env') });
const { Client } = require('pg');

async function main() {
    const cfg = {
        host: process.env.PG_HOST, port: parseInt(process.env.PG_PORT, 10) || 5432,
        user: process.env.PG_USER, password: process.env.PG_PASSWORD,
        database: process.env.PG_DATABASE,
    };
    const client = new Client(cfg);
    await client.connect();
    try {
        await client.query('ALTER TABLE members ADD COLUMN IF NOT EXISTS antigravity JSONB');
        console.log('Added members.antigravity column (idempotent).');
    } finally { await client.end(); }
}
main().catch(e => { console.error(e); process.exit(1); });
```

- [ ] **Step 3: 运行 migration**

```bash
cd /usr/src/workspace/github/QQhuxuhui/auto_chrome && node scripts/antigravity-migration.js
```

Expected: `Added members.antigravity column (idempotent).`

- [ ] **Step 4: 验证列存在**

```bash
PGPASSWORD='123Hxh' psql -h 104.194.91.23 -p 5444 -U root -d auto_chrome \
    -c "\d members" | grep antigravity
```

Expected: `antigravity     | jsonb`

- [ ] **Step 5: Commit**

```bash
git add src/db/schema.sql scripts/antigravity-migration.js
git commit -m "feat(db): add members.antigravity JSONB column for platform mirror"
```

---

### Task 2: HTTP 客户端 `src/common/antigravity.js` + 单测

**Files:**
- Create: `src/common/antigravity.js`
- Create: `src/common/antigravity.test.js`

- [ ] **Step 1: 写失败测试**

Create `src/common/antigravity.test.js`:

```javascript
const test = require('node:test');
const assert = require('node:assert');

// 用全局 mock 替换 fetch 以隔离测试
const realFetch = global.fetch;
const calls = [];
let mockResponse = null;
global.fetch = async (url, opts) => {
    calls.push({ url, opts });
    return mockResponse;
};

// 测试前保证读到预期 env
process.env.ANTIGRAVITY_URL = 'http://test-platform:9999';
process.env.ANTIGRAVITY_API_KEY = 'test-key';

const { listAccounts, pushAccount, deleteAccount } = require('./antigravity');

function resetMock() {
    calls.length = 0;
    mockResponse = null;
}

test('listAccounts issues GET with Bearer auth', async () => {
    resetMock();
    mockResponse = { ok: true, status: 200, headers: new Map([['content-type', 'application/json']]),
        json: async () => ({ accounts: [{ id: 'u1', email: 'a@x' }], current_id: null }) };
    mockResponse.headers.get = function (k) { return this.get(k); };
    const r = await listAccounts();
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'http://test-platform:9999/api/accounts');
    assert.equal(calls[0].opts.method, 'GET');
    assert.equal(calls[0].opts.headers.Authorization, 'Bearer test-key');
    assert.equal(r.accounts.length, 1);
    assert.equal(r.accounts[0].id, 'u1');
});

test('pushAccount POSTs refreshToken and returns parsed account', async () => {
    resetMock();
    mockResponse = { ok: true, status: 200,
        headers: { get: () => 'application/json' },
        json: async () => ({ id: 'new-id', email: 'b@x', disabled: false }) };
    const r = await pushAccount({ refreshToken: 'rt-abc' });
    assert.equal(calls[0].opts.method, 'POST');
    assert.equal(calls[0].opts.headers['Content-Type'], 'application/json');
    const body = JSON.parse(calls[0].opts.body);
    assert.equal(body.refreshToken, 'rt-abc');
    assert.equal(r.id, 'new-id');
});

test('pushAccount throws AntigravityError on non-2xx', async () => {
    resetMock();
    mockResponse = { ok: false, status: 400,
        headers: { get: () => 'application/json' },
        json: async () => ({ error: 'duplicate' }) };
    await assert.rejects(
        () => pushAccount({ refreshToken: 'rt' }),
        err => {
            assert.equal(err.status, 400);
            assert.match(err.message, /duplicate|HTTP 400/);
            return true;
        }
    );
});

test('deleteAccount issues DELETE', async () => {
    resetMock();
    mockResponse = { ok: true, status: 204,
        headers: { get: () => null },
        json: async () => ({}) };
    await deleteAccount('some-uuid');
    assert.equal(calls[0].opts.method, 'DELETE');
    assert.ok(calls[0].url.endsWith('/api/accounts/some-uuid'));
});

test('restore native fetch after tests', () => {
    global.fetch = realFetch;
    assert.ok(true);
});
```

- [ ] **Step 2: 运行 — expect fail**

```bash
cd src && node --test common/antigravity.test.js
```

Expected: FAIL "Cannot find module './antigravity'"

- [ ] **Step 3: 写 `src/common/antigravity.js`**

```javascript
/**
 * Antigravity-Manager HTTP 客户端。
 * 无状态，只做网络调用。上层业务逻辑在 src/sync/antigravity-sync.js。
 */

const BASE = process.env.ANTIGRAVITY_URL || 'http://104.194.91.23:8045';
const API_KEY = process.env.ANTIGRAVITY_API_KEY;
const TIMEOUT_MS = parseInt(process.env.ANTIGRAVITY_TIMEOUT_MS, 10) || 10000;

class AntigravityError extends Error {
    constructor(message, status, body) {
        super(message);
        this.name = 'AntigravityError';
        this.status = status;
        this.body = body;
    }
}

async function request(path, { method = 'GET', body } = {}) {
    if (!API_KEY) throw new AntigravityError('ANTIGRAVITY_API_KEY missing in env', 0, null);
    const url = `${BASE}${path}`;
    const headers = { Authorization: `Bearer ${API_KEY}` };
    const init = { method, headers };
    if (body !== undefined) {
        headers['Content-Type'] = 'application/json';
        init.body = JSON.stringify(body);
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    init.signal = controller.signal;
    let res;
    try {
        res = await fetch(url, init);
    } catch (e) {
        clearTimeout(timer);
        throw new AntigravityError(`network: ${e.message}`, 0, null);
    }
    clearTimeout(timer);

    const ct = res.headers.get && res.headers.get('content-type');
    let parsed = null;
    if (ct && String(ct).includes('application/json')) {
        try { parsed = await res.json(); } catch (_) { parsed = null; }
    }
    if (!res.ok) {
        const msg = (parsed && (parsed.error || parsed.message)) || `HTTP ${res.status}`;
        throw new AntigravityError(msg, res.status, parsed);
    }
    return parsed;
}

async function listAccounts() {
    return request('/api/accounts');
}

async function pushAccount({ refreshToken }) {
    return request('/api/accounts', { method: 'POST', body: { refreshToken } });
}

async function deleteAccount(id) {
    return request(`/api/accounts/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

module.exports = { listAccounts, pushAccount, deleteAccount, AntigravityError };
```

- [ ] **Step 4: 运行 — expect pass**

```bash
cd src && node --test common/antigravity.test.js
```

Expected: `pass 5`

- [ ] **Step 5: 对 live 平台 smoke-test**

```bash
cd src && node -e "
process.env.ANTIGRAVITY_URL = 'http://104.194.91.23:8045';
process.env.ANTIGRAVITY_API_KEY = '123Abc!@#';
const c = require('./common/antigravity');
c.listAccounts().then(r => console.log('accounts:', r.accounts.length, 'current_id:', r.current_id))
    .catch(e => { console.error('ERR:', e.status, e.message); process.exit(1); });
"
```

Expected: `accounts: 7 current_id: null`（或你当前的实际数量）

- [ ] **Step 6: Commit**

```bash
git add src/common/antigravity.js src/common/antigravity.test.js
git commit -m "feat(antigravity): add HTTP client (listAccounts/pushAccount/deleteAccount)"
```

---

### Task 3: `src/sync/antigravity-sync.js` + 单测

**Files:**
- Create: `src/sync/antigravity-sync.js`
- Create: `src/sync/antigravity-sync.test.js`
- Create: `src/db/members.js`（新方法，或修改现有）— 添加 `updateAntigravity(memberId, partial)` 方法

- [ ] **Step 1: 给 `src/db/members.js` 加 `updateAntigravity` 方法**

Open `src/db/members.js`. 在 `abandonMember` 之后、`listMembersForStage` 之前，添加：

```javascript
async function updateAntigravity(memberId, partial) {
    // JSONB 合并: 已有值 || partial（partial 优先）
    // 用 jsonb || operator；null 的字段会被覆盖，已有 key 会被新 partial 的 key 替换
    const sql = `
        UPDATE members
        SET antigravity = COALESCE(antigravity, '{}'::jsonb) || $2::jsonb,
            updated_at = NOW()
        WHERE id = $1
        RETURNING *
    `;
    const { rows } = await db.query(sql, [memberId, partial]);
    return mapRow(rows[0]);
}

async function listMembersByEmailLower(emails) {
    if (!emails || !emails.length) return [];
    const lowered = emails.map(e => String(e).toLowerCase());
    const { rows } = await db.query(
        `SELECT * FROM members WHERE LOWER(email) = ANY($1)`,
        [lowered]
    );
    return rows.map(mapRow);
}

async function listMembersNeedingPush() {
    const sql = `
        SELECT * FROM members
        WHERE status = 'done'
          AND token IS NOT NULL
          AND (antigravity IS NULL OR antigravity->>'id' IS NULL)
        ORDER BY done_at ASC
    `;
    const { rows } = await db.query(sql);
    return rows.map(mapRow);
}

async function listMembersNeedingFamilyRemoval(hostId) {
    const sql = `
        SELECT * FROM members
        WHERE host_id = $1
          AND status IN ('joined','done','oauth_failed')
          AND antigravity->>'disabled' = 'true'
        ORDER BY id ASC
    `;
    const { rows } = await db.query(sql, [hostId]);
    return rows.map(mapRow);
}
```

然后在模块底部的 `module.exports = { ... }` 里加上四个新方法名：

```javascript
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
    updateAntigravity,              // NEW
    listMembersByEmailLower,        // NEW
    listMembersNeedingPush,         // NEW
    listMembersNeedingFamilyRemoval,// NEW
    listMembersForStage,
    countByStatus,
    ABANDON_THRESHOLD,
};
```

- [ ] **Step 2: 运行现有 members 测试，确保没破坏**

```bash
cd src && node --test db/members.test.js 2>&1 | tail -5
```

Expected: 之前的 10 个测试全过。

- [ ] **Step 3: 给 `src/db/members.test.js` 加 `updateAntigravity` 测试**

在 `test.after` 之前加入：

```javascript
test('updateAntigravity merges JSONB partial into existing object', async () => {
    const { member } = await members.upsertMember({ email: 'test-mem-ag1@example.com', password: 'pw' });
    // 第一次写入
    let updated = await members.updateAntigravity(member.id, { id: 'uuid-1', pushed_at: '2026-04-19T10:00:00Z' });
    assert.equal(updated.antigravity.id, 'uuid-1');
    assert.equal(updated.antigravity.pushed_at, '2026-04-19T10:00:00Z');
    // 第二次只更新 disabled
    updated = await members.updateAntigravity(member.id, { disabled: true });
    assert.equal(updated.antigravity.id, 'uuid-1');     // 保留
    assert.equal(updated.antigravity.pushed_at, '2026-04-19T10:00:00Z'); // 保留
    assert.equal(updated.antigravity.disabled, true);   // 新增
});

test('listMembersByEmailLower is case-insensitive', async () => {
    await members.upsertMember({ email: 'test-mem-AG2@example.com', password: 'pw' });
    const found = await members.listMembersByEmailLower(['test-mem-ag2@example.com', 'nope@x.com']);
    assert.equal(found.length, 1);
    assert.equal(found[0].email.toLowerCase(), 'test-mem-ag2@example.com');
});

test('listMembersNeedingPush returns only done+unpushed', async () => {
    const { member: m1 } = await members.upsertMember({ email: 'test-mem-push1@example.com', password: 'pw' });
    const { member: m2 } = await members.upsertMember({ email: 'test-mem-push2@example.com', password: 'pw' });
    await members.transitionToInvitePending(m1.id, hostId);
    await members.transitionToJoined(m1.id);
    await members.transitionToDone(m1.id, 'RT1', {});
    await members.transitionToInvitePending(m2.id, hostId);
    await members.transitionToJoined(m2.id);
    await members.transitionToDone(m2.id, 'RT2', {});
    await members.updateAntigravity(m2.id, { id: 'already-pushed-uuid' });
    const pending = await members.listMembersNeedingPush();
    const emails = pending.map(p => p.email);
    assert.ok(emails.includes('test-mem-push1@example.com'));
    assert.ok(!emails.includes('test-mem-push2@example.com'));
});
```

- [ ] **Step 4: 运行 — expect pass**

```bash
cd src && node --test db/members.test.js 2>&1 | tail -5
```

Expected: `pass 13`（原 10 + 新 3）。

- [ ] **Step 5: 写 sync 模块测试**

Create `src/sync/antigravity-sync.test.js`:

```javascript
const test = require('node:test');
const assert = require('node:assert');
const db = require('../db');
const hosts = require('../db/hosts');
const members = require('../db/members');

// Mock antigravity client — 替换 require 缓存
const mockClient = {
    _listResp: { accounts: [], current_id: null },
    _pushResp: null,
    _pushError: null,
    _deleteCalls: [],
    async listAccounts() { return this._listResp; },
    async pushAccount({ refreshToken }) {
        if (this._pushError) throw this._pushError;
        return this._pushResp;
    },
    async deleteAccount(id) { this._deleteCalls.push(id); },
};
require.cache[require.resolve('../common/antigravity')] = { exports: mockClient };

const sync = require('./antigravity-sync');

let hostId;

test.before(async () => {
    await db.query("DELETE FROM members WHERE email LIKE 'test-sync-%@example.com'");
    await db.query("DELETE FROM hosts WHERE email LIKE 'test-sync-host-%@example.com'");
    const { host } = await hosts.upsertHost({ email: 'test-sync-host-1@example.com', password: 'p' });
    hostId = host.id;
});

test.after(async () => {
    await db.query("DELETE FROM members WHERE email LIKE 'test-sync-%@example.com'");
    await db.query("DELETE FROM hosts WHERE email LIKE 'test-sync-host-%@example.com'");
    await db.close();
});

test('syncFromRemote matches by email (case-insensitive) and updates JSONB', async () => {
    const { member } = await members.upsertMember({ email: 'test-sync-Match@example.com', password: 'pw' });
    mockClient._listResp = {
        accounts: [{
            id: 'uuid-match', email: 'test-sync-match@example.com',
            disabled: false, validation_blocked: false,
            quota: { is_forbidden: false, forbidden_reason: null }
        }],
        current_id: null,
    };
    const r = await sync.syncFromRemote();
    assert.equal(r.matched, 1);
    const updated = await members.getMemberById(member.id);
    assert.equal(updated.antigravity.id, 'uuid-match');
    assert.equal(updated.antigravity.disabled, false);
    assert.ok(updated.antigravity.last_synced_at);
});

test('syncFromRemote reports orphans', async () => {
    mockClient._listResp = {
        accounts: [
            { id: 'u1', email: 'orphan1@nowhere.com', disabled: false, validation_blocked: false, quota: null },
            { id: 'u2', email: 'orphan2@nowhere.com', disabled: false, validation_blocked: false, quota: null },
        ],
        current_id: null,
    };
    const r = await sync.syncFromRemote();
    assert.equal(r.matched, 0);
    assert.equal(r.orphans.length, 2);
    assert.ok(r.orphans.includes('orphan1@nowhere.com'));
});

test('syncFromRemote updates disabled flag for matched account', async () => {
    const { member } = await members.upsertMember({ email: 'test-sync-ban@example.com', password: 'pw' });
    mockClient._listResp = {
        accounts: [{ id: 'u-ban', email: 'test-sync-ban@example.com',
            disabled: true, disabled_reason: 'invalid_grant', disabled_at: 1700000000,
            validation_blocked: false, quota: null }],
        current_id: null,
    };
    const r = await sync.syncFromRemote();
    assert.equal(r.newly_disabled.length, 1);
    const updated = await members.getMemberById(member.id);
    assert.equal(updated.antigravity.disabled, true);
    assert.equal(updated.antigravity.disabled_reason, 'invalid_grant');
});

test('pushAccount happy path writes antigravity.id + pushed_at', async () => {
    const { member } = await members.upsertMember({ email: 'test-sync-push@example.com', password: 'pw' });
    await members.transitionToInvitePending(member.id, hostId);
    await members.transitionToJoined(member.id);
    await members.transitionToDone(member.id, 'RT-1', {});
    mockClient._pushResp = { id: 'pushed-uuid', email: 'test-sync-push@example.com' };
    mockClient._pushError = null;
    const r = await sync.pushAccount(member.id);
    assert.equal(r.success, true);
    const updated = await members.getMemberById(member.id);
    assert.equal(updated.antigravity.id, 'pushed-uuid');
    assert.ok(updated.antigravity.pushed_at);
    assert.equal(updated.antigravity.push_error, null);
});

test('pushAccount error path records push_error and does not set id', async () => {
    const { member } = await members.upsertMember({ email: 'test-sync-err@example.com', password: 'pw' });
    await members.transitionToInvitePending(member.id, hostId);
    await members.transitionToJoined(member.id);
    await members.transitionToDone(member.id, 'RT-2', {});
    const { AntigravityError } = require('../common/antigravity');
    mockClient._pushError = new AntigravityError('duplicate token', 400, { error: 'duplicate' });
    mockClient._pushResp = null;
    const r = await sync.pushAccount(member.id);
    assert.equal(r.success, false);
    const updated = await members.getMemberById(member.id);
    assert.equal(updated.antigravity?.id || null, null);
    assert.ok(updated.antigravity.push_error);
    assert.equal(updated.antigravity.push_error.status, 400);
});

test('pushAccount refuses if member not done', async () => {
    const { member } = await members.upsertMember({ email: 'test-sync-notdone@example.com', password: 'pw' });
    const r = await sync.pushAccount(member.id);
    assert.equal(r.success, false);
    assert.match(r.error, /status.*done/i);
});
```

- [ ] **Step 6: 运行 — expect fail**

```bash
cd src && node --test sync/antigravity-sync.test.js
```

Expected: FAIL "Cannot find module './antigravity-sync'"

- [ ] **Step 7: 写 `src/sync/antigravity-sync.js`**

Create directory first: `mkdir -p src/sync`.

```javascript
/**
 * Antigravity 同步逻辑。
 * 从平台 pull 账号状态并 merge 到本地 members.antigravity JSONB。
 * Push：把本地 status='done' 的子号推到平台。
 */
const antigravity = require('../common/antigravity');
const membersDb = require('../db/members');

function pickMirror(acct) {
    return {
        id: acct.id,
        disabled: !!acct.disabled,
        disabled_reason: acct.disabled_reason || null,
        disabled_at: acct.disabled_at || null,
        validation_blocked: !!acct.validation_blocked,
        validation_blocked_until: acct.validation_blocked_until || null,
        validation_blocked_reason: acct.validation_blocked_reason || null,
        is_forbidden: !!(acct.quota && acct.quota.is_forbidden),
        forbidden_reason: (acct.quota && acct.quota.forbidden_reason) || null,
        last_synced_at: new Date().toISOString(),
    };
}

async function syncFromRemote() {
    const { accounts = [] } = await antigravity.listAccounts();
    const emailsLower = accounts.map(a => String(a.email || '').toLowerCase()).filter(Boolean);
    const locals = await membersDb.listMembersByEmailLower(emailsLower);
    const localByEmail = new Map(locals.map(m => [m.email.toLowerCase(), m]));

    const out = { matched: 0, updated: 0, newly_disabled: [], orphans: [] };

    for (const acct of accounts) {
        const emailLower = String(acct.email || '').toLowerCase();
        if (!emailLower) continue;
        const local = localByEmail.get(emailLower);
        if (!local) {
            out.orphans.push(acct.email);
            continue;
        }
        out.matched++;
        const wasDisabled = !!(local.antigravity && local.antigravity.disabled);
        const mirror = pickMirror(acct);
        await membersDb.updateAntigravity(local.id, mirror);
        out.updated++;
        if (!wasDisabled && mirror.disabled) {
            out.newly_disabled.push({ memberId: local.id, email: local.email, reason: mirror.disabled_reason });
        }
    }
    return out;
}

async function pushAccount(memberId) {
    const member = await membersDb.getMemberById(memberId);
    if (!member) return { success: false, error: 'member not found' };
    if (member.status !== 'done') {
        return { success: false, error: `member status=${member.status}, expected 'done'` };
    }
    if (!member.token) {
        return { success: false, error: 'member has no token' };
    }
    try {
        const resp = await antigravity.pushAccount({ refreshToken: member.token });
        const partial = {
            id: resp.id,
            pushed_at: new Date().toISOString(),
            push_error: null,
            disabled: !!resp.disabled,
            disabled_reason: resp.disabled_reason || null,
            validation_blocked: !!resp.validation_blocked,
            last_synced_at: new Date().toISOString(),
        };
        await membersDb.updateAntigravity(memberId, partial);
        return { success: true };
    } catch (e) {
        const partial = {
            push_error: {
                at: new Date().toISOString(),
                status: e.status || 0,
                message: e.message || String(e),
            },
        };
        await membersDb.updateAntigravity(memberId, partial);
        return { success: false, error: e.message };
    }
}

async function pushAllPending() {
    const pending = await membersDb.listMembersNeedingPush();
    const out = { total: pending.length, pushed: 0, failed: 0, errors: [] };
    for (const m of pending) {
        const r = await pushAccount(m.id);
        if (r.success) out.pushed++;
        else {
            out.failed++;
            out.errors.push({ memberId: m.id, email: m.email, error: r.error });
        }
    }
    return out;
}

async function deleteAccount(memberId) {
    const member = await membersDb.getMemberById(memberId);
    if (!member) return { success: false, error: 'member not found' };
    const agId = member.antigravity && member.antigravity.id;
    if (!agId) return { success: false, error: 'member has no antigravity.id' };
    try {
        await antigravity.deleteAccount(agId);
        await membersDb.updateAntigravity(memberId, { id: null, disabled: false, disabled_reason: null });
        return { success: true };
    } catch (e) {
        return { success: false, error: e.message, status: e.status };
    }
}

module.exports = { syncFromRemote, pushAccount, pushAllPending, deleteAccount, pickMirror };
```

- [ ] **Step 8: 运行 — expect pass**

```bash
cd src && node --test sync/antigravity-sync.test.js 2>&1 | tail -6
```

Expected: `pass 6`.

- [ ] **Step 9: 完整测试套件**

```bash
cd src && node --test db/*.test.js routes/*.test.js stages/*.test.js orchestrator/*.test.js common/antigravity.test.js sync/*.test.js 2>&1 | tail -5
```

Expected: pass 57（原 49 + 3 新 members + 5 antigravity client + 6 sync = 63，具体看实际，应 ≥ 57）。

- [ ] **Step 10: Commit**

```bash
git add src/db/members.js src/db/members.test.js src/sync/antigravity-sync.js src/sync/antigravity-sync.test.js
git commit -m "feat(sync): antigravity sync module (pull + push + delete) + tests"
```

---

### Task 4: API 路由 `src/routes/antigravity.js` + 集成测试

**Files:**
- Create: `src/routes/antigravity.js`
- Create: `src/routes/antigravity.test.js`
- Modify: `src/server.js` — 注册新路由

- [ ] **Step 1: 写 route**

Create `src/routes/antigravity.js`:

```javascript
const sync = require('../sync/antigravity-sync');
const antigravityClient = require('../common/antigravity');
const membersDb = require('../db/members');

module.exports = async function routes(app) {
    app.post('/api/antigravity/sync', async () => {
        return sync.syncFromRemote();
    });

    app.post('/api/antigravity/push/:id', async (req, reply) => {
        const id = parseInt(req.params.id, 10);
        const r = await sync.pushAccount(id);
        if (!r.success) return reply.code(400).send(r);
        return r;
    });

    app.post('/api/antigravity/push-all', async () => {
        return sync.pushAllPending();
    });

    app.delete('/api/antigravity/account/:id', async (req, reply) => {
        const id = parseInt(req.params.id, 10);
        const r = await sync.deleteAccount(id);
        if (!r.success) return reply.code(400).send(r);
        return r;
    });

    // 只读 orphans: 远程有、本地没有
    app.get('/api/antigravity/orphans', async () => {
        const { accounts = [] } = await antigravityClient.listAccounts();
        const emails = accounts.map(a => a.email).filter(Boolean);
        const locals = await membersDb.listMembersByEmailLower(emails);
        const localSet = new Set(locals.map(m => m.email.toLowerCase()));
        const orphans = accounts
            .filter(a => !localSet.has(String(a.email).toLowerCase()))
            .map(a => ({ id: a.id, email: a.email, disabled: a.disabled, validation_blocked: a.validation_blocked }));
        return orphans;
    });
};
```

- [ ] **Step 2: 注册到 server.js**

Open `src/server.js`. 找到现有 `await app.register(require('./routes/ops'));`（或最后一个 register 调用），在它后面加：

```javascript
    await app.register(require('./routes/antigravity'));
```

- [ ] **Step 3: 写集成测试**

Create `src/routes/antigravity.test.js`:

```javascript
const test = require('node:test');
const assert = require('node:assert');
const db = require('../db');

// 和 sync 测试同样的 mock 方式
const mockClient = {
    _listResp: { accounts: [], current_id: null },
    _pushResp: null,
    _pushError: null,
    async listAccounts() { return this._listResp; },
    async pushAccount({ refreshToken }) {
        if (this._pushError) throw this._pushError;
        return this._pushResp;
    },
    async deleteAccount() { /* noop */ },
};
require.cache[require.resolve('../common/antigravity')] = { exports: mockClient };

const { build } = require('../server');

let app;

test.before(async () => {
    app = await build();
    await db.query("DELETE FROM members WHERE email LIKE 'rt-ag-%@example.com'");
});

test.after(async () => {
    await db.query("DELETE FROM members WHERE email LIKE 'rt-ag-%@example.com'");
    await app.close();
    await db.close();
});

test('POST /api/antigravity/sync returns matched + orphans', async () => {
    // seed local
    await db.query("INSERT INTO members (email, password, status) VALUES ('rt-ag-match@example.com', 'p', 'new') ON CONFLICT DO NOTHING");
    mockClient._listResp = {
        accounts: [
            { id: 'a1', email: 'rt-ag-match@example.com', disabled: false, validation_blocked: false, quota: null },
            { id: 'a2', email: 'rt-ag-orphan@example.com', disabled: false, validation_blocked: false, quota: null },
        ],
        current_id: null,
    };
    const r = await app.inject({ method: 'POST', url: '/api/antigravity/sync' });
    assert.equal(r.statusCode, 200);
    const body = JSON.parse(r.body);
    assert.equal(body.matched, 1);
    assert.equal(body.orphans.length, 1);
    assert.equal(body.orphans[0], 'rt-ag-orphan@example.com');
});

test('POST /api/antigravity/push/:id on non-done member returns 400', async () => {
    const { rows } = await db.query("INSERT INTO members (email, password, status) VALUES ('rt-ag-notdone@example.com', 'p', 'new') RETURNING id");
    const r = await app.inject({ method: 'POST', url: `/api/antigravity/push/${rows[0].id}` });
    assert.equal(r.statusCode, 400);
    const body = JSON.parse(r.body);
    assert.match(body.error, /status.*done/i);
});

test('GET /api/antigravity/orphans returns remote-only accounts', async () => {
    mockClient._listResp = {
        accounts: [
            { id: 'a1', email: 'rt-ag-match@example.com', disabled: false, validation_blocked: false, quota: null },
            { id: 'a2', email: 'rt-ag-orphan@example.com', disabled: false, validation_blocked: false, quota: null },
        ],
        current_id: null,
    };
    const r = await app.inject({ method: 'GET', url: '/api/antigravity/orphans' });
    assert.equal(r.statusCode, 200);
    const list = JSON.parse(r.body);
    const emails = list.map(o => o.email);
    assert.ok(emails.includes('rt-ag-orphan@example.com'));
    assert.ok(!emails.includes('rt-ag-match@example.com'));
});
```

- [ ] **Step 4: 运行 — expect pass**

```bash
cd src && node --test routes/antigravity.test.js 2>&1 | tail -5
```

Expected: `pass 3`。

- [ ] **Step 5: Commit**

```bash
git add src/routes/antigravity.js src/routes/antigravity.test.js src/server.js
git commit -m "feat(api): POST /api/antigravity/{sync,push,push-all} + GET /orphans"
```

---

## Phase 2 · 调度 + 集成

### Task 5: Server 挂 5 分钟 setInterval 定时同步

**Files:**
- Modify: `src/server.js`

- [ ] **Step 1: 加 setInterval**

Open `src/server.js`. 找到 `async function start()` 函数。在 `await app.listen({...})` 成功之后，`app.log.info(...)` 之前，插入：

```javascript
    // Antigravity 定时 sync (set SYNC_INTERVAL_MS=0 to disable)
    const SYNC_MS = parseInt(process.env.SYNC_INTERVAL_MS, 10);
    if (SYNC_MS === 0) {
        app.log.info('Antigravity scheduled sync disabled (SYNC_INTERVAL_MS=0)');
    } else {
        const ms = Number.isFinite(SYNC_MS) && SYNC_MS > 0 ? SYNC_MS : 5 * 60 * 1000;
        const sync = require('./sync/antigravity-sync');
        setInterval(() => {
            sync.syncFromRemote()
                .then(r => app.log.info({ event: 'antigravity-sync', ...r }, `antigravity sync: matched=${r.matched} orphans=${r.orphans.length}`))
                .catch(e => app.log.warn({ err: e.message }, 'antigravity scheduled sync failed'));
        }, ms).unref();
        app.log.info(`Antigravity scheduled sync every ${ms}ms`);
    }
```

- [ ] **Step 2: 语法检查**

```bash
cd src && node --check server.js
```

Expected: no output.

- [ ] **Step 3: Smoke test — 起 server 2 秒看初始化日志**

**IMPORTANT**: kill 掉任何还在跑的 server 实例先。

```bash
pkill -f 'node server.js' 2>/dev/null; sleep 1
cd /usr/src/workspace/github/QQhuxuhui/auto_chrome/src && SYNC_INTERVAL_MS=60000 timeout 3 node server.js 2>&1 | grep -E 'Antigravity|HTTP ready' | head -5
```

Expected 包含：
- `Antigravity scheduled sync every 60000ms`
- `HTTP ready on http://127.0.0.1:3000`

- [ ] **Step 4: Commit**

```bash
git add src/server.js
git commit -m "feat(server): schedule antigravity sync every 5min (SYNC_INTERVAL_MS env)"
```

---

### Task 6: Reconcile 扩展 — sync + 移除 disabled 成员

**Files:**
- Modify: `src/stages/reconcile.js` — 扩展 `reconcileHost` 逻辑

- [ ] **Step 1: 查看现有 reconcileHost**

```bash
cd /usr/src/workspace/github/QQhuxuhui/auto_chrome/src && cat stages/reconcile.js
```

了解它的既有结构。

- [ ] **Step 2: 加一个辅助函数和扩展 reconcileHost**

Open `src/stages/reconcile.js`. 在文件顶部 `require` 列表后加：

```javascript
const antigravityClient = require('../common/antigravity');
const antigravitySync = require('../sync/antigravity-sync');
```

在现有 `reconcileAgainstDB` 函数之后、`reconcileHost` 之前，添加：

```javascript
/**
 * 在 Google Family 页面上移除一个成员。
 * 定位策略：找到 email 文本所在行，点行尾的更多按钮 / 移除按钮，确认。
 * 返回 true 表示成功或该成员已不在；false 表示 UI 路径找不到。
 */
async function removeFamilyMember(page, memberEmail, wlog) {
    const result = await page.evaluate((targetEmail) => {
        const lowerTarget = targetEmail.toLowerCase();
        // 找所有包含 email 的 list item 或 row 元素
        const candidates = document.querySelectorAll('li, div[role="listitem"], div[role="row"], tr');
        for (const row of candidates) {
            const text = (row.textContent || '').toLowerCase();
            if (!text.includes(lowerTarget)) continue;
            const r = row.getBoundingClientRect();
            if (r.width < 100 || r.height < 20) continue;
            // 找移除/踢出按钮 —— 多语言 aria-label 覆盖
            const buttons = row.querySelectorAll('button, [role="button"]');
            for (const btn of buttons) {
                const aria = (btn.getAttribute('aria-label') || '').toLowerCase();
                const btnText = (btn.textContent || '').toLowerCase();
                if (aria.includes('remove') || aria.includes('移除') || aria.includes('删除') ||
                    btnText.includes('remove') || btnText.includes('移除') || btnText.includes('删除')) {
                    btn.click();
                    return 'clicked_row_button';
                }
            }
            // 兜底：点行的「更多」按钮（3 个点图标）
            const moreBtn = row.querySelector('button[aria-label*="more" i], button[aria-label*="更多"]');
            if (moreBtn) {
                moreBtn.click();
                return 'clicked_more';
            }
        }
        return null;
    }, memberEmail).catch(() => null);

    if (!result) {
        wlog && wlog.warn && wlog.warn(`removeFamilyMember: could not locate row for ${memberEmail}`);
        return false;
    }
    // 等弹窗出现
    await sleep(1500);
    // 点确认按钮
    const confirmed = await page.evaluate(() => {
        const buttons = document.querySelectorAll('button, [role="button"]');
        for (const btn of buttons) {
            const text = (btn.textContent || '').trim().toLowerCase();
            if (text === 'remove' || text === 'confirm' || text === '移除' ||
                text === '删除' || text === '确认' || text === '确定') {
                btn.click();
                return true;
            }
        }
        return false;
    }).catch(() => false);

    if (!confirmed) {
        wlog && wlog.warn && wlog.warn(`removeFamilyMember: no confirm dialog for ${memberEmail}`);
        return false;
    }
    await sleep(2500);
    return true;
}
```

- [ ] **Step 3: 扩展 reconcileHost**

Find the existing `reconcileHost` function. 在它内部，在 `return reconcileAgainstDB(hostRecord, emails, runId);` 这行之前，插入一段「平台 disabled 清理」逻辑：

```javascript
        const emails = await scrapeFamilyMembers(page, wlog);
        wlog && wlog.info && wlog.info(`reconcile: host ${hostRecord.email} has ${emails.length} family members`);

        // 先把远程状态同步到本地，确保下一步 listMembersNeedingFamilyRemoval 用最新数据
        try {
            const syncResult = await antigravitySync.syncFromRemote();
            wlog && wlog.info && wlog.info(`reconcile sync: matched=${syncResult.matched} newly_disabled=${syncResult.newly_disabled.length}`);
        } catch (e) {
            wlog && wlog.warn && wlog.warn(`reconcile sync failed: ${e.message}`);
        }

        // 对 host 下面所有 antigravity.disabled=true 的成员执行移除
        const toRemove = await membersDb.listMembersNeedingFamilyRemoval(hostRecord.id);
        const emailLowerSet = new Set(emails.map(e => e.toLowerCase()));
        for (const member of toRemove) {
            const stillInFamily = emailLowerSet.has(member.email.toLowerCase());
            if (!stillInFamily) {
                // Google 上已经不在了 —— 只需清理本地 + 平台
                wlog && wlog.info && wlog.info(`${member.email} already absent from family, cleaning local state`);
            } else {
                wlog && wlog.info && wlog.info(`removing ${member.email} from ${hostRecord.email}'s family (disabled on platform)`);
                const ok = await removeFamilyMember(page, member.email, wlog);
                if (!ok) {
                    wlog && wlog.warn && wlog.warn(`skip ${member.email}: removal UI failed, will retry next round`);
                    continue;
                }
            }
            // 平台删账号
            const agId = member.antigravity && member.antigravity.id;
            if (agId) {
                try {
                    await antigravityClient.deleteAccount(agId);
                } catch (e) {
                    wlog && wlog.warn && wlog.warn(`DELETE platform ${agId} failed: ${e.message}`);
                }
            }
            await membersDb.markRemovedFromFamily(member.id);
            await membersDb.updateAntigravity(member.id, { id: null, disabled: false, disabled_reason: null });
            await eventsDb.logEvent({
                memberId: member.id, hostId: hostRecord.id, runId,
                stage: 'reconcile', eventType: 'note',
                message: `removed from family + antigravity (platform disabled: ${member.antigravity?.disabled_reason || 'unknown'})`,
            });
        }
```

- [ ] **Step 4: 语法检查**

```bash
cd /usr/src/workspace/github/QQhuxuhui/auto_chrome/src && node --check stages/reconcile.js
```

Expected: no output.

- [ ] **Step 5: 重启 server（setInterval 需要重新加载）**

```bash
pkill -f 'node server.js' 2>/dev/null; sleep 1
cd /usr/src/workspace/github/QQhuxuhui/auto_chrome/src && node server.js > /tmp/server.log 2>&1 &
sleep 2
tail -3 /tmp/server.log
```

Expected 看到 `Antigravity scheduled sync every` + `HTTP ready`.

- [ ] **Step 6: 触发一次 /api/antigravity/sync 看真实数据**

```bash
curl -s -X POST http://127.0.0.1:3000/api/antigravity/sync | python3 -m json.tool
```

Expected: 输出含 `"matched": N, "orphans": [...]` 这样的 JSON。因为你的 3 个 member 和平台的 3 个账号应该 match 上。

- [ ] **Step 7: Commit**

```bash
git add src/stages/reconcile.js
git commit -m "feat(reconcile): sync + auto-remove disabled members from Google family"
```

---

## Phase 3 · UI

### Task 7: 仪表盘 Antigravity 同步卡片

**Files:**
- Modify: `public/index.html`

- [ ] **Step 1: 读现有 index.html 结构**

```bash
sed -n '40,75p' /usr/src/workspace/github/QQhuxuhui/auto_chrome/public/index.html
```

- [ ] **Step 2: 在仪表盘「Host Capacity」旁边新增 Antigravity 卡片**

Open `public/index.html`. 找到 `<section class="grid grid-cols-2 gap-4">` 这一行（容纳 Member Status 和 Host Capacity 两个 card 的外 section）。**把它改成 3 列布局**，并在第二个 `</div>`（Host Capacity card 结尾）后面加第三个卡片：

将 `<section class="grid grid-cols-2 gap-4">` 改为 `<section class="grid grid-cols-3 gap-4">`。

然后在 Host Capacity `</div>` 之后、整个 `</section>` 之前，添加：

```html
        <div class="card p-4">
            <h3 class="font-semibold mb-2">Antigravity 平台</h3>
            <ul class="text-sm space-y-1">
                <li class="flex justify-between"><span>平台总账号</span><span x-text="ag.total || 0"></span></li>
                <li class="flex justify-between"><span>disabled</span><span x-text="ag.disabled || 0" class="text-red-400"></span></li>
                <li class="flex justify-between"><span>需验证</span><span x-text="ag.validation_blocked || 0" class="text-yellow-400"></span></li>
                <li class="flex justify-between"><span>quota 禁用</span><span x-text="ag.is_forbidden || 0" class="text-orange-400"></span></li>
                <li class="flex justify-between"><span>未关联本地</span><span x-text="ag.orphans || 0"></span></li>
                <li class="flex justify-between text-xs text-slate-400 pt-1 border-t border-slate-700/50 mt-1">
                    <span>最近同步</span><span x-text="ag.last_sync || '从未'"></span>
                </li>
            </ul>
            <div class="flex gap-2 mt-3">
                <button @click="agSync()" class="px-2 py-1 bg-blue-800 hover:bg-blue-700 rounded text-xs">立即同步</button>
                <button @click="agCleanup()" class="px-2 py-1 bg-orange-800 hover:bg-orange-700 rounded text-xs">执行清理</button>
            </div>
        </div>
```

- [ ] **Step 3: 扩展 dashboard() Alpine 数据 + 方法**

找到 `function dashboard() {` 块。在 `status: { ... }` 之后添加：

```javascript
        ag: { total: 0, disabled: 0, validation_blocked: 0, is_forbidden: 0, orphans: 0, last_sync: null },
```

在 `load()` 方法内部，在现有的 `this.status = await App.api(...)` 之后添加异步获取 antigravity 状态（用 orphan 接口 + listAccounts 直查。简化做法：新增一个专门统计路由，或者前端直接调 orphans）。

实际上我们没有「GET /api/antigravity/status」统计路由。**新增一个**。修改前的 task 4 已经定稿，这里要在 `src/routes/antigravity.js` 再加一条路由：

Open `src/routes/antigravity.js`. 在 `app.get('/api/antigravity/orphans', ...)` 之后添加：

```javascript
    app.get('/api/antigravity/stats', async () => {
        const { accounts = [] } = await antigravityClient.listAccounts();
        const total = accounts.length;
        const disabled = accounts.filter(a => a.disabled).length;
        const validation_blocked = accounts.filter(a => a.validation_blocked).length;
        const is_forbidden = accounts.filter(a => a.quota && a.quota.is_forbidden).length;
        const emails = accounts.map(a => a.email).filter(Boolean);
        const locals = await membersDb.listMembersByEmailLower(emails);
        const localSet = new Set(locals.map(m => m.email.toLowerCase()));
        const orphans = accounts.filter(a => !localSet.has(String(a.email).toLowerCase())).length;
        return { total, disabled, validation_blocked, is_forbidden, orphans };
    });
```

再回到 `public/index.html`, 在 `load()` 里面 `this.status = ...` 之后添加：

```javascript
                try {
                    const s = await App.api('GET', '/api/antigravity/stats');
                    this.ag = { ...s, last_sync: this.ag.last_sync };
                } catch (_) { /* platform 不可达时静默跳过 */ }
```

再在 dashboard() 对象里加两个新方法（放在 cancelRun 之后）：

```javascript
        async agSync() {
            try {
                const r = await App.api('POST', '/api/antigravity/sync');
                this.ag.last_sync = new Date().toLocaleTimeString();
                alert(`同步完成：匹配 ${r.matched}，新 disabled ${r.newly_disabled.length}，orphan ${r.orphans.length}`);
                this.load();
            } catch (e) { alert('同步失败：' + e.message); }
        },
        async agCleanup() {
            if (!confirm('执行清理会登录 host、扫描 family 页并移除 disabled 成员。确认？')) return;
            try {
                const r = await App.api('POST', '/api/reconcile');
                alert(`清理流程已启动（run #${r.runId}）。打开运行历史看进度。`);
                this.load();
            } catch (e) { alert('启动清理失败：' + e.message); }
        },
```

- [ ] **Step 4: 重启 server（新路由 /api/antigravity/stats 生效）**

```bash
pkill -f 'node server.js' 2>/dev/null; sleep 1
cd /usr/src/workspace/github/QQhuxuhui/auto_chrome/src && node server.js > /tmp/server.log 2>&1 &
sleep 2
curl -s http://127.0.0.1:3000/api/antigravity/stats | python3 -m json.tool
```

Expected: JSON with `total, disabled, validation_blocked, is_forbidden, orphans`。

- [ ] **Step 5: 浏览器硬刷新验证**

用户自行硬刷 `http://127.0.0.1:3000/`，应该能看到第三个卡片「Antigravity 平台」with 数字。

- [ ] **Step 6: Commit**

```bash
git add public/index.html src/routes/antigravity.js
git commit -m "feat(ui): dashboard antigravity card + sync/cleanup buttons + /stats route"
```

---

### Task 8: Members 表「平台状态」列 + 推送按钮

**Files:**
- Modify: `public/accounts.html`

- [ ] **Step 1: 加列**

Open `public/accounts.html`. 找到 Members tab 的 `<table class="data card">` 里的 `<thead>` 行：

```html
<thead><tr><th>邮箱</th><th>状态</th><th>母号</th><th>失败次数</th><th>凭证</th><th>操作</th></tr></thead>
```

把它改成：

```html
<thead><tr><th>邮箱</th><th>状态</th><th>母号</th><th>失败次数</th><th>凭证</th><th>平台状态</th><th>操作</th></tr></thead>
```

- [ ] **Step 2: 加 tbody 单元格**

找到 Members tab `<template x-for="m in members">` 的行。在 `凭证` 列（含 `token` 那个 `<td>`）和 `操作` 列之间，插入一个新 `<td>`：

```html
                        <td>
                            <!-- 平台状态 pill -->
                            <template x-if="!m.antigravity || !m.antigravity.id">
                                <template x-if="m.antigravity && m.antigravity.push_error">
                                    <span class="pill invite_failed" title="点击 操作 列的 推送 重试">❗ 推送失败</span>
                                </template>
                                <template x-if="!m.antigravity || !m.antigravity.push_error">
                                    <span class="pill new">— 未推送</span>
                                </template>
                            </template>
                            <template x-if="m.antigravity && m.antigravity.id">
                                <template x-if="m.antigravity.disabled">
                                    <span class="pill invite_failed">❌ 已封禁</span>
                                </template>
                                <template x-if="!m.antigravity.disabled && m.antigravity.validation_blocked">
                                    <span class="pill oauth_failed">⚠️ 需验证</span>
                                </template>
                                <template x-if="!m.antigravity.disabled && !m.antigravity.validation_blocked && m.antigravity.is_forbidden">
                                    <span class="pill accept_failed">⚠️ quota 禁</span>
                                </template>
                                <template x-if="!m.antigravity.disabled && !m.antigravity.validation_blocked && !m.antigravity.is_forbidden">
                                    <span class="pill done">✅ 正常</span>
                                </template>
                            </template>
                        </td>
```

- [ ] **Step 3: 操作列加「推送」按钮**

找到 `<td class="space-x-2 text-sm">` 这个操作列。在现有 `详情` 按钮之后、`重置` 按钮之前，加：

```html
                            <template x-if="m.status === 'done' && (!m.antigravity || !m.antigravity.id)">
                                <button @click="pushMember(m)" class="text-green-400">推送</button>
                            </template>
                            <template x-if="m.antigravity && m.antigravity.id && m.antigravity.disabled">
                                <button @click="pushMember(m)" class="text-green-400" title="重新推送">重推</button>
                            </template>
```

注意：空表格行的 `<td colspan="...">` 也需要从 6 改成 7。找 `no members` 那行：

```html
                <tr x-show="!members.length"><td colspan="6" class="text-center text-slate-500 py-4">暂无子号</td></tr>
```

改成 `colspan="7"`.

- [ ] **Step 4: 顶部加「批量推送」按钮**

找 Members tab 顶部的 `<div class="flex gap-2 mb-3">`。在现有 `+ 批量导入` 按钮之后，加：

```html
            <button @click="pushAllPending()" class="px-3 py-1 bg-emerald-700 hover:bg-emerald-600 rounded">
                批量推送待推送（<span x-text="pendingPushCount"></span>）
            </button>
```

- [ ] **Step 5: Alpine 方法 + 计数**

在 `function accounts() { return { ... } }` 里加数据字段：

```javascript
        pendingPushCount: 0,
```

（放在 `detail: null,` 之后）

在 `loadMembers()` 方法最后一行之后（return 之前）算一下：

```javascript
            this.pendingPushCount = this.members.filter(m =>
                m.status === 'done' && (!m.antigravity || !m.antigravity.id)
            ).length;
```

在 `deleteMember` 方法后面加两个新方法：

```javascript
        async pushMember(m) {
            if (!confirm(`推送 ${m.email} 到 Antigravity 平台？`)) return;
            try {
                const r = await App.api('POST', `/api/antigravity/push/${m.id}`);
                alert(r.success ? '推送成功' : '推送失败：' + r.error);
                await this.loadMembers();
            } catch (e) { alert('推送失败：' + e.message); }
        },
        async pushAllPending() {
            if (!this.pendingPushCount) { alert('没有待推送的账号'); return; }
            if (!confirm(`批量推送 ${this.pendingPushCount} 个账号到 Antigravity？`)) return;
            try {
                const r = await App.api('POST', '/api/antigravity/push-all');
                alert(`推送完成：成功 ${r.pushed} / 失败 ${r.failed} / 总计 ${r.total}` +
                    (r.failed ? '\n失败详情：\n' + r.errors.map(e => `${e.email}: ${e.error}`).join('\n') : ''));
                await this.loadMembers();
            } catch (e) { alert('批量推送失败：' + e.message); }
        },
```

- [ ] **Step 6: 硬刷新验证**

浏览器硬刷新 `/accounts` → Members tab 应该看到：
- 新的「平台状态」列（暂时全是「— 未推送」因为当前没 antigravity.id）
- 顶部「批量推送待推送（N）」按钮

- [ ] **Step 7: Commit**

```bash
git add public/accounts.html
git commit -m "feat(ui): members table platform status column + push buttons (row + batch)"
```

---

### Task 9: Member 详情抽屉 — 平台状态区块

**Files:**
- Modify: `public/accounts.html`

- [ ] **Step 1: 找详情抽屉位置**

Open `public/accounts.html`. 找 `<!-- Member detail drawer -->` 注释，drawer 内部 `<template x-if="detail">` 里的那段「状态 / 失败次数 / 时间 / 最后错误」块。

- [ ] **Step 2: 在 last_error 之后、Token textarea 之前加平台状态块**

找到：

```html
                    <div>last_error: <span class="mono text-red-400" x-text="detail.last_error || '—'"></span></div>
                    <div class="text-xs text-slate-500">Current host (internal): <span class="mono" x-text="hostEmailById(detail.host_id)"></span></div>
                </div>
                <div>
                    <div class="text-sm font-semibold mb-1">Token</div>
```

在 `Current host (internal)` 那行之后，`</div>` 之前，加：

```html
                    <div class="pt-2 border-t border-slate-700/50 mt-2">
                        <div class="text-sm font-semibold mb-1">Antigravity 平台</div>
                        <template x-if="!detail.antigravity || !detail.antigravity.id">
                            <div class="text-xs text-slate-400">未推送</div>
                        </template>
                        <template x-if="detail.antigravity && detail.antigravity.id">
                            <div class="text-xs space-y-1">
                                <div>平台 ID: <span class="mono" x-text="detail.antigravity.id"></span></div>
                                <div>推送时间: <span class="mono" x-text="detail.antigravity.pushed_at || '—'"></span></div>
                                <div>最近同步: <span class="mono" x-text="detail.antigravity.last_synced_at || '—'"></span></div>
                                <div>disabled: <span :class="detail.antigravity.disabled ? 'text-red-400' : ''" x-text="detail.antigravity.disabled ? `是 (${detail.antigravity.disabled_reason || '未知'})` : '否'"></span></div>
                                <div>需验证: <span :class="detail.antigravity.validation_blocked ? 'text-yellow-400' : ''" x-text="detail.antigravity.validation_blocked ? '是' : '否'"></span></div>
                                <div>quota 禁用: <span :class="detail.antigravity.is_forbidden ? 'text-orange-400' : ''" x-text="detail.antigravity.is_forbidden ? `是 (${detail.antigravity.forbidden_reason || '未知'})` : '否'"></span></div>
                            </div>
                        </template>
                        <template x-if="detail.antigravity && detail.antigravity.push_error">
                            <div class="text-xs text-red-400 mt-1">
                                推送错误 [<span x-text="detail.antigravity.push_error.status"></span>]:
                                <span x-text="detail.antigravity.push_error.message"></span>
                                <span class="text-slate-400">(at <span x-text="detail.antigravity.push_error.at"></span>)</span>
                            </div>
                        </template>
                        <div class="flex gap-2 mt-2">
                            <template x-if="detail.status === 'done' && (!detail.antigravity || !detail.antigravity.id)">
                                <button @click="pushMemberById(detail.id); detailOpen=false" class="px-2 py-1 bg-green-800 hover:bg-green-700 rounded text-xs">推送到平台</button>
                            </template>
                            <template x-if="detail.antigravity && detail.antigravity.id">
                                <button @click="deleteFromPlatform(detail.id); detailOpen=false" class="px-2 py-1 bg-red-900 hover:bg-red-800 rounded text-xs">从平台删除</button>
                            </template>
                        </div>
                    </div>
```

- [ ] **Step 3: 加辅助方法 `pushMemberById`, `deleteFromPlatform`**

在 `accounts()` 对象里、`pushAllPending` 之后，加：

```javascript
        async pushMemberById(id) {
            try {
                const r = await App.api('POST', `/api/antigravity/push/${id}`);
                alert(r.success ? '推送成功' : '推送失败：' + r.error);
                await this.loadMembers();
            } catch (e) { alert('推送失败：' + e.message); }
        },
        async deleteFromPlatform(id) {
            if (!confirm('从 Antigravity 平台删除此账号（本地保留）？')) return;
            try {
                const r = await App.api('DELETE', `/api/antigravity/account/${id}`);
                alert(r.success ? '已从平台删除' : '删除失败：' + r.error);
                await this.loadMembers();
            } catch (e) { alert('删除失败：' + e.message); }
        },
```

Note: `/api/antigravity/account/:id` 路由已经在 Task 4 实现了（DELETE 方法）。

- [ ] **Step 4: 硬刷新验证**

打开一个 member 详情抽屉，看到「Antigravity 平台」区块（若未推送显示"未推送"；按钮文字能显示）。

- [ ] **Step 5: Commit**

```bash
git add public/accounts.html
git commit -m "feat(ui): member detail drawer antigravity section + push/delete buttons"
```

---

## Phase 4 · e2e

### Task 10: 手动端到端验证

**无代码改动**，全手动。但每一步做完请在这里打勾。

- [ ] **Step 1: 验证定时 sync 工作**

启动 server 后等 5 分钟（或把 SYNC_INTERVAL_MS 设成 30000 = 30 秒）。用 `tail -f` 看 server 日志：

```bash
tail -f /tmp/server.log | grep antigravity
```

Expected: 每隔设定的间隔看到 `antigravity sync: matched=N orphans=M` 日志。

- [ ] **Step 2: 验证初次 sync 匹配已知账号**

当前本地 3 个 member 和平台上的 `buderusluis823 / norwoodroxanne13 / jaynathan898` 匹配。点仪表盘「立即同步」或 curl：

```bash
curl -s -X POST http://127.0.0.1:3000/api/antigravity/sync | python3 -m json.tool
```

Expected: `matched: 3`（如果这 3 个还在平台上），`orphans: [...]` 含未匹配的邮箱列表。

检查 DB 确认这 3 个 member 的 antigravity 列被填：

```bash
PGPASSWORD='123Hxh' psql -h 104.194.91.23 -p 5444 -U root -d auto_chrome \
    -c "SELECT email, antigravity FROM members WHERE antigravity IS NOT NULL;"
```

Expected: 3 行数据，每行的 JSONB 里有 `id`、`disabled: false`、`last_synced_at` 等字段。

- [ ] **Step 3: 手动推送一个新账号**

先在 UI 把 Members tab 的任意 member reset（清掉它的 antigravity 状态）或新增一个测试账号。用 curl 模拟一个 "done + has token" 的账号：

```bash
# 把一个现有 member 人工塞 token 走完整流程太慢，这里直接 SQL 注入假数据验证 API
PGPASSWORD='123Hxh' psql -h 104.194.91.23 -p 5444 -U root -d auto_chrome <<'SQL'
UPDATE members SET status='done', token='fake-token-for-push-test', done_at=NOW()
WHERE email='BuderusLuis823@gmail.com';
UPDATE members SET antigravity=NULL WHERE email='BuderusLuis823@gmail.com';
SQL

# 拿到 id
ID=$(PGPASSWORD='123Hxh' psql -h 104.194.91.23 -p 5444 -U root -d auto_chrome -t -A \
    -c "SELECT id FROM members WHERE email='BuderusLuis823@gmail.com'")

# 推送
curl -s -X POST http://127.0.0.1:3000/api/antigravity/push/$ID | python3 -m json.tool
```

注意：如果平台认为 fake token 无效会返 4xx，`antigravity.push_error` 会填上。用户可以观察 UI 上的「❗ 推送失败」状态。

- [ ] **Step 4: 验证 UI 平台状态列**

浏览器硬刷 `/accounts`。找到 BuderusLuis823。检查：
- 「平台状态」列显示正确（✅ 正常 / ❗ 推送失败 / — 未推送）
- 行上出现「推送」或「重推」按钮

- [ ] **Step 5: 模拟平台封禁 + 执行清理（风险动作 —— 影响 Google family）**

这一步有副作用。**只在你确认要验证时做**：

1. 到 Antigravity-Manager UI (不是我们这个 UI) 把某个账号标记 `disabled=true`（或用 SQL 直接改平台数据，取决于你这个平台怎么操作）。
2. 回本系统 UI 点「执行清理」。
3. 观察 `/runs` 页 —— 应该有一行新 run，`launched_by=ui`, `stages=reconcile`, 状态从 running 变 completed。
4. 检查 events 时间线，应该能看到「removed from family + antigravity ...」事件。
5. SQL 检查本地 member 状态：

```bash
PGPASSWORD='123Hxh' psql -h 104.194.91.23 -p 5444 -U root -d auto_chrome \
    -c "SELECT email, status, host_id, antigravity->>'id' AS ag_id FROM members WHERE status='removed_from_family';"
```

Expected: 被 disabled 的 member 现在 status=`removed_from_family`，host_id 为 NULL，ag_id 为 NULL。

6. 到 Google family 页面（`https://myaccount.google.com/family`）确认该成员真的被移除了。

- [ ] **Step 6: 没通过则报告 issues，通过则收工**

---

## Self-review Checklist

- ✅ Spec §3 schema → Task 1
- ✅ Spec §5 HTTP 客户端 → Task 2
- ✅ Spec §5 sync 模块 → Task 3
- ✅ Spec §5 路由 → Task 4
- ✅ Spec §5 setInterval → Task 5
- ✅ Spec §5 reconcile 扩展 → Task 6
- ✅ Spec §6 仪表盘卡片（立即同步 + 执行清理）→ Task 7
- ✅ Spec §6 Members 平台状态列 + 按钮 → Task 8
- ✅ Spec §6 详情抽屉平台区块 → Task 9
- ✅ Spec §8 手动 e2e → Task 10
- ✅ Q9（删平台记录）在 Task 6 reconcile 扩展 + Task 4 DELETE 路由实现
- ✅ Q4（email 小写匹配）在 Task 3 `listMembersByEmailLower` + syncFromRemote
- ✅ Q5（orphan 忽略）在 Task 3 + Task 4 `GET /api/antigravity/orphans`（只读）
- ✅ Q8（不自动重试）在 Task 3 `pushAccount` 的 catch 只写 push_error 不 retry
- ✅ pushed_at / push_error 不被远程 sync 覆盖：pickMirror 只返回远程字段，updateAntigravity 用 JSONB `||` 合并保留本地字段

**任务数**：10（分 4 phase）
**估计测试覆盖**：原 49 → 新增 ~14（members 3 + antigravity client 5 + sync 6）= 63 tests
**估计时间**：8–10 个自动化任务（~1 小时）+ Task 10 手动 e2e 20 分钟
