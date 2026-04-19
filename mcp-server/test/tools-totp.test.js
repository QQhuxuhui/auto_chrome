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

test('totp.generate throws TOTP_INVALID_SECRET on bad secret', async () => {
    const tools = registerTotpTools({ logger: createLogger('warn') });
    try {
        await tools['totp.generate'].handler({ secret: 'NOT-VALID-BASE32!!!' });
        assert.fail('expected throw');
    } catch (e) {
        assert.match(e.code || e.message, /TOTP_INVALID_SECRET/);
    }
});
