const test = require('node:test');
const assert = require('node:assert');
const db = require('./index');
const hosts = require('./hosts');
const members = require('./members');

let hostId;

test.before(async () => {
    await db.query('DELETE FROM members WHERE email LIKE $1', ['test-mem-%@example.com']);
    await db.query('DELETE FROM hosts   WHERE email LIKE $1', ['test-mem-host-%@example.com']);
    const { host } = await hosts.upsertHost({ email: 'test-mem-host-1@example.com', password: 'hp' });
    hostId = host.id;
});

test.after(async () => {
    await db.query('DELETE FROM members WHERE email LIKE $1', ['test-mem-%@example.com']);
    await db.query('DELETE FROM hosts   WHERE email LIKE $1', ['test-mem-host-%@example.com']);
    await db.close();
});

test('upsertMember inserts with default status=new', async () => {
    const r = await members.upsertMember({ email: 'test-mem-1@example.com', password: 'pw' });
    assert.equal(r.inserted, true);
    assert.equal(r.member.status, 'new');
    assert.equal(r.member.fail_count, 0);
});

test('transitionToInvitePending sets host_id + invited_at', async () => {
    const { member } = await members.upsertMember({ email: 'test-mem-2@example.com', password: 'pw' });
    const updated = await members.transitionToInvitePending(member.id, hostId);
    assert.equal(updated.status, 'invite_pending');
    assert.equal(updated.host_id, hostId);
    assert.ok(updated.invited_at);
});

test('transitionToFailed increments fail_count and clears host when releaseHost=true', async () => {
    const { member } = await members.upsertMember({ email: 'test-mem-3@example.com', password: 'pw' });
    await members.transitionToInvitePending(member.id, hostId);
    const updated = await members.transitionToFailed(member.id, {
        newStatus: 'invite_failed',
        error: 'boom',
        releaseHost: true,
    });
    assert.equal(updated.status, 'invite_failed');
    assert.equal(updated.fail_count, 1);
    assert.equal(updated.host_id, null);
    assert.equal(updated.last_error, 'boom');
});

test('transitionToFailed promotes to abandoned after 3 fails', async () => {
    const { member } = await members.upsertMember({ email: 'test-mem-4@example.com', password: 'pw' });
    await members.transitionToInvitePending(member.id, hostId);
    await members.transitionToFailed(member.id, { newStatus: 'invite_failed', error: 'e1', releaseHost: true });
    await members.transitionToFailed(member.id, { newStatus: 'invite_failed', error: 'e2', releaseHost: true });
    const third = await members.transitionToFailed(member.id, { newStatus: 'invite_failed', error: 'e3', releaseHost: true });
    assert.equal(third.status, 'abandoned');
    assert.equal(third.fail_count, 3);
});

test('transitionToJoined sets joined_at', async () => {
    const { member } = await members.upsertMember({ email: 'test-mem-5@example.com', password: 'pw' });
    await members.transitionToInvitePending(member.id, hostId);
    const updated = await members.transitionToJoined(member.id);
    assert.equal(updated.status, 'joined');
    assert.ok(updated.joined_at);
});

test('transitionToDone sets token and done_at', async () => {
    const { member } = await members.upsertMember({ email: 'test-mem-6@example.com', password: 'pw' });
    await members.transitionToInvitePending(member.id, hostId);
    await members.transitionToJoined(member.id);
    const updated = await members.transitionToDone(member.id, 'REFRESH_TOKEN_XYZ', {});
    assert.equal(updated.status, 'done');
    assert.equal(updated.token, 'REFRESH_TOKEN_XYZ');
    assert.ok(updated.done_at);
});

test('resetMember clears state back to new', async () => {
    const { member } = await members.upsertMember({ email: 'test-mem-7@example.com', password: 'pw' });
    await members.transitionToInvitePending(member.id, hostId);
    await members.transitionToFailed(member.id, { newStatus: 'invite_failed', error: 'x', releaseHost: true });
    const reset = await members.resetMember(member.id);
    assert.equal(reset.status, 'new');
    assert.equal(reset.fail_count, 0);
    assert.equal(reset.host_id, null);
    assert.equal(reset.last_error, null);
});

test('listMembersForStage returns stage 1 work items', async () => {
    const { member: m1 } = await members.upsertMember({ email: 'test-mem-8a@example.com', password: 'pw' });
    const { member: m2 } = await members.upsertMember({ email: 'test-mem-8b@example.com', password: 'pw' });
    await members.transitionToInvitePending(m1.id, hostId);
    await members.transitionToFailed(m1.id, { newStatus: 'invite_failed', error: 'x', releaseHost: true });
    // m2 stays 'new'
    const work = await members.listMembersForStage(1);
    const emails = work.map(m => m.email);
    assert.ok(emails.includes('test-mem-8a@example.com'));
    assert.ok(emails.includes('test-mem-8b@example.com'));
});
