const test = require('node:test');
const assert = require('node:assert/strict');
const {
    normalizeProxyUrl,
    parseWindowsProxyServer,
    mergeNoProxy,
    getLocalListeningProxy,
} = require('./node-fetch-proxy');

test('normalizeProxyUrl adds http scheme for host:port proxy', () => {
    assert.equal(normalizeProxyUrl('127.0.0.1:7890'), 'http://127.0.0.1:7890');
});

test('parseWindowsProxyServer prefers https-specific proxy', () => {
    assert.equal(
        parseWindowsProxyServer('http=127.0.0.1:7890;https=127.0.0.1:7891;socks=127.0.0.1:7892'),
        'http://127.0.0.1:7891'
    );
});

test('parseWindowsProxyServer handles single host:port proxy', () => {
    assert.equal(parseWindowsProxyServer('127.0.0.1:7890'), 'http://127.0.0.1:7890');
});

test('mergeNoProxy preserves existing entries and adds loopback', () => {
    assert.equal(
        mergeNoProxy('example.com, localhost'),
        'example.com,localhost,127.0.0.1,::1'
    );
});


test('getLocalListeningProxy detects common listening proxy ports', () => {
    const execFile = () => [
        '  Proto  Local Address          Foreign Address        State           PID',
        '  TCP    127.0.0.1:7890         0.0.0.0:0              LISTENING       1234',
    ].join('\r\n');
    assert.equal(
        getLocalListeningProxy({ platform: 'win32', execFile, ports: [7890] }),
        'http://127.0.0.1:7890'
    );
});

test('getLocalListeningProxy ignores non-Windows platforms', () => {
    const execFile = () => { throw new Error('should not run'); };
    assert.equal(getLocalListeningProxy({ platform: 'linux', execFile, ports: [7890] }), null);
});
