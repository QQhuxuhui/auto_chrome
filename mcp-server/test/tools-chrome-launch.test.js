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
