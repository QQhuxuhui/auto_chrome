# stealth-chrome-mcp Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `auto_chrome/common/` 里的"原子能力"（Chrome 启动、Google 登录、OAuth、SMS、TOTP）封装成独立的 `stealth-chrome-mcp` MCP server，供 Claude Code / Hermes agent 消费；配套 skill 把现有 stage 3 流程重写为调用 MCP 的业务 playbook。

**Architecture:** stdio MCP server（Node + `@modelcontextprotocol/sdk`）内部驻留 Session Registry（最多 5 个并发 Chrome session），通过 `require` 复用 `auto_chrome/common/*` 模块（需小重构以支持参数注入）。业务流程作为独立 skill 放 `/usr/src/workspace/github/QQhuxuhui/my-skills` repo，仅组合 MCP tool，不重复实现状态机。

**Tech Stack:** Node.js ≥18（本机 22），`@modelcontextprotocol/sdk`、`puppeteer-core` ^24.2.1（与 auto_chrome 锁定同版本）、`undici`（已装，用于代理 fetch）、Node 内置 `node:test` 做集成测试。

**Spec reference:** `docs/superpowers/specs/2026-04-18-stealth-chrome-mcp-design.md`

---

## 文件结构

### 新增文件
```
auto_chrome/mcp-server/
├── package.json                    # 独立的子 package
├── bin/server.js                   # stdio 入口 (shebang)
├── src/
│   ├── server.js                   # MCP server 初始化 + tool 注册
│   ├── sessions.js                 # SessionRegistry + per-session mutex
│   ├── config.js                   # env 读取 + 默认值
│   ├── logger.js                   # stderr 日志（stdout 保留给 JSON-RPC）
│   ├── errors.js                   # 14 个错误码常量
│   ├── tools/
│   │   ├── chrome.js               # launch / connect / close / list / clear_google_cookies / evaluate
│   │   ├── google.js               # login / oauth_get_code
│   │   ├── oauth.js                # exchange_code
│   │   ├── sms.js                  # get_phone / wait_code / cancel
│   │   └── totp.js                 # generate
│   └── providers/sms/
│       ├── index.js                # SmsProvider interface + registry
│       └── hero-sms.js             # 现有 common/sms.js 搬过来
└── test/
    ├── smoke.test.js               # 集成 smoke（真账号）
    └── fixtures/test-account.example.json
```

```
auto_chrome/common/
└── oauth.js                        # 新增：从 3_local_oauth.js 抽出 OAuth helpers
```

```
/usr/src/workspace/github/QQhuxuhui/my-skills/    # 独立 repo
├── google-login-playbook/SKILL.md
├── oauth-token-harvest/SKILL.md
└── google-oauth-validate/SKILL.md
```

### 修改文件
- `auto_chrome/common/chrome.js` — `launchRealChrome` 改造为接受 `{dataDir, extraArgs, lang, viewport}` 参数
- `auto_chrome/common/google-login.js` — `googleLogin` 改造为接受 `{smsProvider}` 依赖注入
- `auto_chrome/common/sms.js` — 保留（变成 hero-sms provider 的实现文件，由 `mcp-server/src/providers/sms/hero-sms.js` require 它）
- `auto_chrome/src/3_local_oauth.js` — 抽出 `startCbServer`/`buildAuthUrl`/`obtainAuthCode`/`exchangeCode` 到 `common/oauth.js`（后续 stage 3 skill 化后整个文件会删，本 plan 只抽不删）
- `/root/.claude.json` — mcpServers 加入 `stealth-chrome-mcp` 条目

---

## M0 — MCP 核心骨架

目标：3 个账户用 `google.login` 能登进去，`chrome.launch`/`close` 正常，MCP 在 Claude Code 里可调。

### Task 1: 初始化 mcp-server 子 package

**Files:**
- Create: `auto_chrome/mcp-server/package.json`
- Create: `auto_chrome/mcp-server/.gitignore`

- [ ] **Step 1: Create directory and package.json**

```bash
mkdir -p /usr/src/workspace/github/QQhuxuhui/auto_chrome/mcp-server
cd /usr/src/workspace/github/QQhuxuhui/auto_chrome/mcp-server
```

Write `package.json`:

```json
{
  "name": "stealth-chrome-mcp",
  "version": "0.1.0",
  "private": true,
  "description": "Atomic browser + Google login tools as an MCP server for auto_chrome",
  "type": "commonjs",
  "bin": { "stealth-chrome-mcp": "./bin/server.js" },
  "main": "src/server.js",
  "scripts": {
    "start": "node bin/server.js",
    "test": "node --test test/"
  },
  "engines": { "node": ">=18" },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.0.0",
    "puppeteer-core": "^24.2.1",
    "undici": "^7.25.0"
  }
}
```

Write `.gitignore`:

```
node_modules/
*.log
test/fixtures/test-account.json
```

- [ ] **Step 2: Install deps**

```bash
cd /usr/src/workspace/github/QQhuxuhui/auto_chrome/mcp-server && npm install --no-fund --no-audit
```

Expected: `added N packages in Xs` with no errors.

- [ ] **Step 3: Commit**

```bash
cd /usr/src/workspace/github/QQhuxuhui/auto_chrome
git add mcp-server/package.json mcp-server/package-lock.json mcp-server/.gitignore
git commit -m "chore(mcp): scaffold stealth-chrome-mcp sub-package"
```

---

### Task 2: Implement config.js (env reader)

**Files:**
- Create: `auto_chrome/mcp-server/src/config.js`
- Create: `auto_chrome/mcp-server/test/config.test.js`

- [ ] **Step 1: Write the failing test**

Write `test/config.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert/strict');

test('config reads env with defaults', () => {
    const oldEnv = { ...process.env };
    try {
        delete process.env.MAX_SESSIONS;
        delete process.env.CHROME_DATA_ROOT;
        delete process.env.CLIENT_ID;
        const { loadConfig } = require('../src/config');
        const cfg = loadConfig();
        assert.equal(cfg.maxSessions, 5);
        assert.equal(cfg.chromeDataRoot, '/tmp/stealth-chrome-mcp');
        assert.equal(cfg.clientId, null);
    } finally {
        process.env = oldEnv;
    }
});

test('MAX_SESSIONS env overrides default', () => {
    process.env.MAX_SESSIONS = '3';
    delete require.cache[require.resolve('../src/config')];
    const { loadConfig } = require('../src/config');
    assert.equal(loadConfig().maxSessions, 3);
    delete process.env.MAX_SESSIONS;
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd auto_chrome/mcp-server && node --test test/config.test.js
```

Expected: FAIL with `Cannot find module '../src/config'`.

- [ ] **Step 3: Implement config.js**

Write `src/config.js`:

```js
'use strict';

function parseIntOr(value, fallback) {
    const n = parseInt(value, 10);
    return Number.isFinite(n) && n >= 1 ? n : fallback;
}

function loadConfig(env = process.env) {
    return {
        chromePath: env.CHROME_PATH || null,
        httpsProxy: env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy || null,
        clientId: env.CLIENT_ID || null,
        clientSecret: env.CLIENT_SECRET || null,
        smsProvider: env.SMS_PROVIDER || 'hero-sms',
        heroSmsApiKey: env.HERO_SMS_API_KEY || null,
        maxSessions: parseIntOr(env.MAX_SESSIONS, 5),
        chromeDataRoot: env.CHROME_DATA_ROOT || '/tmp/stealth-chrome-mcp',
        keepBrowserOpen: (env.KEEP_BROWSER_OPEN || '').toLowerCase() === 'true',
        logLevel: env.LOG_LEVEL || 'info',
        logFile: env.LOG_FILE || null,
        basePort: parseIntOr(env.BASE_PORT, 9234),
    };
}

module.exports = { loadConfig };
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd auto_chrome/mcp-server && node --test test/config.test.js
```

Expected: `# pass 2  # fail 0`.

- [ ] **Step 5: Commit**

```bash
cd auto_chrome && git add mcp-server/src/config.js mcp-server/test/config.test.js && git commit -m "feat(mcp): add config loader with env + defaults"
```

---

### Task 3: Implement logger.js (stderr only)

**Files:**
- Create: `auto_chrome/mcp-server/src/logger.js`
- Create: `auto_chrome/mcp-server/test/logger.test.js`

- [ ] **Step 1: Write the failing test**

Write `test/logger.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const { createLogger } = require('../src/logger');

test('logger writes to stderr, never stdout', (t) => {
    const stderrChunks = [];
    const stdoutChunks = [];
    const origErr = process.stderr.write;
    const origOut = process.stdout.write;
    process.stderr.write = (s) => { stderrChunks.push(String(s)); return true; };
    process.stdout.write = (s) => { stdoutChunks.push(String(s)); return true; };
    try {
        const log = createLogger('info');
        log.info('hello');
        log.debug('should-not-appear'); // level=info, debug suppressed
        log.error('boom');
    } finally {
        process.stderr.write = origErr;
        process.stdout.write = origOut;
    }
    assert.equal(stdoutChunks.length, 0, 'stdout must stay clean for JSON-RPC');
    const joined = stderrChunks.join('');
    assert.ok(joined.includes('hello'));
    assert.ok(joined.includes('boom'));
    assert.ok(!joined.includes('should-not-appear'));
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd auto_chrome/mcp-server && node --test test/logger.test.js
```

Expected: FAIL with `Cannot find module '../src/logger'`.

- [ ] **Step 3: Implement logger.js**

Write `src/logger.js`:

```js
'use strict';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

function createLogger(level = 'info', { prefix = '' } = {}) {
    const threshold = LEVELS[level] || LEVELS.info;
    function write(lvl, args) {
        if (LEVELS[lvl] < threshold) return;
        const ts = new Date().toISOString();
        const tag = `[${ts}][${lvl.toUpperCase()}]${prefix ? ' ' + prefix : ''}`;
        const msg = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ');
        process.stderr.write(`${tag} ${msg}\n`);
    }
    return {
        debug: (...a) => write('debug', a),
        info: (...a) => write('info', a),
        warn: (...a) => write('warn', a),
        error: (...a) => write('error', a),
        child: (childPrefix) => createLogger(level, { prefix: `${prefix} ${childPrefix}`.trim() }),
    };
}

module.exports = { createLogger };
```

- [ ] **Step 4: Run test**

```bash
cd auto_chrome/mcp-server && node --test test/logger.test.js
```

Expected: `# pass 1`.

- [ ] **Step 5: Commit**

```bash
cd auto_chrome && git add mcp-server/src/logger.js mcp-server/test/logger.test.js && git commit -m "feat(mcp): add stderr-only logger with levels"
```

---

### Task 4: Implement errors.js (error code constants)

**Files:**
- Create: `auto_chrome/mcp-server/src/errors.js`
- Create: `auto_chrome/mcp-server/test/errors.test.js`

- [ ] **Step 1: Write the failing test**

Write `test/errors.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert/strict');

test('McpError carries code + message', () => {
    const { McpError, CODES } = require('../src/errors');
    const e = new McpError(CODES.SESSION_NOT_FOUND, 'no such session: sess_x');
    assert.equal(e.code, 'SESSION_NOT_FOUND');
    assert.equal(e.message, 'no such session: sess_x');
    assert.ok(e instanceof Error);
});

test('all 14 codes defined', () => {
    const { CODES } = require('../src/errors');
    const expected = [
        'CHROME_LAUNCH_FAILED', 'CHROME_PROTOCOL_ERROR', 'SESSION_NOT_FOUND',
        'GOOGLE_LOGIN_REJECTED', 'GOOGLE_LOGIN_STUCK', 'GOOGLE_CHALLENGE_UNSUPPORTED',
        'OAUTH_CODE_NOT_RECEIVED', 'OAUTH_TOKEN_EXCHANGE_FAILED',
        'SMS_BALANCE_INSUFFICIENT', 'SMS_TIMEOUT', 'SMS_PROVIDER_ERROR',
        'TOTP_INVALID_SECRET', 'CONCURRENCY_LIMIT_EXCEEDED',
        'TIMEOUT', 'PRECONDITION_FAILED',
    ];
    for (const k of expected) assert.equal(CODES[k], k, `missing code ${k}`);
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd auto_chrome/mcp-server && node --test test/errors.test.js
```

Expected: FAIL with `Cannot find module '../src/errors'`.

- [ ] **Step 3: Implement errors.js**

Write `src/errors.js`:

```js
'use strict';

const CODES = Object.freeze({
    CHROME_LAUNCH_FAILED: 'CHROME_LAUNCH_FAILED',
    CHROME_PROTOCOL_ERROR: 'CHROME_PROTOCOL_ERROR',
    SESSION_NOT_FOUND: 'SESSION_NOT_FOUND',
    GOOGLE_LOGIN_REJECTED: 'GOOGLE_LOGIN_REJECTED',
    GOOGLE_LOGIN_STUCK: 'GOOGLE_LOGIN_STUCK',
    GOOGLE_CHALLENGE_UNSUPPORTED: 'GOOGLE_CHALLENGE_UNSUPPORTED',
    OAUTH_CODE_NOT_RECEIVED: 'OAUTH_CODE_NOT_RECEIVED',
    OAUTH_TOKEN_EXCHANGE_FAILED: 'OAUTH_TOKEN_EXCHANGE_FAILED',
    SMS_BALANCE_INSUFFICIENT: 'SMS_BALANCE_INSUFFICIENT',
    SMS_TIMEOUT: 'SMS_TIMEOUT',
    SMS_PROVIDER_ERROR: 'SMS_PROVIDER_ERROR',
    TOTP_INVALID_SECRET: 'TOTP_INVALID_SECRET',
    CONCURRENCY_LIMIT_EXCEEDED: 'CONCURRENCY_LIMIT_EXCEEDED',
    TIMEOUT: 'TIMEOUT',
    PRECONDITION_FAILED: 'PRECONDITION_FAILED',
});

class McpError extends Error {
    constructor(code, message, { cause } = {}) {
        super(message);
        this.name = 'McpError';
        this.code = code;
        if (cause) this.cause = cause;
    }
}

module.exports = { CODES, McpError };
```

- [ ] **Step 4: Run test**

```bash
cd auto_chrome/mcp-server && node --test test/errors.test.js
```

Expected: `# pass 2`.

- [ ] **Step 5: Commit**

```bash
cd auto_chrome && git add mcp-server/src/errors.js mcp-server/test/errors.test.js && git commit -m "feat(mcp): define 15 error codes + McpError class"
```

---

### Task 5: Implement sessions.js (registry + mutex + cap)

**Files:**
- Create: `auto_chrome/mcp-server/src/sessions.js`
- Create: `auto_chrome/mcp-server/test/sessions.test.js`

- [ ] **Step 1: Write the failing test**

Write `test/sessions.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const { SessionRegistry } = require('../src/sessions');
const { CODES } = require('../src/errors');

test('create/get/close happy path', () => {
    const r = new SessionRegistry({ maxSessions: 3 });
    const id = r.create({ workerId: 0, browser: {}, proc: {}, dataDir: '/tmp/x', debugPort: 9234 });
    assert.match(id, /^sess_/);
    assert.equal(r.get(id).debugPort, 9234);
    r.close(id);
    assert.throws(() => r.get(id), (e) => e.code === CODES.SESSION_NOT_FOUND);
});

test('enforces maxSessions', () => {
    const r = new SessionRegistry({ maxSessions: 2 });
    r.create({ workerId: 0, browser: {}, proc: {}, dataDir: '/tmp/a', debugPort: 9234 });
    r.create({ workerId: 1, browser: {}, proc: {}, dataDir: '/tmp/b', debugPort: 9235 });
    assert.throws(
        () => r.create({ workerId: 2, browser: {}, proc: {}, dataDir: '/tmp/c', debugPort: 9236 }),
        (e) => e.code === CODES.CONCURRENCY_LIMIT_EXCEEDED,
    );
});

test('per-session mutex serializes withLock', async () => {
    const r = new SessionRegistry({ maxSessions: 3 });
    const id = r.create({ workerId: 0, browser: {}, proc: {}, dataDir: '/tmp/x', debugPort: 9234 });
    const order = [];
    const a = r.withLock(id, async () => { order.push('a-start'); await new Promise(res => setTimeout(res, 30)); order.push('a-end'); });
    const b = r.withLock(id, async () => { order.push('b-start'); order.push('b-end'); });
    await Promise.all([a, b]);
    assert.deepEqual(order, ['a-start', 'a-end', 'b-start', 'b-end']);
});

test('list returns all active sessions', () => {
    const r = new SessionRegistry({ maxSessions: 3 });
    r.create({ workerId: 0, browser: {}, proc: {}, dataDir: '/tmp/a', debugPort: 9234, tags: { foo: 'bar' } });
    r.create({ workerId: 1, browser: {}, proc: {}, dataDir: '/tmp/b', debugPort: 9235 });
    const list = r.list();
    assert.equal(list.length, 2);
    assert.ok(list[0].sessionId);
    assert.ok(typeof list[0].createdAt === 'number');
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd auto_chrome/mcp-server && node --test test/sessions.test.js
```

Expected: FAIL with `Cannot find module '../src/sessions'`.

- [ ] **Step 3: Implement sessions.js**

Write `src/sessions.js`:

```js
'use strict';

const { randomUUID } = require('crypto');
const { McpError, CODES } = require('./errors');

class Mutex {
    constructor() { this._tail = Promise.resolve(); }
    acquire() {
        let release;
        const gate = new Promise(res => { release = res; });
        const prev = this._tail;
        this._tail = prev.then(() => gate);
        return prev.then(() => release);
    }
}

class SessionRegistry {
    constructor({ maxSessions = 5 } = {}) {
        this._sessions = new Map();  // sessionId → session
        this._mutexes = new Map();   // sessionId → Mutex
        this.maxSessions = maxSessions;
    }

    create({ workerId, browser, proc, dataDir, debugPort, tags = {} }) {
        if (this._sessions.size >= this.maxSessions) {
            throw new McpError(CODES.CONCURRENCY_LIMIT_EXCEEDED,
                `active sessions (${this._sessions.size}) >= max (${this.maxSessions})`);
        }
        const sessionId = `sess_${randomUUID().slice(0, 12)}`;
        const session = { sessionId, workerId, browser, proc, dataDir, debugPort, tags, createdAt: Date.now() };
        this._sessions.set(sessionId, session);
        this._mutexes.set(sessionId, new Mutex());
        return sessionId;
    }

    get(sessionId) {
        const s = this._sessions.get(sessionId);
        if (!s) throw new McpError(CODES.SESSION_NOT_FOUND, `no such session: ${sessionId}`);
        return s;
    }

    close(sessionId) {
        this._sessions.delete(sessionId);
        this._mutexes.delete(sessionId);
    }

    list() {
        return Array.from(this._sessions.values()).map(s => ({
            sessionId: s.sessionId, tags: s.tags, createdAt: s.createdAt, debugPort: s.debugPort,
        }));
    }

    async withLock(sessionId, fn) {
        this.get(sessionId);  // throws if not found
        const mutex = this._mutexes.get(sessionId);
        const release = await mutex.acquire();
        try { return await fn(); }
        finally { release(); }
    }

    async closeAll({ cleanup } = {}) {
        const ids = Array.from(this._sessions.keys());
        await Promise.all(ids.map(async (id) => {
            const s = this._sessions.get(id);
            if (cleanup && s) { try { await cleanup(s); } catch (_) {} }
            this.close(id);
        }));
    }
}

module.exports = { SessionRegistry, Mutex };
```

- [ ] **Step 4: Run test**

```bash
cd auto_chrome/mcp-server && node --test test/sessions.test.js
```

Expected: `# pass 4`.

- [ ] **Step 5: Commit**

```bash
cd auto_chrome && git add mcp-server/src/sessions.js mcp-server/test/sessions.test.js && git commit -m "feat(mcp): add SessionRegistry with hard cap + per-session mutex"
```

---

### Task 6: Refactor common/chrome.js to accept injection params

**Files:**
- Modify: `auto_chrome/src/common/chrome.js:79-159`
- Create: `auto_chrome/src/common/chrome.refactor.test.js`

**Context:** `launchRealChrome` currently hard-codes dataDir path (`chrome_data_temp_pipeline_${workerId}`) and args. We make it accept `{dataDir, extraArgs}` with the old behavior as defaults so existing stage 1/2/3 still work.

- [ ] **Step 1: Write failing test**

Write `src/common/chrome.refactor.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { buildChromeArgs } = require('./chrome');

test('buildChromeArgs uses provided dataDir over default', () => {
    const args = buildChromeArgs({ workerId: 0, dataDir: '/tmp/custom', debugPort: 9999 });
    assert.ok(args.some(a => a === '--user-data-dir=/tmp/custom'));
    assert.ok(args.some(a => a === '--remote-debugging-port=9999'));
});

test('buildChromeArgs merges extraArgs', () => {
    const args = buildChromeArgs({ workerId: 0, dataDir: '/tmp/x', debugPort: 9999, extraArgs: ['--proxy-server=http://x:1'] });
    assert.ok(args.includes('--proxy-server=http://x:1'));
});

test('buildChromeArgs falls back to default pipeline dataDir when not provided', () => {
    const args = buildChromeArgs({ workerId: 2, debugPort: 9236 });
    assert.ok(args.some(a => a.includes('chrome_data_temp_pipeline_2')));
});
```

- [ ] **Step 2: Run test**

```bash
cd auto_chrome/src && node --test common/chrome.refactor.test.js
```

Expected: FAIL — `buildChromeArgs` is not exported yet.

- [ ] **Step 3: Refactor common/chrome.js**

Read current `auto_chrome/src/common/chrome.js` lines 79-159 (the `launchRealChrome` function). Extract the spawn args list into a new exported function `buildChromeArgs(opts)`. Keep `launchRealChrome` API backwards-compatible by calling `buildChromeArgs` internally.

Replace lines 79-159 with:

```js
function buildChromeArgs({ workerId = 0, dataDir, debugPort, extraArgs = [], lang = 'en-US', viewport = '1280,800' }) {
    const resolvedDataDir = dataDir || path.resolve(__dirname, '..', `chrome_data_temp_pipeline_${workerId}`);
    if (!fs.existsSync(resolvedDataDir)) fs.mkdirSync(resolvedDataDir, { recursive: true });
    return [
        `--remote-debugging-port=${debugPort}`,
        `--user-data-dir=${resolvedDataDir}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-sync',
        '--disable-features=InProductHelp',
        `--lang=${lang}`,
        `--accept-lang=${lang},en`,
        `--window-size=${viewport}`,
        '--disable-gpu',
        '--disable-dev-shm-usage',
        '--disable-background-networking',
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
        '--disable-hang-monitor',
        '--disable-popup-blocking',
        '--disable-prompt-on-repost',
        '--disable-extensions',
        '--disable-component-update',
        '--disable-domain-reliability',
        '--no-sandbox',
        '--metrics-recording-only',
        ...extraArgs,
    ];
}

async function launchRealChrome(chromePath, workerId = 0, opts = {}) {
    const wlog = createWorkerLogger(workerId);
    const debugPort = opts.debugPort || (BASE_DEBUG_PORT + workerId);
    const dataDir = opts.dataDir || path.resolve(__dirname, '..', `chrome_data_temp_pipeline_${workerId}`);
    const args = buildChromeArgs({ workerId, dataDir, debugPort, extraArgs: opts.extraArgs, lang: opts.lang, viewport: opts.viewport });

    wlog.debug(`Launch Chrome: debugPort=${debugPort}, dataDir=${dataDir}`);

    const proc = spawn(chromePath, args, {
        detached: (process.env.KEEP_BROWSER_OPEN || '').toLowerCase() === 'true',
        stdio: 'ignore',
    });
    if ((process.env.KEEP_BROWSER_OPEN || '').toLowerCase() === 'true') proc.unref();

    proc.on('error', e => { wlog.error(`Chrome process error: ${e.message}`, e); });
    proc.on('exit', (code, signal) => { wlog.warn(`Chrome process exit: code=${code}, signal=${signal}`); });

    let wsUrl = null;
    for (let i = 0; i < 30; i++) {
        try {
            const r = await httpFetch(`http://localhost:${debugPort}/json/version`);
            const data = await r.json();
            wsUrl = data.webSocketDebuggerUrl;
            break;
        } catch (_) {
            if (i % 5 === 4) wlog.debug(`Waiting for Chrome... (${i + 1}/30)`);
            await sleep(1000);
        }
    }
    if (!wsUrl) { proc.kill(); throw new Error(`[W${workerId}] Chrome launch timeout (30s)`); }

    const browser = await puppeteer.connect({ browserWSEndpoint: wsUrl, defaultViewport: null, protocolTimeout: 180000 });

    try { const testPage = await browser.newPage(); await testPage.close(); }
    catch (e) { wlog.warn(`Chrome warm-up failed: ${e.message}, waiting...`); await sleep(2000); }

    wlog.info(`Chrome started (port ${debugPort}, PID ${proc.pid})`);
    return { browser, proc, dataDir, debugPort };
}
```

At the end of chrome.js, add `buildChromeArgs` to the existing `module.exports`.

- [ ] **Step 4: Run refactor test + existing integration (stage 3 smoke)**

```bash
cd auto_chrome/src && node --test common/chrome.refactor.test.js
```

Expected: `# pass 3`.

Run existing pipeline to confirm no regression:

```bash
bash /usr/src/workspace/github/QQhuxuhui/auto_chrome/run_pipeline.sh --stage 3
```

Expected: 3 accounts all skipped (already verified) — pipeline exits code 0 quickly.

- [ ] **Step 5: Commit**

```bash
cd auto_chrome && git add src/common/chrome.js src/common/chrome.refactor.test.js && git commit -m "refactor(common): extract buildChromeArgs for injection, keep launchRealChrome API"
```

---

### Task 7: Implement tools/chrome.js — launch

**Files:**
- Create: `auto_chrome/mcp-server/src/tools/chrome.js`
- Create: `auto_chrome/mcp-server/test/tools-chrome-launch.test.js`

- [ ] **Step 1: Write the failing test**

Write `test/tools-chrome-launch.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { SessionRegistry } = require('../src/sessions');
const { createLogger } = require('../src/logger');
const { loadConfig } = require('../src/config');
const { registerChromeTools } = require('../src/tools/chrome');

test('chrome.launch returns sessionId + debugPort', async () => {
    const cfg = loadConfig();
    cfg.maxSessions = 1;
    cfg.chromeDataRoot = '/tmp/stealth-chrome-mcp-test';
    const registry = new SessionRegistry({ maxSessions: cfg.maxSessions });
    const logger = createLogger('warn');
    const tools = registerChromeTools({ registry, logger, config: cfg });

    const result = await tools['chrome.launch'].handler({ tags: { test: '1' } });
    try {
        assert.match(result.sessionId, /^sess_/);
        assert.ok(result.debugPort >= 9234);
        assert.ok(result.dataDir.startsWith('/tmp/stealth-chrome-mcp-test'));
    } finally {
        await tools['chrome.close'].handler({ sessionId: result.sessionId });
    }
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd auto_chrome/mcp-server && node --test test/tools-chrome-launch.test.js
```

Expected: FAIL — missing module.

- [ ] **Step 3: Implement tools/chrome.js (launch + close + list)**

Write `src/tools/chrome.js`:

```js
'use strict';

const path = require('path');
const fs = require('fs');
const { randomUUID } = require('crypto');
const { McpError, CODES } = require('../errors');

// Reach into common/ for proven Chrome launching
const COMMON_PATH = path.resolve(__dirname, '..', '..', '..', 'src', 'common');
const { launchRealChrome, findChrome, clearBrowserSession } = require(path.join(COMMON_PATH, 'chrome'));

function registerChromeTools({ registry, logger, config }) {
    const chromePath = config.chromePath || findChrome();
    if (!chromePath) throw new Error('Chrome not found; set CHROME_PATH');

    const tools = {};

    tools['chrome.launch'] = {
        schema: {
            type: 'object',
            properties: {
                dataDir: { type: 'string' },
                extraArgs: { type: 'array', items: { type: 'string' } },
                lang: { type: 'string', default: 'en-US' },
                viewport: { type: 'string', default: '1280,800' },
                proxy: { type: 'string' },
                tags: { type: 'object', additionalProperties: { type: 'string' } },
            },
        },
        async handler({ dataDir, extraArgs = [], lang, viewport, proxy, tags = {} } = {}) {
            if (proxy) extraArgs = [`--proxy-server=${proxy}`, ...extraArgs];
            const workerId = registry.list().length;
            const resolvedDataDir = dataDir
                || path.join(config.chromeDataRoot, `sess-${randomUUID().slice(0, 8)}`);
            fs.mkdirSync(resolvedDataDir, { recursive: true });

            let launched;
            try {
                launched = await launchRealChrome(chromePath, workerId, {
                    dataDir: resolvedDataDir, extraArgs, lang, viewport,
                    debugPort: config.basePort + workerId,
                });
            } catch (e) {
                throw new McpError(CODES.CHROME_LAUNCH_FAILED, `Chrome launch failed: ${e.message}`, { cause: e });
            }

            const sessionId = registry.create({
                workerId,
                browser: launched.browser,
                proc: launched.proc,
                dataDir: resolvedDataDir,
                debugPort: launched.debugPort,
                tags,
            });
            logger.info(`chrome.launch ok sessionId=${sessionId} port=${launched.debugPort}`);
            return { sessionId, debugPort: launched.debugPort, dataDir: resolvedDataDir };
        },
    };

    tools['chrome.close'] = {
        schema: { type: 'object', required: ['sessionId'], properties: { sessionId: { type: 'string' } } },
        async handler({ sessionId }) {
            const s = registry.get(sessionId);
            try { await s.browser.close(); } catch (_) {}
            try { s.proc.kill(); } catch (_) {}
            try { fs.rmSync(s.dataDir, { recursive: true, force: true }); } catch (_) {}
            registry.close(sessionId);
            logger.info(`chrome.close ok sessionId=${sessionId}`);
            return { ok: true };
        },
    };

    tools['chrome.list'] = {
        schema: { type: 'object', properties: {} },
        async handler() { return { sessions: registry.list() }; },
    };

    return tools;
}

module.exports = { registerChromeTools };
```

- [ ] **Step 4: Run test**

```bash
cd auto_chrome/mcp-server && node --test --test-timeout=60000 test/tools-chrome-launch.test.js
```

Expected: `# pass 1`. This actually launches real Chrome. If Chrome path not found, set `CHROME_PATH=/usr/bin/google-chrome`.

- [ ] **Step 5: Commit**

```bash
cd auto_chrome && git add mcp-server/src/tools/chrome.js mcp-server/test/tools-chrome-launch.test.js && git commit -m "feat(mcp): add chrome.launch/close/list tools"
```

---

### Task 8: Implement chrome.connect / clear_google_cookies / evaluate

**Files:**
- Modify: `auto_chrome/mcp-server/src/tools/chrome.js`
- Create: `auto_chrome/mcp-server/test/tools-chrome-extras.test.js`

- [ ] **Step 1: Write failing test**

Write `test/tools-chrome-extras.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const { SessionRegistry } = require('../src/sessions');
const { createLogger } = require('../src/logger');
const { loadConfig } = require('../src/config');
const { registerChromeTools } = require('../src/tools/chrome');

test('chrome.evaluate runs script in page and returns value', async () => {
    const cfg = loadConfig(); cfg.maxSessions = 1; cfg.chromeDataRoot = '/tmp/stealth-chrome-mcp-test';
    const registry = new SessionRegistry({ maxSessions: 1 });
    const tools = registerChromeTools({ registry, logger: createLogger('warn'), config: cfg });
    const { sessionId } = await tools['chrome.launch'].handler({});
    try {
        const r = await tools['chrome.evaluate'].handler({ sessionId, script: '1 + 2' });
        assert.equal(r.value, 3);
    } finally {
        await tools['chrome.close'].handler({ sessionId });
    }
});

test('chrome.clear_google_cookies does not throw on empty session', async () => {
    const cfg = loadConfig(); cfg.maxSessions = 1; cfg.chromeDataRoot = '/tmp/stealth-chrome-mcp-test';
    const registry = new SessionRegistry({ maxSessions: 1 });
    const tools = registerChromeTools({ registry, logger: createLogger('warn'), config: cfg });
    const { sessionId } = await tools['chrome.launch'].handler({});
    try {
        const r = await tools['chrome.clear_google_cookies'].handler({ sessionId });
        assert.equal(r.ok, true);
    } finally {
        await tools['chrome.close'].handler({ sessionId });
    }
});
```

- [ ] **Step 2: Run test to verify fail**

```bash
cd auto_chrome/mcp-server && node --test --test-timeout=60000 test/tools-chrome-extras.test.js
```

Expected: FAIL — `chrome.evaluate` handler not registered.

- [ ] **Step 3: Add three more tools to tools/chrome.js**

Append inside `registerChromeTools` body (before `return tools;`):

```js
tools['chrome.connect'] = {
    schema: {
        type: 'object',
        properties: {
            browserURL: { type: 'string' },
            wsEndpoint: { type: 'string' },
            tags: { type: 'object' },
        },
    },
    async handler({ browserURL, wsEndpoint, tags = {} } = {}) {
        if (!browserURL && !wsEndpoint) throw new McpError(CODES.PRECONDITION_FAILED, 'browserURL or wsEndpoint required');
        const puppeteer = require('puppeteer-core');
        let browser;
        try {
            browser = browserURL
                ? await puppeteer.connect({ browserURL, defaultViewport: null })
                : await puppeteer.connect({ browserWSEndpoint: wsEndpoint, defaultViewport: null });
        } catch (e) {
            throw new McpError(CODES.CHROME_PROTOCOL_ERROR, `connect failed: ${e.message}`, { cause: e });
        }
        const sessionId = registry.create({
            workerId: registry.list().length,
            browser, proc: null,
            dataDir: null,
            debugPort: null,
            tags: { ...tags, connected: 'true' },
        });
        return { sessionId };
    },
};

tools['chrome.clear_google_cookies'] = {
    schema: { type: 'object', required: ['sessionId'], properties: { sessionId: { type: 'string' } } },
    async handler({ sessionId }) {
        const s = registry.get(sessionId);
        const wlog = logger.child(`[${sessionId}]`);
        await clearBrowserSession(s.browser, wlog);
        return { ok: true };
    },
};

tools['chrome.evaluate'] = {
    schema: {
        type: 'object',
        required: ['sessionId', 'script'],
        properties: {
            sessionId: { type: 'string' },
            script: { type: 'string' },
            args: { type: 'array' },
        },
    },
    async handler({ sessionId, script, args = [] }) {
        const s = registry.get(sessionId);
        const pages = await s.browser.pages();
        const page = pages[0] || await s.browser.newPage();
        try {
            const fn = new Function(...(args.map((_, i) => `arg${i}`)), `return (${script});`);
            const value = await page.evaluate(fn, ...args);
            return { value };
        } catch (e) {
            throw new McpError(CODES.CHROME_PROTOCOL_ERROR, `evaluate failed: ${e.message}`, { cause: e });
        }
    },
};
```

- [ ] **Step 4: Run test**

```bash
cd auto_chrome/mcp-server && node --test --test-timeout=60000 test/tools-chrome-extras.test.js
```

Expected: `# pass 2`.

- [ ] **Step 5: Commit**

```bash
cd auto_chrome && git add mcp-server/src/tools/chrome.js mcp-server/test/tools-chrome-extras.test.js && git commit -m "feat(mcp): add chrome.connect/clear_google_cookies/evaluate tools"
```

---

### Task 9: Refactor common/google-login.js to inject smsProvider

**Files:**
- Modify: `auto_chrome/src/common/google-login.js` (top of file: require `./sms`)

**Context:** Current `google-login.js` does `require('./sms')` directly. We add a `smsProvider` parameter to `googleLogin` with a default that falls back to `require('./sms')` so existing callers still work.

- [ ] **Step 1: Find the require in google-login.js**

```bash
grep -n "require.*sms" /usr/src/workspace/github/QQhuxuhui/auto_chrome/src/common/google-login.js
```

- [ ] **Step 2: Change signature + remove top-level require**

Locate the top-level imports and the `googleLogin` function signature. Remove the static `require('./sms')` and change the function signature:

Before:
```js
const { getPhone, getCode, cancelSms } = require('./sms');
async function googleLogin(page, account, wlog) { ... }
```

After:
```js
async function googleLogin(page, account, wlog, opts = {}) {
    const smsProvider = opts.smsProvider || require('./sms'); // lazy fallback
    // Use smsProvider.getPhone / smsProvider.getCode / smsProvider.cancelSms in place of destructured names
    ...
}
```

Then in the function body, replace every direct `getPhone(...)` / `getCode(...)` / `cancelSms(...)` with `smsProvider.getPhone(...)` etc. Use grep to find all call sites:

```bash
grep -nE "\b(getPhone|getCode|cancelSms)\b\(" /usr/src/workspace/github/QQhuxuhui/auto_chrome/src/common/google-login.js
```

Edit each line accordingly.

- [ ] **Step 3: Smoke test with existing pipeline (no behavior change expected)**

```bash
bash /usr/src/workspace/github/QQhuxuhui/auto_chrome/run_pipeline.sh --stage 3
```

Expected: 3 accounts all skipped — pipeline exits code 0 with `ok (verified): 0, skipped: 3`.

- [ ] **Step 4: Commit**

```bash
cd auto_chrome && git add src/common/google-login.js && git commit -m "refactor(common): inject smsProvider into googleLogin, keep default fallback"
```

---

### Task 10: Implement tools/google.js — login

**Files:**
- Create: `auto_chrome/mcp-server/src/tools/google.js`
- Create: `auto_chrome/mcp-server/test/tools-google-login.test.js`
- Create: `auto_chrome/mcp-server/test/fixtures/test-account.example.json`

- [ ] **Step 1: Create test account fixture**

Write `test/fixtures/test-account.example.json`:

```json
{
    "email": "REPLACE_WITH_TEST_ACCOUNT@gmail.com",
    "password": "REPLACE_WITH_PASSWORD",
    "totp_secret": "REPLACE_WITH_BASE32_SECRET"
}
```

User creates a real copy at `test/fixtures/test-account.json` (gitignored). Document this in `mcp-server/README.md` later.

- [ ] **Step 2: Write the failing test (gated on fixture existence)**

Write `test/tools-google-login.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { SessionRegistry } = require('../src/sessions');
const { createLogger } = require('../src/logger');
const { loadConfig } = require('../src/config');
const { registerChromeTools } = require('../src/tools/chrome');
const { registerGoogleTools } = require('../src/tools/google');

const FIXTURE = path.join(__dirname, 'fixtures', 'test-account.json');
const skip = !fs.existsSync(FIXTURE);

test('google.login happy path (real account)', { skip }, async () => {
    const account = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
    const cfg = loadConfig(); cfg.maxSessions = 1; cfg.chromeDataRoot = '/tmp/stealth-chrome-mcp-test';
    const registry = new SessionRegistry({ maxSessions: 1 });
    const chromeTools = registerChromeTools({ registry, logger: createLogger('warn'), config: cfg });
    const googleTools = registerGoogleTools({ registry, logger: createLogger('warn'), config: cfg });

    const { sessionId } = await chromeTools['chrome.launch'].handler({});
    try {
        const r = await googleTools['google.login'].handler({
            sessionId, account, smsBehavior: 'skip',
        });
        assert.equal(r.status, 'ok', `expected ok, got ${r.status}: stateHistory=${JSON.stringify(r.stateHistory)}`);
        assert.match(r.finalUrl, /myaccount\.google\.com|accounts\.google\.com\/(?!v3\/signin\/rejected)/);
    } finally {
        await chromeTools['chrome.close'].handler({ sessionId });
    }
});
```

- [ ] **Step 3: Run test — expect skip without fixture**

```bash
cd auto_chrome/mcp-server && node --test test/tools-google-login.test.js
```

Expected: `# skip 1` (no fixture). Once fixture exists and tool implemented, re-run to see it fail on implementation.

- [ ] **Step 4: Implement tools/google.js — login**

Write `src/tools/google.js`:

```js
'use strict';

const path = require('path');
const { McpError, CODES } = require('../errors');

const COMMON_PATH = path.resolve(__dirname, '..', '..', '..', 'src', 'common');
const { googleLogin } = require(path.join(COMMON_PATH, 'google-login'));

const REJECTED_URL_PATTERN = /\/v3\/signin\/rejected/;
const AUTHENTICATED_URL_PATTERN = /myaccount\.google\.com|continue=.*authenticated/;

function registerGoogleTools({ registry, logger, config }) {
    const tools = {};

    tools['google.login'] = {
        schema: {
            type: 'object',
            required: ['sessionId', 'account'],
            properties: {
                sessionId: { type: 'string' },
                account: {
                    type: 'object',
                    required: ['email', 'password'],
                    properties: {
                        email: { type: 'string' },
                        password: { type: 'string' },
                        totp_secret: { type: 'string' },
                        fa_secret: { type: 'string' },
                        recovery_email: { type: 'string' },
                    },
                },
                smsBehavior: { type: 'string', enum: ['auto', 'skip', 'manual'], default: 'auto' },
                timeoutMs: { type: 'integer', default: 180000 },
                startUrl: { type: 'string', default: 'https://accounts.google.com/signin' },
            },
        },
        async handler({ sessionId, account, smsBehavior = 'auto', timeoutMs = 180000, startUrl = 'https://accounts.google.com/signin' }) {
            return registry.withLock(sessionId, async () => {
                const s = registry.get(sessionId);
                const wlog = logger.child(`[${sessionId}]`);

                // Merge fa_secret as alias of totp_secret
                const effectiveAccount = {
                    ...account,
                    totp_secret: account.totp_secret || account.fa_secret,
                };

                // Determine smsProvider based on smsBehavior
                let smsProvider = null;
                if (smsBehavior === 'auto') {
                    try {
                        const { getProvider } = require('../providers/sms');
                        smsProvider = getProvider(config.smsProvider, config);
                    } catch (e) {
                        throw new McpError(CODES.SMS_PROVIDER_ERROR, `SMS provider '${config.smsProvider}' unavailable: ${e.message}`);
                    }
                } else if (smsBehavior === 'skip') {
                    // Provide a stub that refuses to operate — googleLogin will hit fallback/manual
                    smsProvider = {
                        getPhone: async () => { throw new Error('SMS skipped by smsBehavior=skip'); },
                        getCode: async () => { throw new Error('SMS skipped'); },
                        cancelSms: async () => {},
                    };
                } else if (smsBehavior === 'manual') {
                    // Let googleLogin fall through to its manual-mode waiting loop
                    smsProvider = null;
                }

                const page = await s.browser.newPage();

                // Watch-dog: poll for "Couldn't sign you in" URL; short-circuit if hit
                let rejected = false;
                const rejectWatcher = setInterval(() => {
                    try {
                        const url = page.url();
                        if (REJECTED_URL_PATTERN.test(url)) {
                            rejected = true;
                            page.emit('__mcp_rejected');
                        }
                    } catch (_) {}
                }, 750);

                try {
                    await page.goto(startUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(e => wlog.warn(`signin nav: ${e.message}`));

                    // Race googleLogin against rejection detection + timeout
                    const loginPromise = googleLogin(page, effectiveAccount, wlog, { smsProvider });
                    const rejectPromise = new Promise((_, rej) => {
                        page.once('__mcp_rejected', () => rej(new McpError(CODES.GOOGLE_LOGIN_REJECTED,
                            'Google rejected signin: "Couldn\'t sign you in"')));
                    });
                    const timeoutPromise = new Promise((_, rej) => setTimeout(
                        () => rej(new McpError(CODES.TIMEOUT, `login timed out after ${timeoutMs}ms`)),
                        timeoutMs));

                    try {
                        await Promise.race([loginPromise, rejectPromise, timeoutPromise]);
                    } catch (e) {
                        if (e instanceof McpError) {
                            const screenshot = await captureBase64Screenshot(page).catch(() => null);
                            return { status: e.code === CODES.GOOGLE_LOGIN_REJECTED ? 'rejected' : 'timeout',
                                finalUrl: page.url(), stateHistory: [], screenshot };
                        }
                        if (/deadloop|stuck/i.test(e.message || '')) {
                            const screenshot = await captureBase64Screenshot(page).catch(() => null);
                            return { status: 'stuck', finalUrl: page.url(), stateHistory: [], screenshot };
                        }
                        throw e;
                    }

                    return { status: 'ok', finalUrl: page.url(), stateHistory: [] };
                } finally {
                    clearInterval(rejectWatcher);
                    await page.close().catch(() => {});
                }
            });
        },
    };

    return tools;
}

async function captureBase64Screenshot(page) {
    const buf = await page.screenshot({ type: 'png' });
    return buf.toString('base64');
}

module.exports = { registerGoogleTools };
```

- [ ] **Step 5: Run test (with fixture in place)**

Assume user has created `test/fixtures/test-account.json`.

```bash
cd auto_chrome/mcp-server && node --test --test-timeout=240000 test/tools-google-login.test.js
```

Expected: `# pass 1` with ok status. If the MCP-launched Chrome triggers Google's "browser not secure" (per spec §5.6), the test will fail with `status: rejected` — that's a known risk; see M1 Task 14 notes.

- [ ] **Step 6: Commit**

```bash
cd auto_chrome && git add mcp-server/src/tools/google.js mcp-server/test/tools-google-login.test.js mcp-server/test/fixtures/test-account.example.json && git commit -m "feat(mcp): add google.login with rejected-page short-circuit"
```

---

### Task 11: Implement server.js + bin/server.js (stdio wiring)

**Files:**
- Create: `auto_chrome/mcp-server/src/server.js`
- Create: `auto_chrome/mcp-server/bin/server.js`

- [ ] **Step 1: Implement src/server.js (tool registration + dispatch)**

Write `src/server.js`:

```js
'use strict';

const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { CallToolRequestSchema, ListToolsRequestSchema } = require('@modelcontextprotocol/sdk/types.js');

const { loadConfig } = require('./config');
const { createLogger } = require('./logger');
const { SessionRegistry } = require('./sessions');
const { McpError, CODES } = require('./errors');
const { registerChromeTools } = require('./tools/chrome');
const { registerGoogleTools } = require('./tools/google');

// Configure Node fetch to honor HTTPS_PROXY (same pattern as 3_local_oauth.js)
{
    const cfg = loadConfig();
    if (cfg.httpsProxy) {
        const { setGlobalDispatcher, ProxyAgent } = require('undici');
        setGlobalDispatcher(new ProxyAgent(cfg.httpsProxy));
    }
}

async function startServer() {
    const config = loadConfig();
    const logger = createLogger(config.logLevel);
    const registry = new SessionRegistry({ maxSessions: config.maxSessions });

    const tools = {
        ...registerChromeTools({ registry, logger, config }),
        ...registerGoogleTools({ registry, logger, config }),
    };

    const server = new Server(
        { name: 'stealth-chrome-mcp', version: '0.1.0' },
        { capabilities: { tools: {} } },
    );

    server.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: Object.entries(tools).map(([name, t]) => ({
            name, description: t.description || '', inputSchema: t.schema,
        })),
    }));

    server.setRequestHandler(CallToolRequestSchema, async (req) => {
        const tool = tools[req.params.name];
        if (!tool) throw new Error(`Unknown tool: ${req.params.name}`);
        try {
            const result = await tool.handler(req.params.arguments || {});
            return { content: [{ type: 'text', text: JSON.stringify(result) }] };
        } catch (e) {
            const code = e instanceof McpError ? e.code : 'INTERNAL_ERROR';
            logger.warn(`tool ${req.params.name} failed: ${code}: ${e.message}`);
            throw new Error(`${code}: ${e.message}`);
        }
    });

    const shutdown = async () => {
        logger.info('shutting down, closing sessions...');
        await registry.closeAll({
            cleanup: async (s) => { try { await s.browser.close(); } catch (_) {} try { s.proc && s.proc.kill(); } catch (_) {} },
        });
        process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
    process.on('uncaughtException', (e) => { logger.error('uncaughtException:', e.stack || e.message); shutdown(); });

    const transport = new StdioServerTransport();
    await server.connect(transport);
    logger.info(`stealth-chrome-mcp ready (maxSessions=${config.maxSessions})`);
}

module.exports = { startServer };
```

- [ ] **Step 2: Implement bin/server.js (entry point)**

Write `bin/server.js`:

```js
#!/usr/bin/env node
'use strict';

const { startServer } = require('../src/server');
startServer().catch(e => {
    process.stderr.write(`[fatal] ${e.stack || e.message}\n`);
    process.exit(1);
});
```

Make executable:

```bash
chmod +x /usr/src/workspace/github/QQhuxuhui/auto_chrome/mcp-server/bin/server.js
```

- [ ] **Step 3: Smoke-test the server via stdio (echo a ListTools request)**

```bash
cd /usr/src/workspace/github/QQhuxuhui/auto_chrome/mcp-server
echo '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | timeout 5 node bin/server.js 2>/tmp/mcp-stderr.log
cat /tmp/mcp-stderr.log
```

Expected: a single JSON response on stdout listing all `chrome.*` and `google.*` tool names. stderr shows `stealth-chrome-mcp ready`.

- [ ] **Step 4: Commit**

```bash
cd auto_chrome && git add mcp-server/src/server.js mcp-server/bin/server.js && git commit -m "feat(mcp): stdio server with tool dispatch, graceful shutdown, undici proxy"
```

---

### Task 12: Register MCP in ~/.claude.json

**Files:**
- Modify: `/root/.claude.json` (mcpServers section)

- [ ] **Step 1: Backup + add entry**

```bash
cp /root/.claude.json /root/.claude.json.bak.$(date +%s)
python3 -c "
import json
with open('/root/.claude.json') as f: d = json.load(f)
d['mcpServers']['stealth-chrome'] = {
    'command': 'node',
    'args': ['/usr/src/workspace/github/QQhuxuhui/auto_chrome/mcp-server/bin/server.js'],
    'env': {
        'DISPLAY': ':0',
        'LOG_LEVEL': 'info',
        'CHROME_DATA_ROOT': '/tmp/stealth-chrome-mcp',
    },
}
with open('/root/.claude.json', 'w') as f: json.dump(d, f, indent=2)
print('added stealth-chrome to mcpServers')
"
```

- [ ] **Step 2: Verify entry**

```bash
python3 -c "import json; print(json.dumps(json.load(open('/root/.claude.json'))['mcpServers']['stealth-chrome'], indent=2))"
```

Expected: the JSON block with command/args/env.

- [ ] **Step 3: Restart Claude Code session**

Inform user: "MCP registered. Exit this Claude Code session and re-enter to pick up the new MCP server."

- [ ] **Step 4: After re-entering, verify ListTools**

User (or Claude on new session) runs:

```
chrome.list via stealth-chrome MCP
```

Expected: returns `{ sessions: [] }` (no active sessions yet).

- [ ] **Step 5: No commit needed** (`.claude.json` is a user config file, not in repo)

---

### M0 Integration Smoke

- [ ] **Step 1: End-to-end smoke against real account**

User creates `mcp-server/test/fixtures/test-account.json` with a real Google account that has TOTP configured.

```bash
cd /usr/src/workspace/github/QQhuxuhui/auto_chrome/mcp-server && node --test --test-timeout=240000 test/tools-google-login.test.js
```

Expected: `# pass 1`.

- [ ] **Step 2: Tag M0 milestone**

```bash
cd auto_chrome && git tag m0-mcp-core && git push origin dev --tags
```

---

## M1 — OAuth 链路 + Stage 3 改写为 skill

目标：`google.oauth_get_code` + `oauth.exchange_code` tool 跑通；stage 3 业务用 skill 重写；现有 3 账户 `--reauth` 回归。

### Task 13: Extract OAuth helpers to common/oauth.js

**Files:**
- Create: `auto_chrome/src/common/oauth.js`
- Modify: `auto_chrome/src/3_local_oauth.js` (replace inline helpers with require)
- Create: `auto_chrome/src/common/oauth.test.js`

- [ ] **Step 1: Read current location of helpers**

```bash
grep -n "^function \(buildAuthUrl\|exchangeCode\|startCbServer\|obtainAuthCode\)" /usr/src/workspace/github/QQhuxuhui/auto_chrome/src/3_local_oauth.js
```

Expected: lines ~118, 134, 163, 217.

- [ ] **Step 2: Write failing test**

Write `src/common/oauth.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildAuthUrl } = require('./oauth');

test('buildAuthUrl composes correct query params', () => {
    const url = buildAuthUrl({
        clientId: 'c1.apps.googleusercontent.com',
        scopes: ['https://www.googleapis.com/auth/cloud-platform'],
        port: 18900,
    });
    const u = new URL(url);
    assert.equal(u.host, 'accounts.google.com');
    assert.equal(u.searchParams.get('client_id'), 'c1.apps.googleusercontent.com');
    assert.equal(u.searchParams.get('redirect_uri'), 'http://localhost:18900/callback');
    assert.equal(u.searchParams.get('prompt'), 'consent');
});
```

- [ ] **Step 3: Run test — fail**

```bash
cd auto_chrome/src && node --test common/oauth.test.js
```

Expected: FAIL — `Cannot find module ./oauth`.

- [ ] **Step 4: Create common/oauth.js**

Write `src/common/oauth.js`:

```js
'use strict';

const http = require('http');
const { randomUUID } = require('crypto');

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const PORT_RANGE_PER_WORKER = 50;

function buildAuthUrl({ clientId, scopes, port, redirectUri }) {
    const uri = redirectUri || `http://localhost:${port}/callback`;
    return `${AUTH_URL}?${new URLSearchParams({
        client_id: clientId,
        redirect_uri: uri,
        response_type: 'code',
        scope: scopes.join(' '),
        access_type: 'offline',
        prompt: 'consent',
    }).toString()}`;
}

async function exchangeCode({ code, clientId, clientSecret, redirectUri }) {
    const resp = await fetch(TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            code, client_id: clientId, client_secret: clientSecret,
            redirect_uri: redirectUri, grant_type: 'authorization_code',
        }).toString(),
    });
    const text = await resp.text();
    let data;
    try { data = JSON.parse(text); }
    catch (_) { throw new Error(`Token exchange: non-JSON response (${resp.status}): ${text.slice(0, 200)}`); }
    if (data.error) throw new Error(`Token exchange failed: ${data.error}: ${data.error_description || ''}`);
    if (!data.refresh_token) throw new Error('Token exchange succeeded but no refresh_token (prompt=consent required?)');
    return data;
}

function startCbServer(startPort, wlog) {
    return new Promise((resolve, reject) => {
        let done;
        const codePromise = new Promise(r => { done = r; });
        function tryListen(port) {
            if (port > startPort + PORT_RANGE_PER_WORKER) {
                reject(new Error(`no available port in range ${startPort}~${port}`));
                return;
            }
            const server = http.createServer((req, res) => {
                try {
                    const u = new URL(req.url, `http://localhost:${port}`);
                    if (u.pathname === '/callback') {
                        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
                        const code = u.searchParams.get('code');
                        const err = u.searchParams.get('error');
                        res.end(code ? '<h1>OK. You can close this tab.</h1>' : `<h1>FAIL: ${err || 'unknown'}</h1>`);
                        done(code ? { code } : { error: err || 'unknown' });
                    } else { res.writeHead(404); res.end('Not Found'); }
                } catch (_) { try { res.writeHead(500); res.end('err'); } catch (_2) {} }
            });
            server.on('error', (e) => { if (e.code === 'EADDRINUSE') tryListen(port + 1); else reject(e); });
            server.listen(port, () => resolve({ server, port, codePromise }));
        }
        tryListen(startPort);
    });
}

module.exports = { buildAuthUrl, exchangeCode, startCbServer, TOKEN_URL, AUTH_URL };
```

- [ ] **Step 5: Update 3_local_oauth.js to use common/oauth.js**

Replace inline `buildAuthUrl`/`exchangeCode`/`startCbServer` in `3_local_oauth.js` with:

```js
const { buildAuthUrl: _buildAuthUrl, exchangeCode: _exchangeCode, startCbServer: _startCbServer } = require('./common/oauth');

function buildAuthUrl(port) {
    return _buildAuthUrl({ clientId: CLIENT_ID, scopes: SCOPES.split(' '), port });
}
async function exchangeCode(code, port) {
    return _exchangeCode({
        code, clientId: CLIENT_ID, clientSecret: CLIENT_SECRET,
        redirectUri: `http://localhost:${port}/callback`,
    });
}
function startCbServer(startPort, wlog) { return _startCbServer(startPort, wlog); }
```

- [ ] **Step 6: Run test + regression**

```bash
cd auto_chrome/src && node --test common/oauth.test.js
```

Expected: `# pass 1`.

```bash
bash /usr/src/workspace/github/QQhuxuhui/auto_chrome/run_pipeline.sh --stage 3 --reauth=BuderusLuis823@gmail.com
```

Expected: `ok (verified): 1, failed: 0` — same result as pre-refactor.

- [ ] **Step 7: Commit**

```bash
cd auto_chrome && git add src/common/oauth.js src/common/oauth.test.js src/3_local_oauth.js && git commit -m "refactor(common): extract OAuth helpers (buildAuthUrl/exchangeCode/startCbServer)"
```

---

### Task 14: Implement tools/oauth.js — exchange_code

**Files:**
- Create: `auto_chrome/mcp-server/src/tools/oauth.js`
- Create: `auto_chrome/mcp-server/test/tools-oauth.test.js`

- [ ] **Step 1: Write failing test**

Write `test/tools-oauth.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadConfig } = require('../src/config');
const { createLogger } = require('../src/logger');
const { registerOauthTools } = require('../src/tools/oauth');
const { CODES } = require('../src/errors');

test('oauth.exchange_code uses env clientId/secret as fallback', async () => {
    process.env.CLIENT_ID = 'test.apps.googleusercontent.com';
    process.env.CLIENT_SECRET = 'test-secret';
    const cfg = loadConfig();
    const tools = registerOauthTools({ logger: createLogger('warn'), config: cfg });
    // Use an obviously invalid code; Google will reject, but we test that env fallback was used.
    try {
        await tools['oauth.exchange_code'].handler({ code: 'invalid', redirectUri: 'http://localhost:18900/callback' });
        assert.fail('expected failure');
    } catch (e) {
        assert.ok(/OAUTH_TOKEN_EXCHANGE_FAILED/.test(e.code || e.message));
    } finally {
        delete process.env.CLIENT_ID; delete process.env.CLIENT_SECRET;
    }
});
```

- [ ] **Step 2: Run test — fail**

```bash
cd auto_chrome/mcp-server && node --test test/tools-oauth.test.js
```

Expected: FAIL — module missing.

- [ ] **Step 3: Implement tools/oauth.js**

Write `src/tools/oauth.js`:

```js
'use strict';

const path = require('path');
const { McpError, CODES } = require('../errors');
const COMMON_PATH = path.resolve(__dirname, '..', '..', '..', 'src', 'common');
const { exchangeCode } = require(path.join(COMMON_PATH, 'oauth'));

function registerOauthTools({ logger, config }) {
    const tools = {};

    tools['oauth.exchange_code'] = {
        schema: {
            type: 'object',
            required: ['code', 'redirectUri'],
            properties: {
                code: { type: 'string' },
                clientId: { type: 'string' },
                clientSecret: { type: 'string' },
                redirectUri: { type: 'string' },
            },
        },
        async handler({ code, clientId, clientSecret, redirectUri }) {
            const effectiveClientId = clientId || config.clientId;
            const effectiveClientSecret = clientSecret || config.clientSecret;
            if (!effectiveClientId || !effectiveClientSecret) {
                throw new McpError(CODES.PRECONDITION_FAILED,
                    'clientId/clientSecret missing (pass as args or set CLIENT_ID/CLIENT_SECRET env)');
            }
            try {
                const tokens = await exchangeCode({
                    code, clientId: effectiveClientId, clientSecret: effectiveClientSecret, redirectUri,
                });
                return {
                    accessToken: tokens.access_token,
                    refreshToken: tokens.refresh_token,
                    expiresIn: tokens.expires_in,
                    scope: tokens.scope,
                    idToken: tokens.id_token,
                };
            } catch (e) {
                throw new McpError(CODES.OAUTH_TOKEN_EXCHANGE_FAILED, e.message, { cause: e });
            }
        },
    };

    return tools;
}

module.exports = { registerOauthTools };
```

- [ ] **Step 4: Run test**

```bash
cd auto_chrome/mcp-server && node --test test/tools-oauth.test.js
```

Expected: `# pass 1`.

- [ ] **Step 5: Register in server.js**

Edit `src/server.js` — import and register:

```js
const { registerOauthTools } = require('./tools/oauth');
// ...
const tools = {
    ...registerChromeTools({ registry, logger, config }),
    ...registerGoogleTools({ registry, logger, config }),
    ...registerOauthTools({ logger, config }),
};
```

- [ ] **Step 6: Commit**

```bash
cd auto_chrome && git add mcp-server/src/tools/oauth.js mcp-server/src/server.js mcp-server/test/tools-oauth.test.js && git commit -m "feat(mcp): add oauth.exchange_code tool with env fallback"
```

---

### Task 15: Implement google.oauth_get_code

**Files:**
- Modify: `auto_chrome/mcp-server/src/tools/google.js` (add oauth_get_code)

- [ ] **Step 1: Add schema + handler to google.js**

Inside `registerGoogleTools`, before `return tools;`, add:

```js
const { buildAuthUrl, startCbServer } = require(path.join(COMMON_PATH, 'oauth'));

tools['google.oauth_get_code'] = {
    schema: {
        type: 'object',
        required: ['sessionId', 'scopes'],
        properties: {
            sessionId: { type: 'string' },
            clientId: { type: 'string' },
            scopes: { type: 'array', items: { type: 'string' } },
            callbackPortStart: { type: 'integer', default: 18900 },
            handleConsent: { type: 'boolean', default: true },
            account: { type: 'object' },
            timeoutMs: { type: 'integer', default: 120000 },
        },
    },
    async handler({ sessionId, clientId, scopes, callbackPortStart = 18900, handleConsent = true, account, timeoutMs = 120000 }) {
        return registry.withLock(sessionId, async () => {
            const s = registry.get(sessionId);
            const wlog = logger.child(`[${sessionId}]`);
            const effectiveClientId = clientId || config.clientId;
            if (!effectiveClientId) {
                throw new McpError(CODES.PRECONDITION_FAILED, 'clientId missing (set env CLIENT_ID or pass arg)');
            }

            const cbServer = await startCbServer(callbackPortStart, wlog);
            try {
                const authUrl = buildAuthUrl({ clientId: effectiveClientId, scopes, port: cbServer.port });
                const redirectUri = `http://localhost:${cbServer.port}/callback`;
                const page = await s.browser.newPage();
                try {
                    // Fire navigation; consent driving is done inline below
                    page.goto(authUrl, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(e => wlog.debug(`authUrl goto: ${e.message}`));

                    // Consent poller: use existing logic from auto_chrome's 3_sub2api.js
                    let keepPolling = true;
                    const { clickOAuthConsentTarget, handleTotpChallenge } = require(path.join(COMMON_PATH, '..', '3_sub2api'));
                    const poller = (async () => {
                        while (handleConsent && keepPolling) {
                            try {
                                if (account) {
                                    const handled = await handleTotpChallenge(page, account, wlog);
                                    if (handled) { await new Promise(r => setTimeout(r, 3000)); continue; }
                                }
                                const hit = account ? await clickOAuthConsentTarget(page, account.email) : null;
                                if (hit) wlog.debug(`[consent] ${hit}`);
                            } catch (_) {}
                            await new Promise(r => setTimeout(r, 1500));
                        }
                    })();

                    const timeoutP = new Promise((_, rej) => setTimeout(
                        () => rej(new McpError(CODES.OAUTH_CODE_NOT_RECEIVED, `no code within ${timeoutMs}ms`)), timeoutMs));

                    let result;
                    try {
                        result = await Promise.race([cbServer.codePromise, timeoutP]);
                    } finally {
                        keepPolling = false;
                        await poller.catch(() => {});
                    }

                    if (result.error) {
                        throw new McpError(CODES.OAUTH_CODE_NOT_RECEIVED, `oauth denied: ${result.error}`);
                    }
                    if (!result.code) {
                        throw new McpError(CODES.OAUTH_CODE_NOT_RECEIVED, 'callback received but no code');
                    }
                    return { code: result.code, redirectUri };
                } finally {
                    await page.close().catch(() => {});
                }
            } finally {
                try { cbServer.server.close(); } catch (_) {}
            }
        });
    },
};
```

- [ ] **Step 2: No new unit test** — this tool is exercised end-to-end by the M1 regression in Task 17.

- [ ] **Step 3: Commit**

```bash
cd auto_chrome && git add mcp-server/src/tools/google.js && git commit -m "feat(mcp): add google.oauth_get_code with consent driving"
```

---

### Task 16: Write technical skills (my-skills repo)

**Files:**
- Create: `/usr/src/workspace/github/QQhuxuhui/my-skills/google-login-playbook/SKILL.md`
- Create: `/usr/src/workspace/github/QQhuxuhui/my-skills/oauth-token-harvest/SKILL.md`

- [ ] **Step 1: Init my-skills repo (if not yet)**

```bash
cd /usr/src/workspace/github/QQhuxuhui
if [ ! -d my-skills/.git ]; then
    mkdir -p my-skills && cd my-skills
    git init && echo "# my-skills" > README.md
    git add README.md && git commit -m "init"
fi
```

- [ ] **Step 2: Write google-login-playbook SKILL.md**

Write `/usr/src/workspace/github/QQhuxuhui/my-skills/google-login-playbook/SKILL.md`:

```markdown
---
name: google-login-playbook
description: Use when driving a Google account login via stealth-chrome-mcp. Explains the account object shape, smsBehavior options, error recovery, and session reuse strategy.
---

# Google Login Playbook (stealth-chrome-mcp)

## Account Object

All tools accepting `account` expect this shape:

\`\`\`json
{
  "email": "user@gmail.com",
  "password": "...",
  "totp_secret": "BASE32SECRET",  // optional; OR fa_secret (alias)
  "recovery_email": "backup@gmail.com"  // optional
}
\`\`\`

`fa_secret` is treated as `totp_secret` for compatibility with the auto_chrome
account format.

## Flow (one account)

1. `chrome.launch` → sessionId
2. `google.login({ sessionId, account, smsBehavior })` → status
3. Business tools (oauth, navigation, etc.)
4. `chrome.close({ sessionId })`

Always close sessions. The server caps at 5 concurrent and will refuse new
launches with `CONCURRENCY_LIMIT_EXCEEDED`.

## smsBehavior

- `auto` (default): use the MCP server's configured SMS provider (env `SMS_PROVIDER` + API key). Automatic end-to-end.
- `skip`: fail immediately on SMS challenge. Use for environments without SMS budget or when you want to bail early.
- `manual`: skip the provider and block for up to 5 min waiting for a human to enter the SMS code in the open Chrome window.

## Error handling

Tool returns `status` (enum):

| status | meaning | typical recovery |
|---|---|---|
| `ok` | authenticated | proceed to next tool |
| `rejected` | "Couldn't sign you in" — Google refused browser | retry with `chrome.connect` to a manually-launched Chrome, or bail |
| `stuck` | state machine deadloop (page doesn't change) | check screenshot; often fixes itself on retry with fresh session |
| `sms_needed` | only when smsBehavior=skip; SMS was needed but not attempted | provide SMS provider or switch to manual |
| `timeout` | exceeded timeoutMs (default 180s) | extend timeout or investigate via screenshot |

On non-ok status, `screenshot` field contains base64 PNG of the page at
failure — decode and inspect before deciding.

## Session reuse across tools

Within ONE business task (e.g. OAuth token harvest for one member):
- Login once → run all tools on the same sessionId → close.

Do NOT reuse one session across multiple members — clear state with
`chrome.clear_google_cookies` or simply close and re-launch. Google cookies
persist and will confuse account identity.
```

- [ ] **Step 3: Write oauth-token-harvest SKILL.md**

Write `/usr/src/workspace/github/QQhuxuhui/my-skills/oauth-token-harvest/SKILL.md`:

```markdown
---
name: oauth-token-harvest
description: Use when harvesting Google OAuth refresh tokens (access_token + refresh_token) for a given client_id and scopes via stealth-chrome-mcp. Covers the 3-step flow and error recovery.
---

# OAuth Token Harvest

## Prerequisites

- MCP server has `CLIENT_ID` and `CLIENT_SECRET` configured in env (or pass per-call).
- A logged-in Google session (see `google-login-playbook`).

## Flow (3 steps)

1. `google.login({ sessionId, account })` → authenticated session
2. `google.oauth_get_code({ sessionId, scopes, account })` → `{ code, redirectUri }`
3. `oauth.exchange_code({ code, redirectUri })` → `{ accessToken, refreshToken, expiresIn, scope }`

## Choosing scopes

Common scope sets:
- `['https://www.googleapis.com/auth/cloud-platform']` — generic GCP
- Full Antigravity set (for Gemini family pipeline): see
  `auto_chrome/src/3_local_oauth.js` const `SCOPES`

## Refreshing tokens later

The returned `refreshToken` is what you persist. To get a new access token:

\`\`\`
POST https://oauth2.googleapis.com/token
  grant_type=refresh_token
  refresh_token=...
  client_id=...
  client_secret=...
\`\`\`

You can call `oauth.exchange_code` is only for the initial code → token swap.
For refresh, call Google directly from your business code.

## Common errors

- `OAUTH_CODE_NOT_RECEIVED`: browser never hit the localhost callback. Usually
  means consent page was not driven — pass `account` so the consent poller
  can handle TOTP challenges and account selection.
- `OAUTH_TOKEN_EXCHANGE_FAILED`: Google rejected the code. Check that
  `redirectUri` matches EXACTLY what `google.oauth_get_code` used (same port).
  The `redirectUri` returned by `google.oauth_get_code` is the one to pass.
```

- [ ] **Step 4: Commit in my-skills repo**

```bash
cd /usr/src/workspace/github/QQhuxuhui/my-skills && git add google-login-playbook/ oauth-token-harvest/ && git commit -m "feat: add google-login-playbook and oauth-token-harvest skills"
```

---

### Task 17: Write google-oauth-validate skill (stage 3 rewrite)

**Files:**
- Create: `/usr/src/workspace/github/QQhuxuhui/my-skills/google-oauth-validate/SKILL.md`

**Context:** This skill teaches agents how to replicate `3_local_oauth.js`'s business logic using MCP tools. The Antigravity-specific helpers (`getProjectId`, `probeAntigravity`, `completeValidationFlow`) stay in business code (callable via `chrome.evaluate` for page interaction or plain `fetch` for API calls).

- [ ] **Step 1: Write the skill**

Write `/usr/src/workspace/github/QQhuxuhui/my-skills/google-oauth-validate/SKILL.md`:

```markdown
---
name: google-oauth-validate
description: Use when running the Gemini/Antigravity OAuth + probe + SMS-validation flow for a single member account. Mirrors auto_chrome stage 3.
---

# Google OAuth + Antigravity Validation (per-member)

Replicates `auto_chrome/src/3_local_oauth.js` using stealth-chrome-mcp tools.
Pipeline ordering and account list management remain the caller's business.

## Per-member sequence

\`\`\`
1. chrome.launch → sessionId
2. google.login({sessionId, account, smsBehavior: "auto"})
3. google.oauth_get_code({sessionId, scopes: ANTIGRAVITY_SCOPES, account})
4. oauth.exchange_code({code, redirectUri}) → tokens
5. HTTP POST cloudcode-pa.googleapis.com/v1internal:loadCodeAssist
   with Bearer accessToken → get project_id
6. HTTP POST cloudcode-pa/v1internal:streamGenerateContent → probe
   - if 200: verified ✓ — save credential
   - if 403 with validation_url: drive validation flow
7. completeValidationFlow (see §8 below)
8. Re-probe; write credentials.json
9. chrome.close({sessionId})
\`\`\`

## Scopes

Use the same set as `auto_chrome/src/3_local_oauth.js` SCOPES constant.
Copy verbatim — do not edit — to match existing refresh tokens.

## Validation flow (when probe returns 403 + validation_url)

Caller navigates the session to `validation_url` using `chrome.evaluate` or
direct puppeteer; the MCP's `google.login` already handles the common
identity_verify + verify_phone case. If the validation URL lands on a
different Google signin (session was wiped), call `google.login` again with
the same account (cookies already present; it should exit fast).

## Credential shape (to persist)

\`\`\`json
{
  "name": "ultra_<host>_<member>",
  "email": "<google email>",
  "host_email": "<host email>",
  "member_email": "<member email>",
  "refresh_token": "...",
  "access_token": "...",
  "expires_at": <unix_ms>,
  "project_id": "...",
  "verified_at": "<ISO8601 or null if only refresh_token saved>",
  "probe_status": <int>,
  "updated_at": "<ISO8601>"
}
\`\`\`

See `auto_chrome/src/credentials.json` for reference (live records).

## Error recovery

| error | recovery |
|---|---|
| `google.login` → rejected | record in failed.json; skip this member |
| probe HTTP 403 after validation | retry once with fresh session; if still 403, save as `saved_unverified` |
| `OAUTH_TOKEN_EXCHANGE_FAILED: invalid_grant` | check if code was already exchanged (only valid once); re-run `google.oauth_get_code` |

## Concurrency

MCP caps at 5 sessions; pipeline should honor `--concurrency <=5`. Each
member gets its own `chrome.launch` → `chrome.close`. Do not share a session
across members (cookie contamination).
```

- [ ] **Step 2: Commit**

```bash
cd /usr/src/workspace/github/QQhuxuhui/my-skills && git add google-oauth-validate/ && git commit -m "feat: add google-oauth-validate skill (stage 3 rewrite)"
```

---

### Task 18: M1 regression — reauth existing 3 accounts via MCP tools

**Files:** none created; runs existing MCP + skill manually.

**Context:** Validate the MCP path for an already-working account by performing login → oauth_get_code → exchange_code without running the legacy pipeline.

- [ ] **Step 1: Write a throwaway verification script**

Write `/tmp/mcp-m1-verify.js`:

```js
#!/usr/bin/env node
const path = require('path');
const MCP = path.resolve('/usr/src/workspace/github/QQhuxuhui/auto_chrome/mcp-server');
const { loadConfig } = require(path.join(MCP, 'src/config'));
const { createLogger } = require(path.join(MCP, 'src/logger'));
const { SessionRegistry } = require(path.join(MCP, 'src/sessions'));
const { registerChromeTools } = require(path.join(MCP, 'src/tools/chrome'));
const { registerGoogleTools } = require(path.join(MCP, 'src/tools/google'));
const { registerOauthTools } = require(path.join(MCP, 'src/tools/oauth'));

(async () => {
    const cfg = loadConfig();
    const logger = createLogger('info');
    const registry = new SessionRegistry({ maxSessions: 1 });
    const chromeTools = registerChromeTools({ registry, logger, config: cfg });
    const googleTools = registerGoogleTools({ registry, logger, config: cfg });
    const oauthTools = registerOauthTools({ logger, config: cfg });

    const members = require('/usr/src/workspace/github/QQhuxuhui/auto_chrome/src/credentials.json');
    const target = members.find(m => m.member_email === 'BuderusLuis823@gmail.com');
    const account = {
        email: target.member_email,
        // Password + totp_secret live in members.txt; parse from there in a real run.
        // For smoke, skip this test if password unavailable.
        password: process.env.TEST_PASSWORD,
        totp_secret: process.env.TEST_TOTP_SECRET,
    };
    if (!account.password) { console.error('Set TEST_PASSWORD to run'); process.exit(0); }

    const { sessionId } = await chromeTools['chrome.launch'].handler({ tags: { email: account.email } });
    try {
        const r = await googleTools['google.login'].handler({ sessionId, account, smsBehavior: 'skip' });
        console.log('login:', r.status);
        if (r.status !== 'ok') process.exit(2);
        // Optional: get code + exchange
        if (process.env.CLIENT_ID && process.env.CLIENT_SECRET) {
            const { code, redirectUri } = await googleTools['google.oauth_get_code'].handler({
                sessionId, scopes: ['https://www.googleapis.com/auth/cloud-platform'], account,
            });
            const tokens = await oauthTools['oauth.exchange_code'].handler({ code, redirectUri });
            console.log('refresh_token:', tokens.refreshToken.slice(0, 12), '...');
        }
    } finally {
        await chromeTools['chrome.close'].handler({ sessionId });
    }
})();
```

- [ ] **Step 2: Run it (caller provides real creds via env)**

```bash
CLIENT_ID=<from members.txt> CLIENT_SECRET=<...> TEST_PASSWORD=<...> TEST_TOTP_SECRET=<...> \
    node /tmp/mcp-m1-verify.js
```

Expected:
```
login: ok
refresh_token: 1//06...
```

- [ ] **Step 3: Tag milestone**

```bash
cd /usr/src/workspace/github/QQhuxuhui/auto_chrome && git tag m1-oauth-skills && git push origin dev --tags
cd /usr/src/workspace/github/QQhuxuhui/my-skills && git tag m1-initial && git push origin master --tags 2>/dev/null || true
```

---

## M2 — SMS provider + 截图产物 + 完整错误码

目标：`smsBehavior=auto` 端到端；登录失败返回 base64 截图；三个 `sms.*` tool 可单独调用。

### Task 19: Define SmsProvider interface + registry

**Files:**
- Create: `auto_chrome/mcp-server/src/providers/sms/index.js`
- Create: `auto_chrome/mcp-server/test/providers-sms.test.js`

- [ ] **Step 1: Write failing test**

Write `test/providers-sms.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const { getProvider, registerProvider } = require('../src/providers/sms');

test('registers and retrieves provider by name', () => {
    const stub = {
        name: 'stub',
        getPhone: async () => ({ number: '+1', activationId: 'x' }),
        waitCode: async () => ({ code: '000' }),
        cancel: async () => {},
    };
    registerProvider(stub);
    const p = getProvider('stub', {});
    assert.equal(p.name, 'stub');
});

test('unknown provider throws', () => {
    assert.throws(() => getProvider('nope', {}), /unknown SMS provider/);
});
```

- [ ] **Step 2: Run test — fail**

```bash
cd auto_chrome/mcp-server && node --test test/providers-sms.test.js
```

- [ ] **Step 3: Implement providers/sms/index.js**

Write `src/providers/sms/index.js`:

```js
'use strict';

const _providers = new Map();

function registerProvider(provider) {
    if (!provider.name) throw new Error('provider.name required');
    _providers.set(provider.name, provider);
}

function getProvider(name, config) {
    if (_providers.has(name)) return _providers.get(name);
    // Lazy-load built-ins
    if (name === 'hero-sms') {
        const hero = require('./hero-sms');
        registerProvider(hero.create(config));
        return _providers.get(name);
    }
    throw new Error(`unknown SMS provider: ${name}`);
}

module.exports = { registerProvider, getProvider };
```

- [ ] **Step 4: Run test**

```bash
cd auto_chrome/mcp-server && node --test test/providers-sms.test.js
```

Expected: `# pass 2`.

- [ ] **Step 5: Commit**

```bash
cd auto_chrome && git add mcp-server/src/providers/sms/index.js mcp-server/test/providers-sms.test.js && git commit -m "feat(mcp): sms provider interface + registry"
```

---

### Task 20: hero-sms provider (wraps common/sms.js)

**Files:**
- Create: `auto_chrome/mcp-server/src/providers/sms/hero-sms.js`

- [ ] **Step 1: Implement wrapper**

Write `src/providers/sms/hero-sms.js`:

```js
'use strict';

const path = require('path');
const COMMON_PATH = path.resolve(__dirname, '..', '..', '..', '..', 'src', 'common');
const heroSms = require(path.join(COMMON_PATH, 'sms'));

function create(config) {
    if (!config.heroSmsApiKey) {
        throw new Error('HERO_SMS_API_KEY env required for hero-sms provider');
    }
    // common/sms.js reads HERO_SMS_API_KEY from env internally. Nothing more to wire.
    return {
        name: 'hero-sms',
        async getPhone({ service, country }) {
            const res = await heroSms.getPhone(service, country);
            return { number: res.number, activationId: res.activationId };
        },
        async waitCode({ activationId, timeoutMs = 120000 }) {
            const code = await heroSms.getCode(activationId, timeoutMs);
            return { code };
        },
        async cancel({ activationId }) {
            await heroSms.cancelSms(activationId);
        },
    };
}

module.exports = { create };
```

- [ ] **Step 2: Commit**

```bash
cd auto_chrome && git add mcp-server/src/providers/sms/hero-sms.js && git commit -m "feat(mcp): hero-sms provider wraps common/sms.js"
```

---

### Task 21: Implement tools/sms.js — 3 tools

**Files:**
- Create: `auto_chrome/mcp-server/src/tools/sms.js`
- Modify: `auto_chrome/mcp-server/src/server.js` (register)

- [ ] **Step 1: Implement**

Write `src/tools/sms.js`:

```js
'use strict';

const { McpError, CODES } = require('../errors');
const { getProvider } = require('../providers/sms');

function registerSmsTools({ logger, config }) {
    function resolveProvider(override) {
        try { return getProvider(override || config.smsProvider, config); }
        catch (e) { throw new McpError(CODES.SMS_PROVIDER_ERROR, e.message, { cause: e }); }
    }
    const tools = {};

    tools['sms.get_phone'] = {
        schema: {
            type: 'object', required: ['service', 'country'],
            properties: {
                service: { type: 'string' },
                country: { type: 'string' },
                provider: { type: 'string' },
            },
        },
        async handler({ service, country, provider }) {
            const p = resolveProvider(provider);
            try { return await p.getPhone({ service, country }); }
            catch (e) {
                if (/balance/i.test(e.message)) throw new McpError(CODES.SMS_BALANCE_INSUFFICIENT, e.message);
                throw new McpError(CODES.SMS_PROVIDER_ERROR, e.message, { cause: e });
            }
        },
    };

    tools['sms.wait_code'] = {
        schema: {
            type: 'object', required: ['activationId'],
            properties: {
                activationId: { type: 'string' },
                timeoutMs: { type: 'integer', default: 120000 },
                provider: { type: 'string' },
            },
        },
        async handler({ activationId, timeoutMs = 120000, provider }) {
            const p = resolveProvider(provider);
            try { return await p.waitCode({ activationId, timeoutMs }); }
            catch (e) {
                if (/timeout/i.test(e.message)) throw new McpError(CODES.SMS_TIMEOUT, e.message);
                throw new McpError(CODES.SMS_PROVIDER_ERROR, e.message, { cause: e });
            }
        },
    };

    tools['sms.cancel'] = {
        schema: {
            type: 'object', required: ['activationId'],
            properties: { activationId: { type: 'string' }, provider: { type: 'string' } },
        },
        async handler({ activationId, provider }) {
            const p = resolveProvider(provider);
            await p.cancel({ activationId });
            return { ok: true };
        },
    };

    return tools;
}

module.exports = { registerSmsTools };
```

Add to `src/server.js`:

```js
const { registerSmsTools } = require('./tools/sms');
// ...in tools object:
...registerSmsTools({ logger, config }),
```

- [ ] **Step 2: Commit**

```bash
cd auto_chrome && git add mcp-server/src/tools/sms.js mcp-server/src/server.js && git commit -m "feat(mcp): add sms.get_phone/wait_code/cancel tools"
```

---

### Task 22: Implement tools/totp.js

**Files:**
- Create: `auto_chrome/mcp-server/src/tools/totp.js`
- Create: `auto_chrome/mcp-server/test/tools-totp.test.js`
- Modify: `auto_chrome/mcp-server/src/server.js`

- [ ] **Step 1: Write failing test**

Write `test/tools-totp.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const { registerTotpTools } = require('../src/tools/totp');
const { createLogger } = require('../src/logger');

test('totp.generate returns 6-digit code with validForS', async () => {
    const tools = registerTotpTools({ logger: createLogger('warn') });
    const r = await tools['totp.generate'].handler({ secret: 'JBSWY3DPEHPK3PXP' });
    assert.match(r.code, /^\d{6}$/);
    assert.ok(r.validForS > 0 && r.validForS <= 30);
});
```

- [ ] **Step 2: Implement**

Write `src/tools/totp.js`:

```js
'use strict';

const path = require('path');
const { McpError, CODES } = require('../errors');
const COMMON_PATH = path.resolve(__dirname, '..', '..', '..', 'src', 'common');
const { generateTOTP } = require(path.join(COMMON_PATH, 'totp'));

function registerTotpTools({ logger }) {
    return {
        'totp.generate': {
            schema: {
                type: 'object', required: ['secret'],
                properties: {
                    secret: { type: 'string' },
                    timestamp: { type: 'integer' },
                },
            },
            async handler({ secret, timestamp }) {
                try {
                    const code = generateTOTP(secret, timestamp);
                    const validForS = 30 - Math.floor((timestamp || Date.now()) / 1000) % 30;
                    return { code, validForS };
                } catch (e) {
                    throw new McpError(CODES.TOTP_INVALID_SECRET, e.message, { cause: e });
                }
            },
        },
    };
}

module.exports = { registerTotpTools };
```

Register in `src/server.js`:

```js
const { registerTotpTools } = require('./tools/totp');
// ...
...registerTotpTools({ logger }),
```

- [ ] **Step 3: Run test**

```bash
cd auto_chrome/mcp-server && node --test test/tools-totp.test.js
```

Expected: `# pass 1`.

- [ ] **Step 4: Commit**

```bash
cd auto_chrome && git add mcp-server/src/tools/totp.js mcp-server/src/server.js mcp-server/test/tools-totp.test.js && git commit -m "feat(mcp): add totp.generate tool"
```

---

### Task 23: Wire smsBehavior=auto into google.login

**Files:**
- Modify: `auto_chrome/mcp-server/src/tools/google.js`

**Context:** The scaffold in Task 10 already routes `auto` to `getProvider(config.smsProvider, config)`. Now that providers actually exist (M2 Task 19-20), verify end-to-end with a fresh account that needs SMS.

- [ ] **Step 1: End-to-end test with fresh account**

User creates `mcp-server/test/fixtures/fresh-test-account.json` with a new Google account that has not completed identity verification (so it will hit SMS). Set `HERO_SMS_API_KEY` in env.

Run the same verification script from Task 18 but with `smsBehavior: 'auto'`:

```bash
HERO_SMS_API_KEY=... TEST_PASSWORD=... TEST_TOTP_SECRET=... node /tmp/mcp-m1-verify.js
```

Expected: `login: ok` (even with SMS step).

- [ ] **Step 2: Commit (if any change needed for SMS glue)**

If changes made to `google.js` for SMS, commit. Otherwise this task is validation only:

```bash
cd auto_chrome && git tag m2-sms-auto && git push origin dev --tags
```

---

## Self-Review

Completed above tasks cover spec sections:

| Spec § | Covered by Task |
|---|---|
| §1 设计目标 | (Plan intro) |
| §2 代码布局 | Task 1 (scaffold) |
| §3 Server 传输 | Task 11 |
| §4 Session 模型 | Task 5 |
| §5.1 chrome.launch | Task 7 |
| §5.2 chrome.connect | Task 8 |
| §5.3 chrome.close/list | Task 7, 8 |
| §5.4 chrome.clear_google_cookies | Task 8 |
| §5.5 chrome.evaluate | Task 8 |
| §5.6 google.login | Task 10 |
| §5.7 google.oauth_get_code | Task 15 |
| §5.8 oauth.exchange_code | Task 14 |
| §5.9 sms.* | Task 21 |
| §5.10 totp.generate | Task 22 |
| §6 错误语义 | Task 4 |
| §7 SMS provider 接口 | Task 19, 20 |
| §8 配置 | Task 2 |
| §9 观测 | Task 3 (logger), 11 (stdout clean) |
| §10 生命周期 | Task 11 (shutdown handlers) |
| §11 并发模型 | Task 5 (mutex + cap) |
| §12 common/ 重构 | Task 6 (chrome.js), 9 (google-login.js), 13 (oauth.js) |
| §13 Skill 层 (技术) | Task 16 |
| §13 Skill 层 (google-oauth-validate) | Task 17 |
| §14 M0 切片 | Tasks 1-12 |
| §14 M1 切片 | Tasks 13-18 |
| §14 M2 切片 | Tasks 19-23 |
| §15 决策 (全部) | 嵌入各对应 Task |
| §16 测试策略 | Task 10, 18 (real accounts), 23 (fresh account) |

**Out of plan scope (future plan):**
- M3: `my-skills/google-invite`, `my-skills/google-accept`, `my-skills/gpt-plus` — these rewrite stage 1/2 and gpt-plus. One plan per stage preferred since they're independent business flows.
