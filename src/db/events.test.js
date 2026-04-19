const test = require('node:test');
const assert = require('node:assert');
const db = require('./index');
const events = require('./events');
const members = require('./members');
const hosts = require('./hosts');

let memberId, hostId;
test.before(async () => {
    await db.query("DELETE FROM events WHERE message LIKE 'test-evt-%'");
    await db.query("DELETE FROM members WHERE email LIKE 'test-evt-%@example.com'");
    await db.query("DELETE FROM hosts   WHERE email LIKE 'test-evt-%@example.com'");
    const { host } = await hosts.upsertHost({ email: 'test-evt-host@example.com', password: 'p' });
    hostId = host.id;
    const { member } = await members.upsertMember({ email: 'test-evt-mem@example.com', password: 'p' });
    memberId = member.id;
});
test.after(async () => {
    await db.query("DELETE FROM events WHERE member_id = $1", [memberId]);
    await db.query("DELETE FROM members WHERE id = $1", [memberId]);
    await db.query("DELETE FROM hosts   WHERE id = $1", [hostId]);
    await db.close();
});

test('logEvent inserts a row', async () => {
    const e = await events.logEvent({
        memberId, hostId, runId: null,
        stage: 'stage1', eventType: 'start', message: 'test-evt-log',
    });
    assert.ok(e.id);
    assert.equal(e.event_type, 'start');
});

test('listEventsForMember returns DESC order', async () => {
    await events.logEvent({ memberId, stage: 'stage1', eventType: 'start', message: 'test-evt-1' });
    await events.logEvent({ memberId, stage: 'stage1', eventType: 'success', message: 'test-evt-2' });
    const rows = await events.listEventsForMember(memberId, 10);
    assert.ok(rows.length >= 2);
    const top = rows.filter(r => (r.message || '').startsWith('test-evt-')).slice(0, 2);
    assert.equal(top[0].message, 'test-evt-2');
});
