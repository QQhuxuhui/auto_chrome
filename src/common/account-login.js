const { createHmac } = require('node:crypto');
const { setTimeout: sleep } = require('node:timers/promises');
const { geminiAccountState } = require('./gemini-session');

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

async function loginAccount(page, account, log = () => {}, timeoutMs = 360000) {
    await page.goto('https://gemini.google.com/app', { waitUntil: 'domcontentloaded', timeout: 45000 });
    const deadline = Date.now() + timeoutMs;
    let lastAction = '', lastAt = 0;
    const attempts = new Map();
    while (Date.now() < deadline) {
        await sleep(1000);
        const url = new URL(page.url());
        if (url.origin === 'https://gemini.google.com') {
            const state = await page.evaluate(geminiAccountState, account.email).catch(() => false);
            if (state === 'signed-in') return page;
            if (state === 'other-account') throw new Error('环境中的邮箱与目标账号不符');
            if (Date.now() - lastAt < 15000) continue;
            const href = await page.evaluate(() => [...document.links].find(el =>
                el.origin === 'https://accounts.google.com'
                && /^(登录|登入|Sign in)$/i.test(el.innerText.trim()))?.href);
            if (href) {
                log('打开登录页');
                await page.goto(href, { waitUntil: 'domcontentloaded', timeout: 45000 });
                lastAt = Date.now();
            }
            continue;
        }
        if (url.origin !== 'https://accounts.google.com') throw new Error('登录跳转到非预期网站');
        const state = await page.evaluate(() => {
            const visible = selector => [...document.querySelectorAll(selector)].some(el => el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden');
            return { text: document.body.innerText,
                email: visible('#identifierId:not([type="hidden"])'),
                password: visible('input[name="Passwd"]'),
                totp: visible('#totpPin'),
                buttons: [...document.querySelectorAll('button,[role="link"],[role="button"]')].filter(el=>el.getClientRects().length).map(el=>el.innerText.trim()) };
        }).catch(() => null);
        if (!state) continue;
        if (/此浏览器或应用可能不安全|browser or app may not be secure/i.test(state.text)) throw new Error('Google 拒绝浏览器登录');
        if (/密码错误|Wrong password|密码不正确/i.test(state.text)) throw new Error('Google 提示密码错误');
        if (/账号已停用|account has been disabled|Couldn't find your Google Account|找不到您的 Google 账号/i.test(state.text)) throw new Error('Google 提示账号不可用');
        let action;
        if (url.pathname.includes('/speedbump/passkeyenrollment') && state.buttons.some(text => /^(以后再说|Not now|Skip)$/i.test(text))) action = '跳过通行密钥';
        else if (state.totp) action = '验证器验证码';
        else if (state.password && /\/challenge\/pwd/.test(url.pathname)) action = '密码';
        else if (state.email && /\/identifier/.test(url.pathname)) action = '邮箱';
        else if (state.buttons.some(text => /身份验证器|Authenticator/i.test(text))) action = '选择身份验证器';
        else if (state.buttons.some(text => /^(试试其他方式|Try another way)$/i.test(text))) action = '其他验证方式';
        else continue;
        const key = `${url.pathname}:${action}`;
        if (key === lastAction && Date.now() - lastAt < 25000) continue;
        const count = (attempts.get(key) || 0) + 1;
        if (count > 3) throw new Error(`登录停留在${action}，需检查验证页面`);
        attempts.set(key, count);
        log(action);
        let submitted = false;
        if (action === '邮箱') submitted = await fillInput(page, '#identifierId', account.email);
        if (action === '密码') submitted = await fillInput(page, 'input[name="Passwd"]', account.password);
        if (action === '验证器验证码') {
            if (!account.secret) throw new Error('缺少验证器密钥');
            if (Date.now() % 30000 > 24000) await sleep(31000 - Date.now() % 30000);
            submitted = await fillInput(page, '#totpPin', totp(account.secret));
        }
        if (submitted) {
            // 输入事件更新表单后，使用真实键盘提交，避免程序化 click 未触发提交。
            await page.focus(action === '邮箱' ? '#identifierId' : action === '密码' ? 'input[name="Passwd"]' : '#totpPin');
            await page.keyboard.press('Enter');
        }
        if (action === '选择身份验证器') await clickText(page, '身份验证器|Authenticator');
        if (action === '其他验证方式') await clickText(page, '^(试试其他方式|Try another way)$');
        if (action === '跳过通行密钥') await clickText(page, '^(以后再说|Not now|Skip)$');
        lastAction = key;
        lastAt = Date.now();
    }
    throw new Error('等待登录完成超时');
}

module.exports = { loginAccount, totp };
