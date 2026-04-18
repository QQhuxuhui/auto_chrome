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
