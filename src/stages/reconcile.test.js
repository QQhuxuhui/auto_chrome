const test = require('node:test');
const assert = require('node:assert');
const { computeUnknownEmails } = require('./reconcile');

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
