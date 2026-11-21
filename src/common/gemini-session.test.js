const assert = require('node:assert/strict');
const { test } = require('node:test');
const puppeteer = require('puppeteer-core');
const { geminiAccountState, loginToGemini } = require('./gemini-session');
const { exportCookies } = require('./cookie-export');
const fs = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');

test('在 Chrome 中识别 Gemini 账号状态', async t => {
    const browser = await puppeteer.launch(process.env.CHROME_PATH
        ? { executablePath: process.env.CHROME_PATH }
        : { channel: 'chrome' });
    t.after(() => browser.close());
    const email = 'tester@example.test';
    const target = 'https://gemini.google.com/app';

    async function fixture(html, url = target) {
        const page = await browser.newPage();
        await page.setRequestInterception(true);
        page.on('request', req => {
            if (req.url() === url) {
                return req.respond({ contentType: 'text/html; charset=utf-8', body: html });
            }
            return req.abort();
        });
        await page.goto(url);
        return page;
    }

    await t.test('游客页即使有对话输入框，也不能记作登录成功', async () => {
        const page = await fixture(`<header hidden><button aria-label="Google Account: ${email}"></button></header>
            <main><textarea></textarea><button aria-label="Google Account: ${email}">聊天内容</button></main>
            <a href="/login">登录</a>`);
        assert.equal(await page.evaluate(geminiAccountState, email), 'guest');
        await page.close();
    });
    await t.test('账号菜单显示目标邮箱时确认登录', async () => {
        const page = await fixture(`<a href="https://accounts.google.com/SignOutOptions"
            aria-label="Google 账号：测试（TESTER@example.test）">头像</a>`);
        assert.equal(await page.evaluate(geminiAccountState, email), 'signed-in');
        await page.close();
    });
    await t.test('新版侧栏账号入口支持本地化标签和双向文本标记', async () => {
        const page = await fixture(`<sidenav-mavatar-footer><a class="mavatar-footer-left"
            aria-label="Google એકાઉન્ટ: Test (\u202a${email}\u202c)">Test Pro</a></sidenav-mavatar-footer>`);
        assert.equal(await page.evaluate(geminiAccountState, email), 'signed-in');
        assert.equal(await page.evaluate(geminiAccountState, 'other@example.test'), 'other-account');
        await page.close();
    });
    await t.test('已知 Google 账号链接不依赖界面语言', async () => {
        const page = await fixture(`<a href="https://accounts.google.com/SignOutOptions"
            aria-label="Compte Google : Test (${email})">Compte</a>`);
        assert.equal(await page.evaluate(geminiAccountState, email), 'signed-in');
        await page.close();
    });
    await t.test('普通正文中相似的侧栏样式不被当成账号入口', async () => {
        const page = await fixture(`<main><a class="mavatar-footer-left"
            aria-label="Google Account: ${email}">聊天内容</a></main>`);
        assert.equal(await page.evaluate(geminiAccountState, email), false);
        await page.close();
    });
    await t.test('邮箱只有部分相同不能记作目标账号', async () => {
        const page = await fixture('<header><button aria-label="Google Account: Other (mytester@example.test)">头像</button></header>');
        assert.equal(await page.evaluate(geminiAccountState, email), 'other-account');
        await page.close();
    });
    await t.test('即使页面看起来相同，也不能在其他域确认登录', async () => {
        const page = await fixture(`<header><button aria-label="Google Account: ${email}">头像</button></header>`,
            'https://example.test/app');
        assert.equal(await page.evaluate(geminiAccountState, email), false);
        await page.close();
    });
    await t.test('多地址取并集，保留作用域和同名冲突，排除其他站点并拒绝不匹配邮箱', async () => {
        const dir = await fs.mkdtemp(path.join(tmpdir(), 'gemini-cookie-test-'));
        const page = await fixture(`<header><button aria-label="Google Account: ${email}">头像</button></header><textarea></textarea>`);
        try {
            await browser.defaultBrowserContext().setCookie(
                { name: 'gemini_test', value: 'fixture', domain: 'gemini.google.com', path: '/' },
                { name: 'account_test', value: 'account', domain: 'accounts.google.com', path: '/' },
                { name: 'path_test', value: 'bound', domain: 'accounts.google.com', path: '/RotateBoundCookies' },
                { name: 'play_test', value: 'play', domain: 'play.google.com', path: '/' },
                { name: 'search_test', value: 'search', domain: 'www.google.com', path: '/' },
                { name: 'same_name', value: 'gemini', domain: 'gemini.google.com', path: '/' },
                { name: 'same_name', value: 'accounts', domain: 'accounts.google.com', path: '/' },
                { name: 'other_test', value: 'excluded', domain: 'example.test', path: '/' });
            await assert.rejects(exportCookies(page, 'other@example.test', dir), /拒绝导出/);
            const exported = await exportCookies(page, email, dir);
            assert.equal(exported.initialization.verified, true);
            assert.match(exported.cookieText, /gemini_test=fixture/);
            for (const pair of ['account_test=account','path_test=bound','play_test=play','search_test=search','same_name=gemini']) assert.ok(exported.cookieText.includes(pair));
            assert.equal(exported.cookieText.split('same_name=').length - 1, 1);
            assert.deepEqual(exported.conflictingNames, ['same_name']);
            const metadata = JSON.parse(await fs.readFile(exported.metadataPath, 'utf8'));
            assert.equal(metadata.initialization.verified, true);
            const bound = metadata.scopes.find(s => s.url === 'https://accounts.google.com/RotateBoundCookies');
            assert.equal(bound.cookies.find(c => c.name === 'same_name').value, 'accounts');
            assert.equal(bound.cookies.find(c => c.name === 'path_test').path, '/RotateBoundCookies');
            assert.ok(bound.cookies.every(c => 'expires' in c && 'secure' in c && 'httpOnly' in c));
            assert.doesNotMatch(exported.cookieText, /other_test|[\r\n]/);
            assert.equal(await fs.readFile(exported.filePath, 'utf8'), exported.cookieText);
        } finally {
            await page.close();
            await fs.rm(dir, { recursive: true });
        }
    });
    await t.test('顶部链接被布局隐藏时仍能从游客页登录并确认邮箱', async () => {
        const page = await browser.newPage();
        const signIn = 'https://accounts.google.com/ServiceLogin';
        let visitedSignIn = false;
        await page.setRequestInterception(true);
        page.on('request', req => {
            let body;
            if (req.url() === target) {
                body = visitedSignIn
                    ? `<header><button aria-label="Google Account: ${email}">头像</button></header>`
                    : `<a hidden href="${signIn}">登录</a><a href="#">登录</a>`;
            } else if (req.url() === signIn) {
                visitedSignIn = true;
                body = `<a href="${target}">返回 Gemini</a>`;
            } else {
                return req.abort();
            }
            return req.respond({ contentType: 'text/html; charset=utf-8', body });
        });
        const returning = page.waitForSelector(`a[href="${target}"]`).then(link => link.click());
        const [confirmed] = await Promise.all([loginToGemini(browser, page, email, 10000), returning]);
        assert.equal(visitedSignIn, true);
        assert.equal(confirmed.url(), target);
        await page.close();
    });
});
