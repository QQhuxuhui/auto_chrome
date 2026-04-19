const test = require('node:test');
const assert = require('node:assert/strict');
const { loadConfig } = require('../src/config');
const { createLogger } = require('../src/logger');
const { registerOauthTools } = require('../src/tools/oauth');

test('oauth.exchange_code uses env clientId/secret as fallback', async () => {
    process.env.CLIENT_ID = 'test.apps.googleusercontent.com';
    process.env.CLIENT_SECRET = 'test-secret';
    const cfg = loadConfig();
    const tools = registerOauthTools({ logger: createLogger('warn'), config: cfg });
    // Use an invalid code; Google will reject → OAUTH_TOKEN_EXCHANGE_FAILED.
    // Test verifies the error flows through correctly AND that env fallback was used
    // (if env weren't used, the tool would throw PRECONDITION_FAILED first).
    try {
        await tools['oauth.exchange_code'].handler({ code: 'invalid', redirectUri: 'http://localhost:18900/callback' });
        assert.fail('expected failure');
    } catch (e) {
        const msg = e.code || e.message || '';
        assert.ok(/OAUTH_TOKEN_EXCHANGE_FAILED/.test(msg), `expected OAUTH_TOKEN_EXCHANGE_FAILED, got ${msg}`);
    } finally {
        delete process.env.CLIENT_ID;
        delete process.env.CLIENT_SECRET;
    }
});

test('oauth.exchange_code throws PRECONDITION_FAILED when no clientId available', async () => {
    delete process.env.CLIENT_ID;
    delete process.env.CLIENT_SECRET;
    const cfg = loadConfig();
    const tools = registerOauthTools({ logger: createLogger('warn'), config: cfg });
    try {
        await tools['oauth.exchange_code'].handler({ code: 'x', redirectUri: 'http://localhost:18900/callback' });
        assert.fail('expected PRECONDITION_FAILED');
    } catch (e) {
        const msg = e.code || e.message || '';
        assert.ok(/PRECONDITION_FAILED/.test(msg), `expected PRECONDITION_FAILED, got ${msg}`);
    }
});
