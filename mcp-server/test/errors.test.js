const test = require('node:test');
const assert = require('node:assert/strict');

test('McpError carries code + message', () => {
    const { McpError, CODES } = require('../src/errors');
    const e = new McpError(CODES.SESSION_NOT_FOUND, 'no such session: sess_x');
    assert.equal(e.code, 'SESSION_NOT_FOUND');
    assert.equal(e.message, 'no such session: sess_x');
    assert.ok(e instanceof Error);
});

test('all 14 codes defined', () => {
    const { CODES } = require('../src/errors');
    const expected = [
        'CHROME_LAUNCH_FAILED', 'CHROME_PROTOCOL_ERROR', 'SESSION_NOT_FOUND',
        'GOOGLE_LOGIN_REJECTED', 'GOOGLE_LOGIN_STUCK', 'GOOGLE_CHALLENGE_UNSUPPORTED',
        'OAUTH_CODE_NOT_RECEIVED', 'OAUTH_TOKEN_EXCHANGE_FAILED',
        'SMS_BALANCE_INSUFFICIENT', 'SMS_TIMEOUT', 'SMS_PROVIDER_ERROR',
        'TOTP_INVALID_SECRET', 'CONCURRENCY_LIMIT_EXCEEDED',
        'TIMEOUT', 'PRECONDITION_FAILED',
    ];
    for (const k of expected) assert.equal(CODES[k], k, `missing code ${k}`);
});
