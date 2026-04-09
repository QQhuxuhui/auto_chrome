const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
    accountName,
    parseSub2apiConfig,
    shouldForceReauth,
    extractValidationUrl,
} = require('./3_sub2api');

// ============ accountName ============
test('accountName: canonical case', () => {
    assert.strictEqual(
        accountName('BrinaSzreder470@gmail.com', 'chauanh2083@gmail.com'),
        'ultra_BrinaSzreder470_chauanh2083'
    );
});

test('accountName: preserves case of local parts', () => {
    assert.strictEqual(
        accountName('FooBar@x.com', 'BazQux@y.com'),
        'ultra_FooBar_BazQux'
    );
});

test('accountName: local part with dot', () => {
    assert.strictEqual(
        accountName('first.last@gmail.com', 'a.b.c@gmail.com'),
        'ultra_first.last_a.b.c'
    );
});

test('accountName: local part with plus tag', () => {
    assert.strictEqual(
        accountName('user+tag@gmail.com', 'child+1@gmail.com'),
        'ultra_user+tag_child+1'
    );
});

// ============ parseSub2apiConfig ============
function writeTmp(content) {
    const p = path.join(os.tmpdir(), `sub2api_cfg_${Date.now()}_${Math.random().toString(36).slice(2)}.txt`);
    fs.writeFileSync(p, content, 'utf-8');
    return p;
}

test('parseSub2apiConfig: well-formed', () => {
    const p = writeTmp('url=http://example.com:3001\napi_key=abc123\n');
    assert.deepStrictEqual(parseSub2apiConfig(p), {
        url: 'http://example.com:3001',
        apiKey: 'abc123',
    });
    fs.unlinkSync(p);
});

test('parseSub2apiConfig: ignores blank lines and comments', () => {
    const p = writeTmp('# comment line\n\nurl=http://x\n# another\napi_key=k\n\n');
    assert.deepStrictEqual(parseSub2apiConfig(p), {
        url: 'http://x',
        apiKey: 'k',
    });
    fs.unlinkSync(p);
});

test('parseSub2apiConfig: tolerates BOM and CRLF', () => {
    const p = writeTmp('\uFEFFurl=http://x\r\napi_key=k\r\n');
    assert.deepStrictEqual(parseSub2apiConfig(p), {
        url: 'http://x',
        apiKey: 'k',
    });
    fs.unlinkSync(p);
});

test('parseSub2apiConfig: value may contain equals sign', () => {
    const p = writeTmp('url=http://x\napi_key=abc=def=ghi\n');
    assert.strictEqual(parseSub2apiConfig(p).apiKey, 'abc=def=ghi');
    fs.unlinkSync(p);
});

test('parseSub2apiConfig: throws when url missing', () => {
    const p = writeTmp('api_key=abc\n');
    assert.throws(() => parseSub2apiConfig(p), /url/);
    fs.unlinkSync(p);
});

test('parseSub2apiConfig: throws when api_key missing', () => {
    const p = writeTmp('url=http://x\n');
    assert.throws(() => parseSub2apiConfig(p), /api_key/);
    fs.unlinkSync(p);
});

test('parseSub2apiConfig: throws when file missing', () => {
    assert.throws(() => parseSub2apiConfig('/nonexistent/__none__.txt'), /not found/i);
});

// ============ shouldForceReauth ============
test('shouldForceReauth: --reauth-all matches anything', () => {
    assert.strictEqual(shouldForceReauth('x@y.com', { reauthAll: true, reauthList: [] }), true);
});

test('shouldForceReauth: email in list matches (case-insensitive)', () => {
    assert.strictEqual(
        shouldForceReauth('Foo@Bar.com', { reauthAll: false, reauthList: ['foo@bar.com'] }),
        true
    );
});

test('shouldForceReauth: email not in list', () => {
    assert.strictEqual(
        shouldForceReauth('x@y.com', { reauthAll: false, reauthList: ['a@b.com'] }),
        false
    );
});

test('shouldForceReauth: empty list, no flag', () => {
    assert.strictEqual(
        shouldForceReauth('x@y.com', { reauthAll: false, reauthList: [] }),
        false
    );
});

// ============ extractValidationUrl ============

// Real fixture captured from a 403 VALIDATION_REQUIRED response.
const realValidationUrl = 'https://accounts.google.com/signin/continue?sarp=1&scc=1&continue=https://developers.google.com/gemini-code-assist/auth/auth_success_gemini&plt=AKgnsbttubjUg1jPxV7c4gSf2Qx1eVznehhjM_aLw02q0z9WtiVGekFzw7QIxfRrcCDMBeavu88k3bOFyOxZHTO3h_udUjeoU7iscCLS6sNuZrtP2eIJhbSQSmOskmpMGbUqoXV887PA&flowName=GlifWebSignIn&authuser';

const real403ErrorPayload = {
    error: {
        code: 403,
        message: 'Verify your account to continue.',
        status: 'PERMISSION_DENIED',
        details: [
            {
                '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
                reason: 'VALIDATION_REQUIRED',
                domain: 'cloudcode-pa.googleapis.com',
                metadata: {
                    validation_error_message: 'Verify your account to continue.',
                    validation_url_link_text: 'Verify your account',
                    validation_url: realValidationUrl,
                    validation_learn_more_link_text: 'Learn more',
                    validation_learn_more_url: 'https://support.google.com/accounts?p=al_alert',
                },
            },
            {
                '@type': 'type.googleapis.com/google.rpc.Help',
                links: [
                    { description: 'Verify your account', url: realValidationUrl },
                    { description: 'Learn more', url: 'https://support.google.com/accounts?p=al_alert' },
                ],
            },
        ],
    },
};

test('extractValidationUrl: real 403 VALIDATION_REQUIRED (half-width colon)', () => {
    const errStr = `API 返回 403: ${JSON.stringify(real403ErrorPayload)}`;
    assert.strictEqual(extractValidationUrl(errStr), realValidationUrl);
});

test('extractValidationUrl: real 403 VALIDATION_REQUIRED (full-width colon)', () => {
    const errStr = `API 返回 403：${JSON.stringify(real403ErrorPayload)}`;
    assert.strictEqual(extractValidationUrl(errStr), realValidationUrl);
});

test('extractValidationUrl: bare JSON without "API 返回" prefix', () => {
    const errStr = JSON.stringify(real403ErrorPayload);
    assert.strictEqual(extractValidationUrl(errStr), realValidationUrl);
});

test('extractValidationUrl: fallback to Help.links[].url when metadata missing', () => {
    const payload = {
        error: {
            code: 403,
            details: [
                {
                    '@type': 'type.googleapis.com/google.rpc.Help',
                    links: [
                        { description: 'Verify your account', url: realValidationUrl },
                    ],
                },
            ],
        },
    };
    const errStr = `API 返回 403: ${JSON.stringify(payload)}`;
    assert.strictEqual(extractValidationUrl(errStr), realValidationUrl);
});

test('extractValidationUrl: returns null when no validation URL present', () => {
    const payload = {
        error: {
            code: 401,
            message: 'Token expired',
            status: 'UNAUTHENTICATED',
        },
    };
    const errStr = `API 返回 401: ${JSON.stringify(payload)}`;
    assert.strictEqual(extractValidationUrl(errStr), null);
});

test('extractValidationUrl: returns null for non-JSON error', () => {
    assert.strictEqual(extractValidationUrl('connection refused'), null);
    assert.strictEqual(extractValidationUrl('token 刷新失败 (HTTP 400): invalid_grant'), null);
});

test('extractValidationUrl: returns null for malformed JSON', () => {
    assert.strictEqual(extractValidationUrl('API 返回 403: {not valid json'), null);
});

test('extractValidationUrl: returns null for null/undefined/empty input', () => {
    assert.strictEqual(extractValidationUrl(null), null);
    assert.strictEqual(extractValidationUrl(undefined), null);
    assert.strictEqual(extractValidationUrl(''), null);
});

test('extractValidationUrl: ignores learn_more_url, picks only validation_url', () => {
    const payload = {
        error: {
            details: [
                {
                    '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
                    metadata: {
                        validation_learn_more_url: 'https://support.google.com/accounts?p=al_alert',
                        validation_url: realValidationUrl,
                    },
                },
            ],
        },
    };
    assert.strictEqual(
        extractValidationUrl(`API 返回 403: ${JSON.stringify(payload)}`),
        realValidationUrl
    );
});
