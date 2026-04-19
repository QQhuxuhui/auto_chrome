const test = require('node:test');
const assert = require('node:assert');
const db = require('../db');

// 和 sync 测试同样的 mock 方式
const mockClient = {
    _listResp: { accounts: [], current_id: null },
    _pushResp: null,
    _pushError: null,
    async listAccounts() { return this._listResp; },
    async pushAccount({ refreshToken }) {
        if (this._pushError) throw this._pushError;
        return this._pushResp;
    },
    async deleteAccount() { /* noop */ },
};
require.cache[require.resolve('../common/antigravity')] = { exports: mockClient };

const { build } = require('../server');

let app;

test.before(async () => {
    app = await build();
    await db.query("DELETE FROM members WHERE email LIKE 'rt-ag-%@example.com'");
});

test.after(async () => {
    await db.query("DELETE FROM members WHERE email LIKE 'rt-ag-%@example.com'");
    await app.close();
    await db.close();
});

test('POST /api/antigravity/sync returns matched + orphans', async () => {
    // seed local
    await db.query("INSERT INTO members (email, password, status) VALUES ('rt-ag-match@example.com', 'p', 'new') ON CONFLICT DO NOTHING");
    mockClient._listResp = {
        accounts: [
            { id: 'a1', email: 'rt-ag-match@example.com', disabled: false, validation_blocked: false, quota: null },
            { id: 'a2', email: 'rt-ag-orphan@example.com', disabled: false, validation_blocked: false, quota: null },
        ],
        current_id: null,
    };
    const r = await app.inject({ method: 'POST', url: '/api/antigravity/sync' });
    assert.equal(r.statusCode, 200);
    const body = JSON.parse(r.body);
    assert.equal(body.matched, 1);
    assert.equal(body.orphans.length, 1);
    assert.equal(body.orphans[0], 'rt-ag-orphan@example.com');
});

test('POST /api/antigravity/push/:id on non-done member returns 400', async () => {
    const { rows } = await db.query("INSERT INTO members (email, password, status) VALUES ('rt-ag-notdone@example.com', 'p', 'new') RETURNING id");
    const r = await app.inject({ method: 'POST', url: `/api/antigravity/push/${rows[0].id}` });
    assert.equal(r.statusCode, 400);
    const body = JSON.parse(r.body);
    assert.match(body.error, /status.*done/i);
});

test('GET /api/antigravity/orphans returns remote-only accounts', async () => {
    mockClient._listResp = {
        accounts: [
            { id: 'a1', email: 'rt-ag-match@example.com', disabled: false, validation_blocked: false, quota: null },
            { id: 'a2', email: 'rt-ag-orphan@example.com', disabled: false, validation_blocked: false, quota: null },
        ],
        current_id: null,
    };
    const r = await app.inject({ method: 'GET', url: '/api/antigravity/orphans' });
    assert.equal(r.statusCode, 200);
    const list = JSON.parse(r.body);
    const emails = list.map(o => o.email);
    assert.ok(emails.includes('rt-ag-orphan@example.com'));
    assert.ok(!emails.includes('rt-ag-match@example.com'));
});
