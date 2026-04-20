const test = require('node:test');
const assert = require('node:assert');
const { computeUnknownEmails, computeReconcileChanges } = require('./reconcile');

test('computeUnknownEmails excludes host email and known members', () => {
    const familyEmails = ['host@x.com', 'a@x.com', 'b@x.com', 'stranger@x.com'];
    const localMembers = [
        { email: 'A@X.com' },   // case difference
        { email: 'b@x.com' },
    ];
    const result = computeUnknownEmails(familyEmails, localMembers, 'host@x.com');
    assert.deepEqual(result, ['stranger@x.com']);
});

test('computeUnknownEmails excludes host email even with case difference', () => {
    const familyEmails = ['Host@X.com', 'unknown@y.com'];
    const localMembers = [];
    const result = computeUnknownEmails(familyEmails, localMembers, 'host@x.com');
    assert.deepEqual(result, ['unknown@y.com']);
});

test('computeUnknownEmails returns empty when all known', () => {
    const familyEmails = ['a@x.com', 'b@x.com'];
    const localMembers = [{ email: 'a@x.com' }, { email: 'b@x.com' }];
    const result = computeUnknownEmails(familyEmails, localMembers, 'host@x.com');
    assert.deepEqual(result, []);
});

test('computeUnknownEmails handles empty family list', () => {
    const result = computeUnknownEmails([], [{ email: 'a@x' }], 'host@x.com');
    assert.deepEqual(result, []);
});

// ─── computeReconcileChanges: pending invites must NOT be misread as joined ───

test('computeReconcileChanges: pending invite alone does NOT flip invite_pending → joined', () => {
    const members = [{ id: 1, email: 'a@x.com', status: 'invite_pending' }];
    const lists = { joinedEmails: [], pendingEmails: ['a@x.com'] };
    assert.deepEqual(computeReconcileChanges(members, lists), []);
});

test('computeReconcileChanges: joined email DOES flip invite_pending → joined', () => {
    const members = [{ id: 1, email: 'a@x.com', status: 'invite_pending' }];
    const lists = { joinedEmails: ['a@x.com'], pendingEmails: [] };
    assert.deepEqual(computeReconcileChanges(members, lists), [
        { id: 1, from: 'invite_pending', to: 'joined' },
    ]);
});

test('computeReconcileChanges: joined email case-insensitive', () => {
    const members = [{ id: 1, email: 'A@X.com', status: 'invite_pending' }];
    const lists = { joinedEmails: ['a@x.COM'], pendingEmails: [] };
    assert.deepEqual(computeReconcileChanges(members, lists), [
        { id: 1, from: 'invite_pending', to: 'joined' },
    ]);
});

test('computeReconcileChanges: DB joined/done not in either list → removed_from_family', () => {
    const members = [
        { id: 1, email: 'a@x.com', status: 'joined' },
        { id: 2, email: 'b@x.com', status: 'done' },
    ];
    const lists = { joinedEmails: [], pendingEmails: [] };
    assert.deepEqual(computeReconcileChanges(members, lists), [
        { id: 1, from: 'joined', to: 'removed_from_family' },
        { id: 2, from: 'done', to: 'removed_from_family' },
    ]);
});

test('computeReconcileChanges: DB joined but still a pending invite on Google → do not remove', () => {
    // Edge case: host re-invited after member was removed — member re-appears as pending,
    // but local DB still has old 'joined'. Don't mark removed while invite is live.
    const members = [{ id: 1, email: 'a@x.com', status: 'joined' }];
    const lists = { joinedEmails: [], pendingEmails: ['a@x.com'] };
    assert.deepEqual(computeReconcileChanges(members, lists), []);
});

test('computeReconcileChanges: other DB statuses unaffected', () => {
    const members = [
        { id: 1, email: 'a@x.com', status: 'new' },
        { id: 2, email: 'b@x.com', status: 'accept_failed' },
        { id: 3, email: 'c@x.com', status: 'removed_from_family' },
    ];
    const lists = { joinedEmails: [], pendingEmails: ['a@x.com', 'b@x.com', 'c@x.com'] };
    assert.deepEqual(computeReconcileChanges(members, lists), []);
});

test('computeReconcileChanges: back-compat — plain array treated as joined', () => {
    const members = [
        { id: 1, email: 'a@x.com', status: 'invite_pending' },
        { id: 2, email: 'b@x.com', status: 'joined' },
    ];
    assert.deepEqual(computeReconcileChanges(members, ['a@x.com']), [
        { id: 1, from: 'invite_pending', to: 'joined' },
        { id: 2, from: 'joined', to: 'removed_from_family' },
    ]);
});

// ─── partialScrape guard: Chrome crash / anchor click fail must not cause ───
// ─── false "removed_from_family" updates for members we didn't actually see ──

test('computeReconcileChanges: partialScrape=true suppresses joined/done → removed_from_family', () => {
    const members = [
        { id: 1, email: 'seen@x.com',   status: 'joined' },
        { id: 2, email: 'missed@x.com', status: 'joined' },  // not in any list due to crash
        { id: 3, email: 'done@x.com',   status: 'done' },
    ];
    const lists = { joinedEmails: ['seen@x.com'], pendingEmails: [] };
    // Without guard the bug marks missed@x.com + done@x.com as removed.
    assert.deepEqual(computeReconcileChanges(members, lists, { partialScrape: true }), []);
});

test('computeReconcileChanges: partialScrape=true still emits additive invite_pending → joined', () => {
    // Additive changes are safe: we confirmed we SAW the email, even if other
    // anchors failed. No reason to withhold the joined promotion.
    const members = [
        { id: 1, email: 'a@x.com', status: 'invite_pending' },
        { id: 2, email: 'b@x.com', status: 'joined' },  // would be removed without guard
    ];
    const lists = { joinedEmails: ['a@x.com'], pendingEmails: [] };
    assert.deepEqual(computeReconcileChanges(members, lists, { partialScrape: true }), [
        { id: 1, from: 'invite_pending', to: 'joined' },
    ]);
});

test('computeReconcileChanges: partialScrape=false (default) keeps the removal branch', () => {
    const members = [
        { id: 1, email: 'gone@x.com', status: 'joined' },
    ];
    const lists = { joinedEmails: [], pendingEmails: [] };
    assert.deepEqual(computeReconcileChanges(members, lists), [
        { id: 1, from: 'joined', to: 'removed_from_family' },
    ]);
    // Explicit false behaves the same.
    assert.deepEqual(computeReconcileChanges(members, lists, { partialScrape: false }), [
        { id: 1, from: 'joined', to: 'removed_from_family' },
    ]);
});
