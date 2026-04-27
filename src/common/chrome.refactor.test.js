const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { buildChromeArgs } = require('./chrome');

test('buildChromeArgs uses provided dataDir over default', () => {
    const args = buildChromeArgs({ workerId: 0, dataDir: '/tmp/custom', debugPort: 9999 });
    assert.ok(args.some(a => a === '--user-data-dir=/tmp/custom'));
    assert.ok(args.some(a => a === '--remote-debugging-port=9999'));
});

test('buildChromeArgs merges extraArgs', () => {
    const args = buildChromeArgs({ workerId: 0, dataDir: '/tmp/x', debugPort: 9999, extraArgs: ['--proxy-server=http://x:1'] });
    assert.ok(args.includes('--proxy-server=http://x:1'));
});

test('buildChromeArgs falls back to default pipeline dataDir when not provided', () => {
    const args = buildChromeArgs({ workerId: 2, debugPort: 9236 });
    assert.ok(args.some(a => a.includes(`${path.sep}pipeline_2`)));
});

test('buildChromeArgs preserves stealth flag set', () => {
    const args = buildChromeArgs({ workerId: 0, dataDir: '/tmp/x', debugPort: 9234 });
    const required = [
        '--no-first-run', '--no-default-browser-check', '--disable-sync',
        '--disable-features=InProductHelp', '--lang=en-US', '--accept-lang=en-US,en',
        '--disable-gpu', '--disable-dev-shm-usage', '--disable-background-networking',
        '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding', '--disable-hang-monitor',
        '--disable-popup-blocking', '--disable-prompt-on-repost', '--disable-extensions',
        '--disable-component-update', '--disable-domain-reliability',
        '--no-sandbox', '--metrics-recording-only',
    ];
    for (const flag of required) assert.ok(args.includes(flag), `missing ${flag}`);
});
