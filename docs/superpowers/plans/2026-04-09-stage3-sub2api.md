# Stage 3 sub2api Account Registration — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `src/5_sub2api.js` (browser UI automation) with `src/3_sub2api.js`, a REST-driven stage that registers each `members.txt` account into sub2api as an antigravity OAuth account, using Puppeteer request interception to capture the OAuth callback `code` without any local HTTP server.

**Architecture:** Single-file Node script at `src/3_sub2api.js`. Internal structure: pure helpers (name, config, flag parsing) → `Sub2apiClient` class (REST wrapper over Node's built-in `fetch`) → `captureOAuthCode` utility (puppeteer request interception) → `processMember` orchestration (idempotency decision tree, optional re-auth) → `main` worker pool (mirrors `2_accept.js`). Unit tests cover pure helpers only, via Node built-in `node:test`. Everything else is verified by manual smoke tests L1–L6.

**Tech Stack:** Node 20+ (uses `fetch`, `node:test`, `node:assert`), puppeteer-core (already a dep), existing `common/` modules (`logger`, `chrome`, `state`, `google-login`). No new npm dependencies.

**Spec:** `docs/superpowers/specs/2026-04-09-stage3-sub2api-design.md`

---

## File Structure

### Files created
- `src/3_sub2api.js` — main stage 3 script (single file, ~400 lines)
- `src/3_sub2api.test.js` — unit tests for pure helpers (Node built-in `node:test`)

### Files modified
- `src/package.json` — add `test:stage3` script
- `run_pipeline.sh` — add `3)` case in `run_stage`
- `.gitignore` — add `sub2api.txt`

### Files deleted
- `src/5_sub2api.js` — legacy UI-flow script (obsoleted)

### Files untracked (removed from git index, kept locally)
- `sub2api.txt` — currently contains committed credentials; must be untracked and rewritten to the new `key=value` format by the user

---

## Task 1: Helper functions with TDD

Pure functions that can be tested in isolation with no live server / no browser. TDD flow (red → green → commit).

**Files:**
- Create: `src/3_sub2api.js`
- Create: `src/3_sub2api.test.js`
- Modify: `src/package.json`

- [ ] **Step 1: Create the failing test file**

Create `src/3_sub2api.test.js` with:

```js
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
    accountName,
    parseSub2apiConfig,
    shouldForceReauth,
} = require('./3_sub2api');

// ============ accountName ============
test('accountName: canonical case', () => {
    assert.strictEqual(
        accountName('BrinaSzreder470@gmail.com', 'chauanh2083@gmail.com'),
        'ultra_BrinaSzreder470_chauanh2083'
    );
});

test('accountName: preserves case of local parts', () => {
    assert.strictEqual(
        accountName('FooBar@x.com', 'BazQux@y.com'),
        'ultra_FooBar_BazQux'
    );
});

test('accountName: local part with dot', () => {
    assert.strictEqual(
        accountName('first.last@gmail.com', 'a.b.c@gmail.com'),
        'ultra_first.last_a.b.c'
    );
});

test('accountName: local part with plus tag', () => {
    assert.strictEqual(
        accountName('user+tag@gmail.com', 'child+1@gmail.com'),
        'ultra_user+tag_child+1'
    );
});

// ============ parseSub2apiConfig ============
function writeTmp(content) {
    const p = path.join(os.tmpdir(), `sub2api_cfg_${Date.now()}_${Math.random().toString(36).slice(2)}.txt`);
    fs.writeFileSync(p, content, 'utf-8');
    return p;
}

test('parseSub2apiConfig: well-formed', () => {
    const p = writeTmp('url=http://example.com:3001\napi_key=abc123\n');
    assert.deepStrictEqual(parseSub2apiConfig(p), {
        url: 'http://example.com:3001',
        apiKey: 'abc123',
    });
    fs.unlinkSync(p);
});

test('parseSub2apiConfig: ignores blank lines and comments', () => {
    const p = writeTmp('# comment line\n\nurl=http://x\n# another\napi_key=k\n\n');
    assert.deepStrictEqual(parseSub2apiConfig(p), {
        url: 'http://x',
        apiKey: 'k',
    });
    fs.unlinkSync(p);
});

test('parseSub2apiConfig: tolerates BOM and CRLF', () => {
    const p = writeTmp('\uFEFFurl=http://x\r\napi_key=k\r\n');
    assert.deepStrictEqual(parseSub2apiConfig(p), {
        url: 'http://x',
        apiKey: 'k',
    });
    fs.unlinkSync(p);
});

test('parseSub2apiConfig: value may contain equals sign', () => {
    const p = writeTmp('url=http://x\napi_key=abc=def=ghi\n');
    assert.strictEqual(parseSub2apiConfig(p).apiKey, 'abc=def=ghi');
    fs.unlinkSync(p);
});

test('parseSub2apiConfig: throws when url missing', () => {
    const p = writeTmp('api_key=abc\n');
    assert.throws(() => parseSub2apiConfig(p), /url/);
    fs.unlinkSync(p);
});

test('parseSub2apiConfig: throws when api_key missing', () => {
    const p = writeTmp('url=http://x\n');
    assert.throws(() => parseSub2apiConfig(p), /api_key/);
    fs.unlinkSync(p);
});

test('parseSub2apiConfig: throws when file missing', () => {
    assert.throws(() => parseSub2apiConfig('/nonexistent/__none__.txt'), /not found/i);
});

// ============ shouldForceReauth ============
test('shouldForceReauth: --reauth-all matches anything', () => {
    assert.strictEqual(shouldForceReauth('x@y.com', { reauthAll: true, reauthList: [] }), true);
});

test('shouldForceReauth: email in list matches (case-insensitive)', () => {
    assert.strictEqual(
        shouldForceReauth('Foo@Bar.com', { reauthAll: false, reauthList: ['foo@bar.com'] }),
        true
    );
});

test('shouldForceReauth: email not in list', () => {
    assert.strictEqual(
        shouldForceReauth('x@y.com', { reauthAll: false, reauthList: ['a@b.com'] }),
        false
    );
});

test('shouldForceReauth: empty list, no flag', () => {
    assert.strictEqual(
        shouldForceReauth('x@y.com', { reauthAll: false, reauthList: [] }),
        false
    );
});
```

- [ ] **Step 2: Create skeleton `3_sub2api.js` that exports the symbols under test (no impl yet)**

Create `src/3_sub2api.js` with:

```js
/**
 * 阶段3 — 在 sub2api 注册 antigravity OAuth 账号
 *
 * 流程：对 members.txt 里的每个成员，按 name=ultra_<hostLocal>_<memberLocal>
 * 查 sub2api；没有则新建、非 active 则自动重授权、active 则跳过。
 * OAuth callback 通过 puppeteer 请求拦截捕获，不起本地 HTTP 服务器。
 *
 * 详见 docs/superpowers/specs/2026-04-09-stage3-sub2api-design.md
 */

function accountName(hostEmail, memberEmail) {
    throw new Error('not implemented');
}

function parseSub2apiConfig(filePath) {
    throw new Error('not implemented');
}

function shouldForceReauth(memberEmail, opts) {
    throw new Error('not implemented');
}

module.exports = {
    accountName,
    parseSub2apiConfig,
    shouldForceReauth,
};
```

- [ ] **Step 3: Add `test:stage3` npm script**

Modify `src/package.json`. Replace the `scripts` object:

```json
  "scripts": {
    "start": "node auth.js",
    "start:verbose": "node auth.js --verbose",
    "start:test": "node auth.js --test 2 --verbose",
    "test:stage3": "node --test 3_sub2api.test.js"
  },
```

- [ ] **Step 4: Run the tests — confirm all RED**

Run: `cd src && npm run test:stage3`
Expected: All tests fail with `Error: not implemented` or similar. Test runner reports non-zero exit.

- [ ] **Step 5: Implement the three helpers**

Replace the three stub functions in `src/3_sub2api.js` with:

```js
const fs = require('fs');

function accountName(hostEmail, memberEmail) {
    const localOf = (e) => String(e).split('@')[0];
    return `ultra_${localOf(hostEmail)}_${localOf(memberEmail)}`;
}

function parseSub2apiConfig(filePath) {
    if (!fs.existsSync(filePath)) {
        throw new Error(`sub2api config not found: ${filePath}`);
    }
    let raw = fs.readFileSync(filePath, 'utf-8');
    if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);

    const result = {};
    for (const line of raw.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eqPos = trimmed.indexOf('=');
        if (eqPos <= 0) continue;
        const key = trimmed.slice(0, eqPos).trim();
        const value = trimmed.slice(eqPos + 1).trim();
        if (key === 'url') result.url = value;
        else if (key === 'api_key') result.apiKey = value;
    }

    if (!result.url) throw new Error(`sub2api config: missing "url" in ${filePath}`);
    if (!result.apiKey) throw new Error(`sub2api config: missing "api_key" in ${filePath}`);
    return result;
}

function shouldForceReauth(memberEmail, opts) {
    if (opts.reauthAll) return true;
    const target = String(memberEmail).toLowerCase();
    return (opts.reauthList || []).some(e => String(e).toLowerCase() === target);
}

module.exports = {
    accountName,
    parseSub2apiConfig,
    shouldForceReauth,
};
```

- [ ] **Step 6: Run the tests — confirm all GREEN**

Run: `cd src && npm run test:stage3`
Expected: All ~15 tests pass, exit code 0.

- [ ] **Step 7: Commit**

```bash
git add src/3_sub2api.js src/3_sub2api.test.js src/package.json
git commit -m "feat(stage3): helper functions (accountName, parseSub2apiConfig, shouldForceReauth)

Initial skeleton of src/3_sub2api.js with pure helpers + unit tests
via Node built-in node:test runner. npm run test:stage3 wires them up."
```

---

## Task 2: Sub2apiClient REST wrapper

Adds the HTTP client. No automated tests — verified by L1 smoke test after implementation.

**Files:**
- Modify: `src/3_sub2api.js` (append class before `module.exports`)

- [ ] **Step 1: Add Sub2apiError and Sub2apiClient class**

In `src/3_sub2api.js`, insert this code **before** the `module.exports` block:

```js
// ============ REST client ============

class Sub2apiError extends Error {
    constructor(endpoint, httpStatus, bizCode, message) {
        super(`[sub2api] ${endpoint} http=${httpStatus} code=${bizCode}: ${message}`);
        this.name = 'Sub2apiError';
        this.endpoint = endpoint;
        this.httpStatus = httpStatus;
        this.bizCode = bizCode;
    }
}

class Sub2apiClient {
    constructor(baseUrl, apiKey) {
        this.baseUrl = String(baseUrl).replace(/\/+$/, '');
        this.apiKey = apiKey;
    }

    async _request(method, pathname, body) {
        const url = `${this.baseUrl}${pathname}`;
        const headers = { 'x-api-key': this.apiKey };
        const init = { method, headers };
        if (body !== undefined) {
            headers['content-type'] = 'application/json';
            init.body = JSON.stringify(body);
        }
        let res;
        try {
            res = await fetch(url, init);
        } catch (e) {
            throw new Sub2apiError(pathname, 0, -1, `network: ${e.message}`);
        }
        const text = await res.text();
        let json = null;
        try { json = text ? JSON.parse(text) : null; } catch (_) { /* keep null */ }
        if (!res.ok) {
            throw new Sub2apiError(pathname, res.status, json?.code ?? -1, json?.message || text || res.statusText);
        }
        if (json && typeof json === 'object' && 'code' in json && json.code !== 0) {
            throw new Sub2apiError(pathname, res.status, json.code, json.message || 'non-zero biz code');
        }
        return json?.data ?? null;
    }

    async getAuthUrl(proxyId = null) {
        const data = await this._request('POST', '/api/v1/admin/antigravity/oauth/auth-url', { proxy_id: proxyId });
        return {
            sessionId: data.session_id,
            state: data.state,
            authUrl: data.auth_url,
        };
    }

    async exchangeCode({ sessionId, state, code, proxyId = null }) {
        return this._request('POST', '/api/v1/admin/antigravity/oauth/exchange-code', {
            session_id: sessionId,
            state,
            code,
            proxy_id: proxyId,
        });
    }

    /**
     * Exact-match lookup by account name. Server search is substring; we fetch
     * and filter client-side. Returns the account object or null.
     */
    async findAccountByName(name) {
        const qs = new URLSearchParams({ search: name, page: '1', page_size: '50' }).toString();
        const data = await this._request('GET', `/api/v1/admin/accounts?${qs}`, undefined);
        const list = Array.isArray(data?.items) ? data.items
            : Array.isArray(data?.list) ? data.list
            : Array.isArray(data) ? data
            : [];
        return list.find(a => a && a.name === name) || null;
    }

    async createAccount({ name, credentials }) {
        return this._request('POST', '/api/v1/admin/accounts', {
            name,
            platform: 'antigravity',
            type: 'oauth',
            credentials,
        });
    }

    async updateAccountCredentials(id, credentials) {
        return this._request('PUT', `/api/v1/admin/accounts/${encodeURIComponent(id)}`, { credentials });
    }

    /**
     * Runs the test endpoint. Consumes the SSE stream and returns true if no
     * explicit error event was seen, false otherwise. Non-fatal by design.
     */
    async testAccount(id) {
        const url = `${this.baseUrl}/api/v1/admin/accounts/${encodeURIComponent(id)}/test`;
        let res;
        try {
            res = await fetch(url, {
                method: 'POST',
                headers: { 'x-api-key': this.apiKey, 'content-type': 'application/json' },
                body: JSON.stringify({}),
            });
        } catch (e) {
            return false;
        }
        if (!res.ok || !res.body) return false;
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = '';
        let sawError = false;
        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                buf += decoder.decode(value, { stream: true });
                // Scan each SSE event (separated by blank line)
                let idx;
                while ((idx = buf.indexOf('\n\n')) >= 0) {
                    const evt = buf.slice(0, idx);
                    buf = buf.slice(idx + 2);
                    if (/event:\s*error/i.test(evt) || /"type"\s*:\s*"error"/i.test(evt)) {
                        sawError = true;
                    }
                }
            }
        } catch (_) {
            return false;
        }
        return !sawError;
    }
}
```

Also add `Sub2apiClient` and `Sub2apiError` to `module.exports` so downstream code and future manual smoke can import them:

```js
module.exports = {
    accountName,
    parseSub2apiConfig,
    shouldForceReauth,
    Sub2apiClient,
    Sub2apiError,
};
```

- [ ] **Step 2: Re-run helper tests to confirm nothing regressed**

Run: `cd src && npm run test:stage3`
Expected: All ~15 helper tests still pass.

- [ ] **Step 3: Manual smoke L1 — REST client reachability**

⚠️ **This smoke test requires a live sub2api server and a valid `api_key`.** If `sub2api.txt` has not yet been rewritten, skip this step and return to it after Task 8.

Run (from repo root):
```bash
node -e "
const { parseSub2apiConfig, Sub2apiClient } = require('./src/3_sub2api');
const cfg = parseSub2apiConfig('./sub2api.txt');
const c = new Sub2apiClient(cfg.url, cfg.apiKey);
(async () => {
  const auth = await c.getAuthUrl();
  console.log('getAuthUrl OK:', auth.sessionId, auth.authUrl.slice(0, 60) + '...');
  const miss = await c.findAccountByName('__definitely_not_a_real_name__');
  console.log('findAccountByName(missing) OK:', miss);
})().catch(e => { console.error('FAIL', e); process.exit(1); });
"
```
Expected output: `getAuthUrl OK: <sessionId> https://accounts.google.com/o/oauth2/v2/auth?...` and `findAccountByName(missing) OK: null`. No account created.

- [ ] **Step 4: Commit**

```bash
git add src/3_sub2api.js
git commit -m "feat(stage3): Sub2apiClient REST wrapper

Thin client over Node built-in fetch. Covers auth-url, exchange-code,
find/create/update accounts (PUT for re-auth), and best-effort test
endpoint SSE consumer."
```

---

## Task 3: captureOAuthCode puppeteer interceptor

Adds the browser-side utility that extracts the `code` from the OAuth redirect without binding port 8085.

**Files:**
- Modify: `src/3_sub2api.js` (append)

- [ ] **Step 1: Add the `captureOAuthCode` function**

In `src/3_sub2api.js`, insert **after** the `Sub2apiClient` class, **before** `module.exports`:

```js
// ============ OAuth code capture via request interception ============

/**
 * Opens authUrl in `page`, intercepts the redirect to
 * http://localhost:8085/callback, and returns the OAuth `code`.
 * Throws on timeout (60s default) or if the callback URL carries `error=`.
 *
 * Relies on request interception, so port 8085 is never actually contacted
 * and multiple workers can run in parallel without collision.
 */
async function captureOAuthCode(page, authUrl, wlog, { timeoutMs = 60000 } = {}) {
    await page.setRequestInterception(true);

    let resolveCode, rejectCode;
    const codePromise = new Promise((resolve, reject) => {
        resolveCode = resolve;
        rejectCode = reject;
    });

    const onRequest = (req) => {
        const url = req.url();
        if (url.startsWith('http://localhost:8085/callback')) {
            try {
                const u = new URL(url);
                const code = u.searchParams.get('code');
                const err = u.searchParams.get('error');
                if (err) {
                    rejectCode(new Error(`oauth_denied:${err}`));
                } else if (code) {
                    resolveCode(code);
                } else {
                    rejectCode(new Error('oauth_callback_missing_code'));
                }
            } catch (e) {
                rejectCode(new Error(`oauth_callback_parse: ${e.message}`));
            }
            req.abort().catch(() => { });
            return;
        }
        req.continue().catch(() => { });
    };

    page.on('request', onRequest);

    const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('oauth_capture_timeout')), timeoutMs)
    );

    try {
        // Kick off navigation but do not await it — the redirect to
        // localhost:8085 will fire request interception first and we resolve
        // via the promise, not via goto's return value.
        page.goto(authUrl, { waitUntil: 'domcontentloaded', timeout: timeoutMs })
            .catch(() => { /* navigation may error due to aborted request; ignore */ });

        const code = await Promise.race([codePromise, timeoutPromise]);
        if (wlog) wlog.debug(`  OAuth code captured (${code.length} chars)`);
        return code;
    } finally {
        page.off('request', onRequest);
        await page.setRequestInterception(false).catch(() => { });
    }
}
```

- [ ] **Step 2: Export `captureOAuthCode`**

Update `module.exports` to include it:

```js
module.exports = {
    accountName,
    parseSub2apiConfig,
    shouldForceReauth,
    Sub2apiClient,
    Sub2apiError,
    captureOAuthCode,
};
```

- [ ] **Step 3: Re-run helper tests**

Run: `cd src && npm run test:stage3`
Expected: All helper tests still pass (captureOAuthCode has no automated test).

- [ ] **Step 4: Commit**

```bash
git add src/3_sub2api.js
git commit -m "feat(stage3): captureOAuthCode via request interception

Intercepts the redirect to http://localhost:8085/callback inside Chrome,
extracts the code, aborts the request so no TCP connect happens.
No local HTTP server, concurrency-safe."
```

---

## Task 4: maybePause + processMember orchestration

Adds the condition-pause helper (same pattern already used in stages 1/2) and the per-member business logic that implements the §4 decision tree of the spec.

**Files:**
- Modify: `src/3_sub2api.js` (append)

- [ ] **Step 1: Add top-level CLI args, maybePause helper, constants**

In `src/3_sub2api.js`, insert immediately after the initial `require('fs')` line:

```js
const path = require('path');
const { log, createWorkerLogger, setVerbose, StepTimer } = require('./common/logger');
const {
    sleep, rand, findChrome, launchRealChrome, restartChrome,
    isChromeAlive, newPage, takeScreenshot,
} = require('./common/chrome');
const { parseAccounts, addFailedRecord } = require('./common/state');
const { googleLogin } = require('./common/google-login');

// ============ CLI 参数 ============
const args = process.argv.slice(2);
if (args.includes('--verbose') || args.includes('-v')) setVerbose(true);

function parseIntArg(names, fallback) {
    for (let i = 0; i < args.length; i++) {
        if (names.includes(args[i]) && args[i + 1]) {
            const n = parseInt(args[i + 1], 10);
            if (!Number.isNaN(n)) return n;
        }
    }
    return fallback;
}

function parseListArg(prefix) {
    for (const a of args) {
        if (a.startsWith(prefix)) {
            return a.slice(prefix.length).split(',').map(s => s.trim()).filter(Boolean);
        }
    }
    return [];
}

const CLI_OPTS = {
    concurrency: parseIntArg(['-c', '--concurrency'], parseInt(process.env.CONCURRENCY, 10) || 1),
    reauthAll: args.includes('--reauth-all'),
    reauthList: parseListArg('--reauth='),
    skipTest: args.includes('--skip-test'),
};

const HARD_TIMEOUT_MS = parseInt(process.env.SUB2API_HARD_TIMEOUT_MS, 10) || 300000;

// ============ 条件暂停 ============
const PAUSE_POINTS = (process.env.PAUSE_AT || '')
    .split(',').map(s => s.trim()).filter(Boolean);
const _pauseLock = { busy: false };

async function maybePause(label, wlog) {
    if (!PAUSE_POINTS.includes('all') && !PAUSE_POINTS.includes(label)) return;
    if (!process.stdin.isTTY) {
        (wlog || console).warn && (wlog || console).warn(`[pause:${label}] stdin 非 TTY，跳过暂停`);
        return;
    }
    while (_pauseLock.busy) await sleep(500);
    _pauseLock.busy = true;
    try {
        process.stdout.write(`\n>>> [pause:${label}] 已暂停，人工干预完成后按回车继续...\n`);
        await new Promise(resolve => {
            process.stdin.resume();
            process.stdin.once('data', () => {
                process.stdin.pause();
                resolve();
            });
        });
        (wlog || console).info && (wlog || console).info(`[pause:${label}] 继续执行`);
    } finally {
        _pauseLock.busy = false;
    }
}
```

- [ ] **Step 2: Add `processMember` function**

Insert after `captureOAuthCode`, before `module.exports`:

```js
// ============ 单 member 编排 ============

const SESSION_SAFETY_WINDOW_MS = 25 * 60 * 1000; // sub2api SessionTTL = 30min, keep 5min buffer

async function processMember({ member, host, client, browser, workerId, opts }) {
    const wlog = createWorkerLogger(workerId);
    const timer = new StepTimer(wlog);
    const name = accountName(host.email, member.email);
    wlog.info(`>> processMember name=${name} email=${member.email}`);

    // 1. Check existence + decide mode
    const existing = await client.findAccountByName(name);
    timer.step('findAccountByName');

    const forceReauth = shouldForceReauth(member.email, opts);
    let mode;
    if (!existing) {
        mode = 'create';
    } else if (forceReauth) {
        mode = 'reauth';
        wlog.info(`  forced re-auth requested (id=${existing.id})`);
    } else if (existing.status === 'active') {
        wlog.success(`  [skip] already active (id=${existing.id})`);
        return { status: 'skipped', accountId: existing.id, mode: 'skip' };
    } else {
        mode = 'reauth';
        wlog.info(`  auto re-auth: status=${existing.status} (id=${existing.id})`);
    }

    // 2. Get auth url (starts sub2api session 30min countdown)
    const authStartedAt = Date.now();
    const { sessionId, state, authUrl } = await client.getAuthUrl();
    timer.step('getAuthUrl');

    // 3. Browser login as the member
    const page = await newPage(browser);
    try {
        await googleLogin(page, member, wlog);
        timer.step('googleLogin');

        // 4. Manual intervention point
        await maybePause('before-oauth', wlog);

        // Session TTL safety check after (potentially long) pause
        if (Date.now() - authStartedAt > SESSION_SAFETY_WINDOW_MS) {
            throw new Error(`sub2api session nearly expired (${Math.round((Date.now() - authStartedAt) / 1000)}s elapsed, limit ${SESSION_SAFETY_WINDOW_MS / 1000}s) — re-run stage 3 to restart`);
        }

        // 5. Capture OAuth code via request interception
        let code;
        try {
            code = await captureOAuthCode(page, authUrl, wlog);
        } catch (e) {
            await takeScreenshot(page, `sub2api_oauth_fail_${member.email.replace(/[^a-z0-9]/gi, '_')}`, wlog);
            throw e;
        }
        timer.step('captureOAuthCode');

        // 6. Exchange code -> tokens
        const tokens = await client.exchangeCode({ sessionId, state, code });
        timer.step('exchangeCode');

        // 7. Build credentials (expires_at must be string per spec note)
        const credentials = {
            access_token: tokens.access_token,
            refresh_token: tokens.refresh_token,
            expires_at: String(tokens.expires_at),
            token_type: tokens.token_type || 'Bearer',
            email: tokens.email,
            project_id: tokens.project_id,
        };

        // 8. Create or update
        let account;
        if (mode === 'create') {
            try {
                account = await client.createAccount({ name, credentials });
            } catch (e) {
                // Race fallback: maybe someone else created it between our lookup and now
                if (e instanceof Sub2apiError) {
                    const again = await client.findAccountByName(name);
                    if (again) {
                        wlog.warn(`  create collided, falling back to PUT id=${again.id}`);
                        account = await client.updateAccountCredentials(again.id, credentials);
                    } else {
                        throw e;
                    }
                } else {
                    throw e;
                }
            }
            timer.step('createAccount');
        } else {
            account = await client.updateAccountCredentials(existing.id, credentials);
            timer.step('updateAccountCredentials');
        }

        // 9. Optional test (non-fatal)
        if (!opts.skipTest) {
            const ok = await client.testAccount(account.id);
            if (ok) {
                wlog.success(`  test passed (id=${account.id})`);
            } else {
                wlog.warn(`  test did not pass (id=${account.id}) — non-fatal, account still counted as success`);
            }
            timer.step('testAccount');
        }

        wlog.success(`  ${mode} done: id=${account.id}`);
        return {
            status: mode === 'create' ? 'created' : 'updated',
            accountId: account.id,
            mode,
        };
    } finally {
        await page.close().catch(() => { });
    }
}
```

- [ ] **Step 3: Re-run helper tests**

Run: `cd src && npm run test:stage3`
Expected: All helper tests still pass.

- [ ] **Step 4: Commit**

```bash
git add src/3_sub2api.js
git commit -m "feat(stage3): processMember orchestration + maybePause

Implements the idempotency decision tree: create new, skip active,
auto re-auth non-active, force re-auth on flags. Includes
before-oauth manual intervention point and sub2api session TTL
safety check."
```

---

## Task 5: main() worker pool + SIGINT handler + runnable script

Ties everything together. After this task `node src/3_sub2api.js` becomes a working command.

**Files:**
- Modify: `src/3_sub2api.js` (append)

- [ ] **Step 1: Add `main()`, worker cleanup, SIGINT handler, and the invocation at the bottom of the file**

Insert **after** `processMember` and **before** `module.exports`:

```js
// ============ main ============

const keepBrowserOpen = (process.env.KEEP_BROWSER_OPEN || '').toLowerCase() === 'true';
let _workers = [];

function cleanupWorkers(workers) {
    for (const w of workers) {
        if (keepBrowserOpen) {
            try { w.browser.disconnect(); } catch (_) { }
        } else {
            try { w.browser.close(); } catch (_) { }
            try { w.proc.kill(); } catch (_) { }
        }
    }
    if (keepBrowserOpen && workers.length > 0) log('Browsers kept open (KEEP_BROWSER_OPEN=true)');
}

process.on('SIGINT', () => {
    log('\nInterrupted (Ctrl+C). Cleaning up...', 'WARN');
    cleanupWorkers(_workers);
    process.exit();
});

function pairMembersWithHosts(hosts, members) {
    // Same convention as stage1 buildGroups: 5 members per host, by index.
    const pairs = [];
    for (let i = 0; i < members.length; i++) {
        const hostIdx = Math.floor(i / 5);
        if (hostIdx >= hosts.length) {
            log(`  Dropping member[${i}] ${members[i].email}: no host (members > 5 * hosts.length)`, 'WARN');
            continue;
        }
        pairs.push({ member: members[i], host: hosts[hostIdx] });
    }
    return pairs;
}

async function main() {
    const repoRoot = path.resolve(__dirname, '..');
    const sub2apiFile = path.join(repoRoot, 'sub2api.txt');
    const hostsFile = path.join(repoRoot, 'hosts.txt');
    const membersFile = path.join(repoRoot, 'members.txt');

    const cfg = parseSub2apiConfig(sub2apiFile);
    const client = new Sub2apiClient(cfg.url, cfg.apiKey);

    const hosts = parseAccounts(hostsFile);
    const members = parseAccounts(membersFile);
    const pending = pairMembersWithHosts(hosts, members);

    const chromePath = findChrome();
    if (!chromePath) { console.error('Chrome not found'); process.exit(1); }

    log('');
    log('='.repeat(60));
    log('  Stage 3: Register Accounts in sub2api');
    log('='.repeat(60));
    log(`  sub2api URL:  ${cfg.url}`);
    log(`  Hosts:        ${hostsFile}`);
    log(`  Members:      ${membersFile}`);
    log(`  Pending:      ${pending.length}`);
    log(`  Concurrency:  ${CLI_OPTS.concurrency}`);
    log(`  Reauth all:   ${CLI_OPTS.reauthAll}`);
    log(`  Reauth list:  ${CLI_OPTS.reauthList.length ? CLI_OPTS.reauthList.join(',') : '(none)'}`);
    log(`  Skip test:    ${CLI_OPTS.skipTest}`);
    log('='.repeat(60));
    log('');

    if (pending.length === 0) {
        log('No members to process. Exiting.', 'SUCCESS');
        return;
    }

    // Launch workers
    const workers = _workers = [];
    for (let w = 0; w < Math.min(CLI_OPTS.concurrency, pending.length); w++) {
        try {
            const chrome = await launchRealChrome(chromePath, w);
            workers.push({ id: w, ...chrome });
            if (w < CLI_OPTS.concurrency - 1) await sleep(rand(2000, 3000));
        } catch (e) {
            log(`Worker${w} launch failed: ${e.message}`, 'ERROR');
        }
    }
    if (workers.length === 0) {
        console.error('All Chrome instances failed to start');
        process.exit(1);
    }

    let idx = 0;
    const stats = { created: 0, updated: 0, skipped: 0, failed: 0 };

    async function workerFn(worker) {
        const wlog = createWorkerLogger(worker.id);
        while (true) {
            const myIdx = idx++;
            if (myIdx >= pending.length) break;
            const { member, host } = pending[myIdx];

            try {
                const alive = await isChromeAlive(worker);
                if (!alive) await restartChrome(chromePath, worker);

                const result = await Promise.race([
                    processMember({
                        member, host, client,
                        browser: worker.browser,
                        workerId: worker.id,
                        opts: CLI_OPTS,
                    }),
                    new Promise((_, rej) => setTimeout(
                        () => rej(new Error(`sub2api_hard_timeout: exceeded ${HARD_TIMEOUT_MS / 1000}s`)),
                        HARD_TIMEOUT_MS
                    )),
                ]);

                if (result.status === 'created') stats.created++;
                else if (result.status === 'updated') stats.updated++;
                else if (result.status === 'skipped') stats.skipped++;
            } catch (e) {
                wlog.error(`processMember failed [${member.email}]: ${e.message}`);
                stats.failed++;
                await addFailedRecord({
                    stage: 3,
                    memberEmail: member.email,
                    hostEmail: host.email,
                    reason: e.message,
                });
                if (/hard_timeout|Protocol error|Session closed|Target closed/i.test(e.message || '')) {
                    wlog.warn('  Restarting Chrome after hard failure...');
                    try { await restartChrome(chromePath, worker); } catch (re) {
                        wlog.error(`  Chrome restart failed: ${re.message}`);
                    }
                }
            }

            await sleep(rand(1000, 2000));
        }
    }

    await Promise.all(workers.map(w => workerFn(w)));
    cleanupWorkers(workers);

    log('');
    log('='.repeat(60));
    log('  Stage 3 Complete', 'SUCCESS');
    log(`  Created: ${stats.created}  Updated: ${stats.updated}  Skipped: ${stats.skipped}  Failed: ${stats.failed}`);
    log('='.repeat(60));
    log('');
}

// Invoke main when this file is run directly (not when imported by the test file).
if (require.main === module) {
    main().catch(e => {
        log(`Fatal: ${e.message}`, 'ERROR');
        if (e.stack) console.error(e.stack);
        process.exit(1);
    });
}
```

- [ ] **Step 2: Re-run helper tests to ensure `require('./3_sub2api')` still works**

Run: `cd src && npm run test:stage3`
Expected: All helper tests still pass. `main()` does not run because of the `require.main === module` guard.

- [ ] **Step 3: Sanity run — with no pending work**

Temporarily create a blank members.txt to make sure main starts cleanly and exits:

```bash
# from repo root
mv members.txt members.txt.__bak && echo "# empty" > members.txt
node src/3_sub2api.js -c 1 --skip-test
mv members.txt.__bak members.txt
```
Expected: Stage 3 banner prints, "No members to process. Exiting." appears, exit code 0. (Only works if `sub2api.txt` is already in the new key=value format AND has a valid api_key — if not, you'll see a clear config error; restore `members.txt` and continue to Task 6 regardless.)

- [ ] **Step 4: Commit**

```bash
git add src/3_sub2api.js
git commit -m "feat(stage3): main() worker pool, SIGINT, runnable script

node src/3_sub2api.js is now a working command. Worker model mirrors
2_accept.js: independent Chrome profiles, per-worker queue pull,
hard-timeout + Chrome restart on protocol errors."
```

---

## Task 6: Remove legacy 5_sub2api.js

**Files:**
- Delete: `src/5_sub2api.js`

- [ ] **Step 1: Confirm no references**

Run: `grep -rn "5_sub2api" . --include='*.js' --include='*.sh' --include='*.md' 2>/dev/null | grep -v node_modules | grep -v docs/superpowers/`

Expected: no output (the spec and plan themselves don't match because of the `docs/superpowers/` filter).

- [ ] **Step 2: Delete the file and commit**

```bash
git rm src/5_sub2api.js
git commit -m "chore(stage3): remove legacy 5_sub2api.js

Superseded by src/3_sub2api.js (REST API + request-intercept OAuth).
See docs/superpowers/specs/2026-04-09-stage3-sub2api-design.md."
```

---

## Task 7: Untrack sub2api.txt and add to .gitignore

`sub2api.txt` is currently committed (it contains credentials — see `git log sub2api.txt`). We stop tracking it, add it to `.gitignore`, and the user will rewrite it locally in Task 8.

⚠️ **Security note to mention in the commit message:** the old credentials in git history are still retrievable. The user should consider rotating them.

**Files:**
- Modify: `.gitignore`
- Untrack: `sub2api.txt`

- [ ] **Step 1: Add `sub2api.txt` to .gitignore**

Edit `.gitignore`. In the "Sensitive files" section (where `hosts.txt` and `members.txt` already live), append:

```
sub2api.txt
```

The section should now look like:
```
# Sensitive files
src/.env
hosts.txt
members.txt
sub2api.txt
```

- [ ] **Step 2: Remove from git index (keep file on disk)**

```bash
git rm --cached sub2api.txt
```
Expected: `rm 'sub2api.txt'`. The file on disk is preserved (still in old format).

- [ ] **Step 3: Commit**

```bash
git add .gitignore
git commit -m "chore: untrack sub2api.txt and add to .gitignore

sub2api.txt will be rewritten to the new key=value format
(url=... / api_key=...) for stage 3. The previously committed
credentials should be rotated on the sub2api side — the old file
content remains in git history."
```

---

## Task 8: Rewrite sub2api.txt to new format (user action, not committed)

This file is now untracked. The user rewrites it locally.

- [ ] **Step 1: Replace contents of `sub2api.txt`**

Edit (or fully overwrite) `sub2api.txt` at repo root with:

```
url=http://104.194.91.23:3001
api_key=<PASTE_REAL_ADMIN_API_KEY_HERE>
```

Replace `<PASTE_REAL_ADMIN_API_KEY_HERE>` with the actual admin API key from sub2api. If the sub2api URL has changed, update it too.

- [ ] **Step 2: Verify gitignore is working**

Run: `git status`
Expected: `sub2api.txt` does NOT appear in the status (not in modified, not in untracked). If it appears, re-check Task 7 step 1.

- [ ] **Step 3: Run L1 smoke test (retry if skipped in Task 2)**

```bash
node -e "
const { parseSub2apiConfig, Sub2apiClient } = require('./src/3_sub2api');
const cfg = parseSub2apiConfig('./sub2api.txt');
const c = new Sub2apiClient(cfg.url, cfg.apiKey);
(async () => {
  const auth = await c.getAuthUrl();
  console.log('getAuthUrl OK:', auth.sessionId, auth.authUrl.slice(0, 60) + '...');
  const miss = await c.findAccountByName('__definitely_not_a_real_name__');
  console.log('findAccountByName(missing) OK:', miss);
})().catch(e => { console.error('FAIL', e); process.exit(1); });
"
```
Expected: both lines print successfully, no account is created.

(No commit — sub2api.txt is now untracked.)

---

## Task 9: Wire stage 3 into run_pipeline.sh

**Files:**
- Modify: `run_pipeline.sh`

- [ ] **Step 1: Add the `3)` case in `run_stage()`**

Edit `run_pipeline.sh`. Locate the `run_stage()` function (around line 76). Replace the case block:

```bash
run_stage() {
    case "$1" in
        1)
            echo " ---- Stage 1: Send Family Invitations ----"
            node 1_invite.js "${EXTRA_ARGS[@]}"
            ;;
        2)
            echo " ---- Stage 2: Accept Family Invitations ----"
            node 2_accept.js "${EXTRA_ARGS[@]}"
            ;;
        *)
            echo " WARNING: unknown stage '$1'"
            return 1
            ;;
    esac
}
```

with:

```bash
run_stage() {
    case "$1" in
        1)
            echo " ---- Stage 1: Send Family Invitations ----"
            node 1_invite.js "${EXTRA_ARGS[@]}"
            ;;
        2)
            echo " ---- Stage 2: Accept Family Invitations ----"
            node 2_accept.js "${EXTRA_ARGS[@]}"
            ;;
        3)
            echo " ---- Stage 3: Register Accounts in sub2api ----"
            node 3_sub2api.js "${EXTRA_ARGS[@]}"
            ;;
        *)
            echo " WARNING: unknown stage '$1'"
            return 1
            ;;
    esac
}
```

**Do NOT** add stage 3 to the "run all" branch. The default `./run_pipeline.sh` (no args) must keep running only stages 1 and 2. Verify by reading the block below `if [[ "$RUN_ALL" == "1" ]]; then` — it should still only call `run_stage 1` and `run_stage 2`.

- [ ] **Step 2: Smoke — show help / list stages**

Run: `./run_pipeline.sh --stage 3 --help 2>&1 | head -20`
Expected: the banner prints, "Stage 3: Register Accounts in sub2api" line shows, then `node 3_sub2api.js --help` is invoked (which will print the stage-3 header and immediately exit because `--help` is not a flag we handle — that's fine, we just want to confirm the dispatch works).

Alternatively, to just confirm routing without starting Chrome:
```bash
bash -n run_pipeline.sh  # syntax check only
```
Expected: no output, exit 0.

- [ ] **Step 3: Commit**

```bash
git add run_pipeline.sh
git commit -m "feat(pipeline): wire stage 3 into run_pipeline.sh

--stage 3 now dispatches to node 3_sub2api.js. Default (no --stage)
still runs only stages 1 and 2 — stage 3 is opt-in because it needs
sub2api config and may trigger Google login rate limits."
```

---

## Task 10: Manual smoke tests L2–L6

No automation — these are the end-to-end validations from the spec §11.2. Run them in order and stop at the first failure. Each test assumes `sub2api.txt` is valid and `members.txt` / `hosts.txt` have the test accounts you're willing to touch.

⚠️ **Use test/small-scale accounts**, not production.

- [ ] **L2: Single-member end-to-end create**

Setup: `hosts.txt` has 1 host, `members.txt` has 1 member (that does NOT already exist on sub2api by this name).

```bash
PAUSE_AT=before-oauth ./run_pipeline.sh --stage 3 --skip-test -c 1
```
Expected:
- Banner prints, pending=1, concurrency=1
- Worker logs in to Google as the member
- Pause prompt appears: `[pause:before-oauth] 已暂停...`
- Eyeball the Chrome window: confirm Google consent page is for the correct member email
- Press Enter
- `OAuth code captured (N chars)` → `exchangeCode` → `create done: id=<N>`
- Stage 3 complete: Created=1, Updated=0, Skipped=0, Failed=0
- Verify in sub2api admin UI / API: account `ultra_<hostLocal>_<memberLocal>` exists with `status=active`

- [ ] **L3: Idempotent re-run**

Same setup as L2, run again WITHOUT `PAUSE_AT`:

```bash
./run_pipeline.sh --stage 3 --skip-test -c 1
```
Expected:
- `[skip] already active (id=<N>)`
- Stage 3 complete: Created=0, Updated=0, Skipped=1, Failed=0
- No OAuth, no browser consent page navigation (log has no `captureOAuthCode` step)

- [ ] **L4: Forced re-auth**

```bash
./run_pipeline.sh --stage 3 --skip-test -c 1 --reauth-all
```
Expected:
- `forced re-auth requested (id=<N>)`
- Full OAuth flow runs again (login, consent, code capture, exchange)
- `updateAccountCredentials` (not createAccount) is called
- Stage 3 complete: Created=0, Updated=1, Skipped=0, Failed=0
- In sub2api: same `id`, but `updated_at` timestamp is now newer

- [ ] **L5: Concurrency + test enabled**

Setup: `members.txt` has 3-5 members (mix of new and already-active).

```bash
./run_pipeline.sh --stage 3 -c 2
```
(no `--skip-test`, so the `/test` endpoint is called after create/update)

Expected:
- 2 workers launch
- Already-active members are skipped
- New members go through full flow, each gets `test passed (id=<N>)` at the end
- Stats line sums correctly: Created + Updated + Skipped + Failed == total pending
- No port-binding errors (request interception doesn't touch 8085)

- [ ] **L6: Fault injection — bad api_key**

Temporarily corrupt `sub2api.txt`:
```bash
cp sub2api.txt sub2api.txt.__bak
sed -i 's/^api_key=.*/api_key=OBVIOUSLY_WRONG/' sub2api.txt
./run_pipeline.sh --stage 3 -c 1 --skip-test || echo "(expected non-zero exit)"
cp sub2api.txt.__bak sub2api.txt && rm sub2api.txt.__bak
```
Expected:
- Stage starts, prints banner
- First `getAuthUrl` or `findAccountByName` returns Sub2apiError with httpStatus=401 (or similar)
- That member fails, written to `failed.json`
- **Importantly:** startup does NOT fail before launching Chrome — the auth is checked per-request, not at startup. So 1 Chrome is launched, fails, cleaned up.
- Stage 3 complete: Failed=1

- [ ] **L6b: Fault injection — bad member password**

Pick one member in `members.txt` and change its password to a wrong value. Re-run `./run_pipeline.sh --stage 3 -c 1 --skip-test`.

Expected:
- That member's `googleLogin` fails, screenshot `sub2api_login_failed_<email>.png` saved
- Other members still succeed
- `failed.json` has a record for the bad member with `stage: 3`

Restore the password after the test.

- [ ] **Post-L6: Clean `failed.json` before next real run**

If the fault-injection tests left entries in `failed.json` that don't reflect real failures, delete them (or truncate the file) before the next real run.

---

## Self-Review Checklist (run this after completing all tasks)

- [ ] `cd src && npm run test:stage3` — all helper tests pass
- [ ] `grep -rn "5_sub2api" . --include='*.js' --include='*.sh' 2>/dev/null | grep -v node_modules` — no matches
- [ ] `git ls-files | grep sub2api.txt` — no output (untracked)
- [ ] `git status` — clean (no leftover debris)
- [ ] `bash -n run_pipeline.sh` — syntax OK
- [ ] Default pipeline still works: `./run_pipeline.sh --stage 1` shows stage 1 banner (no regression)
- [ ] Spec §12 "Work Checklist" items all have corresponding completed tasks above
