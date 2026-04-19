const test = require('node:test');
const assert = require('node:assert');
const { build } = require('../server');
const db = require('../db');

let app;
test.before(async () => {
    app = await build();
    await db.query("DELETE FROM hosts WHERE email LIKE 'api-host-%@example.com'");
});
test.after(async () => {
    await db.query("DELETE FROM hosts WHERE email LIKE 'api-host-%@example.com'");
    await app.close();
    await db.close();
});

test('POST /api/hosts/bulk inserts from lines string', async () => {
    const r = await app.inject({
        method: 'POST', url: '/api/hosts/bulk',
        payload: { lines: 'api-host-1@example.com:pw1\napi-host-2@example.com:pw2' },
    });
    assert.equal(r.statusCode, 200);
    const body = JSON.parse(r.body);
    assert.equal(body.inserted, 2);
    assert.equal(body.skipped, 0);
});

test('POST /api/hosts/bulk skips duplicates', async () => {
    const r = await app.inject({
        method: 'POST', url: '/api/hosts/bulk',
        payload: { lines: 'api-host-1@example.com:pw1' },
    });
    const body = JSON.parse(r.body);
    assert.equal(body.inserted, 0);
    assert.equal(body.skipped, 1);
});

test('GET /api/hosts returns list with slot fields', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/hosts?search=api-host' });
    assert.equal(r.statusCode, 200);
    const list = JSON.parse(r.body);
    assert.ok(Array.isArray(list));
    for (const h of list) {
        assert.ok('slot_used' in h);
        assert.ok('slot_free' in h);
    }
});

test('PATCH /api/hosts/:id updates disabled flag', async () => {
    const list = await app.inject({ method: 'GET', url: '/api/hosts?search=api-host-1' })
        .then(r => JSON.parse(r.body));
    const id = list[0].id;
    const r = await app.inject({ method: 'PATCH', url: `/api/hosts/${id}`, payload: { disabled: true } });
    assert.equal(r.statusCode, 200);
    const b = JSON.parse(r.body);
    assert.equal(b.disabled, true);
});

test('DELETE /api/hosts/:id removes the host', async () => {
    const list = await app.inject({ method: 'GET', url: '/api/hosts?search=api-host-2' })
        .then(r => JSON.parse(r.body));
    const id = list[0].id;
    const r = await app.inject({ method: 'DELETE', url: `/api/hosts/${id}` });
    assert.equal(r.statusCode, 204);
});
