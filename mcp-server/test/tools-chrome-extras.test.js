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
