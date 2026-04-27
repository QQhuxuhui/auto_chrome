const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const { resolveExeDir, pickEnvPath } = require('./paths');

test('resolveExeDir returns dirname(execPath) when isPkg=true', () => {
    const got = resolveExeDir({
        isPkg: true,
        execPath: 'C:\\Users\\you\\Desktop\\auto_chrome.exe',
        srcCommonDir: '/whatever',
    });
    assert.strictEqual(got, 'C:\\Users\\you\\Desktop');
});

test('resolveExeDir returns repo root (../../) when isPkg=false', () => {
    const got = resolveExeDir({
        isPkg: false,
        execPath: '/usr/bin/node',
        srcCommonDir: '/repo/src/common',
    });
    assert.strictEqual(got, path.resolve('/repo/src/common', '..', '..'));
});

test('pickEnvPath picks the first existing candidate', () => {
    const exists = (p) => p === '/B';
    assert.strictEqual(pickEnvPath(['/A', '/B', '/C'], exists), '/B');
});

test('pickEnvPath returns null when none exist', () => {
    assert.strictEqual(pickEnvPath(['/A', '/B'], () => false), null);
});
