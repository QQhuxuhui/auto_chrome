const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
    accountName,
    parseSub2apiConfig,
    shouldForceReauth,
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
