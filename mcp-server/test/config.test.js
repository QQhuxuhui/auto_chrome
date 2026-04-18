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

test('parseIntOr rejects malformed integers', () => {
    delete require.cache[require.resolve('../src/config')];
    process.env.MAX_SESSIONS = '5abc';
    const { loadConfig } = require('../src/config');
    assert.throws(() => loadConfig(), /Invalid integer for MAX_SESSIONS/);
    delete process.env.MAX_SESSIONS;
});

test('parseBool accepts truthy variants', () => {
    delete require.cache[require.resolve('../src/config')];
    for (const truthy of ['true', '1', 'yes', 'on', 'TRUE', 'Yes']) {
        process.env.KEEP_BROWSER_OPEN = truthy;
        delete require.cache[require.resolve('../src/config')];
        const { loadConfig } = require('../src/config');
        assert.equal(loadConfig().keepBrowserOpen, true, `expected truthy for ${truthy}`);
    }
    delete process.env.KEEP_BROWSER_OPEN;
});

test('parseBool throws on unrecognized values', () => {
    delete require.cache[require.resolve('../src/config')];
    process.env.KEEP_BROWSER_OPEN = 'maybe';
    const { loadConfig } = require('../src/config');
    assert.throws(() => loadConfig(), /Invalid boolean value/);
    delete process.env.KEEP_BROWSER_OPEN;
});

test('validateConfig throws when hero-sms selected without key', () => {
    const { validateConfig } = require('../src/config');
    assert.throws(
        () => validateConfig({ smsProvider: 'hero-sms', heroSmsApiKey: null }),
        /HERO_SMS_API_KEY.*required/,
    );
});

test('validateConfig passes when sms provider has key', () => {
    const { validateConfig } = require('../src/config');
    assert.doesNotThrow(() => validateConfig({ smsProvider: 'hero-sms', heroSmsApiKey: 'sk-x' }));
});
