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

test('updateAntigravity merges JSONB partial into existing object', async () => {
    const { member } = await members.upsertMember({ email: 'test-mem-ag1@example.com', password: 'pw' });
    let updated = await members.updateAntigravity(member.id, { id: 'uuid-1', pushed_at: '2026-04-19T10:00:00Z' });
    assert.equal(updated.antigravity.id, 'uuid-1');
    assert.equal(updated.antigravity.pushed_at, '2026-04-19T10:00:00Z');
    updated = await members.updateAntigravity(member.id, { disabled: true });
    assert.equal(updated.antigravity.id, 'uuid-1');
    assert.equal(updated.antigravity.pushed_at, '2026-04-19T10:00:00Z');
    assert.equal(updated.antigravity.disabled, true);
});

test('listMembersByEmailLower is case-insensitive', async () => {
    await members.upsertMember({ email: 'test-mem-AG2@example.com', password: 'pw' });
    const found = await members.listMembersByEmailLower(['test-mem-ag2@example.com', 'nope@x.com']);
    assert.equal(found.length, 1);
    assert.equal(found[0].email.toLowerCase(), 'test-mem-ag2@example.com');
});

test('listMembersNeedingPush returns only done+unpushed', async () => {
    const { member: m1 } = await members.upsertMember({ email: 'test-mem-push1@example.com', password: 'pw' });
    const { member: m2 } = await members.upsertMember({ email: 'test-mem-push2@example.com', password: 'pw' });
    await members.transitionToInvitePending(m1.id, hostId);
    await members.transitionToJoined(m1.id);
    await members.transitionToDone(m1.id, 'RT1', {});
    await members.transitionToInvitePending(m2.id, hostId);
    await members.transitionToJoined(m2.id);
    await members.transitionToDone(m2.id, 'RT2', {});
    await members.updateAntigravity(m2.id, { id: 'already-pushed-uuid' });
    const pending = await members.listMembersNeedingPush();
    const emails = pending.map(p => p.email);
    assert.ok(emails.includes('test-mem-push1@example.com'));
    assert.ok(!emails.includes('test-mem-push2@example.com'));
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

test('transitionToFailed counts fails without auto-abandoning', async () => {
    const { member } = await members.upsertMember({ email: 'test-mem-4@example.com', password: 'pw' });
    await members.transitionToInvitePending(member.id, hostId);
    await members.transitionToFailed(member.id, { newStatus: 'invite_failed', error: 'e1', releaseHost: true });
    await members.transitionToFailed(member.id, { newStatus: 'invite_failed', error: 'e2', releaseHost: true });
    const third = await members.transitionToFailed(member.id, { newStatus: 'invite_failed', error: 'e3', releaseHost: true });
    assert.equal(third.status, 'invite_failed');
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

test('listMembersForStage stage 2 respects hostIds filter', async () => {
    const { host: h2 } = await hosts.upsertHost({ email: 'test-mem-host-2@example.com', password: 'hp' });
    const { member: mA } = await members.upsertMember({ email: 'test-mem-9a@example.com', password: 'pw' });
    const { member: mB } = await members.upsertMember({ email: 'test-mem-9b@example.com', password: 'pw' });
    await members.transitionToInvitePending(mA.id, hostId);  // host 1
    await members.transitionToInvitePending(mB.id, h2.id);   // host 2

    const filtered = await members.listMembersForStage(2, { hostIds: [hostId] });
    const emails = filtered.map(m => m.email);
    assert.ok(emails.includes('test-mem-9a@example.com'), 'should include host 1 member');
    assert.ok(!emails.includes('test-mem-9b@example.com'), 'should NOT include host 2 member');

    // Without filter: both visible
    const unfiltered = await members.listMembersForStage(2);
    const unfilteredEmails = unfiltered.map(m => m.email);
    assert.ok(unfilteredEmails.includes('test-mem-9a@example.com'));
    assert.ok(unfilteredEmails.includes('test-mem-9b@example.com'));

    // inline cleanup (also covered by test.after)
    await db.query('DELETE FROM members WHERE id IN ($1, $2)', [mA.id, mB.id]);
    await db.query('DELETE FROM hosts WHERE id = $1', [h2.id]);
});

test('listMembersForStage with empty hostIds returns zero results', async () => {
    // Seed one member in invite_pending
    const { member: m } = await members.upsertMember({ email: 'test-mem-empty@example.com', password: 'pw' });
    await members.transitionToInvitePending(m.id, hostId);

    // Empty array → filter with no matches (NOT "disable filter")
    const filtered = await members.listMembersForStage(2, { hostIds: [] });
    const emails = filtered.map(x => x.email);
    assert.ok(!emails.includes('test-mem-empty@example.com'), 'empty hostIds should exclude all rows');

    // No key → no filter, member is visible
    const unfiltered = await members.listMembersForStage(2);
    const unfilteredEmails = unfiltered.map(x => x.email);
    assert.ok(unfilteredEmails.includes('test-mem-empty@example.com'));

    await db.query('DELETE FROM members WHERE id = $1', [m.id]);
});
