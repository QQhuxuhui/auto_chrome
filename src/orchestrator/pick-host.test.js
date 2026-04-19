const test = require('node:test');
const assert = require('node:assert');
const { pickHost } = require('./pick-host');

function H(id, email, slot_used = 0, disabled = false) {
    return { id, email, slot_used, slot_free: 5 - slot_used, disabled, created_at: new Date(id * 1000).toISOString() };
}

test('pickHost picks host with fewest slot_used', () => {
    const hosts = [H(1, 'a@x', 4), H(2, 'b@x', 1), H(3, 'c@x', 3)];
    const h = pickHost(hosts, []);
    assert.equal(h.id, 2);
});

test('pickHost tie-breaks by created_at ASC', () => {
    const hosts = [H(2, 'b@x', 1), H(1, 'a@x', 1)];
    const h = pickHost(hosts, []);
    assert.equal(h.id, 1);
});

test('pickHost skips full hosts', () => {
    const hosts = [H(1, 'a@x', 5), H(2, 'b@x', 4)];
    const h = pickHost(hosts, []);
    assert.equal(h.id, 2);
});

test('pickHost skips disabled hosts', () => {
    const hosts = [H(1, 'a@x', 0, true), H(2, 'b@x', 3)];
    const h = pickHost(hosts, []);
    assert.equal(h.id, 2);
});

test('pickHost restricts to filter list when non-empty', () => {
    const hosts = [H(1, 'a@x', 0), H(2, 'b@x', 0), H(3, 'c@x', 0)];
    const h = pickHost(hosts, ['b@x']);
    assert.equal(h.id, 2);
});

test('pickHost returns null when no candidates', () => {
    const hosts = [H(1, 'a@x', 5), H(2, 'b@x', 5)];
    const h = pickHost(hosts, []);
    assert.equal(h, null);
});

test('pickHost returns null when filter matches nothing with slots', () => {
    const hosts = [H(1, 'a@x', 0), H(2, 'b@x', 5)];
    const h = pickHost(hosts, ['b@x']);
    assert.equal(h, null);
});
