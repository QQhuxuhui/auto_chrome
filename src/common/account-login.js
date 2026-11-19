const { createHmac } = require('node:crypto');
const { setTimeout: sleep } = require('node:timers/promises');
const { geminiAccountState } = require('./gemini-session');
const { readLoginState, loginAction, retryDelay, skipReason } = require('./login-state');

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

async function chooseAccount(page, email) {
    const handle = await page.evaluateHandle(email => [...document.querySelectorAll('[data-identifier],[data-email]')]
        .find(el => el.getClientRects().length && (el.getAttribute('data-identifier') || el.getAttribute('data-email') || '').trim().toLowerCase() === email.toLowerCase()), email);
    try {
        const element = handle.asElement();
        if (!element) throw new Error('账号选择器未找到目标邮箱');
        await element.click();
        return true;
    } finally { await handle.dispose(); }
}

async function loginAccount(page, account, log = () => {}, timeoutMs = 360000, steps = []) {
    const started = Date.now();
    await page.goto('https://gemini.google.com/app', { waitUntil: 'domcontentloaded', timeout: 45000 });
    const deadline = Date.now() + timeoutMs;
    let lastAction = '', lastAt = 0;
    const attempts = new Map();
    let previousState = null;
    let wakeAfter = 1000;
    let supplementalVisits = 0;
    let geminiEnteredAt = 0;
    let geminiReloaded = false;
    let unavailableSelectionAt = 0;
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
        const reason = skipReason(state);
        if (reason) throw Object.assign(new Error(reason), { code: 'ACCOUNT_SKIPPED' });
        if (url.origin === 'https://gemini.google.com') {
            if (!geminiEnteredAt) geminiEnteredAt = Date.now();
            const accountState = await page.evaluate(geminiAccountState, account.email).catch(() => false);
            if (accountState === 'signed-in') { record('邮箱确认成功'); return page; }
            if (accountState === 'other-account') throw new Error('环境中的邮箱与目标账号不符');
            if (state.buttons.some(text => /^(Use without content apps|不使用内容应用)$/i.test(text))) {
                if (lastAction === '跳过可选内容应用' && Date.now() - lastAt < 5000) continue;
                if (await clickText(page, '^(Use without content apps|不使用内容应用)$')) {
                    record('跳过可选内容应用'); lastAction = '跳过可选内容应用'; lastAt = Date.now();
                }
                continue;
            }
            // 单次刷新恢复登录后未完整渲染的页面，仍须核对可见的账号控件。
            if (accountState === false && !geminiReloaded && Date.now() - geminiEnteredAt > 45000) {
                geminiReloaded = true; record('刷新未完成渲染的Gemini页面');
                await page.reload({ waitUntil: 'domcontentloaded', timeout: 45000 });
                continue;
            }
            // 已有会话加载时也可能短暂保留隐藏的登录链接；只有确认游客状态才进入登录。
            if (accountState !== 'guest') continue;
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
        geminiEnteredAt = 0;
        // 已实测：此入口位于2FA之后，为Google可选设置引导；返回Gemini即可跳过。
        if (url.origin === 'https://gds.google.com' && url.pathname === '/web/landing') {
            if (++supplementalVisits > 2) throw Object.assign(new Error('Google补充设置无法跳过'), { code: 'ACCOUNT_SKIPPED' });
            record('跳过Google补充设置');
            await page.goto('https://gemini.google.com/app', { waitUntil: 'domcontentloaded', timeout: 45000 });
            continue;
        }
        if (url.origin !== 'https://accounts.google.com') throw new Error('登录跳转到非预期网站');
        if (/\/unknownerror\/?$/.test(url.pathname)) throw new Error('Google登录服务出错，请稍后重试');
        if (/此浏览器或应用可能不安全|browser or app may not be secure/i.test(state.text)) throw new Error('Google 拒绝浏览器登录');
        if (/密码错误|Wrong password|密码不正确/i.test(state.text)) throw new Error('Google 提示密码错误');
        if (/密码.{0,40}(?:发生了更改|已更改|已更改过)|password was changed/i.test(state.text)) throw new Error('Google提示密码已更改，输入凭据失效');
        if (/账号已停用|account has been disabled|Couldn't find your Google Account|找不到您的 Google 账号|找不到此账号/i.test(state.text)) throw new Error('Google 提示账号不可用');
        const action = loginAction(state);
        const unavailableSelection = /\/challenge\/selection\/?$/.test(url.pathname)
            && !state.busy && !state.totp && !action
            && /选择您想要使用的登录方式|Choose how you want to sign in/i.test(state.text)
            && !state.buttons.some(text => /身份验证器|Authenticator/i.test(text));
        if (unavailableSelection) {
            if (!unavailableSelectionAt) unavailableSelectionAt = Date.now();
            if (Date.now() - unavailableSelectionAt >= 30000) {
                throw Object.assign(new Error('验证方式中未提供验证器验证码'), { code: 'ACCOUNT_SKIPPED' });
            }
        } else unavailableSelectionAt = 0;
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
        if (action === '选择目标账号') submitted = await chooseAccount(page, account.email);
        if (action === '其他验证方式') submitted = await clickText(page, '^(试试其他方式|Try another way)$');
        if (action === '跳过通行密钥') submitted = await clickText(page, '^(以后再说|Not now|Skip)$');
        if (action === '跳过补充信息') submitted = await clickText(page, '^(跳过|以后再说|暂不|不用了|Skip|Not now|Maybe later|No thanks)$');
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
