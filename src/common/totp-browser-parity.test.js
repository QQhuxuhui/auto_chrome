// Parity test: public/js/totp.js (Web Crypto) must produce the same code as
// src/common/totp.js (Node crypto) for the same secret + time.
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const { generateTOTP: nodeGenerateTOTP } = require('./totp');
// Load the browser file as a CommonJS module — it UMD-exports when module.exports exists.
const browserTOTP = require(path.resolve(__dirname, '..', '..', 'public', 'js', 'totp.js'));

// A handful of realistic 32-char base32 secrets (the Google fa_secret format).
const SECRETS = [
    'JBSWY3DPEHPK3PXP',                  // "Hello!\xde\xad\xbe\xef" — RFC sample
    'sn3rjepz4rwqpweuomy5x4w2lcwyufg2',  // lowercase — tests case-insensitivity
    'EG472ZWEWKZ5PWDAIF6DKEMUTKEMO73Z',
    'YAGAZNJCXD2QCX4FQMSSPLOAIA2LIFK7',
];

test('browser TOTP matches Node TOTP across several secrets (sampled at the current 30s window)', async () => {
    for (const secret of SECRETS) {
        const expected = nodeGenerateTOTP(secret);
        const actual = await browserTOTP.generateTOTP(secret);
        assert.equal(actual, expected, `mismatch for secret=${secret}: node=${expected} browser=${actual}`);
    }
});

test('browser getTOTPWithTTL returns a remaining-seconds value in [1, 30]', async () => {
    const { code, remainingSeconds } = await browserTOTP.getTOTPWithTTL(SECRETS[0]);
    assert.match(code, /^\d{6}$/);
    assert.ok(remainingSeconds >= 1 && remainingSeconds <= 30, `ttl out of range: ${remainingSeconds}`);
});

test('browser base32Decode rejects invalid characters', () => {
    assert.throws(() => browserTOTP.base32Decode('NOT_BASE32!'), /Invalid base32 character/);
});
