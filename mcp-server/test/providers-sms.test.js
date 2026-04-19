const test = require('node:test');
const assert = require('node:assert/strict');
const { getProvider, registerProvider } = require('../src/providers/sms');

test('registers and retrieves provider by name', () => {
    const stub = {
        name: 'stub',
        getPhone: async () => ({ number: '+1', activationId: 'x' }),
        waitCode: async () => ({ code: '000' }),
        cancel: async () => {},
    };
    registerProvider(stub);
    const p = getProvider('stub', {});
    assert.equal(p.name, 'stub');
});

test('unknown provider throws', () => {
    assert.throws(() => getProvider('nope', {}), /unknown SMS provider/);
});
