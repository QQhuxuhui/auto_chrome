const test = require('node:test');
const assert = require('node:assert');
const { build } = require('../server');
const db = require('../db');

let app;
test.before(async () => {
    app = await build();
    await db.query("DELETE FROM members WHERE email LIKE 'api-mem-%@example.com'");
});
test.after(async () => {
    await db.query("DELETE FROM members WHERE email LIKE 'api-mem-%@example.com'");
    await app.close();
    await db.close();
});

test('POST /api/members/bulk inserts', async () => {
    const r = await app.inject({
        method: 'POST', url: '/api/members/bulk',
        payload: { lines: 'api-mem-1@example.com:pw1\napi-mem-2@example.com:pw2' },
    });
    const b = JSON.parse(r.body);
    assert.equal(b.inserted, 2);
});

test('GET /api/members filters by status', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/members?status=new&search=api-mem' });
    assert.equal(r.statusCode, 200);
    const list = JSON.parse(r.body);
    assert.ok(list.every(m => m.status === 'new'));
});

test('GET /api/members/:id includes events array', async () => {
    const list = await app.inject({ method: 'GET', url: '/api/members?search=api-mem-1' })
        .then(r => JSON.parse(r.body));
    const id = list[0].id;
    const r = await app.inject({ method: 'GET', url: `/api/members/${id}` });
    assert.equal(r.statusCode, 200);
    const body = JSON.parse(r.body);
    assert.ok(Array.isArray(body.events));
    assert.equal(body.id, id);
});

test('PATCH /api/members/:id?action=reset clears state', async () => {
    const list = await app.inject({ method: 'GET', url: '/api/members?search=api-mem-2' })
        .then(r => JSON.parse(r.body));
    const id = list[0].id;
    const r = await app.inject({ method: 'PATCH', url: `/api/members/${id}?action=reset`, payload: {} });
    const b = JSON.parse(r.body);
    assert.equal(b.status, 'new');
});

test('PATCH /api/members/:id?action=abandon', async () => {
    const list = await app.inject({ method: 'GET', url: '/api/members?search=api-mem-1' })
        .then(r => JSON.parse(r.body));
    const id = list[0].id;
    const r = await app.inject({ method: 'PATCH', url: `/api/members/${id}?action=abandon`, payload: {} });
    const b = JSON.parse(r.body);
    assert.equal(b.status, 'abandoned');
});
