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
    assert.ok(args.some(a => a.includes('chrome_data_temp_pipeline_2')));
});
