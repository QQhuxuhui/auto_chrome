const test = require('node:test');
const assert = require('node:assert/strict');
const { createLogger } = require('../src/logger');

test('logger writes to stderr, never stdout', (t) => {
    const stderrChunks = [];
    const stdoutChunks = [];
    const origErr = process.stderr.write;
    const origOut = process.stdout.write;
    process.stderr.write = (s) => { stderrChunks.push(String(s)); return true; };
    process.stdout.write = (s) => { stdoutChunks.push(String(s)); return true; };
    try {
        const log = createLogger('info');
        log.info('hello');
        log.debug('should-not-appear');
        log.error('boom');
    } finally {
        process.stderr.write = origErr;
        process.stdout.write = origOut;
    }
    assert.equal(stdoutChunks.length, 0, 'stdout must stay clean for JSON-RPC');
    const joined = stderrChunks.join('');
    assert.ok(joined.includes('hello'));
    assert.ok(joined.includes('boom'));
    assert.ok(!joined.includes('should-not-appear'));
});

test('logger exposes success method matching common/logger interface', (t) => {
    const chunks = [];
    const orig = process.stderr.write;
    process.stderr.write = (s) => { chunks.push(String(s)); return true; };
    try {
        const log = createLogger('info');
        log.success('finished ok');
    } finally {
        process.stderr.write = orig;
    }
    const joined = chunks.join('');
    assert.ok(joined.includes('finished ok'), 'success message should appear');
    assert.ok(joined.includes('[SUCCESS]'), 'tag should be SUCCESS');
});
