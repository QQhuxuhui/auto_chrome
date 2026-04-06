/**
 * Chrome 浏览器管理 + 页面交互工具 — 从 auth.js 抽取
 */

const puppeteer = require('puppeteer-core');
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const { log, createWorkerLogger } = require('./logger');

// ============ 基础工具 ============
const sleep = ms => new Promise(r => setTimeout(r, ms));
const rand = (a, b) => Math.floor(Math.random() * (b - a) + a);

// ============ fetch 兼容层 ============
async function httpFetch(url, options = {}) {
    if (typeof globalThis.fetch === 'function') {
        return globalThis.fetch(url, options);
    }
    return new Promise((resolve, reject) => {
        const parsedUrl = new URL(url);
        const mod = parsedUrl.protocol === 'https:' ? https : http;
        const reqOptions = {
            hostname: parsedUrl.hostname,
            port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
            path: parsedUrl.pathname + parsedUrl.search,
            method: options.method || 'GET',
            headers: options.headers || {},
        };
        const req = mod.request(reqOptions, (res) => {
            let data = '';
            res.on('data', chunk => (data += chunk));
            res.on('end', () => {
                resolve({
                    ok: res.statusCode >= 200 && res.statusCode < 300,
                    status: res.statusCode,
                    json: () => Promise.resolve(JSON.parse(data)),
                    text: () => Promise.resolve(data),
                });
            });
        });
        req.on('error', reject);
        if (options.body) req.write(options.body);
        req.end();
    });
}

// ============ Chrome 查找 ============
function findChrome() {
    const paths = [
        (process.env['LOCALAPPDATA'] || '') + '\\Google\\Chrome\\Application\\chrome.exe',
        (process.env['PROGRAMFILES'] || '') + '\\Google\\Chrome\\Application\\chrome.exe',
        (process.env['PROGRAMFILES(X86)'] || '') + '\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        '/usr/bin/google-chrome',
        '/usr/bin/google-chrome-stable',
        '/usr/bin/chromium-browser',
        '/usr/bin/chromium',
    ];
    for (const p of paths) {
        try { if (p && fs.existsSync(p)) return p; } catch (_) { }
    }
    try {
        const cmd = process.platform === 'win32'
            ? 'where chrome'
            : 'which google-chrome || which chromium-browser || which chromium';
        return execSync(cmd, { encoding: 'utf-8' }).trim().split('\n')[0].trim();
    } catch (_) { }
    return null;
}

// ============ Chrome 启动 ============
const BASE_DEBUG_PORT = parseInt(process.env.DEBUG_PORT, 10) || 9234;

async function launchRealChrome(chromePath, workerId = 0) {
    const wlog = createWorkerLogger(workerId);
    const debugPort = BASE_DEBUG_PORT + workerId;
    const CHROME_DATA = path.resolve(__dirname, '..', `chrome_data_temp_pipeline_${workerId}`);
    if (!fs.existsSync(CHROME_DATA)) fs.mkdirSync(CHROME_DATA, { recursive: true });

    wlog.debug(`Launch Chrome: debugPort=${debugPort}, dataDir=${CHROME_DATA}`);

    const proc = spawn(chromePath, [
        `--remote-debugging-port=${debugPort}`,
        `--user-data-dir=${CHROME_DATA}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-sync',
        '--disable-features=InProductHelp',
        '--window-size=1280,800',
        '--disable-gpu',
        '--disable-dev-shm-usage',
        '--disable-background-networking',
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
        '--disable-hang-monitor',
        '--disable-popup-blocking',
        '--disable-prompt-on-repost',
        '--disable-extensions',
        '--disable-component-update',
        '--disable-domain-reliability',
        '--no-sandbox',
        '--metrics-recording-only',
    ], { detached: (process.env.KEEP_BROWSER_OPEN || '').toLowerCase() === 'true', stdio: 'ignore' });

    // 如果 KEEP_BROWSER_OPEN，unref 让 Node 退出时不等待 Chrome
    if ((process.env.KEEP_BROWSER_OPEN || '').toLowerCase() === 'true') {
        proc.unref();
    }

    proc.on('error', e => { wlog.error(`Chrome process error: ${e.message}`, e); });
    proc.on('exit', (code, signal) => {
        wlog.warn(`Chrome process exit: code=${code}, signal=${signal}`);
    });

    let wsUrl = null;
    for (let i = 0; i < 30; i++) {
        try {
            const r = await httpFetch(`http://localhost:${debugPort}/json/version`);
            const data = await r.json();
            wsUrl = data.webSocketDebuggerUrl;
            wlog.debug(`Chrome DevTools WebSocket: ${wsUrl}`);
            break;
        } catch (_) {
            if (i % 5 === 4) wlog.debug(`Waiting for Chrome... (${i + 1}/30)`);
            await sleep(1000);
        }
    }
    if (!wsUrl) {
        proc.kill();
        throw new Error(`[W${workerId}] Chrome launch timeout (30s)`);
    }

    const browser = await puppeteer.connect({
        browserWSEndpoint: wsUrl,
        defaultViewport: null,
        protocolTimeout: 180000,
    });

    try {
        const testPage = await browser.newPage();
        await testPage.close();
        wlog.debug('Chrome warm-up OK');
    } catch (e) {
        wlog.warn(`Chrome warm-up failed: ${e.message}, waiting...`);
        await sleep(2000);
    }

    wlog.info(`Chrome started (port ${debugPort}, PID ${proc.pid})`);
    return { browser, proc, dataDir: CHROME_DATA, debugPort };
}

async function restartChrome(chromePath, worker) {
    const wlog = createWorkerLogger(worker.id);
    wlog.warn('Chrome seems crashed, restarting...');
    try { worker.browser.disconnect(); } catch (_) { }
    try { worker.proc.kill(); } catch (_) { }
    await sleep(3000);
    const fresh = await launchRealChrome(chromePath, worker.id);
    worker.browser = fresh.browser;
    worker.proc = fresh.proc;
    worker.debugPort = fresh.debugPort;
    wlog.success('Chrome restarted');
}

async function isChromeAlive(worker) {
    try {
        const r = await httpFetch(`http://localhost:${worker.debugPort}/json/version`);
        return r.ok;
    } catch (_) {
        return false;
    }
}

// ============ CDP 会话清理 ============
async function clearBrowserSession(browser, wlog) {
    try {
        const pages = await browser.pages();
        for (const p of pages) {
            const url = p.url();
            if (url !== 'about:blank' && !url.startsWith('chrome://')) {
                await p.close().catch(() => { });
            }
        }
        const remainPages = await browser.pages();
        const page = remainPages[0] || await browser.newPage();
        const cdp = await page.createCDPSession();
        await cdp.send('Network.clearBrowserCookies').catch(() => { });
        await cdp.send('Network.clearBrowserCache').catch(() => { });
        for (const origin of [
            'https://accounts.google.com',
            'https://myaccount.google.com',
            'https://console.cloud.google.com',
            'https://mail.google.com',
            'https://one.google.com',
        ]) {
            await cdp.send('Storage.clearDataForOrigin', {
                origin,
                storageTypes: 'all',
            }).catch(() => { });
        }
        await cdp.detach().catch(() => { });
        wlog.debug('Session cleared via CDP');
    } catch (e) {
        wlog.warn(`Session clear failed: ${e.message}`);
    }
}

// ============ 极速输入 ============
async function fastClick(page, element) {
    try {
        await element.click();
    } catch (_) { }
}

async function fastType(page, selector, text, wlog) {
    try {
        const success = await page.evaluate((sel, txt) => {
            const el = document.querySelector(sel);
            if (!el) return false;
            el.focus();
            const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
                window.HTMLInputElement.prototype, 'value'
            ).set;
            nativeInputValueSetter.call(el, txt);
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
            el.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true }));
            el.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true }));
            return true;
        }, selector, text);

        if (!success) {
            const el = await page.$(selector);
            if (!el) throw new Error(`Input not found: ${selector}`);
            await el.click();
            await sleep(100);
            const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
            await page.keyboard.down(mod);
            await page.keyboard.press('KeyA');
            await page.keyboard.up(mod);
            await page.keyboard.press('Backspace');
            await sleep(50);
            await el.type(text, { delay: 0 });
        }
    } catch (e) {
        if (wlog) wlog.debug(`fastType error (${e.message}), trying keyboard fallback`);
        try {
            const el = await page.$(selector);
            if (el) {
                await el.click();
                await el.type(text, { delay: 0 });
            }
        } catch (e2) {
            if (wlog) wlog.warn(`All input methods failed for ${selector}: ${e2.message}`);
        }
    }
}

// ============ 页面状态检测 ============
async function detectPageState(page, wlog) {
    const pageUrl = page.url();

    try {
        const u = new URL(pageUrl);
        if (u.hostname === 'localhost' && u.pathname === '/callback') return { state: 'callback', url: pageUrl };
    } catch (_) { }

    if (pageUrl.startsWith('chrome://')) return { state: 'chrome_internal', url: pageUrl };
    if (pageUrl === 'about:blank') return { state: 'blank', url: pageUrl };

    const pageInfo = await page.evaluate(() => {
        function isVisible(el) {
            if (!el) return false;
            const r = el.getBoundingClientRect();
            const s = window.getComputedStyle(el);
            return r.width > 0 && r.height > 0
                && s.display !== 'none'
                && s.visibility !== 'hidden'
                && s.opacity !== '0';
        }
        const text = document.body ? document.body.innerText : '';
        const emailInputs = Array.from(document.querySelectorAll('input[type="email"]'));
        const hasVisibleEmail = emailInputs.some(isVisible);
        const pwInputs = Array.from(document.querySelectorAll('input[type="password"]'));
        const hasVisiblePassword = pwInputs.some(isVisible);
        const telInputs = Array.from(document.querySelectorAll('input[type="tel"]'));
        const hasVisibleTel = telInputs.some(isVisible);
        return {
            text: text.substring(0, 3000),
            title: document.title || '',
            hasEmailInput: hasVisibleEmail,
            hasPasswordInput: hasVisiblePassword,
            hasPhoneInput: hasVisibleTel,
            url: location.href,
            inputCount: document.querySelectorAll('input').length,
            buttonCount: document.querySelectorAll('button, [role="button"]').length,
            formCount: document.querySelectorAll('form').length,
        };
    }).catch(() => ({
        text: '', title: '', hasEmailInput: false, hasPasswordInput: false, hasPhoneInput: false,
        url: pageUrl, inputCount: 0, buttonCount: 0, formCount: 0,
    }));

    const t = pageInfo.text.toLowerCase();
    const u = pageInfo.url.toLowerCase();

    const debugSummary = {
        url: pageInfo.url.substring(0, 120),
        title: pageInfo.title.substring(0, 60),
        textPreview: pageInfo.text.replace(/\n/g, ' ').substring(0, 150),
        inputs: pageInfo.inputCount,
        buttons: pageInfo.buttonCount,
        forms: pageInfo.formCount,
        hasEmail: pageInfo.hasEmailInput,
        hasPassword: pageInfo.hasPasswordInput,
    };

    let state = 'unknown';
    // URL-based detection takes priority for certain patterns
    if (u.includes('challenge/pwd')) {
        state = 'password';
    } else if (t.includes('verificer, at det er dig') || t.includes('验证身份') ||
        t.includes("verify it's you") || t.includes('verify your identity') ||
        t.includes('验证您的身份') || t.includes('verify your info') ||
        t.includes('choose a way to verify') || t.includes('选择验证方式')) {
        // 这是身份验证页面，需要细分类型
        // 关键判断：页面是"选择验证方式"还是"已进入某种验证方式的输入页面"
        const hasVisibleTextInput = pageInfo.hasEmailInput || await (async () => {
            // 额外检查是否有可见的 text 输入框（不含密码框）
            return false; // detectPageState 是同步的，这里用已有的 pageInfo
        })();

        if (pageInfo.hasEmailInput && (
            t.includes('recovery email') || t.includes('备用邮箱') ||
            t.includes('辅助邮箱') || t.includes('恢复电子邮件'))) {
            // 有可见的邮箱输入框 + 页面提到备用邮箱 = 输入备用邮箱页面
            state = 'verify_recovery_email';
        } else if (pageInfo.hasPhoneInput && (
            t.includes('phone') || t.includes('电话') || t.includes('手机') ||
            t.includes('sms') || t.includes('短信') || t.includes('verify your phone'))) {
            // 有可见的手机号输入框 = 已进入手机号填写页面
            state = 'verify_phone';
        } else if (t.includes('enter code') || t.includes('输入验证码') ||
            t.includes('输入代码') || t.includes('6-digit') || t.includes('6 位') ||
            t.includes('enter the code')) {
            // 页面要求输入验证码（可能是 authenticator 或短信验证码）
            if (t.includes('authenticator') || t.includes('google 验证') ||
                t.includes('两步验证') || t.includes('2-step')) {
                state = 'verify_authenticator';
            } else if (t.includes('phone') || t.includes('电话') ||
                t.includes('短信') || t.includes('sms') || t.includes('手机')) {
                state = 'verify_phone';
            } else {
                state = 'verify_authenticator'; // 默认当验证码处理
            }
        } else {
            // 这是"选择验证方式"的页面，走 identity_verify 逻辑去选择
            state = 'identity_verify';
        }
    } else if (pageInfo.hasPasswordInput) {
        state = 'password';
    } else if (pageInfo.hasEmailInput &&
        (u.includes('identifier') || u.includes('signin'))) {
        state = 'email';
    } else if ((t.includes('add a phone number') || t.includes('添加电话号码') ||
        t.includes('添加手机号') || t.includes('add phone')) &&
        (t.includes('skip') || t.includes('跳过') || t.includes("yes, i'm in") ||
         t.includes('not now') || t.includes('以后再说'))) {
        // "添加手机号"等可跳过的中间页面 — 必须在 profile_info 之前检测
        state = 'skippable_prompt';
    } else if ((u.includes('personal-info') || u.includes('personalinfo') ||
        t.includes('birthday') || t.includes('出生日期') ||
        t.includes('gender') || t.includes('性别')) &&
        !t.includes('verify') && !t.includes('验证') &&
        !t.includes('skip') && !t.includes('跳过')) {
        // 个人信息登记页面（手机号、生日等），排除验证页面和可跳过页面
        state = 'profile_info';
    } else if ((t.includes('street') || t.includes('街道') ||
        t.includes('city') || t.includes('城市') ||
        t.includes('postal') || t.includes('邮政') ||
        t.includes('zip code') || t.includes('邮编') ||
        t.includes('mailing address') || t.includes('通讯地址')) &&
        !t.includes('email address') && !t.includes('verify')) {
        state = 'profile_address';
    } else if (u.includes('speedbump') ||
        t.includes('欢迎使用您的新账号') ||
        t.includes('welcome to your new account')) {
        state = 'speedbump';
    } else if (t.includes('登录 chrome') || t.includes('sign in to chrome') ||
        t.includes('登录chrome') ||
        (t.includes('身份继续') && t.includes('chrome'))) {
        state = 'chrome_sync';
    } else if (t.includes('受到管理') || t.includes('will be managed') ||
        t.includes('资料将受到管理') || t.includes('managed')) {
        state = 'managed_profile';
    } else if (t.includes('服务条款') || t.includes('terms of service') ||
        t.includes('条款和隐私')) {
        state = 'tos';
    } else if (u.includes('challenge') && !pageInfo.hasPasswordInput) {
        // challenge URL 下进一步细分：如果是 SMS 验证页面，走 verify_phone
        if (t.includes('receive an sms') || t.includes('接收短信') ||
            t.includes('sms code') || t.includes('短信验证码') ||
            t.includes('send an sms') || t.includes('发送短信') ||
            (t.includes('phone number') && (t.includes('send') || t.includes('发送')))) {
            state = 'verify_phone';
        } else {
            state = 'challenge';
        }
    } else if (t.includes('选择帐号') || t.includes('choose an account') ||
        t.includes('choose account')) {
        state = 'choose_account';
    } else if (u.includes('consent') || u.includes('approval') ||
        t.includes('wants to access') || t.includes('请求以下权限') ||
        t.includes('想要访问') || t.includes('google antigravity') ||
        t.includes("hasn't verified") || t.includes('未经验证') ||
        t.includes('risky') || t.includes('this app') ||
        t.includes('make sure') || t.includes('确保您已从') ||
        t.includes('downloaded this app') ||
        (t.includes('sign in') && (u.includes('oauth') || u.includes('consent') || u.includes('approval')))) {
        state = 'oauth_consent';
    } else if (t.includes("couldn't sign you in") || t.includes('wrong password') ||
        t.includes('密码错误') ||
        t.includes('account has been disabled') || t.includes('帐号已停用') ||
        t.includes("couldn't find your google account") || t.includes('找不到')) {
        state = 'error';
    } else if (t.includes('sign in') && !pageInfo.hasEmailInput && !pageInfo.hasPasswordInput) {
        state = 'confirm_signin';
    }
    return { state, ...debugSummary };
}

// ============ 按钮点击策略 ============
async function clickButton(page, keywords) {
    const selectors = [
        'button', 'a', 'input[type="submit"]', 'input[type="button"]',
        'div[role="button"]', 'span[role="button"]', 'div[role="link"]',
        'span[jsname]', 'label[role="checkbox"]',
        'material-button', 'mwc-button', 'gm-raised-button',
        '[data-id]', '[jscontroller]', '[jsaction]',
    ];
    const elements = await page.$$(selectors.join(', '));
    const matches = [];
    for (const el of elements) {
        try {
            const info = await page.evaluate(node => {
                const r = node.getBoundingClientRect();
                const s = window.getComputedStyle(node);
                const visible = r.width > 0 && r.height > 0
                    && s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0';
                const tag = node.tagName.toLowerCase();
                const text = (node.textContent || '').trim().toLowerCase();
                let directText = '';
                for (const child of node.childNodes) {
                    if (child.nodeType === Node.TEXT_NODE) directText += child.textContent;
                }
                directText = directText.trim().toLowerCase();
                return { text, directText, visible, tag, area: r.width * r.height };
            }, el);
            if (!info.visible) continue;
            const containerTags = ['form', 'section', 'main', 'body', 'html', 'article', 'nav', 'header', 'footer'];
            if (containerTags.includes(info.tag)) continue;
            if (keywords.some(k => info.text.includes(k))) {
                matches.push({ el, info });
            }
        } catch (_) { }
    }
    if (matches.length === 0) return false;
    matches.sort((a, b) => {
        const aDirectMatch = keywords.some(k => a.info.directText.includes(k)) ? 1 : 0;
        const bDirectMatch = keywords.some(k => b.info.directText.includes(k)) ? 1 : 0;
        if (aDirectMatch !== bDirectMatch) return bDirectMatch - aDirectMatch;
        return a.info.text.length - b.info.text.length;
    });
    const best = matches[0];
    await fastClick(page, best.el);
    return `<${best.info.tag}>: "${best.info.text.substring(0, 40)}"`;
}

async function clickButtonByEval(page, keywords) {
    return page.evaluate((kws) => {
        function isVisible(el) {
            const r = el.getBoundingClientRect();
            const s = window.getComputedStyle(el);
            return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0';
        }
        const all = document.querySelectorAll(
            'button, a, input[type="submit"], div[role="button"], span[role="button"], ' +
            'span[jsname], material-button, mwc-button, [data-id], [jscontroller], ' +
            'div[jscontroller], div[jsaction], span[jsaction]'
        );
        const matches = [];
        for (const el of all) {
            const txt = (el.textContent || '').trim().toLowerCase();
            if (isVisible(el) && kws.some(k => txt.includes(k))) {
                const tag = el.tagName.toLowerCase();
                if (['form', 'section', 'main', 'body', 'html'].includes(tag)) continue;
                matches.push({ el, txt, len: txt.length });
            }
        }
        if (matches.length === 0) return null;
        matches.sort((a, b) => a.len - b.len);
        matches[0].el.click();
        return matches[0].txt.substring(0, 40);
    }, keywords).catch(() => null);
}

async function clickAnyElementByText(page, keywords) {
    return page.evaluate((kws) => {
        function isVisible(el) {
            if (!el || !el.getBoundingClientRect) return false;
            const r = el.getBoundingClientRect();
            if (r.width <= 0 || r.height <= 0) return false;
            const s = window.getComputedStyle(el);
            return s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0';
        }
        const CONTAINER_TAGS = new Set([
            'html', 'body', 'main', 'section', 'article', 'nav',
            'header', 'footer', 'form', 'fieldset', 'table',
            'thead', 'tbody', 'tr', 'ul', 'ol', 'dl',
        ]);
        function isInteractive(el) {
            const role = (el.getAttribute('role') || '').toLowerCase();
            return ['button', 'link', 'menuitem', 'tab', 'checkbox', 'radio', 'switch'].includes(role);
        }
        const all = document.querySelectorAll('*');
        const candidates = [];
        for (const el of all) {
            if (!isVisible(el)) continue;
            const tag = el.tagName.toLowerCase();
            if (CONTAINER_TAGS.has(tag) && !isInteractive(el)) continue;
            let directText = '';
            for (const child of el.childNodes) {
                if (child.nodeType === Node.TEXT_NODE) directText += child.textContent;
            }
            directText = directText.trim().toLowerCase();
            const fullText = (el.innerText || el.textContent || '').trim().toLowerCase();
            if (!fullText) continue;
            const directMatch = kws.some(k => directText.includes(k));
            const fullMatch = kws.some(k => fullText.includes(k));
            if (!directMatch && !fullMatch) continue;
            const r = el.getBoundingClientRect();
            const area = r.width * r.height;
            let score = 0;
            if (directMatch) score += 100;
            if (fullMatch && !directMatch) score += 10;
            const interactiveTags = new Set(['button', 'a', 'input', 'label', 'span']);
            if (interactiveTags.has(tag)) score += 80;
            if (isInteractive(el)) score += 80;
            if (el.hasAttribute('jscontroller') || el.hasAttribute('jsaction')) score += 40;
            if (el.hasAttribute('data-id') || el.hasAttribute('data-action')) score += 30;
            const childElementCount = el.children ? el.children.length : 0;
            if (childElementCount === 0) score += 60;
            else if (childElementCount <= 2) score += 30;
            if (area >= 200 && area <= 30000) score += 50;
            else if (area > 30000 && area <= 80000) score += 10;
            else if (area > 80000) score -= 50;
            const density = fullText.length > 0 ? directText.length / fullText.length : 0;
            score += Math.round(density * 40);
            if (fullText.length <= 20) score += 30;
            else if (fullText.length <= 50) score += 10;
            else score -= 20;
            try {
                const cursor = window.getComputedStyle(el).cursor;
                if (cursor === 'pointer') score += 40;
            } catch (_) { }
            candidates.push({
                el, score, area, tag,
                text: fullText.substring(0, 80),
                directText: directText.substring(0, 80),
            });
        }
        if (candidates.length === 0) return null;
        candidates.sort((a, b) => b.score - a.score);
        const best = candidates[0];
        best.el.click();
        return `<${best.tag}> score=${best.score}: "${best.text.substring(0, 60)}"`;
    }, keywords).catch(() => null);
}

async function tryClickStrategies(page, keywords, wlog, label = '') {
    let result = await clickButton(page, keywords);
    if (result) {
        wlog.debug(`  [${label}] Strategy 1 click: ${result}`);
        return true;
    }

    result = await clickButtonByEval(page, keywords);
    if (result) {
        wlog.debug(`  [${label}] Strategy 2 click: "${result}"`);
        return true;
    }

    result = await clickAnyElementByText(page, keywords);
    if (result) {
        wlog.debug(`  [${label}] Strategy 3 click: "${result}"`);
        return true;
    }

    const jsResult = await page.evaluate((kws) => {
        const all = document.querySelectorAll('[onclick], [jsaction], [data-action]');
        for (const el of all) {
            const r = el.getBoundingClientRect();
            if (r.width <= 0 || r.height <= 0) continue;
            const txt = (el.textContent || '').trim().toLowerCase();
            if (kws.some(k => txt.includes(k))) {
                el.click();
                return txt.substring(0, 40);
            }
        }
        return null;
    }, keywords).catch(() => null);
    if (jsResult) {
        wlog.debug(`  [${label}] Strategy 4 click: "${jsResult}"`);
        return true;
    }

    wlog.debug(`  [${label}] All click strategies missed`);
    return false;
}

async function listVisibleElements(page) {
    return page.evaluate(() => {
        const tags = 'button, a, div[role="button"], span[role="button"], input[type="submit"], ' +
            'input[type="button"], material-button, [jscontroller], [data-id]';
        const els = document.querySelectorAll(tags);
        const result = [];
        for (const el of els) {
            const r = el.getBoundingClientRect();
            if (r.width > 0 && r.height > 0) {
                const s = window.getComputedStyle(el);
                if (s.display !== 'none' && s.visibility !== 'hidden') {
                    result.push(`<${el.tagName.toLowerCase()} class="${(el.className || '').toString().substring(0, 30)}">: "${(el.textContent || '').trim().substring(0, 60)}"`);
                }
            }
        }
        return result;
    }).catch(() => []);
}

async function takeScreenshot(page, label, wlog) {
    try {
        const safeName = label.replace(/[^a-zA-Z0-9_-]/g, '_');
        const ssPath = path.resolve(__dirname, '..', `debug_${safeName}_${Date.now()}.png`);
        await page.screenshot({ path: ssPath, fullPage: true });
        wlog.debug(`Screenshot saved: ${ssPath}`);
        return ssPath;
    } catch (e) {
        wlog.debug(`Screenshot failed: ${e.message}`);
        return null;
    }
}

// ============ 新建页面辅助 ============
async function newPage(browser) {
    // 先记录现有空白页，但不要关闭（避免 Chrome 因无页面而退出）
    let blankPages = [];
    try {
        const existingPages = await browser.pages();
        for (const ep of existingPages) {
            const epUrl = ep.url();
            if (epUrl === 'about:blank' || epUrl === '' || epUrl.startsWith('chrome://newtab') || epUrl.startsWith('chrome://new-tab-page')) {
                blankPages.push(ep);
            }
        }
    } catch (_) { }

    // 先创建新页面，确保 Chrome 至少有一个页面存在
    const page = await browser.newPage();
    const vpWidth = rand(1200, 1400);
    const vpHeight = rand(700, 900);
    await page.setViewport({ width: vpWidth, height: vpHeight }).catch(() => { });

    // 新页面创建成功后，再关闭之前的空白页
    for (const bp of blankPages) {
        await bp.close().catch(() => { });
    }

    return page;
}

module.exports = {
    sleep,
    rand,
    httpFetch,
    findChrome,
    launchRealChrome,
    restartChrome,
    isChromeAlive,
    clearBrowserSession,
    fastClick,
    fastType,
    detectPageState,
    clickButton,
    clickButtonByEval,
    clickAnyElementByText,
    tryClickStrategies,
    listVisibleElements,
    takeScreenshot,
    newPage,
};
