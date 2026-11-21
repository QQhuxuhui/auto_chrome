const assert = require('node:assert/strict');
const { test } = require('node:test');
const puppeteer = require('puppeteer-core');
const { ensureGeminiInitialized } = require('./gemini-initialization');
const { browserCookieData } = require('./cookie-export');

test('恢复会话保留Cookie作用域并补充服务器续期新增的TS', () => {
    const primary={name:'SID',value:'old',domain:'.google.com',path:'/',secure:true,httpOnly:true};
    const variant={...primary,value:'scoped',domain:'accounts.google.com'};
    const cookies=browserCookieData({scopes:[{cookies:[primary]},{cookies:[primary,variant]}]},'SID=current; __Secure-1PSIDTS=renewed; __Secure-3PSIDTS=third');
    assert.equal(cookies.length,4);
    assert.equal(cookies.find(x=>x.name==='SID'&&x.domain==='.google.com').value,'current');
    assert.equal(cookies.find(x=>x.name==='SID'&&x.domain==='accounts.google.com').value,'scoped');
    assert.equal(cookies.find(x=>x.name==='__Secure-1PSIDTS').value,'renewed');
    assert.equal(cookies.find(x=>x.name==='__Secure-1PSIDTS').domain,'.google.com');
});

test('首次初始化必须完成提示并确认邮箱和可用输入框', async t => {
    const browser=await puppeteer.launch(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{channel:'chrome'});
    t.after(()=>browser.close());
    const page=await browser.newPage();
    await page.setRequestInterception(true);
    page.on('request',request=>request.respond({contentType:'text/html; charset=utf-8',body:`
        <header><button aria-label="Google Account: tester@example.test">Account</button></header>
        <div role="textbox" contenteditable="true"></div>
        <section class="gem-banner-container">Gemini is AI and can make mistakes.
          <button onclick="this.closest('section').remove()">Got it</button></section>
        <model-response><button onclick="window.chatClicked=true">Get started</button></model-response>
        <button onclick="window.activityEnabled=true">Turn it on here</button>`}));
    await page.goto('https://gemini.google.com/app');
    const result=await ensureGeminiInitialized(page,'tester@example.test',{timeoutMs:5000,settleMs:100});
    assert.deepEqual(result.actions,['Got it']);
    assert.equal(result.verified,true);
    assert.equal(await page.evaluate(()=>!!window.chatClicked||!!window.activityEnabled),false);
    await page.evaluate(()=>document.querySelector('[contenteditable]').remove());
    await assert.rejects(ensureGeminiInitialized(page,'tester@example.test',{timeoutMs:400,settleMs:100}),/初始化未完成/);
    await assert.rejects(ensureGeminiInitialized(page,'other@example.test',{timeoutMs:400}),/邮箱不匹配/);
});
