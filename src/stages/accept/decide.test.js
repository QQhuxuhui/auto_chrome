const test = require('node:test');
const assert = require('node:assert');
const { decide } = require('./decide');

test('flow truthy + host joined → done/success', () => {
    const d = decide({ flowResult: true, flowError: null, hostStatus: 'joined' });
    assert.deepEqual(d, { finalStatus: 'done', eventType: 'success', message: null });
});

test('flow truthy + host not joined → accept_failed + accept_failed_unconfirmed', () => {
    for (const h of ['pending', 'unknown', 'timeout', 'degraded']) {
        const d = decide({ flowResult: true, flowError: null, hostStatus: h });
        assert.equal(d.finalStatus, 'accept_failed', `hostStatus=${h}`);
        assert.equal(d.eventType, 'accept_failed_unconfirmed');
        assert.match(d.message, /flow ok but host-page not confirmed/i);
    }
});

test('flow threw + host joined → done/success with note', () => {
    const err = new Error('SMS timeout');
    const d = decide({ flowResult: null, flowError: err, hostStatus: 'joined' });
    assert.equal(d.finalStatus, 'done');
    assert.equal(d.eventType, 'success');
    assert.match(d.message, /flow threw.*SMS timeout.*host confirmed joined/i);
});

test('flow threw + host not joined → accept_failed/fail with original error', () => {
    const err = new Error('challenge_timeout: foo');
    const d = decide({ flowResult: null, flowError: err, hostStatus: 'timeout' });
    assert.equal(d.finalStatus, 'accept_failed');
    assert.equal(d.eventType, 'fail');
    assert.equal(d.message, 'challenge_timeout: foo');
});

test('flow falsy (no throw) + host joined → done/success', () => {
    const d = decide({ flowResult: false, flowError: null, hostStatus: 'joined' });
    assert.equal(d.finalStatus, 'done');
    assert.equal(d.eventType, 'success');
    assert.match(d.message, /falsy but host confirmed/i);
});

test('flow falsy + host not joined → accept_failed/fail', () => {
    const d = decide({ flowResult: false, flowError: null, hostStatus: 'pending' });
    assert.equal(d.finalStatus, 'accept_failed');
    assert.equal(d.eventType, 'fail');
    assert.equal(d.message, 'acceptInvite returned falsy');
});

test('rejects invalid hostStatus (case-sensitive, typo)', () => {
    const { decide, VALID_HOST_STATUSES } = require('./decide');
    assert.ok(VALID_HOST_STATUSES.length === 5);
    for (const bad of ['Joined', 'JOINED', 'ok', '', null, undefined]) {
        assert.throws(
            () => decide({ flowResult: true, flowError: null, hostStatus: bad }),
            /invalid hostStatus/,
            `expected throw for hostStatus=${JSON.stringify(bad)}`,
        );
    }
});
