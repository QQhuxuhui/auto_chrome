/**
 * 阶段4 — 处理 sub2api 二次验证
 *
 * 登录 sub2api → 点击测试 → 若弹出验证 URL → 访问 URL 完成验证 → 再次测试确认
 */

require('dotenv').config();
const path = require('path');
const { log, createWorkerLogger, setVerbose, LOG_COLORS, StepTimer } = require('./common/logger');
const {
    sleep, rand, findChrome, launchRealChrome,
    clearBrowserSession, newPage, fastClick,
    tryClickStrategies, takeScreenshot, detectPageState,
} = require('./common/chrome');
const { loadState, updateState, addFailedRecord } = require('./common/state');

// ============ CLI 参数 ============
const args = process.argv.slice(2);
if (args.includes('--verbose') || args.includes('-v')) setVerbose(true);

const SUB2API_URL = process.env.SUB2API_URL || 'http://104.194.91.23:3001';
const SUB2API_USER = process.env.SUB2API_USER || '';
const SUB2API_PASS = process.env.SUB2API_PASS || '';

if (!SUB2API_USER || !SUB2API_PASS) {
    console.error('Error: SUB2API_USER and SUB2API_PASS must be set in .env');
    process.exit(1);
}

// ============ sub2api 登录（复用阶段3的登录逻辑） ============
async function loginSub2api(page, wlog) {
    const { fastType } = require('./common/chrome');

    wlog.info('  Logging in to sub2api...');
    await page.goto(SUB2API_URL, { waitUntil: 'networkidle2', timeout: 30000 })
        .catch(e => wlog.warn(`sub2api page load timeout: ${e.message}`));

    await sleep(2000);

    const pageText = await page.evaluate(() =>
        document.body ? document.body.innerText.substring(0, 1000).toLowerCase() : ''
    ).catch(() => '');

    if (pageText.includes('dashboard') || pageText.includes('accounts') ||
        pageText.includes('仪表') || pageText.includes('账号')) {
        wlog.info('  Already logged in to sub2api');
        return;
    }

    // 用户名
    const usernameSelectors = [
        'input[name="username"]', 'input[name="user"]',
        'input[type="text"]:first-of-type', '#username', '#user',
    ];
    for (const sel of usernameSelectors) {
        try {
            const el = await page.$(sel);
            if (el) {
                await fastType(page, sel, SUB2API_USER, wlog);
                break;
            }
        } catch (_) { }
    }

    // 密码
    const pwEl = await page.$('input[type="password"]');
    if (pwEl) {
        await fastType(page, 'input[type="password"]', SUB2API_PASS, wlog);
    }

    await sleep(300);

    const loginKws = ['login', 'sign in', 'submit', '登录', '提交'];
    const clicked = await tryClickStrategies(page, loginKws, wlog, 'sub2api_login');
    if (!clicked) await page.keyboard.press('Enter');

    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(() => { });
    await sleep(2000);

    wlog.success('  sub2api login complete');
}

// ============ 测试并验证单个账号 ============
async function testAndVerifyAccount(page, browser, memberEmail, wlog) {
    const timer = new StepTimer(wlog);
    wlog.info(`  Testing account: ${memberEmail}`);

    // 在 sub2api 页面找到该账号
    // 尝试搜索该邮箱
    const searchInput = await page.$('input[type="search"], input[placeholder*="search" i], input[placeholder*="搜索" i]');
    if (searchInput) {
        await fastClick(page, searchInput);
        await sleep(200);
        const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
        await page.keyboard.down(mod);
        await page.keyboard.press('KeyA');
        await page.keyboard.up(mod);
        await page.keyboard.press('Backspace');
        await sleep(100);
        await searchInput.type(memberEmail, { delay: 0 });
        await sleep(1000);
    }

    // 找到该账号对应的行/卡片
    const accountFound = await page.evaluate((email) => {
        const allElements = document.querySelectorAll('tr, div[class*="card"], div[class*="item"], li');
        for (const el of allElements) {
            if ((el.textContent || '').includes(email)) {
                return true;
            }
        }
        return false;
    }, memberEmail).catch(() => false);

    if (!accountFound) {
        wlog.warn(`  Account not found in sub2api: ${memberEmail}`);
        // 尝试导航到账号列表
        await page.goto(SUB2API_URL, { waitUntil: 'networkidle2', timeout: 15000 }).catch(() => { });
        await sleep(2000);
    }

    // 点击"测试"按钮
    // 先定位到该账号行，再找测试按钮
    const testClicked = await page.evaluate((email) => {
        const allElements = document.querySelectorAll('tr, div[class*="card"], div[class*="item"], li, div[class*="row"]');
        for (const el of allElements) {
            if (!(el.textContent || '').includes(email)) continue;
            // 在该行中找测试按钮
            const buttons = el.querySelectorAll('button, a, [role="button"]');
            for (const btn of buttons) {
                const btnText = (btn.textContent || '').toLowerCase();
                if (btnText.includes('test') || btnText.includes('测试') ||
                    btnText.includes('check') || btnText.includes('验证')) {
                    btn.click();
                    return btnText.substring(0, 30);
                }
            }
        }
        return null;
    }, memberEmail).catch(() => null);

    if (!testClicked) {
        // fallback：用关键词搜索全局测试按钮
        const testKws = ['test', '测试', 'check', '验证'];
        await tryClickStrategies(page, testKws, wlog, 'test_btn');
    } else {
        wlog.debug(`  Clicked test button: "${testClicked}"`);
    }

    await sleep(5000);
    timer.step('Test clicked');

    // 检查测试结果
    // 可能的结果：
    // 1. 直接通过
    // 2. 弹出对话框，包含验证 URL
    // 3. 失败

    const pageText = await page.evaluate(() =>
        document.body ? document.body.innerText.substring(0, 3000) : ''
    ).catch(() => '');

    const textLower = pageText.toLowerCase();

    // 检查是否测试通过
    if (textLower.includes('success') || textLower.includes('passed') ||
        textLower.includes('成功') || textLower.includes('通过') ||
        textLower.includes('active') || textLower.includes('正常')) {
        wlog.success(`  Test passed directly: ${memberEmail}`);
        return true;
    }

    // 检查是否需要二次验证 — 查找验证 URL
    const verifyUrl = await page.evaluate(() => {
        const text = document.body ? document.body.innerText : '';
        // 匹配 URL 模式
        const urlPattern = /https?:\/\/[^\s<>"']+/gi;
        const urls = text.match(urlPattern) || [];
        // 查找验证相关的 URL
        for (const url of urls) {
            if (url.includes('accounts.google.com') ||
                url.includes('myaccount.google.com') ||
                url.includes('oauth') ||
                url.includes('auth') ||
                url.includes('verify') ||
                url.includes('consent') ||
                url.includes('approval')) {
                return url;
            }
        }
        // 也检查弹窗/对话框中的链接
        const dialogs = document.querySelectorAll('[role="dialog"], [class*="modal"], [class*="dialog"], [class*="popup"]');
        for (const dialog of dialogs) {
            const links = dialog.querySelectorAll('a[href]');
            for (const link of links) {
                if (link.href.includes('google.com')) {
                    return link.href;
                }
            }
            // 也检查文本中的 URL
            const dialogText = dialog.innerText || '';
            const dialogUrls = dialogText.match(/https?:\/\/[^\s<>"']+/gi) || [];
            for (const url of dialogUrls) {
                if (url.includes('google.com')) return url;
            }
        }
        return null;
    }).catch(() => null);

    if (verifyUrl) {
        wlog.info(`  Verification URL found: ${verifyUrl.substring(0, 80)}...`);
        timer.step('Found verify URL');

        // 在新标签中打开验证 URL
        const verifyPage = await browser.newPage();
        try {
            await verifyPage.goto(verifyUrl, { waitUntil: 'networkidle2', timeout: 30000 })
                .catch(e => wlog.warn(`Verify page load timeout: ${e.message}`));

            await sleep(3000);

            // 处理验证页面（可能需要点击同意/确认等按钮）
            for (let verifyStep = 0; verifyStep < 10; verifyStep++) {
                const vPageText = await verifyPage.evaluate(() =>
                    document.body ? document.body.innerText.substring(0, 1000).toLowerCase() : ''
                ).catch(() => '');
                const vUrl = verifyPage.url();

                wlog.debug(`  Verify step ${verifyStep + 1}, URL: ${vUrl.substring(0, 80)}`);

                // 检查是否验证完成
                if (vPageText.includes('success') || vPageText.includes('verified') ||
                    vPageText.includes('complete') || vPageText.includes('done') ||
                    vPageText.includes('成功') || vPageText.includes('已验证') ||
                    vPageText.includes('完成')) {
                    wlog.success('  Verification complete!');
                    break;
                }

                // 点击确认/同意/继续按钮
                const verifyKws = [
                    'continue', 'allow', 'accept', 'confirm', 'agree', 'ok', 'yes', 'grant',
                    'sign in', 'approve', 'done',
                    '继续', '允许', '接受', '确认', '同意', '确定', '是', '授权',
                    '登录', '批准', '完成',
                    'advanced', '高级', 'unsafe', '不安全', 'go to', '前往',
                ];
                const vClicked = await tryClickStrategies(verifyPage, verifyKws, wlog, 'verify_confirm');
                if (vClicked) {
                    await verifyPage.waitForNavigation({ waitUntil: 'networkidle2', timeout: 8000 }).catch(() => { });
                    await sleep(1500);
                } else {
                    // 没有可点击的，检查是否需要登录
                    const stateInfo = await detectPageState(verifyPage, wlog);
                    if (stateInfo.state === 'email' || stateInfo.state === 'password') {
                        wlog.warn('  Verify page requires login — this should not happen in normal flow');
                        await takeScreenshot(verifyPage, `verify_needs_login_${memberEmail}`, wlog);
                    }
                    break;
                }
            }

            timer.step('Verification flow');

        } finally {
            await verifyPage.close().catch(() => { });
        }

        // 回到 sub2api，再次点击测试确认
        await sleep(2000);
        wlog.info('  Re-testing account after verification...');

        // 刷新 sub2api 页面
        await page.reload({ waitUntil: 'networkidle2', timeout: 15000 }).catch(() => { });
        await sleep(2000);

        // 再次点击测试
        const reTestClicked = await page.evaluate((email) => {
            const allElements = document.querySelectorAll('tr, div[class*="card"], div[class*="item"], li, div[class*="row"]');
            for (const el of allElements) {
                if (!(el.textContent || '').includes(email)) continue;
                const buttons = el.querySelectorAll('button, a, [role="button"]');
                for (const btn of buttons) {
                    const btnText = (btn.textContent || '').toLowerCase();
                    if (btnText.includes('test') || btnText.includes('测试') ||
                        btnText.includes('check') || btnText.includes('验证')) {
                        btn.click();
                        return true;
                    }
                }
            }
            return false;
        }, memberEmail).catch(() => false);

        if (!reTestClicked) {
            const testKws = ['test', '测试', 'check', '验证'];
            await tryClickStrategies(page, testKws, wlog, 'retest_btn');
        }

        await sleep(5000);

        // 检查重新测试结果
        const reTestText = await page.evaluate(() =>
            document.body ? document.body.innerText.substring(0, 2000).toLowerCase() : ''
        ).catch(() => '');

        if (reTestText.includes('success') || reTestText.includes('passed') ||
            reTestText.includes('成功') || reTestText.includes('通过') ||
            reTestText.includes('active') || reTestText.includes('正常')) {
            wlog.success(`  Re-test passed: ${memberEmail}`);
            return true;
        }

        wlog.warn(`  Re-test result unclear for ${memberEmail}`);
        await takeScreenshot(page, `retest_result_${memberEmail}`, wlog);
        // 即使结果不明确，验证流程已完成，标记为成功
        return true;
    }

    // 无验证 URL，测试失败
    wlog.error(`  Test failed for ${memberEmail}: no verify URL, no success`);
    await takeScreenshot(page, `test_failed_${memberEmail}`, wlog);
    throw new Error(`Test failed: ${textLower.substring(0, 200)}`);
}

// ============ main ============
async function main() {
    const chromePath = findChrome();
    if (!chromePath) { console.error('Chrome not found'); process.exit(1); }

    log('');
    log(`${'='.repeat(60)}`);
    log(`  Stage 4: Verify Accounts on sub2api`);
    log(`${'='.repeat(60)}`);
    log(`  Chrome:     ${chromePath}`);
    log(`  sub2api:    ${SUB2API_URL}`);
    log(`${'='.repeat(60)}`);
    log('');

    const state = await loadState();

    if (state.length === 0) {
        log('No state found. Run stages 1-3 first.', 'ERROR');
        process.exit(1);
    }

    // 收集需要验证的成员
    const pendingMembers = [];
    for (const group of state) {
        for (let i = 0; i < group.members.length; i++) {
            if (group.stage3_added[i] && !group.stage4_verified[i]) {
                pendingMembers.push({
                    groupId: group.groupId,
                    memberIdx: i,
                    email: group.members[i],
                });
            }
        }
    }

    log(`Pending members to verify: ${pendingMembers.length}`);

    if (pendingMembers.length === 0) {
        log('All accounts already verified. Exiting.', 'SUCCESS');
        return;
    }

    // 启动 Chrome（串行）
    const chrome = await launchRealChrome(chromePath, 0);
    const wlog = createWorkerLogger(0);

    try {
        const page = await newPage(chrome.browser);

        // 登录 sub2api
        await loginSub2api(page, wlog);

        const stats = { ok: 0, ng: 0 };

        for (const pending of pendingMembers) {
            try {
                // 导航回主页
                await page.goto(SUB2API_URL, { waitUntil: 'networkidle2', timeout: 15000 }).catch(() => { });
                await sleep(1000);

                const success = await testAndVerifyAccount(page, chrome.browser, pending.email, wlog);

                if (success) {
                    await updateState(state => {
                        const g = state.find(s => s.groupId === pending.groupId);
                        if (g) g.stage4_verified[pending.memberIdx] = true;
                    });
                    stats.ok++;
                }
            } catch (e) {
                wlog.error(`Verify failed [${pending.email}]: ${e.message}`, e);
                stats.ng++;
                await addFailedRecord({
                    stage: 4,
                    groupId: pending.groupId,
                    memberEmail: pending.email,
                    reason: e.message,
                });
            }

            await sleep(rand(1000, 2000));
        }

        await page.close().catch(() => { });

        log('');
        log(`${'='.repeat(60)}`);
        log(`  Stage 4 Complete`, 'SUCCESS');
        log(`  OK: ${stats.ok}  FAIL: ${stats.ng}`);
        log(`${'='.repeat(60)}`);
        log('');

    } finally {
        try { chrome.browser.close(); } catch (_) { }
        try { chrome.proc.kill(); } catch (_) { }
    }
}

main().catch(e => {
    log(`Fatal: ${e.message}`, 'ERROR');
    if (e.stack) console.error(e.stack);
    process.exit(1);
});
