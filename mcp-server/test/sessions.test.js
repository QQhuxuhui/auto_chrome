const test = require('node:test');
const assert = require('node:assert/strict');
const { SessionRegistry } = require('../src/sessions');
const { CODES } = require('../src/errors');

test('create/get/close happy path', () => {
    const r = new SessionRegistry({ maxSessions: 3 });
    const id = r.create({ workerId: 0, browser: {}, proc: {}, dataDir: '/tmp/x', debugPort: 9234 });
    assert.match(id, /^sess_/);
    assert.equal(r.get(id).debugPort, 9234);
    r.close(id);
    assert.throws(() => r.get(id), (e) => e.code === CODES.SESSION_NOT_FOUND);
});

test('enforces maxSessions', () => {
    const r = new SessionRegistry({ maxSessions: 2 });
    r.create({ workerId: 0, browser: {}, proc: {}, dataDir: '/tmp/a', debugPort: 9234 });
    r.create({ workerId: 1, browser: {}, proc: {}, dataDir: '/tmp/b', debugPort: 9235 });
    assert.throws(
        () => r.create({ workerId: 2, browser: {}, proc: {}, dataDir: '/tmp/c', debugPort: 9236 }),
        (e) => e.code === CODES.CONCURRENCY_LIMIT_EXCEEDED,
    );
});

test('per-session mutex serializes withLock', async () => {
    const r = new SessionRegistry({ maxSessions: 3 });
    const id = r.create({ workerId: 0, browser: {}, proc: {}, dataDir: '/tmp/x', debugPort: 9234 });
    const order = [];
    const a = r.withLock(id, async () => { order.push('a-start'); await new Promise(res => setTimeout(res, 30)); order.push('a-end'); });
    const b = r.withLock(id, async () => { order.push('b-start'); order.push('b-end'); });
    await Promise.all([a, b]);
    assert.deepEqual(order, ['a-start', 'a-end', 'b-start', 'b-end']);
});

test('list returns all active sessions', () => {
    const r = new SessionRegistry({ maxSessions: 3 });
    r.create({ workerId: 0, browser: {}, proc: {}, dataDir: '/tmp/a', debugPort: 9234, tags: { foo: 'bar' } });
    r.create({ workerId: 1, browser: {}, proc: {}, dataDir: '/tmp/b', debugPort: 9235 });
    const list = r.list();
    assert.equal(list.length, 2);
    assert.ok(list[0].sessionId);
    assert.ok(typeof list[0].createdAt === 'number');
});
