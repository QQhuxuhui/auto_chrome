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
