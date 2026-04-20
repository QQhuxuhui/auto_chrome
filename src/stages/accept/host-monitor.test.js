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
        intervalMs: 50_000,
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
    deps.setScrape(async () => ({
        pending: [{ href: '/family/invitation/i1', email: 'foo@bar.com' }],
        joinedHrefs: [],
        scrapedAt: Date.now(),
    }));
    let events = 0;
    hm.on('scrape-done', () => events++);
    await hm.start();
    assert.equal(hm.state['foo@bar.com'].status, 'pending');

    deps.setScrape(async () => ({
        pending: [],
        joinedHrefs: ['/family/invitation/i1'],
        scrapedAt: Date.now(),
    }));
    await new Promise(r => setTimeout(r, 40));
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
    await hm.start();
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
    assert.equal(status, 'pending');
});

test('triggerScrape forces a scrape immediately without waiting for interval', async () => {
    const deps = mkFakeDeps();
    const hm = new HostMonitor({
        host: { id: 1, email: 'h@x.com' },
        fakeBrowser: {}, fakePage: {},
        loginFn: deps.loginFn, scrapeFn: deps.scrapeFn,
        intervalMs: 60_000,  // way longer than test will take
        initialFamilyMap: {},
    });
    await hm.start();
    const before = deps.scrapeCalls;  // typically 1 from start()
    await hm.triggerScrape();
    const after = deps.scrapeCalls;
    await hm.stop();
    assert.equal(after, before + 1, `expected +1 scrape from triggerScrape, got ${after - before}`);
});

test('triggerScrape cancels scheduled timer so there is no overlap', async () => {
    const deps = mkFakeDeps();
    const hm = new HostMonitor({
        host: { id: 1, email: 'h@x.com' },
        fakeBrowser: {}, fakePage: {},
        loginFn: deps.loginFn, scrapeFn: deps.scrapeFn,
        intervalMs: 30,
        initialFamilyMap: {},
    });
    await hm.start();
    // start() → initial scrape (1) + schedules next. Immediately triggerScrape (2).
    // The original scheduled one should have been cancelled, so next fires ≥30ms after trigger.
    await hm.triggerScrape();
    const afterTrigger = deps.scrapeCalls;
    // Wait shorter than interval — no additional scrapes from overlap.
    await new Promise(r => setTimeout(r, 10));
    await hm.stop();
    assert.equal(deps.scrapeCalls, afterTrigger,
        `no extra scrape within 10ms of triggerScrape; got ${deps.scrapeCalls - afterTrigger}`);
});

test('triggerScrape awaits an already in-flight scrape instead of starting a parallel one', async () => {
    // Model real Puppeteer: two concurrent scrapes on the same page produce races.
    let inFlight = 0, maxInFlight = 0, scrapeCalls = 0;
    let unblock = null;
    const blockingScrape = async () => {
        scrapeCalls++;
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise(r => { unblock = r; });
        inFlight--;
        return { pending: [], joinedHrefs: [], scrapedAt: Date.now() };
    };
    const hm = new HostMonitor({
        host: { id: 1, email: 'h@x.com' },
        fakeBrowser: {}, fakePage: {},
        loginFn: async () => {},
        scrapeFn: blockingScrape,
        intervalMs: 60_000,
        initialFamilyMap: {},
    });
    // start() kicks off scrape #1, which is still blocked because we haven't called unblock().
    const startP = hm.start();
    await new Promise(r => setTimeout(r, 10));
    assert.equal(inFlight, 1, 'start()ed scrape should be mid-flight');

    // triggerScrape while another is in-flight should not spawn a second.
    const trigP = hm.triggerScrape();
    await new Promise(r => setTimeout(r, 10));
    assert.equal(maxInFlight, 1, `expected maxInFlight=1, got ${maxInFlight}`);

    // Release the single in-flight scrape, both awaits resolve from the same promise.
    unblock();
    await Promise.all([startP, trigP]);
    await hm.stop();
    // scrapeCalls could be 1 (perfect reuse) or 2 (trigger ran after first resolved).
    // Either is acceptable — the important invariant is no overlap.
});

test('triggerScrape is a no-op on degraded monitor', async () => {
    const hm = new HostMonitor({
        host: { id: 1, email: 'h@x.com' },
        fakeBrowser: {}, fakePage: {},
        loginFn: async () => { throw new Error('boom'); },
        scrapeFn: async () => ({ pending: [], joinedHrefs: [], scrapedAt: Date.now() }),
        intervalMs: 1000,
        initialFamilyMap: {},
    });
    await hm.start();  // login throws → degraded
    assert.equal(hm.degraded, true);
    let scrapes = 0;
    const origScrapeFn = hm.scrapeFn;
    hm.scrapeFn = async (p) => { scrapes++; return origScrapeFn(p); };
    await hm.triggerScrape();
    assert.equal(scrapes, 0);
    await hm.stop();
});

test('awaitHostConfirmation returns degraded immediately when monitor is degraded', async () => {
    const { awaitHostConfirmation } = require('./host-monitor');
    const hm = new HostMonitor({
        host: { id: 1, email: 'h@x.com' },
        fakeBrowser: {}, fakePage: {},
        loginFn: async () => { throw new Error('no'); },
        scrapeFn: async () => ({ pending: [], joinedHrefs: [], scrapedAt: Date.now() }),
        intervalMs: 1000,
        initialFamilyMap: {},
    });
    await hm.start();
    const status = await awaitHostConfirmation(hm, 'foo@x.com', { timeoutMs: 100 });
    await hm.stop();
    assert.equal(status, 'degraded');
});
