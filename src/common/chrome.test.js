const assert = require('node:assert/strict');
const { test, mock } = require('node:test');
const { EventEmitter } = require('node:events');
const childProcess = require('node:child_process');
const puppeteer = require('puppeteer-core');

test('导出配置隔离旧会话并关闭网页和浏览器登录两种绑定路径', async t => {
    const launches = [];
    mock.method(childProcess, 'spawn', (executable, args) => {
        launches.push(args);
        return Object.assign(new EventEmitter(), { exitCode: null });
    });
    mock.method(puppeteer, 'connect', async () => ({}));
    t.after(() => mock.restoreAll());
    const { launchChrome } = require('./chrome');
    await launchChrome('account-profile');
    await launchChrome('account-profile', { portableCookies: true });
    assert.ok(launches[0].includes('--user-data-dir=account-profile'));
    assert.ok(launches[1].includes('--user-data-dir=account-profile-portable-v2'));
    const features = launches[1].find(arg => arg.startsWith('--disable-features=')).split('=')[1].split(',');
    for (const name of ['EnableBoundSessionCredentials', 'DeviceBoundSessions',
        'EnableChromeRefreshTokenBinding', 'EnableOAuthMultiloginCookiesBinding',
        'EnableOAuthMultiloginStandardCookiesBinding', 'EnableOAuthMultiloginCookiesBindingServerExperiment']) {
        assert.ok(features.includes(name), `${name} must be disabled for exported sessions`);
        assert.ok(!launches[0].some(arg => arg.includes(name)), '默认调用应保留原浏览器行为');
    }
    assert.ok(!launches[1].some(arg => arg.startsWith('--log-net-log')));
});
