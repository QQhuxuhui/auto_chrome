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
