const assert = require('node:assert/strict');
const { test } = require('node:test');
const puppeteer = require('puppeteer-core');
const { geminiAccountState, loginToGemini } = require('./gemini-session');

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
    await t.test('从游客页打开 Google 登录入口，返回 Gemini 后确认邮箱', async () => {
        const page = await browser.newPage();
        const signIn = 'https://accounts.google.com/ServiceLogin';
        let visitedSignIn = false;
        await page.setRequestInterception(true);
        page.on('request', req => {
            let body;
            if (req.url() === target) {
                body = visitedSignIn
                    ? `<header><button aria-label="Google Account: ${email}">头像</button></header>`
                    : `<a href="${signIn}">登录</a>`;
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
