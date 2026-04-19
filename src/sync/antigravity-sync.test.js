const test = require('node:test');
const assert = require('node:assert');
const db = require('../db');
const hosts = require('../db/hosts');
const members = require('../db/members');

// Mock antigravity client — 替换 require 缓存
const mockClient = {
    _listResp: { accounts: [], current_id: null },
    _pushResp: null,
    _pushError: null,
    _deleteCalls: [],
    async listAccounts() { return this._listResp; },
    async pushAccount({ refreshToken }) {
        if (this._pushError) throw this._pushError;
        return this._pushResp;
    },
    async deleteAccount(id) { this._deleteCalls.push(id); },
};
require.cache[require.resolve('../common/antigravity')] = { exports: mockClient };

const sync = require('./antigravity-sync');

let hostId;

test.before(async () => {
    await db.query("DELETE FROM members WHERE email LIKE 'test-sync-%@example.com'");
    await db.query("DELETE FROM hosts WHERE email LIKE 'test-sync-host-%@example.com'");
    const { host } = await hosts.upsertHost({ email: 'test-sync-host-1@example.com', password: 'p' });
    hostId = host.id;
});

test.after(async () => {
    await db.query("DELETE FROM members WHERE email LIKE 'test-sync-%@example.com'");
    await db.query("DELETE FROM hosts WHERE email LIKE 'test-sync-host-%@example.com'");
    await db.close();
});

test('syncFromRemote matches by email (case-insensitive) and updates JSONB', async () => {
    const { member } = await members.upsertMember({ email: 'test-sync-Match@example.com', password: 'pw' });
    mockClient._listResp = {
        accounts: [{
            id: 'uuid-match', email: 'test-sync-match@example.com',
            disabled: false, validation_blocked: false,
            quota: { is_forbidden: false, forbidden_reason: null }
        }],
        current_id: null,
    };
    const r = await sync.syncFromRemote();
    assert.equal(r.matched, 1);
    const updated = await members.getMemberById(member.id);
    assert.equal(updated.antigravity.id, 'uuid-match');
    assert.equal(updated.antigravity.disabled, false);
    assert.ok(updated.antigravity.last_synced_at);
});

test('syncFromRemote reports orphans', async () => {
    mockClient._listResp = {
        accounts: [
            { id: 'u1', email: 'orphan1@nowhere.com', disabled: false, validation_blocked: false, quota: null },
            { id: 'u2', email: 'orphan2@nowhere.com', disabled: false, validation_blocked: false, quota: null },
        ],
        current_id: null,
    };
    const r = await sync.syncFromRemote();
    assert.equal(r.matched, 0);
    assert.equal(r.orphans.length, 2);
    assert.ok(r.orphans.includes('orphan1@nowhere.com'));
});

test('syncFromRemote updates disabled flag for matched account', async () => {
    const { member } = await members.upsertMember({ email: 'test-sync-ban@example.com', password: 'pw' });
    mockClient._listResp = {
        accounts: [{ id: 'u-ban', email: 'test-sync-ban@example.com',
            disabled: true, disabled_reason: 'invalid_grant', disabled_at: 1700000000,
            validation_blocked: false, quota: null }],
        current_id: null,
    };
    const r = await sync.syncFromRemote();
    assert.equal(r.newly_disabled.length, 1);
    const updated = await members.getMemberById(member.id);
    assert.equal(updated.antigravity.disabled, true);
    assert.equal(updated.antigravity.disabled_reason, 'invalid_grant');
});

test('pushAccount happy path writes antigravity.id + pushed_at', async () => {
    const { member } = await members.upsertMember({ email: 'test-sync-push@example.com', password: 'pw' });
    await members.transitionToInvitePending(member.id, hostId);
    await members.transitionToJoined(member.id);
    await members.transitionToDone(member.id, 'RT-1', {});
    mockClient._pushResp = { id: 'pushed-uuid', email: 'test-sync-push@example.com' };
    mockClient._pushError = null;
    const r = await sync.pushAccount(member.id);
    assert.equal(r.success, true);
    const updated = await members.getMemberById(member.id);
    assert.equal(updated.antigravity.id, 'pushed-uuid');
    assert.ok(updated.antigravity.pushed_at);
    assert.equal(updated.antigravity.push_error, null);
});

test('pushAccount error path records push_error and does not set id', async () => {
    const { member } = await members.upsertMember({ email: 'test-sync-err@example.com', password: 'pw' });
    await members.transitionToInvitePending(member.id, hostId);
    await members.transitionToJoined(member.id);
    await members.transitionToDone(member.id, 'RT-2', {});
    // Inline AntigravityError for test (mockClient replaced the real module)
    class AntigravityError extends Error {
        constructor(message, status, body) { super(message); this.status = status; this.body = body; }
    }
    mockClient._pushError = new AntigravityError('duplicate token', 400, { error: 'duplicate' });
    mockClient._pushResp = null;
    const r = await sync.pushAccount(member.id);
    assert.equal(r.success, false);
    const updated = await members.getMemberById(member.id);
    assert.equal(updated.antigravity?.id || null, null);
    assert.ok(updated.antigravity.push_error);
    assert.equal(updated.antigravity.push_error.status, 400);
});

test('pushAccount refuses if member not done', async () => {
    const { member } = await members.upsertMember({ email: 'test-sync-notdone@example.com', password: 'pw' });
    const r = await sync.pushAccount(member.id);
    assert.equal(r.success, false);
    assert.match(r.error, /status.*done/i);
});
