const test = require('node:test');
const assert = require('node:assert');
const { parseFamilyListDOM } = require('./family-scrape-fast');

test('parseFamilyListDOM — pending invite with visible email → pending', () => {
    const raw = [
        { href: '/family/invitation/abc123', text: 'foo@bar.com\nInvitation sent' },
    ];
    const out = parseFamilyListDOM(raw);
    assert.deepEqual(out.pending, [{ href: '/family/invitation/abc123', email: 'foo@bar.com' }]);
    assert.deepEqual(out.joinedHrefs, []);
});

test('parseFamilyListDOM — joined member anchor (no email in text) → joinedHrefs', () => {
    const raw = [
        { href: '/family/member/xyz789', text: 'Jane Doe' },
    ];
    const out = parseFamilyListDOM(raw);
    assert.deepEqual(out.pending, []);
    assert.deepEqual(out.joinedHrefs, ['/family/member/xyz789']);
});

test('parseFamilyListDOM — mixed list', () => {
    const raw = [
        { href: '/family/member/host-abc', text: 'Host User\nFamily manager' },
        { href: '/family/member/m1', text: 'Jane Doe' },
        { href: '/family/invitation/i1', text: 'pending@example.com\nInvitation sent' },
        { href: '/family/member/m2', text: 'John Doe' },
        { href: '/some/other/link', text: 'unrelated' },
        { href: '/family/invitemembers', text: 'Send invitations' },
    ];
    const out = parseFamilyListDOM(raw);
    assert.deepEqual(out.pending, [{ href: '/family/invitation/i1', email: 'pending@example.com' }]);
    assert.deepEqual(out.joinedHrefs, ['/family/member/m1', '/family/member/m2']);
});

test('parseFamilyListDOM — concatenated text without newline does not greedy-match TLD', () => {
    const raw = [
        { href: '/family/invitation/i1', text: 'foo@bar.cominvitation sent' },
    ];
    const out = parseFamilyListDOM(raw);
    assert.deepEqual(out.pending, [{ href: '/family/invitation/i1', email: null }]);
});
