const { createHmac } = require('node:crypto');
const { setTimeout: sleep } = require('node:timers/promises');
const { geminiAccountState } = require('./gemini-session');
const { readLoginState, loginAction, retryDelay } = require('./login-state');

function totp(secret, time = Date.now()) {
    let bits = '';
    for (const char of secret.toUpperCase().replace(/[\s=]/g, '')) {
        const value = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'.indexOf(char);
        if (value < 0) throw new Error('验证器密钥格式无效');
        bits += value.toString(2).padStart(5, '0');
    }
    const key = Buffer.from(bits.match(/.{8}/g).map(byte => parseInt(byte, 2)));
    const counter = Buffer.alloc(8);
    counter.writeBigUInt64BE(BigInt(Math.floor(time / 30000)));
    const hash = createHmac('sha1', key).update(counter).digest();
    const offset = hash[hash.length - 1] & 15;
    return String((hash.readUInt32BE(offset) & 0x7fffffff) % 1000000).padStart(6, '0');
}

async function fillInput(page, selector, value) {
    return page.evaluate((selector, value) => {
        const input = document.querySelector(selector);
        if (!input || !input.getClientRects().length) return false;
        input.focus();
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, value);
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        return input.value === value;
    }, selector, value);
}

async function clickText(page, source) {
    const handle = await page.evaluateHandle(source => {
        const re = new RegExp(source, 'i');
        const el = [...document.querySelectorAll('button,[role="button"],[role="link"],a')]
            .find(el => el.getClientRects().length && el.getAttribute('aria-disabled') !== 'true'
                && !el.disabled && re.test(el.innerText.trim()));
        return el || null;
    }, source);
    try {
        const element = handle.asElement();
        if (!element) return false;
        await element.click();
        return true;
    } finally {
        await handle.dispose();
    }
}

async function waitForChange(page, state, timeout) {
    try {
        const handle = await page.waitForFunction(readLoginState,
            { polling: 250, timeout: Math.max(1, timeout) }, JSON.stringify(state));
        await handle.dispose();
    } catch (error) {
        if (error.name !== 'TimeoutError'
            && !/Execution context was destroyed|Cannot find context|detached Frame/i.test(error.message)) throw error;
    }
}

async function loginAccount(page, account, log = () => {}, timeoutMs = 360000, steps = []) {
    const started = Date.now();
    await page.goto('https://gemini.google.com/app', { waitUntil: 'domcontentloaded', timeout: 45000 });
    const deadline = Date.now() + timeoutMs;
    let lastAction = '', lastAt = 0;
    const attempts = new Map();
    let previousState = null;
    let wakeAfter = 1000;
    function record(stage, attempt) {
        const atMs = Date.now() - started;
        steps.push({ stage, atMs, ...(attempt ? { attempt } : {}) });
        log(`${stage}（+${(atMs / 1000).toFixed(1)}秒）`);
    }
    while (Date.now() < deadline) {
        if (previousState) await waitForChange(page, previousState, Math.min(wakeAfter, deadline - Date.now()));
        wakeAfter = 1000;
        const state = await page.evaluate(readLoginState).catch(() => null);
        previousState = state;
        if (!state) { await sleep(250); continue; }
        const url = new URL(page.url());
        if (url.origin !== state.origin || url.pathname !== state.pathname) continue;
        if (url.origin === 'https://gemini.google.com') {
            const accountState = await page.evaluate(geminiAccountState, account.email).catch(() => false);
            if (accountState === 'signed-in') { record('邮箱确认成功'); return page; }
            if (accountState === 'other-account') throw new Error('环境中的邮箱与目标账号不符');
            if (lastAction === '打开登录页' && Date.now() - lastAt < 15000) continue;
            const href = await page.evaluate(() => [...document.links].find(el =>
                el.origin === 'https://accounts.google.com'
                && /^(登录|登入|Sign in)$/i.test(el.innerText.trim()))?.href);
            if (href) {
                record('打开登录页');
                await page.goto(href, { waitUntil: 'domcontentloaded', timeout: 45000 });
                lastAction = '打开登录页';
                lastAt = Date.now();
            }
            continue;
        }
        if (url.origin !== 'https://accounts.google.com') throw new Error('登录跳转到非预期网站');
        if (/此浏览器或应用可能不安全|browser or app may not be secure/i.test(state.text)) throw new Error('Google 拒绝浏览器登录');
        if (/密码错误|Wrong password|密码不正确/i.test(state.text)) throw new Error('Google 提示密码错误');
        if (/账号已停用|account has been disabled|Couldn't find your Google Account|找不到您的 Google 账号/i.test(state.text)) throw new Error('Google 提示账号不可用');
        const action = loginAction(state);
        if (!action) continue;
        const key = `${url.pathname}:${action}`;
        const remaining = retryDelay(action, attempts.get(key)) - (Date.now() - lastAt);
        if (key === lastAction && remaining > 0) {
            wakeAfter = remaining;
            continue;
        }
        const count = (attempts.get(key) || 0) + 1;
        if (count > 3) throw new Error(`登录停留在${action}，需检查验证页面`);
        let submitted = false;
        let inputValue;
        if (action === '邮箱') { inputValue = account.email; submitted = await fillInput(page, '#identifierId', inputValue); }
        if (action === '密码') { inputValue = account.password; submitted = await fillInput(page, 'input[name="Passwd"]', inputValue); }
        if (action === '验证器验证码') {
            if (!account.secret) throw new Error('缺少验证器密钥');
            if (Date.now() % 30000 > 24000) await sleep(31000 - Date.now() % 30000);
            inputValue = totp(account.secret);
            submitted = await fillInput(page, '#totpPin', inputValue);
        }
        if (submitted) {
            // 输入事件更新表单后，使用真实键盘提交，避免程序化 click 未触发提交。
            await page.focus(action === '邮箱' ? '#identifierId' : action === '密码' ? 'input[name="Passwd"]' : '#totpPin');
            // 焦点切换期间页面可能重渲染；确认值仍在再提交。
            submitted = await page.evaluate((selector, expected) => document.querySelector(selector)?.value === expected,
                action === '邮箱' ? '#identifierId' : action === '密码' ? 'input[name="Passwd"]' : '#totpPin',
                inputValue);
            if (!submitted) continue;
            await page.keyboard.press('Enter');
        }
        if (action === '选择身份验证器') submitted = await clickText(page, '身份验证器|Authenticator');
        if (action === '其他验证方式') submitted = await clickText(page, '^(试试其他方式|Try another way)$');
        if (action === '跳过通行密钥') submitted = await clickText(page, '^(以后再说|Not now|Skip)$');
        if (!submitted) continue;
        attempts.set(key, count);
        record(action, count);
        lastAction = key;
        lastAt = Date.now();
        wakeAfter = retryDelay(action, count);
    }
    throw new Error('等待登录完成超时');
}

module.exports = { loginAccount, totp };
