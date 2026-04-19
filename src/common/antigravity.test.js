const test = require('node:test');
const assert = require('node:assert');

// 用全局 mock 替换 fetch 以隔离测试
const realFetch = global.fetch;
const calls = [];
let mockResponse = null;
global.fetch = async (url, opts) => {
    calls.push({ url, opts });
    return mockResponse;
};

// 测试前保证读到预期 env
process.env.ANTIGRAVITY_URL = 'http://test-platform:9999';
process.env.ANTIGRAVITY_API_KEY = 'test-key';

const { listAccounts, pushAccount, deleteAccount } = require('./antigravity');

function resetMock() {
    calls.length = 0;
    mockResponse = null;
}

test('listAccounts issues GET with Bearer auth', async () => {
    resetMock();
    mockResponse = { ok: true, status: 200,
        headers: { get: (k) => k === 'content-type' ? 'application/json' : null },
        json: async () => ({ accounts: [{ id: 'u1', email: 'a@x' }], current_id: null }) };
    const r = await listAccounts();
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'http://test-platform:9999/api/accounts');
    assert.equal(calls[0].opts.method, 'GET');
    assert.equal(calls[0].opts.headers.Authorization, 'Bearer test-key');
    assert.equal(r.accounts.length, 1);
    assert.equal(r.accounts[0].id, 'u1');
});

test('pushAccount POSTs refreshToken and returns parsed account', async () => {
    resetMock();
    mockResponse = { ok: true, status: 200,
        headers: { get: () => 'application/json' },
        json: async () => ({ id: 'new-id', email: 'b@x', disabled: false }) };
    const r = await pushAccount({ refreshToken: 'rt-abc' });
    assert.equal(calls[0].opts.method, 'POST');
    assert.equal(calls[0].opts.headers['Content-Type'], 'application/json');
    const body = JSON.parse(calls[0].opts.body);
    assert.equal(body.refreshToken, 'rt-abc');
    assert.equal(r.id, 'new-id');
});

test('pushAccount throws AntigravityError on non-2xx', async () => {
    resetMock();
    mockResponse = { ok: false, status: 400,
        headers: { get: () => 'application/json' },
        json: async () => ({ error: 'duplicate' }) };
    await assert.rejects(
        () => pushAccount({ refreshToken: 'rt' }),
        err => {
            assert.equal(err.status, 400);
            assert.match(err.message, /duplicate|HTTP 400/);
            return true;
        }
    );
});

test('deleteAccount issues DELETE', async () => {
    resetMock();
    mockResponse = { ok: true, status: 204,
        headers: { get: () => null },
        json: async () => ({}) };
    await deleteAccount('some-uuid');
    assert.equal(calls[0].opts.method, 'DELETE');
    assert.ok(calls[0].url.endsWith('/api/accounts/some-uuid'));
});

test('restore native fetch after tests', () => {
    global.fetch = realFetch;
    assert.ok(true);
});
