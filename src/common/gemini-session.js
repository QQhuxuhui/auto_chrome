const { setTimeout: sleep } = require('node:timers/promises');

// 此函数在页面内执行。只读取 Gemini 顶部或侧栏的账号控件中的邮箱。
function geminiAccountState(expectedEmail) {
    if (location.origin !== 'https://gemini.google.com') return false;

    const controls = Array.from(document.querySelectorAll('a, button, [role="button"]'))
        .filter(el => el.getClientRects().length && getComputedStyle(el).visibility === 'visible');
    const email = expectedEmail.trim().toLowerCase();
    for (const el of controls) {
        const isAccountLink = el.origin === 'https://accounts.google.com' && el.pathname === '/SignOutOptions';
        const isSidebarAccount = el.matches('sidenav-mavatar-footer a.mavatar-footer-left');
        const knownAccountControl = isAccountLink || isSidebarAccount;
        if (!knownAccountControl && !el.closest('header, [role="banner"]')) continue;
        const labels = [el.getAttribute('aria-label'), el.getAttribute('title')].filter(Boolean);
        // 已知账号入口不依赖翻译后的“Google 账号”前缀，兼容其他语言。
        if (!knownAccountControl && !labels.some(label => /Google\s*(?:Account\b|账号|帐号|帳戶|帳號)/i.test(label))) continue;
        const emails = labels.join(' ').toLowerCase().replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '')
            .split(/[\s:：,，()（）<>]+/).filter(part => part.includes('@'));
        if (emails.includes(email)) return 'signed-in';
        if (emails.length) return 'other-account';
    }

    const hasSignIn = controls.some(el =>
        [el.textContent, el.getAttribute('aria-label')].some(label => /^(sign in|登录|登入)$/i.test((label || '').trim()))
    );
    return hasSignIn ? 'guest' : false;
}

function googleSignInLink() {
    if (location.origin !== 'https://gemini.google.com') return null;
    const link = Array.from(document.links).find(el => el.origin === 'https://accounts.google.com'
        && [el.textContent, el.getAttribute('aria-label')].some(label => /^(sign in|登录|登入)$/i.test((label || '').trim())));
    return link ? link.href : null;
}

async function loginToGemini(browser, page, email, timeoutMs = 10 * 60 * 1000) {
    await page.goto('https://gemini.google.com/app', { waitUntil: 'domcontentloaded' });
    const deadline = Date.now() + timeoutMs;
    let openedSignIn = false;
    let otherAccount = false;
    while (browser.connected && Date.now() < deadline) {
        const tabs = (await browser.pages()).filter(tab => tab.url().startsWith('https://gemini.google.com/'));
        for (const tab of tabs) {
            // 用户可能正在提交表单或关闭标签页。下一轮读取导航后的页面。
            const state = await tab.evaluate(geminiAccountState, email).catch(() => false);
            if (state === 'signed-in') return tab;
            if (state === 'other-account' && !otherAccount) {
                otherAccount = true;
                console.log('当前 Gemini 邮箱与目标邮箱不符，请在账号菜单切换账号。');
            }
            if (state === 'guest' && tab === page && !openedSignIn) {
                const href = await tab.evaluate(googleSignInLink).catch(() => null);
                if (href) {
                    openedSignIn = true;
                    await tab.goto(href, { waitUntil: 'domcontentloaded' });
                }
            }
        }
        await sleep(500);
    }
    throw new Error(browser.connected ? '等待 Gemini 确认登录超时' : '验证前浏览器已关闭');
}

module.exports = { geminiAccountState, loginToGemini };
