const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { exportCookies, browserCookieData } = require('./cookie-export');

function baseCookies(overrides = []) {
    const defaults = [
        { name: 'SID', value: 'sid-1', domain: '.google.com', path: '/', secure: false, httpOnly: true },
        { name: 'HSID', value: 'hsid-1', domain: '.google.com', path: '/', secure: false, httpOnly: true },
        { name: 'SSID', value: 'ssid-1', domain: '.google.com', path: '/', secure: true, httpOnly: true },
        { name: 'APISID', value: 'apisid-1', domain: '.google.com', path: '/', secure: false, httpOnly: false },
        { name: 'SAPISID', value: 'sapisid-1', domain: '.google.com', path: '/', secure: true, httpOnly: false },
        { name: '__Secure-1PSID', value: '1psid-1', domain: '.google.com', path: '/', secure: true, httpOnly: true },
        { name: '__Secure-3PSID', value: '3psid-1', domain: '.google.com', path: '/', secure: true, httpOnly: true, sameSite: 'None' },
        { name: 'SIDCC', value: 'sidcc-1', domain: '.google.com', path: '/', secure: false, httpOnly: false },
        { name: '__Secure-1PSIDCC', value: '1psidcc-1', domain: '.google.com', path: '/', secure: true, httpOnly: true },
        { name: 'OSID', value: 'osid-1', domain: 'gemini.google.com', path: '/', secure: true, httpOnly: true },
        { name: '__Secure-OSID', value: 'sosid-1', domain: 'gemini.google.com', path: '/', secure: true, httpOnly: true, sameSite: 'None' },
    ];
    const map = new Map(defaults.map(item => [`${item.name}\0${item.domain}\0${item.path}`, item]));
    for (const item of overrides) {
        const key = `${item.name}\0${item.domain}\0${item.path}`;
        if (item.value === null) map.delete(key);
        else map.set(key, item);
    }
    return [...map.values()];
}

function fakeTab({ initialUrl = 'https://gemini.google.com/app', sendImpl }) {
    let currentUrl = initialUrl;
    const navigations = [];
    return {
        navigations,
        url: () => currentUrl,
        goto: async target => {
            navigations.push(target);
            currentUrl = target;
        },
        evaluate: async fn => {
            if (fn.name === 'geminiAccountState') return 'signed-in';
            if (fn.name === 'inspectInitialization') return { action: null, editor: true, dialogs: 0 };
            return null;
        },
        createCDPSession: async () => ({
            send: sendImpl,
            detach: async () => {},
        }),
    };
}

test('等待延迟写入的 OSID 齐全后先切空白页冻结后台请求再导出', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cookie-export-ok-'));
    try {
        let multiCalls = 0;
        let frozenAtRead = false;
        const tab = fakeTab({
            sendImpl: async (method, params) => {
                assert.equal(method, 'Network.getCookies');
                if (params.urls.length > 1) {
                    multiCalls++;
                    if (multiCalls < 2) {
                        return {
                            cookies: baseCookies([
                                { name: 'OSID', domain: 'gemini.google.com', path: '/', value: null },
                                { name: '__Secure-OSID', domain: 'gemini.google.com', path: '/', value: null },
                            ]),
                        };
                    }
                    return { cookies: baseCookies() };
                }
                if (tab.url() === 'about:blank') frozenAtRead = true;
                const url = params.urls[0];
                const cookies = baseCookies().filter(c => c.domain === '.google.com' || url.startsWith('https://gemini.google.com'));
                return { cookies };
            },
        });
        const result = await exportCookies(tab, 'tester@example.test', dir, { cookieTimeoutMs: 2000, freezeSettleMs: 0 });
        assert.ok(multiCalls >= 2);
        assert.equal(frozenAtRead, true);
        assert.deepEqual(tab.navigations, ['about:blank']);
        assert.deepEqual(result.conflictingNames, []);
        assert.match(result.cookieText, /\bOSID=osid-1\b/);
        assert.match(result.cookieText, /\b__Secure-OSID=sosid-1\b/);
    } finally {
        await fs.rm(dir, { recursive: true, force: true });
    }
});

test('缺少 OSID 或位于非默认 /u/1 多账号槽位时拒绝导出', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cookie-export-reject-'));
    try {
        const missingOsidTab = fakeTab({
            sendImpl: async () => ({
                cookies: baseCookies([
                    { name: 'OSID', domain: 'gemini.google.com', path: '/', value: null },
                ]),
            }),
        });
        await assert.rejects(
            exportCookies(missingOsidTab, 'tester@example.test', dir, { cookieTimeoutMs: 120, freezeSettleMs: 0 }),
            /缺少必要 Cookie：OSID/,
        );

        const secondarySlotTab = fakeTab({
            initialUrl: 'https://gemini.google.com/u/1/app',
            sendImpl: async () => ({ cookies: baseCookies() }),
        });
        await assert.rejects(
            exportCookies(secondarySlotTab, 'tester@example.test', dir, { cookieTimeoutMs: 120, freezeSettleMs: 0 }),
            /非默认多账号槽位/,
        );
    } finally {
        await fs.rm(dir, { recursive: true, force: true });
    }
});

test('同一作用域滚动刷新取最新值且不误报冲突，不同域同名仍保留 Gemini 优先并记录冲突', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cookie-export-conflict-'));
    try {
        let singleReads = 0;
        const tab = fakeTab({
            sendImpl: async (_method, params) => {
                if (params.urls.length > 1) return { cookies: baseCookies() };
                singleReads++;
                const url = params.urls[0];
                // 第 1 轮中途模拟同域 SIDCC 滚动变化，触发自动重读；第 2 轮稳定为最新值 sidcc-2
                const sidccValue = singleReads <= 2 ? 'sidcc-1' : 'sidcc-2';
                const list = baseCookies([
                    { name: 'SIDCC', value: sidccValue, domain: '.google.com', path: '/', secure: false, httpOnly: false },
                ]).filter(c => c.domain === '.google.com' || url.startsWith('https://gemini.google.com'));
                if (url.startsWith('https://accounts.google.com')) {
                    list.push({ name: 'SID', value: 'sid-accounts-scoped', domain: 'accounts.google.com', path: '/', secure: true, httpOnly: true });
                }
                return { cookies: list };
            },
        });
        const result = await exportCookies(tab, 'tester@example.test', dir, { cookieTimeoutMs: 1000, freezeSettleMs: 0 });
        assert.match(result.cookieText, /\bSIDCC=sidcc-2\b/);
        assert.match(result.cookieText, /\bSID=sid-1\b/);
        assert.deepEqual(result.conflictingNames, ['SID']);
    } finally {
        await fs.rm(dir, { recursive: true, force: true });
    }
});

test('browserCookieData 为旧导出补齐服务器修复后的 Gemini OSID 双字段', () => {
    const primary = { name: 'SID', value: 'old', domain: '.google.com', path: '/', secure: true, httpOnly: true };
    const restored = browserCookieData(
        { scopes: [{ cookies: [primary] }] },
        'SID=current; OSID=osid-new; __Secure-OSID=sosid-new',
    );
    const osid = restored.find(item => item.name === 'OSID');
    const secureOsid = restored.find(item => item.name === '__Secure-OSID');
    assert.equal(osid.domain, 'gemini.google.com');
    assert.equal(osid.value, 'osid-new');
    assert.equal(secureOsid.domain, 'gemini.google.com');
    assert.equal(secureOsid.sameSite, 'None');
});
