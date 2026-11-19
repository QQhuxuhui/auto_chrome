const assert = require('node:assert/strict');
const { test } = require('node:test');
const puppeteer = require('puppeteer-core');
const { loginAccount, totp } = require('./account-login');
const { loginAction, readLoginState } = require('./login-state');

test('跳转期间不重复操作旧控件', () => {
    const state = { pathname: '/v3/signin/challenge/totp', buttons: ['从 Google 身份验证器应用获取验证码', '试试其他方式'] };
    assert.equal(loginAction(state), null);
    assert.equal(loginAction({ ...state, totp: true }), '验证器验证码');
    assert.equal(loginAction({ ...state, pathname: '/v3/signin/challenge/selection' }), '选择身份验证器');
    assert.equal(loginAction({ ...state, pathname: '/v3/signin/challenge/dp', password: true }), null);
    assert.equal(loginAction({ ...state, pathname: '/v3/signin/challenge/dp' }), '其他验证方式');
    assert.equal(loginAction({ ...state, totp: true, busy: true }), null);
});

test('验证器算法符合 RFC 测试向量', () => {
    assert.equal(totp('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', 59000), '287082');
});

test('已有会话尚在渲染时，不沿隐藏登录链接重新登录', async t => {
    const browser = await puppeteer.launch(process.env.CHROME_PATH
        ? { executablePath: process.env.CHROME_PATH } : { channel: 'chrome' });
    t.after(() => browser.close());
    const page = await browser.newPage();
    const email = 'existing@example.test';
    let loginRequests = 0;
    await page.setRequestInterception(true);
    page.on('request', request => {
        if (new URL(request.url()).origin !== 'https://gemini.google.com') { loginRequests++; return request.abort(); }
        return request.respond({ contentType: 'text/html; charset=utf-8', body: `<a hidden href="https://accounts.google.com/ServiceLogin">登录</a><script>setTimeout(()=>{document.body.innerHTML='<header><button aria-label="Google Account: ${email}">头像</button></header>';},500);</script>` });
    });
    await loginAccount(page, { email }, () => {}, 5000);
    assert.equal(loginRequests, 0);
});

test('跳过Google补充设置和Gemini可选内容应用后核对邮箱', async t => {
    const browser = await puppeteer.launch(process.env.CHROME_PATH
        ? { executablePath: process.env.CHROME_PATH } : { channel: 'chrome' });
    t.after(() => browser.close());
    const page = await browser.newPage();
    const email = 'optional@example.test';
    let visitedGds = false;
    await page.setRequestInterception(true);
    page.on('request', request => {
        const url = new URL(request.url());
        let body;
        if (url.origin === 'https://accounts.google.com') return request.respond({ status: 302, headers: { location: 'https://gds.google.com/web/landing' } });
        if (url.origin === 'https://gds.google.com') { visitedGds = true; body = '<p>可选补充设置</p>'; }
        else if (url.origin === 'https://gemini.google.com') body = visitedGds
            ? `<button id="skip">Use without content apps</button><script>document.querySelector('#skip').onclick=()=>document.body.innerHTML='<a href="https://accounts.google.com/SignOutOptions" aria-label="Google Account: ${email}">Account</a>';</script>`
            : '<a href="https://accounts.google.com/ServiceLogin">登录</a>';
        else return request.abort();
        return request.respond({ contentType: 'text/html; charset=utf-8', body });
    });
    const steps = [];
    await loginAccount(page, { email }, () => {}, 10000, steps);
    assert.equal(visitedGds, true);
    assert.deepEqual(steps.map(step=>step.stage), ['打开登录页', '跳过Google补充设置', '跳过可选内容应用', '邮箱确认成功']);
});

test('模拟完整登录：等待延迟渲染，阶段就绪立即推进且仅提交一次', async t => {
    const browser = await puppeteer.launch(process.env.CHROME_PATH
        ? { executablePath: process.env.CHROME_PATH } : { channel: 'chrome' });
    t.after(() => browser.close());
    const page = await browser.newPage();
    const account = { email: 'tester@example.test', password: 'fixture-password', secret: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ' };
    let visitedLogin = false;
    await page.setRequestInterception(true);
    page.on('request', req => {
        const url = new URL(req.url());
        if (url.origin === 'https://gemini.google.com') {
            const body = visitedLogin
                ? `<header><button aria-label="Google Account: ${account.email}">头像</button></header>`
                : '<a hidden href="https://accounts.google.com/v3/signin/identifier">登录</a><a href="#">登录</a>';
            return req.respond({ contentType: 'text/html; charset=utf-8', body });
        }
        if (url.origin !== 'https://accounts.google.com') return req.abort();
        visitedLogin = true;
        return req.respond({ contentType: 'text/html; charset=utf-8', body: `
            <div role="progressbar" style="opacity:0">加载</div><main></main>
            <script>
            const main = document.querySelector('main');
            function transition(path, render) {
                history.pushState({}, '', '/v3/signin/' + path);
                // 复现路径先变、旧控件后消失的实际登录页面。
                setTimeout(render, 350);
            }
            function form(id, name, type, next) {
                main.innerHTML = '<form><input id="' + id + '" name="' + name + '" type="' + type + '"><button>下一步</button></form>';
                main.querySelector('form').onsubmit = event => {
                    event.preventDefault();
                    if (!main.querySelector('input').value) throw Error('empty input');
                    next();
                };
            }
            function choose() {
                main.innerHTML = '<button>从 Google 身份验证器应用获取验证码</button>';
                main.querySelector('button').onclick = () => transition('challenge/totp', () => {
                    form('totpPin', 'totpPin', 'tel', () => { location.href = 'https://gemini.google.com/app'; });
                });
            }
            form('identifierId', 'identifier', 'text', () => transition('challenge/pwd', () => {
                form('password', 'Passwd', 'password', () => transition('challenge/skotp', () => {
                    main.innerHTML = '<button>试试其他方式</button>';
                    main.querySelector('button').onclick = () => transition('challenge/selection', choose);
                }));
            }));
            </script>` });
    });
    const steps = [];
    await loginAccount(page, account, () => {}, 15000, steps);
    assert.deepEqual(steps.map(step => step.stage), [
        '打开登录页', '邮箱', '密码', '其他验证方式', '选择身份验证器', '验证器验证码', '邮箱确认成功',
    ]);
    assert.ok(steps.filter(step => step.attempt).every(step => step.attempt === 1));
    assert.doesNotMatch(JSON.stringify(steps), /fixture-password|GEZDGNBV/);
    assert.equal(new URL(page.url()).origin, 'https://gemini.google.com');

    await t.test('禁用或隐藏的按钮不被当作可操作控件', async () => {
        await page.setContent('<button disabled>试试其他方式</button><button aria-disabled="true">Authenticator</button><button style="opacity:0">Next</button>');
        assert.deepEqual((await page.evaluate(readLoginState)).buttons, []);
    });
});
