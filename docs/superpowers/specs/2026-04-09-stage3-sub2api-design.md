# Stage 3: sub2api Account Registration — Design

- **Date**: 2026-04-09
- **Scope**: Add a new pipeline stage that registers each `members.txt` account into sub2api via the admin REST API, using a browser-driven OAuth flow only to obtain the authorization `code`.
- **Replaces**: `src/5_sub2api.js` (legacy UI-automation flow is deleted).

## 1. Goals & Non-Goals

### Goals
- For every member in `members.txt`, create a sub2api antigravity OAuth account named `ultra_<hostLocal>_<memberLocal>`.
- Be idempotent: re-running the script should skip accounts that already exist and are healthy.
- Auto-heal: accounts that exist but are not `active` are silently re-authorized (tokens updated in place).
- Support targeted manual re-authorization via CLI flags.
- Integrate as an explicit `--stage 3` in `run_pipeline.sh`.

### Non-Goals
- No dependency on `state.json` — stage 3 processes the full `members.txt` on every run.
- No local HTTP server on port 8085 — callback interception happens inside Chrome.
- No new test framework introduced. Minimal unit tests via Node built-in `node:test`.
- Does not run automatically when `./run_pipeline.sh` is invoked without `--stage`.

## 2. Inputs & Outputs

### Inputs
- `sub2api.txt` **(new format)**, at repo root:
  ```
  url=http://104.194.91.23:3001
  api_key=<admin-api-key>
  ```
  Lines starting with `#` and blank lines are ignored. BOM-tolerant.
- `hosts.txt` — existing format, parsed by `common/state.js::parseAccounts`.
- `members.txt` — existing format, parsed by `common/state.js::parseAccounts`.

### Outputs
- Side effects on sub2api: create or PUT-update accounts.
- `failed.json` — appended with `{ stage: 3, memberEmail, reason, time }` on per-member failures.
- `sub2api_*.png` debug screenshots on browser-side failures (same directory convention as stage 1/2).
- No write to `state.json`.

### CLI
```
node src/3_sub2api.js [-c N] [--reauth-all] [--reauth=email1,email2]
                     [--skip-test] [--verbose]
```

Pipeline entry:
```
./run_pipeline.sh --stage 3
# with manual intervention:
PAUSE_AT=before-oauth ./run_pipeline.sh --stage 3
```
`./run_pipeline.sh` with no `--stage` keeps the current behavior (stages 1+2 only).

## 3. Account Naming

```
name = "ultra_" + localPart(host.email) + "_" + localPart(member.email)
```
where `localPart(x) = x.split('@')[0]` (case-preserved, no further transformation).

Example: host `BrinaSzreder470@gmail.com` + member `chauanh2083@gmail.com` → `ultra_BrinaSzreder470_chauanh2083`.

Rationale: keeps the name short and free of `@`/`.` escaping concerns. The full member email is still recoverable from `credentials.email` on the sub2api side.

## 4. Idempotency & Re-authorization Decision Tree

For each member:

```
existing = findAccountByName(name)
         │
         ├── null ────────────────────► mode = 'create'
         │
         └── found
              ├── forceReauth(member)? ─► mode = 'reauth'
              │     (--reauth-all, or email ∈ --reauth list)
              │
              ├── status === 'active' ─► SKIP
              │
              └── status ≠ 'active' ──► mode = 'reauth'
                  (auto-heal: error / expired / disabled / unused)
```

- `create` path: auth-url → OAuth → exchange-code → `POST /accounts` → (optional) `/test`.
- `reauth` path: auth-url → OAuth → exchange-code → `PUT /accounts/{id}` (credentials only) → (optional) `/test`. Account ID is preserved.

## 5. Architecture & Components

All code lives in a single file `src/3_sub2api.js`, split into these internal units:

### 5.1 `Sub2apiClient` — thin REST wrapper
Uses Node built-in `fetch`. No new dependencies.

```js
class Sub2apiClient {
  constructor(baseUrl, apiKey)
  async getAuthUrl()                              // → { sessionId, state, authUrl }
  async exchangeCode({ sessionId, state, code })  // → { access_token, refresh_token, expires_at:int64, email, project_id, token_type }
  async findAccountByName(name)                   // → account | null  (server search is substring; client does exact match)
  async createAccount({ name, credentials })      // → account
  async updateAccountCredentials(id, credentials) // → account  (PUT /accounts/{id})
  async testAccount(id)                           // → boolean   (consumes SSE, returns true if no error events)
}
```

Errors: throws `Sub2apiError(endpoint, httpStatus, code, message)`.

### 5.2 `captureOAuthCode(page, authUrl, wlog)` — puppeteer interceptor
Pure utility. Input: a logged-in puppeteer `page` and an `authUrl`. Output: OAuth `code` string.

Flow:
1. `await page.setRequestInterception(true)`
2. Handler on `page.on('request', req => ...)`:
   - If `req.url().startsWith('http://localhost:8085/callback')` → parse `code` (or `error`) from URL, resolve the outer promise, then `req.abort()` so Chrome does not actually attempt the TCP connection.
   - Else → `req.continue()`.
3. `await page.goto(authUrl)`.
4. Wait on the promise with a 60s timeout.
5. **`finally`**: remove listener, `await page.setRequestInterception(false)`.

Errors: rejects on timeout or on `error=` parameter in callback URL.

### 5.3 `processMember(member, host, client, browser, opts, wlog)` — per-member orchestration
Implements the decision tree in §4. Invokes `googleLogin` (from `common/google-login.js`) and `captureOAuthCode`, then the appropriate `Sub2apiClient` calls. Returns one of:
- `{ status: 'created', accountId, mode: 'create' }`
- `{ status: 'updated', accountId, mode: 'reauth' }`
- `{ status: 'skipped', accountId, reason: 'active' }`

Throws on failure; caller logs + writes `failed.json`.

Includes **`maybePause('before-oauth', wlog)`** after successful Google login, before `captureOAuthCode` starts navigating to the consent page.

### 5.4 `main()` — worker pool & stats
Mirrors `2_accept.js::main`:
- Parse `sub2api.txt`, `hosts.txt`, `members.txt`.
- Build a flat pending list of `{ member, host }` pairs. Pairing rule: member index `i` → host index `floor(i / 5)` (same 5-members-per-host convention as stage 1's `buildGroups`). Members beyond `5 * hosts.length` are dropped with a warning.
- Launch `min(concurrency, pending.length)` Chrome workers with independent profiles (`chrome_data_temp_pipeline_<id>`).
- Each worker loops, pulling from pending, calling `processMember`, incrementing `stats.ok/skipped/ng`, handling errors.
- Hard timeout per member: `SUB2API_HARD_TIMEOUT_MS` (default 300000) via `Promise.race`.
- SIGINT handler cleans up workers (same pattern as stage 2).

### 5.5 Helpers
```js
function accountName(hostEmail, memberEmail)
function parseSub2apiConfig(filePath)           // → { url, apiKey }
function shouldForceReauth(memberEmail, opts)   // checks --reauth-all / --reauth
```

## 6. Data Flow (happy path, single member)

```
members.txt ──┐
hosts.txt   ──┤ main pairs (member, host)
              ▼
       processMember
              │
   name = ultra_<hL>_<mL>
              │
   client.findAccountByName(name) → null (new)
              │
   client.getAuthUrl() → {sessionId, state, authUrl}
              │
   newPage(browser) → googleLogin(member)   [common/google-login.js]
              │
   maybePause('before-oauth')                [optional manual intervention]
              │
   captureOAuthCode(page, authUrl)
     ├─ setRequestInterception(true)
     ├─ listener on localhost:8085/callback
     ├─ page.goto(authUrl) → Google consent
     ├─ Chrome navigates to localhost:8085/callback?code=...
     ├─ listener aborts + extracts code
     └─ cleanup
              │
   client.exchangeCode({sessionId, state, code}) → tokens (expires_at:int64)
              │
   credentials = { ...tokens, expires_at: String(expires_at) }
              │
   mode==='create' ? createAccount : updateAccountCredentials(id)
              │
   !skipTest && client.testAccount(id)       [warn on failure, non-fatal]
              │
   stats.ok++, page.close()
```

## 7. Error Handling Matrix

| Failure | Handling |
|---|---|
| `sub2api.txt` missing or malformed | `main` throws at startup — whole stage exits before any browser launches |
| `Sub2apiClient` HTTP non-2xx | `Sub2apiError` → per-member failure, continue queue |
| `getAuthUrl` failure | per-member failure |
| `googleLogin` failure (password / 2FA / captcha) | per-member failure; screenshot `sub2api_login_failed_<email>.png` |
| `captureOAuthCode` 60s timeout | per-member failure; screenshot `sub2api_oauth_timeout_<email>.png` |
| `captureOAuthCode` got `error=` param | per-member failure; reason = `oauth_denied:<error>` |
| `exchangeCode` failure (session TTL, code reuse) | per-member failure |
| `createAccount` name collision (race) | fallback: `findAccountByName` + `updateAccountCredentials` |
| `testAccount` failure | **non-fatal**, warn only; member still counted as success |
| Puppeteer `Protocol error` / `Session closed` / `Target closed` | restart the worker's Chrome (stage 2 pattern), current member counted as failure |
| Hard timeout (>5 min per member) | `Promise.race` rejects, restart Chrome, member failed |
| SIGINT | cleanup workers, exit |

## 8. Key Implementation Notes

1. **`expires_at` type coercion**: `exchange-code` returns `int64`; `createAccount` / `updateAccountCredentials` expect a **string**. Always convert with `String(tokens.expires_at)`. Dedicated unit test covers this transformation.

2. **Session TTL (30 min)**: `getAuthUrl → exchangeCode` must complete within 30 minutes. After `maybePause('before-oauth')`, `processMember` records the time elapsed since `getAuthUrl` and aborts with a clear error if `>25 min` (safety margin), so the user can simply re-run.

3. **Request-interception lifecycle**: `captureOAuthCode` MUST disable interception in `finally`. Leaving it on stalls any subsequent `page.goto` on the same page.

4. **Substring search on `/accounts?search=`**: server-side `search` is substring. `findAccountByName` fetches results and applies `r.name === targetName` client-side. Pagination: the first page (default `page_size`) is sufficient for our naming scheme — a collision on the same prefix is rare; if `total > page_size` we log a warning and iterate pages.

5. **Chrome profile reuse**: each worker uses `chrome_data_temp_pipeline_<workerId>`, independent of stage 2 execution order. `processMember` calls `googleLogin` unconditionally — if already logged in, it short-circuits.

6. **Concurrency & port 8085**: interception never binds a real listener, so concurrent workers do not collide.

7. **`sub2api.txt` must not be committed**. This file contains the admin API key. **Must be added to `.gitignore`** as part of this change (currently only `hosts.txt` and `members.txt` are listed).

## 9. Configuration & Flags

| Flag | Default | Effect |
|---|---|---|
| `-c N` / `--concurrency N` | `1` | Number of Chrome workers |
| `--reauth-all` | off | Force re-auth even for `active` accounts |
| `--reauth=a@x.com,b@y.com` | empty | Force re-auth for listed members only |
| `--skip-test` | off | Do not call `POST /accounts/{id}/test` |
| `--verbose` / `-v` | off | Debug logging |
| `PAUSE_AT=before-oauth` (env) | off | Halt before opening the consent URL |
| `CONCURRENCY=N` (env) | — | Same as `-c N` |
| `SUB2API_HARD_TIMEOUT_MS` (env) | `300000` | Per-member hard timeout |

## 10. Pipeline Integration

`run_pipeline.sh`:
- Add a `3)` case in `run_stage` that executes `node 3_sub2api.js "${EXTRA_ARGS[@]}"`.
- Do **not** add stage 3 to the default "run all" branch — it must be explicitly requested with `--stage 3`.
- Update header banner to mention "3-stage optional" (minor cosmetic).

## 11. Testing Strategy

### 11.1 Unit tests (Node built-in `node:test`)

New file: `src/3_sub2api.test.js`.

Covers:
- `accountName(host, member)` — canonical case, mixed case preserved, `local.part+tag` and `foo.bar` local parts.
- `parseSub2apiConfig(file)` — well-formed, missing `url`, missing `api_key`, comment lines, blank lines, BOM, CRLF, extra `=` in value.
- `shouldForceReauth(email, opts)` — `--reauth-all`, list match, no match, empty list.

Run via:
```
npm run test:stage3     # new script in package.json
# or
node --test src/3_sub2api.test.js
```

No new dependencies.

### 11.2 Manual smoke tests

| Level | Scope | Input | Expected |
|---|---|---|---|
| L1 | API client reachability | ad-hoc `node -e` calling `getAuthUrl` / `findAccountByName('___missing___')` | no account created, 0 errors |
| L2 | Single-member E2E create | 1 host, 1 member, `PAUSE_AT=before-oauth -c 1 --skip-test` | consent page on correct email, account appears in sub2api |
| L3 | Idempotent re-run | re-run L2 unchanged | log `skipped (active)`, no OAuth |
| L4 | Forced re-auth | re-run with `--reauth-all` | same account id, `updated_at` changed |
| L5 | Concurrency + test | 3-5 members, `-c 2` (no `--skip-test`) | correct stats, test SSE success |
| L6 | Fault injection | bad `api_key`; bad member password | L6a: fail at startup, no browser; L6b: only that member fails, others succeed, failed.json has entry |

### 11.3 Not automated

- `captureOAuthCode` — requires live Google consent page; covered by L2.
- `Sub2apiClient` endpoints — require live sub2api; covered by L1/L2.
- `processMember` full paths — covered by L2/L3/L4.
- `googleLogin` — reused unchanged from stage 1/2 battle-tested code.

## 12. Work Checklist

- [ ] Delete `src/5_sub2api.js`.
- [ ] Create `src/3_sub2api.js` per §5.
- [ ] Create `src/3_sub2api.test.js` per §11.1.
- [ ] Add `test:stage3` script to `package.json`.
- [ ] Rewrite `sub2api.txt` to the new `key=value` format; document the schema in a comment.
- [ ] Add `sub2api.txt` to `.gitignore`.
- [ ] Update `run_pipeline.sh` per §10.
- [ ] Smoke tests L1–L6.
