const test = require('node:test');
const assert = require('node:assert');
const { build } = require('../server');
const db = require('../db');

let app;
test.before(async () => { app = await build(); });
test.after(async () => { await app.close(); await db.close(); });

test('GET /api/status returns aggregate', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/status' });
    assert.equal(r.statusCode, 200);
    const b = JSON.parse(r.body);
    assert.ok('byStatus' in b);
    assert.ok('hosts' in b);
    assert.ok('currentRun' in b);
    assert.ok(typeof b.hosts.total === 'number');
    assert.ok(typeof b.hosts.freeSlotsTotal === 'number');
});
