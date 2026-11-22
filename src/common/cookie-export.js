const fs = require('node:fs/promises');
const path = require('node:path');
const { setTimeout: sleep } = require('node:timers/promises');
const { geminiAccountState } = require('./gemini-session');
const { ensureGeminiInitialized } = require('./gemini-initialization');

const REQUIRED_GOOGLE_COOKIES = [
    'SID', 'HSID', 'SSID', 'APISID', 'SAPISID',
    '__Secure-1PSID', '__Secure-3PSID',
    'SIDCC', '__Secure-1PSIDCC',
];
const REQUIRED_GEMINI_COOKIES = ['OSID', '__Secure-OSID'];

// 固定相关站点范围，不读取整个浏览器的所有网站。
function exportUrls(pageUrl) {
    return [...new Set([pageUrl,
        'https://gemini.google.com/_/BardChatUi/data/batchexecute',
        'https://gemini.google.com/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate',
        'https://accounts.google.com/RotateCookies',
        'https://accounts.google.com/RotateBoundCookies',
        'https://accounts.google.com/RotateBoundGaps',
        'https://play.google.com/log',
        'https://www.google.com/',
    ])];
}

function assertDefaultGeminiSlot(pageUrl) {
    const parsed = new URL(pageUrl);
    if (parsed.origin !== 'https://gemini.google.com') {
        throw new Error('尚未在 Gemini 核对目标邮箱，拒绝导出');
    }
    if (/^\/u\/[1-9]\d*(\/|$)/.test(parsed.pathname)) {
        throw new Error('Gemini 页面位于非默认多账号槽位（/u/N），拒绝按 authuser=0 导出');
    }
    return parsed;
}

function missingRequiredCookies(cookies) {
    const byName = new Map();
    const geminiNames = new Set();
    for (const cookie of cookies) {
        if (!cookie || !cookie.name || !cookie.value) continue;
        byName.set(cookie.name, true);
        const domain = (cookie.domain || '').replace(/^\./, '').toLowerCase();
        if (domain === 'gemini.google.com') geminiNames.add(cookie.name);
    }
    const missing = [];
    for (const name of REQUIRED_GOOGLE_COOKIES) {
        if (!byName.has(name)) missing.push(name);
    }
    for (const name of REQUIRED_GEMINI_COOKIES) {
        if (!geminiNames.has(name)) missing.push(name);
    }
    return missing;
}

async function waitForRequiredCookies(client, urls, { cookieTimeoutMs = 15000, pollMs = 250 } = {}) {
    const deadline = Date.now() + Math.max(0, cookieTimeoutMs);
    let missing = [];
    do {
        const { cookies } = await client.send('Network.getCookies', { urls });
        missing = missingRequiredCookies(cookies || []);
        if (!missing.length) return;
        if (Date.now() >= deadline) break;
        await sleep(Math.min(pollMs, Math.max(1, deadline - Date.now())));
    } while (Date.now() <= deadline);
    throw new Error(`Gemini 会话缺少必要 Cookie：${missing.join(', ')}`);
}

async function readConsistentScopes(client, urls) {
    let scopes = [];
    for (let attempt = 0; attempt < 3; attempt++) {
        scopes = [];
        const seenByKey = new Map();
        let rollingChanged = false;
        for (const url of urls) {
            const { cookies } = await client.send('Network.getCookies', { urls: [url] });
            scopes.push({ url, cookies });
            for (const cookie of cookies) {
                const key = `${cookie.name}\0${cookie.domain}\0${cookie.path}`;
                if (seenByKey.has(key) && seenByKey.get(key) !== cookie.value) {
                    rollingChanged = true;
                }
                seenByKey.set(key, cookie.value);
            }
        }
        if (!rollingChanged) break;
        if (attempt < 2) await sleep(100);
    }
    return scopes;
}

async function exportCookies(tab, email, outputDir, { log = () => {}, cookieTimeoutMs = 15000, freezeSettleMs = 200 } = {}) {
    assertDefaultGeminiSlot(tab.url());
    if (await tab.evaluate(geminiAccountState, email) !== 'signed-in') {
        throw new Error('尚未在 Gemini 核对目标邮箱，拒绝导出');
    }
    const initialization = await ensureGeminiInitialized(tab, email, { log });
    const activeUrl = tab.url();
    assertDefaultGeminiSlot(activeUrl);
    const urls = exportUrls(activeUrl);
    const client = await tab.createCDPSession();
    try {
        await waitForRequiredCookies(client, urls, { cookieTimeoutMs });
        // 确认必要 Cookie 齐全后切到空白页，停止后台请求在读取或关窗前继续刷新 SIDCC/1PSIDTS。
        if (typeof tab.goto === 'function') {
            await tab.goto('about:blank', { waitUntil: 'load', timeout: 10000 }).catch(() => {});
            if (freezeSettleMs > 0) await sleep(freezeSettleMs);
        }
        const scopes = await readConsistentScopes(client, urls);
        if (!scopes[0].cookies.length) throw new Error('没有读到 Gemini Cookie');
        const missing = missingRequiredCookies(scopes.flatMap(scope => scope.cookies));
        if (missing.length) throw new Error(`Gemini 会话缺少必要 Cookie：${missing.join(', ')}`);

        const selected = new Map(), conflicts = new Set();
        for (const scope of scopes) {
            for (const cookie of scope.cookies) {
                const prior = selected.get(cookie.name);
                if (!prior) {
                    selected.set(cookie.name, cookie);
                } else if (prior.domain === cookie.domain && prior.path === cookie.path) {
                    // 同一作用域在读取瞬间发生滚动更新时取最新值，避免写出过期 SIDCC。
                    selected.set(cookie.name, cookie);
                } else if (prior.value !== cookie.value) {
                    conflicts.add(cookie.name);
                }
            }
        }
        // TXT无法表示同名、不同域/路径的多个值。优先当前Gemini URL，完整变体保存在JSON。
        const cookieText = [...selected.values()].map(cookie => `${cookie.name}=${cookie.value}`).join('; ');
        if (/[\r\n]/.test(cookieText)) throw new Error('Cookie 包含换行符');
        await fs.mkdir(outputDir, { recursive: true });
        const filePath = path.join(outputDir, `${email.replace(/[^a-zA-Z0-9@._+-]/g, '_')}.cookie.txt`);
        const metadataPath = filePath.replace(/\.cookie\.txt$/, '.cookies.json');
        await fs.writeFile(metadataPath, JSON.stringify({
            schemaVersion: 1, exportedAt: new Date().toISOString(), initialization,
            format: 'multi-url-cookie-union',
            collisionPolicy: 'first URL wins across distinct scopes; latest wins for identical domain/path; all variants retained in scopes',
            conflictingNames: [...conflicts], scopes,
        }, null, 2), { encoding: 'utf8', mode: 0o600 });
        await fs.writeFile(filePath, cookieText, { encoding: 'utf8', mode: 0o600 });
        return { cookieText, filePath, metadataPath, conflictingNames: [...conflicts], initialization };
    } finally {
        await client.detach();
    }
}

// Restore scoped export metadata with current server values. Rotation or OSID
// renewal can add cookies after export; omitting them restores a stale session.
function browserCookieData(metadata, currentCookieText) {
    const current = new Map(currentCookieText.split(';').filter(part => part.includes('=')).map(part => {
        const at = part.indexOf('='); return [part.slice(0, at).trim(), part.slice(at + 1)];
    }));
    const cookies = new Map(), selected = new Set();
    for (const scope of metadata.scopes) for (const item of scope.cookies) {
        const key = JSON.stringify([item.name, item.domain, item.path]);
        if (cookies.has(key)) continue;
        const cookie = { name: item.name, value: item.value, domain: item.domain, path: item.path,
            secure: item.secure, httpOnly: item.httpOnly };
        if (item.sameSite) cookie.sameSite = item.sameSite;
        if (!selected.has(item.name) && current.has(item.name)) cookie.value = current.get(item.name);
        selected.add(item.name); cookies.set(key, cookie);
    }
    for (const name of ['__Secure-1PSIDTS', '__Secure-3PSIDTS']) if (current.has(name) && !selected.has(name)) {
        cookies.set(name, { name, value: current.get(name), domain: '.google.com', path: '/', secure: true, httpOnly: true, sameSite: 'None' });
    }
    for (const name of ['OSID', '__Secure-OSID']) if (current.has(name) && !selected.has(name)) {
        cookies.set(name, {
            name, value: current.get(name), domain: 'gemini.google.com', path: '/',
            secure: true, httpOnly: true, ...(name === '__Secure-OSID' ? { sameSite: 'None' } : {}),
        });
    }
    return [...cookies.values()];
}

module.exports = { exportCookies, browserCookieData, missingRequiredCookies };
