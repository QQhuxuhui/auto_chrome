const test = require('node:test');
const assert = require('node:assert');

const { buildOpenBrowserCommand, buildBannerLines } = require('./banner');

test('buildOpenBrowserCommand uses cmd /c start on win32', () => {
    const got = buildOpenBrowserCommand('win32', 'http://127.0.0.1:3000');
    assert.deepStrictEqual(got, { cmd: 'cmd', args: ['/c', 'start', '""', 'http://127.0.0.1:3000'] });
});

test('buildOpenBrowserCommand uses open on darwin', () => {
    const got = buildOpenBrowserCommand('darwin', 'http://x');
    assert.deepStrictEqual(got, { cmd: 'open', args: ['http://x'] });
});

test('buildOpenBrowserCommand uses xdg-open on linux', () => {
    const got = buildOpenBrowserCommand('linux', 'http://x');
    assert.deepStrictEqual(got, { cmd: 'xdg-open', args: ['http://x'] });
});

test('buildBannerLines renders version + dataDir + listen url', () => {
    const lines = buildBannerLines({ version: '0.1.0', dataDir: 'C:\\Users\\you\\data', listenUrl: 'http://127.0.0.1:3000' });
    const joined = lines.join('\n');
    assert.match(joined, /auto_chrome v0\.1\.0/);
    assert.match(joined, /C:\\Users\\you\\data/);
    assert.match(joined, /http:\/\/127\.0\.0\.1:3000/);
});
