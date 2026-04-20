# Stage 2 Host-Authoritative Verification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 stage 2 接受邀请的成功判定从"子号自动化完成"改为"母号家庭页显示 joined"，用一个独立 host-monitor Chrome 常驻 scrape + 2min 宽限 + 保守裁决表实现。

**Architecture:** 新模块目录 `src/stages/accept/`。`HostMonitor` 是 EventEmitter，独立 Chrome 登 host 后 60s 轮询 family 页。Member worker 跑完 `acceptInvite` 后，`awaitHostConfirmation` 订阅 monitor 的 `scrape-done` 事件，最多等 2 分钟。`decide()` 纯函数按裁决表输出最终 `finalStatus/eventType/message`。每 host 串行处理（monitor + workers + teardown），不跨 host 并行。

**Tech Stack:** Node.js 22 + `node:test` + `puppeteer-core` + Alpine 无关。无构建步骤。

**Spec:** `docs/superpowers/specs/2026-04-20-stage2-host-authoritative-verification-design.md`

---

## 文件结构

```
src/stages/accept/                            (新)
    index.js              — runStage2 入口，per-host 编排
    host-monitor.js       — HostMonitor 类（EventEmitter）
    family-scrape-fast.js — scrapeFamilyListPage(page) + 纯 parser parseFamilyListDOM()
    member-worker.js      — acceptInvite（从 2_accept.js 搬，接口不变）
    decide.js             — decide({flowResult, flowError, hostStatus}) 纯函数
    decide.test.js        — 6 行裁决表单测
    family-scrape-fast.test.js — parser 纯函数单测
    host-monitor.test.js  — EventEmitter / awaitHostConfirmation 单测（用 fake scrape）
src/2_accept.js                               (改为 shim)
```

每个文件单一职责。hosts/reconcile 不动。

---

## Task 1: `decide.js` + 单测（纯函数，从最容易的锚定开始）

**Files:**
- Create: `src/stages/accept/decide.js`
- Create: `src/stages/accept/decide.test.js`

- [ ] **Step 1: 先写失败的测试 `decide.test.js`**

```js
const test = require('node:test');
const assert = require('node:assert');
const { decide } = require('./decide');

test('flow truthy + host joined → done/success', () => {
    const d = decide({ flowResult: true, flowError: null, hostStatus: 'joined' });
    assert.deepEqual(d, { finalStatus: 'done', eventType: 'success', message: null });
});

test('flow truthy + host not joined → accept_failed + accept_failed_unconfirmed', () => {
    for (const h of ['pending', 'unknown', 'timeout', 'degraded']) {
        const d = decide({ flowResult: true, flowError: null, hostStatus: h });
        assert.equal(d.finalStatus, 'accept_failed', `hostStatus=${h}`);
        assert.equal(d.eventType, 'accept_failed_unconfirmed');
        assert.match(d.message, /flow ok but host-page not confirmed/i);
    }
});

test('flow threw + host joined → done/success with note', () => {
    const err = new Error('SMS timeout');
    const d = decide({ flowResult: null, flowError: err, hostStatus: 'joined' });
    assert.equal(d.finalStatus, 'done');
    assert.equal(d.eventType, 'success');
    assert.match(d.message, /flow threw.*SMS timeout.*host confirmed joined/i);
});

test('flow threw + host not joined → accept_failed/fail with original error', () => {
    const err = new Error('challenge_timeout: foo');
    const d = decide({ flowResult: null, flowError: err, hostStatus: 'timeout' });
    assert.equal(d.finalStatus, 'accept_failed');
    assert.equal(d.eventType, 'fail');
    assert.equal(d.message, 'challenge_timeout: foo');
});

test('flow falsy (no throw) + host joined → done/success', () => {
    const d = decide({ flowResult: false, flowError: null, hostStatus: 'joined' });
    assert.equal(d.finalStatus, 'done');
    assert.equal(d.eventType, 'success');
    assert.match(d.message, /falsy but host confirmed/i);
});

test('flow falsy + host not joined → accept_failed/fail', () => {
    const d = decide({ flowResult: false, flowError: null, hostStatus: 'pending' });
    assert.equal(d.finalStatus, 'accept_failed');
    assert.equal(d.eventType, 'fail');
    assert.equal(d.message, 'acceptInvite returned falsy');
});
```

- [ ] **Step 2: 运行测试确认失败**

Run (from repo root):
```
cd src && node --test stages/accept/decide.test.js
```
Expected: 6 tests, all FAIL with `Cannot find module './decide'` or similar.

- [ ] **Step 3: 实现 `decide.js` 满足所有用例**

```js
/**
 * Pure decision function for stage 2 member outcomes.
 *
 * Inputs:
 *   flowResult: any  (truthy/falsy from acceptInvite return)
 *   flowError:  Error|null (null = no throw)
 *   hostStatus: 'joined'|'pending'|'unknown'|'timeout'|'degraded'
 *
 * Output: { finalStatus: 'done'|'accept_failed', eventType: string, message: string|null }
 *
 * Rule: hostStatus==='joined' always wins and marks done. Otherwise:
 *   - flow threw → accept_failed/fail with original error
 *   - flow truthy → accept_failed/accept_failed_unconfirmed (warn)
 *   - flow falsy  → accept_failed/fail
 */
function decide({ flowResult, flowError, hostStatus }) {
    const joined = hostStatus === 'joined';

    if (flowError) {
        if (joined) {
            return {
                finalStatus: 'done',
                eventType: 'success',
                message: `flow threw: ${flowError.message} but host confirmed joined`,
            };
        }
        return {
            finalStatus: 'accept_failed',
            eventType: 'fail',
            message: flowError.message,
        };
    }

    if (flowResult) {
        if (joined) {
            return { finalStatus: 'done', eventType: 'success', message: null };
        }
        return {
            finalStatus: 'accept_failed',
            eventType: 'accept_failed_unconfirmed',
            message: 'flow ok but host-page not confirmed within 2min',
        };
    }

    // falsy, no throw
    if (joined) {
        return {
            finalStatus: 'done',
            eventType: 'success',
            message: 'flow returned falsy but host confirmed joined',
        };
    }
    return {
        finalStatus: 'accept_failed',
        eventType: 'fail',
        message: 'acceptInvite returned falsy',
    };
}

module.exports = { decide };
```

- [ ] **Step 4: 运行测试全绿**

Run: `cd src && node --test stages/accept/decide.test.js`
Expected: `# pass 6` and `# fail 0`.

- [ ] **Step 5: Commit**

```bash
git add src/stages/accept/decide.js src/stages/accept/decide.test.js
git commit -m "feat(stage2): decide() pure function for host-authoritative outcomes

Implements the 6-row decision table from the spec: hostStatus='joined'
always wins; otherwise flow threw → fail/orig error; flow truthy but
host not confirmed → accept_failed_unconfirmed (warn); flow falsy →
fail with 'returned falsy'. Exhaustive unit tests."
```

---

## Task 2: `family-scrape-fast.js` + parser 单测

**Files:**
- Create: `src/stages/accept/family-scrape-fast.js`
- Create: `src/stages/accept/family-scrape-fast.test.js`

**目标：** 产出比 `reconcile.scrapeFamilyMembers` 快得多的 scraper —— 只抓列表页，不进每个 joined 成员的详情页。列表页结构（Google 当前 DOM）：每个家庭条目是一个 `<a href="/family/{invitation|member}/...">...</a>`，pending 邀请的 anchor 文本里直接有 email，joined 成员只有 display name。

把 DOM → 结构化数据的解析抽成**纯函数** `parseFamilyListDOM(rawAnchors)`，Puppeteer `page.evaluate()` 里只做"从 DOM 收集 anchor"，解析单独测。

- [ ] **Step 1: 写 parser 的失败测试 `family-scrape-fast.test.js`**

```js
const test = require('node:test');
const assert = require('node:assert');
const { parseFamilyListDOM } = require('./family-scrape-fast');

test('parseFamilyListDOM — pending invite with visible email → pending', () => {
    const raw = [
        { href: '/family/invitation/abc123', text: 'foo@bar.com\nInvitation sent' },
    ];
    const out = parseFamilyListDOM(raw);
    assert.deepEqual(out.pending, [{ href: '/family/invitation/abc123', email: 'foo@bar.com' }]);
    assert.deepEqual(out.joinedHrefs, []);
});

test('parseFamilyListDOM — joined member anchor (no email in text) → joinedHrefs', () => {
    const raw = [
        { href: '/family/member/xyz789', text: 'Jane Doe' },
    ];
    const out = parseFamilyListDOM(raw);
    assert.deepEqual(out.pending, []);
    assert.deepEqual(out.joinedHrefs, ['/family/member/xyz789']);
});

test('parseFamilyListDOM — mixed list', () => {
    const raw = [
        { href: '/family/member/host-abc', text: 'Host User\nFamily manager' },  // host self, skipped
        { href: '/family/member/m1', text: 'Jane Doe' },
        { href: '/family/invitation/i1', text: 'pending@example.com\nInvitation sent' },
        { href: '/family/member/m2', text: 'John Doe' },
        { href: '/some/other/link', text: 'unrelated' },  // filtered out
        { href: '/family/invitemembers', text: 'Send invitations' },  // filtered out
    ];
    const out = parseFamilyListDOM(raw);
    assert.deepEqual(out.pending, [{ href: '/family/invitation/i1', email: 'pending@example.com' }]);
    assert.deepEqual(out.joinedHrefs, ['/family/member/m1', '/family/member/m2']);
});

test('parseFamilyListDOM — concatenated text without newline does not greedy-match TLD', () => {
    // reconcile.js 老 bug: textContent 把 "name@x.cominvitation" 当一个 TLD
    const raw = [
        { href: '/family/invitation/i1', text: 'foo@bar.cominvitation sent' },
    ];
    const out = parseFamilyListDOM(raw);
    // email regex 要求 TLD 后不再跟字母，这条应当无法提取到合法 email
    assert.deepEqual(out.pending, [{ href: '/family/invitation/i1', email: null }]);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd src && node --test stages/accept/family-scrape-fast.test.js`
Expected: tests fail because the module doesn't exist.

- [ ] **Step 3: 实现 `family-scrape-fast.js`**

```js
/**
 * Fast list-page-only scraper for Google Family page.
 *
 * Difference from stages/reconcile.scrapeFamilyMembers:
 *   - Does NOT click into each joined member's detail page (saves ~3s × N).
 *   - For joined members, returns only the href (no email). Callers that
 *     need email→href mapping should use reconcile.scrapeFamilyMembers once
 *     to build the initial map.
 *
 * Exposed:
 *   parseFamilyListDOM(anchors) → { pending: [{href,email}], joinedHrefs: [href] }
 *       pure, testable, takes {href, text} array already harvested from DOM
 *   scrapeFamilyListPage(page) → same shape; navigates + harvests + parses
 */
const FAMILY_URL = 'https://myaccount.google.com/family/details?utm_source=g1web&utm_medium=default';

// TLD 右边界 lookahead 防止 "gmail.cominvitation" 吞成一个 TLD。
const EMAIL_RE = /(?<![a-zA-Z])([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,10})(?![a-zA-Z])/;

function parseFamilyListDOM(anchors) {
    const pending = [];
    const joinedHrefs = [];
    const seen = new Set();

    for (const a of anchors || []) {
        const href = a.href || '';
        if (!href || seen.has(href)) continue;
        if (!/family\/(member|invitation)\//i.test(href)) continue;
        seen.add(href);

        const text = String(a.text || '').trim();
        if (/family manager|家庭管理员/i.test(text)) continue;  // host self

        if (/family\/invitation\//i.test(href)) {
            // pending invite — try to extract email
            const m = text.match(EMAIL_RE);
            pending.push({ href, email: m ? m[1].toLowerCase() : null });
        } else {
            // family/member/ — joined, no email available here
            joinedHrefs.push(href);
        }
    }
    return { pending, joinedHrefs };
}

async function scrapeFamilyListPage(page, wlog) {
    // Assume caller already navigated to family/details; navigate defensively anyway.
    if (!/\/family\/details/.test(page.url())) {
        await page.goto(FAMILY_URL, { waitUntil: 'networkidle2', timeout: 30000 })
            .catch(e => wlog && wlog.warn && wlog.warn(`scrape-fast: goto failed: ${e.message}`));
    }
    const anchors = await page.evaluate(() => {
        const out = [];
        for (const a of document.querySelectorAll('a[href*="family/"]')) {
            const href = a.getAttribute('href') || '';
            const text = (a.innerText || a.textContent || '').trim();
            out.push({ href, text: text.substring(0, 200) });
        }
        return out;
    }).catch(() => []);
    return { ...parseFamilyListDOM(anchors), scrapedAt: Date.now() };
}

module.exports = { parseFamilyListDOM, scrapeFamilyListPage, FAMILY_URL };
```

- [ ] **Step 4: 跑测试全绿**

Run: `cd src && node --test stages/accept/family-scrape-fast.test.js`
Expected: `# pass 4` and `# fail 0`.

- [ ] **Step 5: Commit**

```bash
git add src/stages/accept/family-scrape-fast.js src/stages/accept/family-scrape-fast.test.js
git commit -m "feat(stage2): list-page-only family scraper + parser unit tests

scrapeFamilyListPage() harvests family/details anchors without clicking
into joined member detail pages (reconcile's slow path). Parser
parseFamilyListDOM is a pure function, exhaustively unit tested including
the TLD-greedy regression from reconcile (gmail.cominvitation). Suitable
for the 60s polling loop that can't afford 3s × N per cycle."
```

---

## Task 3: `host-monitor.js` + 单测（EventEmitter + 生命周期）

**Files:**
- Create: `src/stages/accept/host-monitor.js`
- Create: `src/stages/accept/host-monitor.test.js`

**依赖注入：** HostMonitor 构造时接受 `{ scrapeFn, loginFn, intervalMs }` 三个注入点，真实运行时注入 `scrapeFamilyListPage` / `googleLogin`，测试时注入 fake。

- [ ] **Step 1: 写失败测试**

```js
const test = require('node:test');
const assert = require('node:assert');
const { HostMonitor } = require('./host-monitor');

function mkFakeDeps() {
    let loginCalls = 0;
    let scrapeCalls = 0;
    let scrapeImpl = async () => ({ pending: [], joinedHrefs: [], scrapedAt: Date.now() });
    return {
        loginFn: async () => { loginCalls++; },
        scrapeFn: async (page) => { scrapeCalls++; return scrapeImpl(); },
        get loginCalls() { return loginCalls; },
        get scrapeCalls() { return scrapeCalls; },
        setScrape(fn) { scrapeImpl = fn; },
    };
}

test('start() does initial login + scrape before returning', async () => {
    const deps = mkFakeDeps();
    const hm = new HostMonitor({
        host: { id: 1, email: 'h@x.com' },
        fakeBrowser: {}, fakePage: {},
        loginFn: deps.loginFn, scrapeFn: deps.scrapeFn,
        intervalMs: 50_000,  // large; we stop before it fires
        initialFamilyMap: {},
    });
    await hm.start();
    assert.equal(deps.loginCalls, 1);
    assert.equal(deps.scrapeCalls, 1);
    assert.equal(hm.degraded, false);
    await hm.stop();
});

test('login failure → degraded=true, start() does not throw', async () => {
    const hm = new HostMonitor({
        host: { id: 1, email: 'h@x.com' },
        fakeBrowser: {}, fakePage: {},
        loginFn: async () => { throw new Error('captcha stuck'); },
        scrapeFn: async () => ({ pending: [], joinedHrefs: [], scrapedAt: Date.now() }),
        intervalMs: 50_000,
        initialFamilyMap: {},
    });
    await hm.start();
    assert.equal(hm.degraded, true);
    await hm.stop();
});

test('scrape promotes pending → joined and emits scrape-done', async () => {
    const deps = mkFakeDeps();
    const hm = new HostMonitor({
        host: { id: 1, email: 'h@x.com' },
        fakeBrowser: {}, fakePage: {},
        loginFn: deps.loginFn, scrapeFn: deps.scrapeFn,
        intervalMs: 10,
        initialFamilyMap: {
            'foo@bar.com': { status: 'pending', href: '/family/invitation/i1', lastSeenAt: Date.now() },
        },
    });
    // First scrape: still pending
    deps.setScrape(async () => ({
        pending: [{ href: '/family/invitation/i1', email: 'foo@bar.com' }],
        joinedHrefs: [],
        scrapedAt: Date.now(),
    }));
    let events = 0;
    hm.on('scrape-done', () => events++);
    await hm.start();
    assert.equal(hm.state['foo@bar.com'].status, 'pending');

    // Second scrape: disappeared from pending, appears in joinedHrefs
    deps.setScrape(async () => ({
        pending: [],
        joinedHrefs: ['/family/invitation/i1'],  // same href now classified as member
        scrapedAt: Date.now(),
    }));
    await new Promise(r => setTimeout(r, 40));  // allow at least one tick
    await hm.stop();
    assert.equal(hm.state['foo@bar.com'].status, 'joined');
    assert.ok(events >= 2, `expected ≥2 scrape-done, got ${events}`);
});

test('3 consecutive scrape errors → degraded', async () => {
    const hm = new HostMonitor({
        host: { id: 1, email: 'h@x.com' },
        fakeBrowser: {}, fakePage: {},
        loginFn: async () => {},
        scrapeFn: async () => { throw new Error('bad page'); },
        intervalMs: 10,
        initialFamilyMap: {},
        maxScrapeFails: 3,
    });
    let degradedEvents = 0;
    hm.on('degraded', () => degradedEvents++);
    await hm.start();  // start's initial scrape already fails once
    await new Promise(r => setTimeout(r, 80));
    await hm.stop();
    assert.equal(hm.degraded, true);
    assert.equal(degradedEvents, 1);
});

test('awaitHostConfirmation resolves joined when state flips', async () => {
    const { awaitHostConfirmation } = require('./host-monitor');
    const deps = mkFakeDeps();
    const hm = new HostMonitor({
        host: { id: 1, email: 'h@x.com' },
        fakeBrowser: {}, fakePage: {},
        loginFn: deps.loginFn, scrapeFn: deps.scrapeFn,
        intervalMs: 10,
        initialFamilyMap: {
            'bar@x.com': { status: 'pending', href: '/family/invitation/i2', lastSeenAt: Date.now() },
        },
    });
    let tick = 0;
    deps.setScrape(async () => {
        tick++;
        if (tick >= 2) return { pending: [], joinedHrefs: ['/family/invitation/i2'], scrapedAt: Date.now() };
        return { pending: [{ href: '/family/invitation/i2', email: 'bar@x.com' }], joinedHrefs: [], scrapedAt: Date.now() };
    });
    await hm.start();
    const status = await awaitHostConfirmation(hm, 'bar@x.com', { timeoutMs: 500 });
    await hm.stop();
    assert.equal(status, 'joined');
});

test('awaitHostConfirmation returns timeout when host never flips', async () => {
    const { awaitHostConfirmation } = require('./host-monitor');
    const deps = mkFakeDeps();
    const hm = new HostMonitor({
        host: { id: 1, email: 'h@x.com' },
        fakeBrowser: {}, fakePage: {},
        loginFn: deps.loginFn, scrapeFn: deps.scrapeFn,
        intervalMs: 20,
        initialFamilyMap: { 'x@y.com': { status: 'pending', href: '/family/invitation/hx', lastSeenAt: Date.now() } },
    });
    deps.setScrape(async () => ({ pending: [{ href: '/family/invitation/hx', email: 'x@y.com' }], joinedHrefs: [], scrapedAt: Date.now() }));
    await hm.start();
    const status = await awaitHostConfirmation(hm, 'x@y.com', { timeoutMs: 120 });
    await hm.stop();
    assert.equal(status, 'pending');  // timeout returns the current state, or 'timeout' sentinel
});

test('awaitHostConfirmation returns degraded immediately when monitor is degraded', async () => {
    const { awaitHostConfirmation } = require('./host-monitor');
    const hm = new HostMonitor({
        host: { id: 1, email: 'h@x.com' },
        fakeBrowser: {}, fakePage: {},
        loginFn: async () => { throw new Error('no'); },  // login fail → degraded
        scrapeFn: async () => ({ pending: [], joinedHrefs: [], scrapedAt: Date.now() }),
        intervalMs: 1000,
        initialFamilyMap: {},
    });
    await hm.start();
    const status = await awaitHostConfirmation(hm, 'foo@x.com', { timeoutMs: 100 });
    await hm.stop();
    assert.equal(status, 'degraded');
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd src && node --test stages/accept/host-monitor.test.js`
Expected: all fail with `Cannot find module './host-monitor'`.

- [ ] **Step 3: 实现 `host-monitor.js`**

```js
/**
 * HostMonitor — dedicated Chrome that stays logged into a host account,
 * periodically scrapes myaccount.google.com/family/details, and emits
 * 'scrape-done' events so member workers can subscribe via
 * awaitHostConfirmation().
 *
 * Life cycle:
 *   new HostMonitor(opts)
 *   await hm.start()     // login + first scrape (calibration)
 *   // ... other code subscribes via hm.on('scrape-done', ...) or uses awaitHostConfirmation
 *   await hm.stop()      // stops the polling loop; caller owns browser teardown
 *
 * Dependency injection for tests:
 *   opts.loginFn(page, hostAccount, wlog)
 *   opts.scrapeFn(page, wlog) → { pending, joinedHrefs, scrapedAt }
 *
 * Degradation triggers (hm.degraded=true + emit 'degraded'):
 *   - start() login throws
 *   - consecutive scrape errors ≥ maxScrapeFails (default 3)
 */
const EventEmitter = require('events');

const DEFAULT_POLL_INTERVAL_MS = parseInt(process.env.HOST_MONITOR_POLL_INTERVAL_MS, 10) || 60_000;
const DEFAULT_MAX_SCRAPE_FAILS = parseInt(process.env.HOST_MONITOR_MAX_SCRAPE_FAILS, 10) || 3;

class HostMonitor extends EventEmitter {
    constructor(opts) {
        super();
        this.host = opts.host;
        this.browser = opts.fakeBrowser || opts.browser;
        this.page = opts.fakePage || opts.page;
        this.loginFn = opts.loginFn;
        this.scrapeFn = opts.scrapeFn;
        this.wlog = opts.wlog || { info() {}, warn() {}, error() {}, debug() {}, success() {} };
        this.intervalMs = opts.intervalMs || DEFAULT_POLL_INTERVAL_MS;
        this.maxScrapeFails = opts.maxScrapeFails || DEFAULT_MAX_SCRAPE_FAILS;
        this.state = { ...(opts.initialFamilyMap || {}) };
        this.degraded = false;
        this.stopped = false;
        this._consecutiveFails = 0;
        this._timer = null;
    }

    async start() {
        try {
            await this.loginFn(this.page, this.host, this.wlog);
        } catch (e) {
            this.wlog.warn(`HostMonitor ${this.host.email}: login failed: ${e.message} — degrading`);
            this._setDegraded();
            return;
        }
        try {
            await this._scrapeOnce();  // initial calibration
        } catch (_) {
            // counted by _scrapeOnce; may already be degraded if maxScrapeFails=1
        }
        this._scheduleNext();
    }

    _scheduleNext() {
        if (this.stopped || this.degraded) return;
        this._timer = setTimeout(() => {
            this._scrapeOnce().catch(() => {}).finally(() => this._scheduleNext());
        }, this.intervalMs);
    }

    async _scrapeOnce() {
        try {
            const result = await this.scrapeFn(this.page, this.wlog);
            this._consecutiveFails = 0;
            this._applyScrape(result);
            this.emit('scrape-done', result);
        } catch (e) {
            this._consecutiveFails++;
            this.wlog.warn(`HostMonitor ${this.host.email}: scrape #${this._consecutiveFails} failed: ${e.message}`);
            if (this._consecutiveFails >= this.maxScrapeFails) {
                this._setDegraded();
            }
            throw e;
        }
    }

    _applyScrape({ pending, joinedHrefs }) {
        const pendingHrefs = new Set((pending || []).map(p => p.href));
        const joinedSet = new Set(joinedHrefs || []);

        // Update every known email in state
        for (const email of Object.keys(this.state)) {
            const entry = this.state[email];
            if (!entry.href) continue;  // no way to track this email
            if (pendingHrefs.has(entry.href)) {
                entry.status = 'pending';
                entry.lastSeenAt = Date.now();
            } else if (joinedSet.has(entry.href)) {
                entry.status = 'joined';
                entry.lastSeenAt = Date.now();
            } else {
                // href gone from both lists; keep last known status but mark lastSeenAt unchanged
                entry.status = 'unknown';
            }
        }

        // Newly visible pending emails we didn't know about — add them (best-effort)
        for (const p of pending || []) {
            if (!p.email) continue;
            if (!this.state[p.email]) {
                this.state[p.email] = { status: 'pending', href: p.href, lastSeenAt: Date.now() };
            }
        }
    }

    _setDegraded() {
        if (this.degraded) return;
        this.degraded = true;
        if (this._timer) { clearTimeout(this._timer); this._timer = null; }
        this.emit('degraded');
    }

    async stop() {
        this.stopped = true;
        if (this._timer) { clearTimeout(this._timer); this._timer = null; }
    }
}

/**
 * Subscribe to a HostMonitor and resolve when:
 *   - hm.state[email].status === 'joined' → returns 'joined'
 *   - hm fires 'degraded' or is already degraded → returns 'degraded'
 *   - timeoutMs elapses → returns current status ('pending'|'unknown') or 'timeout' if unknown-email
 */
function awaitHostConfirmation(hm, email, { timeoutMs }) {
    return new Promise((resolve) => {
        // Fast paths
        const cur = hm.state[email];
        if (cur && cur.status === 'joined') return resolve('joined');
        if (hm.degraded) return resolve('degraded');

        let settled = false;
        const finish = (v) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            hm.off('scrape-done', onScrape);
            hm.off('degraded', onDegrade);
            resolve(v);
        };
        const onScrape = () => {
            const s = hm.state[email];
            if (s && s.status === 'joined') finish('joined');
        };
        const onDegrade = () => finish('degraded');
        const timer = setTimeout(() => {
            const s = hm.state[email];
            finish(s ? s.status : 'timeout');
        }, timeoutMs);

        hm.on('scrape-done', onScrape);
        hm.on('degraded', onDegrade);
    });
}

module.exports = { HostMonitor, awaitHostConfirmation, DEFAULT_POLL_INTERVAL_MS };
```

- [ ] **Step 4: 跑测试全绿**

Run: `cd src && node --test stages/accept/host-monitor.test.js`
Expected: `# pass 7` and `# fail 0`. All 7 tests green.

- [ ] **Step 5: Commit**

```bash
git add src/stages/accept/host-monitor.js src/stages/accept/host-monitor.test.js
git commit -m "feat(stage2): HostMonitor + awaitHostConfirmation with fake-injected tests

Dedicated-Chrome host monitor keeps host logged in, polls family/details
on a configurable interval (default 60s), and emits scrape-done events.
awaitHostConfirmation() resolves 'joined' as soon as state flips, or the
final state on timeout, or 'degraded' when monitor can't run.

Login failure and 3 consecutive scrape errors both trigger degraded mode
(callers fall back gracefully). All lifecycle and edge cases unit tested
with injected fake scrape/login."
```

---

## Task 4: `member-worker.js` — 把 `acceptInvite` 搬过去（接口不变）

**Files:**
- Create: `src/stages/accept/member-worker.js`

- [ ] **Step 1: Read `src/2_accept.js:1-881` (the entire acceptInvite definition + its imports)**

Confirm the function signature `async function acceptInvite(memberAccount, browser, workerId)` and every helper/const used inside it.

- [ ] **Step 2: 创建 `member-worker.js`，精确搬运**

读取 `src/2_accept.js` 三段并拼接：

**段 A — 顶部 require 和常量（`2_accept.js:1-136`）**  Read 这一段，拷到 member-worker.js 顶部，然后把 require 路径从 `'./common/chrome'` / `'./common/google-login'` / `'./common/logger'` / `'./common/state'` / `'./db/*'` 相应改成 `'../../common/chrome'` / `'../../common/google-login'` / `'../../common/logger'` / `'../../common/state'` / `'../../db/*'`。

如果 `2_accept.js:1-136` 里含任何 DB 相关 require（`require('./db/members')` 或 `require('./db/events')`），**删除**这些 require —— member-worker.js 只做浏览器动作不写 DB。

**段 B — `acceptInvite` 函数体及其所有私有辅助函数（`2_accept.js:138-881`）**  Read 这一整段，完全 verbatim 拷到 member-worker.js 段 A 下方。不改函数签名（`acceptInvite(memberAccount, browser, workerId)`），不改内部逻辑。

**段 C — 文件尾部的 exports**  替换成：

```js
module.exports = { acceptInvite };
```

**完全不搬**的：`2_accept.js:882-981` —— 那里是 DB-backed `runStage2`、`cleanupWorkers2`、`_workers2`、CLI 入口块，这些由新 `index.js` 重写。

**验证搬过去后 member-worker.js 能被加载**（下面 Step 3 做）。

如果段 A 搬过来后发现 member-worker.js 里有未使用的 import，Node 不会报错但会拖慢启动 —— 建议实现后 grep 一遍移除 `require` 之后没被函数体引用到的名字。

- [ ] **Step 3: 验证文件结构**

Run: `cd src && node -e "const m = require('./stages/accept/member-worker'); console.log(typeof m.acceptInvite);"`
Expected: `function`

- [ ] **Step 4: Commit**

```bash
git add src/stages/accept/member-worker.js
git commit -m "refactor(stage2): move acceptInvite to stages/accept/member-worker.js

Verbatim move of the member-side flow (Gmail login + invite email search +
click + verify) from 2_accept.js. No behavior change. Lets stages/accept/
index.js consume it without the old 981-line omnibus file."
```

---

## Task 5: `stages/accept/index.js` — 新 runStage2（串起 monitor + worker + decide）

**Files:**
- Create: `src/stages/accept/index.js`

- [ ] **Step 1: 实现 `index.js`**

```js
/**
 * stages/accept/index.js — runStage2 orchestration.
 *
 * Per host (sequential):
 *   1. Launch host-monitor Chrome (separate user-data-dir + debug port)
 *   2. HostMonitor.start() — login + initial calibration scrape
 *   3. Launch member worker Chromes per concurrency
 *   4. Member loop: for each member of this host,
 *      run acceptInvite → awaitHostConfirmation(2min) → decide → write DB+event
 *   5. Final scrape (one extra poll tick)
 *   6. Stop monitor + teardown member workers
 *
 * Inter-host boundary: fully tear down before starting the next host.
 */
const path = require('path');
const { log, createWorkerLogger } = require('../../common/logger');
const {
    sleep, rand, findChrome, launchRealChrome, restartChrome,
    isChromeAlive, newPage,
} = require('../../common/chrome');
const { googleLogin } = require('../../common/google-login');
const hostsDb = require('../../db/hosts');
const membersDb = require('../../db/members');
const eventsDb = require('../../db/events');

const { acceptInvite } = require('./member-worker');
const { HostMonitor, awaitHostConfirmation, DEFAULT_POLL_INTERVAL_MS } = require('./host-monitor');
const { scrapeFamilyListPage, FAMILY_URL } = require('./family-scrape-fast');
const { decide } = require('./decide');
const { scrapeFamilyMembers } = require('../reconcile');

const HOST_MONITOR_GRACE_MS = parseInt(process.env.HOST_MONITOR_GRACE_MS, 10) || 120_000;

async function launchHostMonitorChrome(chromePath, host, wlog) {
    const dataDir = path.resolve(__dirname, '..', '..', `chrome_data_temp_pipeline_H${host.id}`);
    const debugPort = (parseInt(process.env.DEBUG_PORT, 10) || 9234) + 100 + (host.id % 50);
    const chrome = await launchRealChrome(chromePath, 'H', { dataDir, debugPort });
    return chrome;
}

async function initialFamilyMap(page, wlog) {
    // Use reconcile's slow+thorough scraper once to establish {email → {status, href}}.
    // This gives us the email↔href mapping for already-joined members, which the
    // fast scraper can't provide.
    const members = await scrapeFamilyMembers(page, wlog);  // [{email, href, name, isPending}]
    const map = {};
    for (const m of members || []) {
        if (!m.email) continue;
        map[m.email.toLowerCase()] = {
            status: m.isPending ? 'pending' : 'joined',
            href: m.href,
            lastSeenAt: Date.now(),
        };
    }
    return map;
}

async function processOneMember(member, worker, hm, chromePath, wlog, runId) {
    const memberAccount = {
        idx: member.id, email: member.email, pass: member.password,
        recovery: member.recovery_email || '',
        totp_secret: member.totp_secret || undefined,
    };

    await eventsDb.logEvent({
        memberId: member.id, hostId: member.host_id, runId,
        stage: 'stage2', eventType: 'start',
    });

    let flowResult = null, flowError = null;
    try {
        const alive = await isChromeAlive(worker);
        if (!alive) await restartChrome(chromePath, worker);
        const hardTimeoutMs = parseInt(process.env.ACCEPT_HARD_TIMEOUT_MS, 10)
            || (parseInt(process.env.INVITE_WAIT_TIMEOUT, 10) || 300) * 1000 + 300_000;
        flowResult = await Promise.race([
            acceptInvite(memberAccount, worker.browser, worker.id),
            new Promise((_, rej) => setTimeout(() => rej(new Error(`hard_timeout ${hardTimeoutMs}ms`)), hardTimeoutMs)),
        ]);
    } catch (e) {
        flowError = e;
    }

    const hostStatus = await awaitHostConfirmation(hm, member.email.toLowerCase(), {
        timeoutMs: HOST_MONITOR_GRACE_MS,
    });

    const dec = decide({ flowResult, flowError, hostStatus });

    if (dec.finalStatus === 'done') {
        await membersDb.transitionToJoined(member.id);
    } else {
        await membersDb.transitionToFailed(member.id, {
            newStatus: 'accept_failed',
            error: dec.message || 'stage2 failed',
            releaseHost: false,
        });
    }
    await eventsDb.logEvent({
        memberId: member.id, hostId: member.host_id, runId,
        stage: 'stage2', eventType: dec.eventType, message: dec.message,
    });

    wlog.info(`  decide: ${member.email} → ${dec.finalStatus}/${dec.eventType}`);
    return dec;
}

async function processOneHost({ host, members, concurrency, runId, chromePath }) {
    const wlog = createWorkerLogger(`H${host.id}`);
    wlog.info(`Stage2 host ${host.email}: ${members.length} pending member(s)`);

    // 1. Host monitor Chrome
    let hmChrome;
    try {
        hmChrome = await launchHostMonitorChrome(chromePath, host, wlog);
    } catch (e) {
        wlog.warn(`Could not launch host monitor Chrome: ${e.message}; falling back to no-monitor mode`);
        // Degraded-from-start: still run members but with hostStatus='degraded' everywhere
        return runHostWithoutMonitor({ host, members, concurrency, runId, chromePath });
    }
    const hmPage = await newPage(hmChrome.browser);

    const hostAccount = { email: host.email, pass: host.password, recovery: host.recovery_email || '', totp_secret: host.totp_secret || undefined };
    const initialMap = {};
    const hm = new HostMonitor({
        host,
        browser: hmChrome.browser,
        page: hmPage,
        loginFn: async (page) => {
            await googleLogin(page, hostAccount, wlog);
            await page.goto(FAMILY_URL, { waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {});
            // Calibration: populate initial email→href map using the slow scraper ONCE
            const cal = await initialFamilyMap(page, wlog);
            Object.assign(initialMap, cal);
            Object.assign(hm.state, cal);
        },
        scrapeFn: async (page) => scrapeFamilyListPage(page, wlog),
        wlog,
        initialFamilyMap: {},
    });
    await hm.start();

    // 2. Member workers
    const workers = [];
    for (let w = 0; w < Math.min(concurrency, members.length); w++) {
        const wChrome = await launchRealChrome(chromePath, w);
        workers.push({ id: w, ...wChrome });
        if (w < concurrency - 1) await sleep(rand(2000, 3000));
    }

    // 3. Member loop
    let idx = 0;
    const stats = { ok: 0, ng: 0 };
    async function workerFn(worker) {
        const wl = createWorkerLogger(worker.id);
        while (true) {
            const i = idx++;
            if (i >= members.length) break;
            const m = members[i];
            try {
                const dec = await processOneMember(m, worker, hm, chromePath, wl, runId);
                if (dec.finalStatus === 'done') stats.ok++; else stats.ng++;
            } catch (e) {
                wl.error(`Stage2 [${m.email}]: ${e.message}`);
                stats.ng++;
            }
            await sleep(rand(1000, 2000));
        }
    }
    await Promise.all(workers.map(w => workerFn(w)));

    // 4. Final scrape tick before teardown (one extra poll interval max)
    try {
        await new Promise((resolve) => {
            const to = setTimeout(resolve, Math.min(hm.intervalMs + 2000, 10_000));
            hm.once('scrape-done', () => { clearTimeout(to); resolve(); });
        });
    } catch (_) {}

    // 5. Teardown
    await hm.stop();
    try { hmChrome.browser.close(); } catch (_) {}
    try { hmChrome.proc.kill(); } catch (_) {}
    for (const w of workers) {
        try { w.browser.close(); } catch (_) {}
        try { w.proc.kill(); } catch (_) {}
    }
    return stats;
}

// Fallback when monitor Chrome itself can't even launch.
async function runHostWithoutMonitor({ host, members, concurrency, runId, chromePath }) {
    const wlog = createWorkerLogger(`H${host.id}`);
    const workers = [];
    for (let w = 0; w < Math.min(concurrency, members.length); w++) {
        const wChrome = await launchRealChrome(chromePath, w);
        workers.push({ id: w, ...wChrome });
        if (w < concurrency - 1) await sleep(rand(2000, 3000));
    }
    const fakeHm = { state: {}, degraded: true, on() {}, off() {}, once() {} };
    let idx = 0;
    const stats = { ok: 0, ng: 0 };
    await Promise.all(workers.map(async (worker) => {
        const wl = createWorkerLogger(worker.id);
        while (true) {
            const i = idx++;
            if (i >= members.length) break;
            const m = members[i];
            try {
                const dec = await processOneMember(m, worker, fakeHm, chromePath, wl, runId);
                if (dec.finalStatus === 'done') stats.ok++; else stats.ng++;
            } catch (e) {
                wl.error(`Stage2 [${m.email}]: ${e.message}`);
                stats.ng++;
            }
            await sleep(rand(1000, 2000));
        }
    }));
    for (const w of workers) {
        try { w.browser.close(); } catch (_) {}
        try { w.proc.kill(); } catch (_) {}
    }
    return stats;
}

async function runStage2({ runId, concurrency = 1, hostIds } = {}) {
    const chromePath = findChrome();
    if (!chromePath) throw new Error('Chrome not found');

    const work = await membersDb.listMembersForStage(2, { hostIds });
    log(`Stage2: ${work.length} pending acceptance(s) across ${new Set(work.map(m => m.host_id)).size} host(s)`);
    if (!work.length) return { ok: 0, ng: 0 };

    // Group members by host; process hosts sequentially.
    const byHost = new Map();
    for (const m of work) {
        if (!byHost.has(m.host_id)) byHost.set(m.host_id, []);
        byHost.get(m.host_id).push(m);
    }

    const overall = { ok: 0, ng: 0 };
    for (const [hostId, members] of byHost) {
        const host = await hostsDb.getHostById(hostId);
        if (!host) { log(`Stage2: host ${hostId} not found in DB, skipping`, 'WARN'); continue; }
        try {
            const stats = await processOneHost({ host, members, concurrency, runId, chromePath });
            overall.ok += stats.ok;
            overall.ng += stats.ng;
        } catch (e) {
            log(`Stage2 host ${host.email}: ${e.message}`, 'ERROR');
            overall.ng += members.length;
        }
    }

    log(`Stage2 done: OK=${overall.ok} FAIL=${overall.ng}`, 'SUCCESS');
    return overall;
}

module.exports = { runStage2, acceptInvite };
```

- [ ] **Step 2: 校对 — 确保与 `2_accept.js` 的 `runStage2` 外部接口一致**

Run:
```
cd src && node -e "
const n = require('./stages/accept');
console.log('exports:', Object.keys(n));
console.log('runStage2 sig ok:', n.runStage2.length >= 1);
console.log('acceptInvite sig ok:', n.acceptInvite.length >= 1);
"
```
Expected: `exports: [ 'runStage2', 'acceptInvite' ]`, both length checks OK.

- [ ] **Step 3: Commit**

```bash
git add src/stages/accept/index.js
git commit -m "feat(stage2): runStage2 orchestration with per-host host-monitor

New runStage2: groups members by host, processes hosts sequentially. Per
host: launch dedicated monitor Chrome (login + initial reconcile-based
calibration of email↔href map), launch member workers, run flow, on each
member's completion awaitHostConfirmation(2min), apply decide() outcome
to DB+events, tear down monitor + workers before next host.

Falls back to monitor-less mode when the monitor Chrome itself can't
launch — equivalent to the pre-change behavior plus accept_failed_\
unconfirmed diagnostic events, never worse."
```

---

## Task 6: `2_accept.js` 变 shim（保持兼容）

**Files:**
- Modify: `src/2_accept.js` (overwrite with shim)

- [ ] **Step 1: 先确认谁在 `require('./2_accept')`**

Run:
```
cd src && grep -rn "require.*2_accept\|require.*['\"]\\./2_accept['\"]" --include='*.js' .
```
Expected: at least `orchestrator.js` should show. Note all paths.

- [ ] **Step 2: 把 `src/2_accept.js` 整个文件替换成 shim**

Use `Write` to overwrite (no Read-first requirement since this is a full rewrite — but per your tool guidance, you need to Read first):

```js
/**
 * 2_accept.js — historical entrypoint.
 *
 * The implementation now lives in src/stages/accept/. This file is a shim
 * preserving require('./2_accept') compatibility for orchestrator.js and
 * any callers that haven't been updated.
 */
module.exports = require('./stages/accept');

// CLI entry — delegate to stages/accept via dynamic import if run directly
if (require.main === module) {
    const { runStage2 } = require('./stages/accept');
    let cli_concurrency = parseInt(process.env.CONCURRENCY, 10) || 1;
    const argv_ = process.argv.slice(2);
    for (let i = 0; i < argv_.length; i++) {
        if ((argv_[i] === '--concurrency' || argv_[i] === '-c') && argv_[i + 1]) {
            cli_concurrency = parseInt(argv_[i + 1], 10) || cli_concurrency;
        }
    }
    runStage2({ runId: null, concurrency: cli_concurrency })
        .then(() => process.exit(0))
        .catch((e) => { console.error(e.stack || e.message); process.exit(1); });
}
```

- [ ] **Step 3: 验证 shim**

Run:
```
cd src && node -e "
const s = require('./2_accept');
console.log('exports:', Object.keys(s));
console.log('runStage2?', typeof s.runStage2);
console.log('acceptInvite?', typeof s.acceptInvite);
"
```
Expected: `runStage2 function`, `acceptInvite function`.

Also: run existing unit tests to catch any regressions.
```
cd src && node --test stages/accept/decide.test.js stages/accept/family-scrape-fast.test.js stages/accept/host-monitor.test.js
```
Expected: all green.

- [ ] **Step 4: Commit**

```bash
git add src/2_accept.js
git commit -m "refactor(stage2): reduce 2_accept.js to shim over stages/accept/

Preserves require('./2_accept') for orchestrator.js and any other caller.
CLI entry still works. The 981-line original is now split into 5 focused
files under src/stages/accept/."
```

---

## Task 7: 端到端手工验证

**Files:** 无代码改动；验证 Task 1–6 合在一起是否 work。

- [ ] **Step 1: 预处理 —— 让目标 host 下有真的 `invite_pending` 成员**

这一步依赖实际环境状态。用 API/UI 手动调一个 host（比如 `surendarkumar987654322@gmail.com`）让它有 ≥2 个 `invite_pending` 成员，且其中至少 1 个在 Google 家庭组里其实已经 joined（模拟"表面失败实际成功" case）、至少 1 个是真 pending。

```
curl -s "http://127.0.0.1:3000/api/members?host_id=<HOST_ID>"
# 对需要的 member 行：
curl -X PATCH http://127.0.0.1:3000/api/members/<MEMBER_ID> \
    -H 'Content-Type: application/json' \
    -d '{"status":"invite_pending"}'
```

- [ ] **Step 2: 清理 Chrome 锁 + 启动 server + 跑 stage 2**

```
rm -f src/chrome_data_temp_pipeline_0/Singleton* src/chrome_data_temp_pipeline_H*/Singleton*
# server 已跑则跳过
curl -s -X POST http://127.0.0.1:3000/api/pipeline/start \
    -H 'Content-Type: application/json' \
    -d '{"stages":"2","hostFilter":["surendarkumar987654322@gmail.com"],"concurrency":1,"removeUnknown":false}'
```

记下返回的 runId。

- [ ] **Step 3: 观察事件流**

```
sleep 180  # 3 分钟后开始轮询
until s=$(curl -s http://127.0.0.1:3000/api/pipeline/runs/<runId> | python3 -c "import sys,json;d=json.load(sys.stdin);print(d.get('status'))"); [ "$s" != "running" ]; do sleep 30; echo "  ...$s"; done
curl -s http://127.0.0.1:3000/api/pipeline/runs/<runId> | python3 -m json.tool
```

- [ ] **Step 4: 校验事件类型**

events 里应该看到至少一种新事件类型：`success`, `accept_failed_unconfirmed`, 或 `fail`（带原 flow error）。对于"模拟表面失败实际成功"那个 member，期望：
- 如果 flow 抛错但 host 翻 joined：event `success`、message 包含 `"flow threw: ... but host confirmed joined"`
- 如果 flow OK 但 host 2 分钟没翻：event `accept_failed_unconfirmed`、members.status = `accept_failed`

校验 server log 含 host-monitor 相关行，例如 `HostMonitor <email>: scrape #...`。

- [ ] **Step 5: Commit 一条空 commit 或不 commit（记录验证通过）**

如果全过，不产生代码改动，跳过 commit。如果测试过程中发现需要调整，回对应 Task 修。

---

## 自检清单

- [ ] `src/stages/accept/` 包含：`decide.js decide.test.js family-scrape-fast.js family-scrape-fast.test.js host-monitor.js host-monitor.test.js member-worker.js index.js`
- [ ] `cd src && node --test stages/accept/*.test.js` — 至少 17 个测试全绿（decide 6 + family-scrape-fast 4 + host-monitor 7）
- [ ] `src/2_accept.js` 少于 30 行，只是 shim
- [ ] `src/orchestrator.js` 原样未动（它用 `require('./2_accept')` 依然工作）
- [ ] `src/stages/reconcile.js` 原样未动
- [ ] 手工端到端至少观察到一次 `accept_failed_unconfirmed` 或 "flow threw but host confirmed" 场景
- [ ] 每 Task 一个 commit，commit 信息说明 "why"（对应 spec 段落）
