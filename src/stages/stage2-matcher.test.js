const test = require('node:test');
const assert = require('node:assert');
const { isInviteRow, findAcceptLinkInRows } = require('./stage2-matcher');

test('matches genuine family invite row', () => {
    const row = {
        text: 'unread google bond has invited you to their family group family/join/ABC',
        hrefs: ['https://myaccount.google.com/family/join/ABC'],
    };
    assert.equal(isInviteRow(row), true);
});

test('rejects welcome to google one email', () => {
    const row = {
        text: "unread, google one, welcome to google one, luis, apr 18, you've been added to bo",
        hrefs: ['https://one.google.com/home'],
    };
    assert.equal(isInviteRow(row), false);
});

test('rejects host-side "X joined your family group" notification', () => {
    const row = {
        text: 'unread, google, your new family group member, apr 18, luis buderus joined your family',
        hrefs: ['https://notifications.googleapis.com/email/redirect?t=foo'],
    };
    assert.equal(isInviteRow(row), false);
});

test('rejects "you have been added to X family" confirmation', () => {
    const row = {
        text: "google, you've been added to bond's family group",
        hrefs: ['https://one.google.com/home'],
    };
    assert.equal(isInviteRow(row), false);
});

test('accepts row where link contains family/join even without keyword', () => {
    const row = {
        text: 'gmail notification apr 18',
        hrefs: ['https://myaccount.google.com/family/join/XYZ'],
    };
    assert.equal(isInviteRow(row), true);
});

test('findAcceptLinkInRows picks the first invite row', () => {
    const rows = [
        { text: 'welcome to google one, bo...', hrefs: ['https://one.google.com/home'] },
        { text: 'bond invited you to family', hrefs: ['https://myaccount.google.com/family/join/ABC'] },
    ];
    const link = findAcceptLinkInRows(rows);
    assert.equal(link, 'https://myaccount.google.com/family/join/ABC');
});
