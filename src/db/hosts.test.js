const test = require('node:test');
const assert = require('node:assert');
const db = require('./index');
const hosts = require('./hosts');

test.before(async () => {
    await db.query('DELETE FROM hosts WHERE email LIKE $1', ['test-host-%@example.com']);
});

test.after(async () => {
    await db.query('DELETE FROM hosts WHERE email LIKE $1', ['test-host-%@example.com']);
    await db.close();
});

test('upsertHost inserts new row', async () => {
    const result = await hosts.upsertHost({
        email: 'test-host-1@example.com',
        password: 'pw1',
        recovery_email: 'r@example.com',
        totp_secret: 'SECRET1',
    });
    assert.equal(result.inserted, true);
    assert.ok(result.host.id);
    assert.equal(result.host.email, 'test-host-1@example.com');
});

test('upsertHost skips duplicate email', async () => {
    await hosts.upsertHost({ email: 'test-host-2@example.com', password: 'pw' });
    const result = await hosts.upsertHost({ email: 'test-host-2@example.com', password: 'other' });
    assert.equal(result.inserted, false);
    assert.equal(result.skipped, true);
});

test('listHosts returns slot_used and slot_free', async () => {
    await hosts.upsertHost({ email: 'test-host-3@example.com', password: 'pw' });
    const rows = await hosts.listHosts({ search: 'test-host-3' });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].slot_used, 0);
    assert.equal(rows[0].slot_free, 5);
});

test('updateHost changes fields', async () => {
    const { host } = await hosts.upsertHost({ email: 'test-host-4@example.com', password: 'pw' });
    const updated = await hosts.updateHost(host.id, { disabled: true, notes: 'off' });
    assert.equal(updated.disabled, true);
    assert.equal(updated.notes, 'off');
});

test('deleteHost removes the row', async () => {
    const { host } = await hosts.upsertHost({ email: 'test-host-5@example.com', password: 'pw' });
    await hosts.deleteHost(host.id);
    const got = await hosts.getHostById(host.id);
    assert.equal(got, null);
});
