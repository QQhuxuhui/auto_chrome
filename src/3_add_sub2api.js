/**
 * 阶段3 — 在 sub2api 平台添加成员账号
 *
 * 登录 sub2api → 创建 antigravity 类型账号 → 填入 refresh_token
 */

require('dotenv').config();
const path = require('path');
const { log, createWorkerLogger, setVerbose, LOG_COLORS, StepTimer } = require('./common/logger');
const {
    sleep, rand, findChrome, launchRealChrome,
    clearBrowserSession, newPage, fastType, fastClick,
    tryClickStrategies, takeScreenshot, detectPageState,
} = require('./common/chrome');
const { parseAccounts, loadState, updateState, addFailedRecord } = require('./common/state');

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

// ============ sub2api 平台登录 ============
async function loginSub2api(page, wlog) {
    wlog.info('  Logging in to sub2api...');
    await page.goto(SUB2API_URL, { waitUntil: 'networkidle2', timeout: 30000 })
        .catch(e => wlog.warn(`sub2api page load timeout: ${e.message}`));

    await sleep(2000);

    // 检查是否已登录
    const currentUrl = page.url();
    const pageText = await page.evaluate(() =>
        document.body ? document.body.innerText.substring(0, 1000).toLowerCase() : ''
    ).catch(() => '');

    if (pageText.includes('dashboard') || pageText.includes('accounts') ||
        pageText.includes('仪表') || pageText.includes('账号')) {
        wlog.info('  Already logged in to sub2api');
        return;
    }

    // 输入用户名
    const usernameSelectors = [
        'input[name="username"]', 'input[name="user"]',
        'input[type="text"]:first-of-type', 'input[placeholder*="user" i]',
        'input[placeholder*="用户" i]', '#username', '#user',
    ];
    let usernameEntered = false;
    for (const sel of usernameSelectors) {
        try {
            const el = await page.$(sel);
            if (el) {
                await fastType(page, sel, SUB2API_USER, wlog);
                usernameEntered = true;
                break;
            }
        } catch (_) { }
    }

    if (!usernameEntered) {
        // 尝试所有 text input
        const inputs = await page.$$('input[type="text"], input:not([type])');
        if (inputs.length > 0) {
            await fastClick(page, inputs[0]);
            await sleep(100);
            await inputs[0].type(SUB2API_USER, { delay: 0 });
            usernameEntered = true;
        }
    }

    if (!usernameEntered) {
        await takeScreenshot(page, 'sub2api_no_username_input', wlog);
        throw new Error('Cannot find username input on sub2api');
    }

    // 输入密码
    const pwSelectors = ['input[type="password"]', 'input[name="password"]', '#password'];
    let pwEntered = false;
    for (const sel of pwSelectors) {
        try {
            const el = await page.$(sel);
            if (el) {
                await fastType(page, sel, SUB2API_PASS, wlog);
                pwEntered = true;
                break;
            }
        } catch (_) { }
    }

    if (!pwEntered) {
        await takeScreenshot(page, 'sub2api_no_password_input', wlog);
        throw new Error('Cannot find password input on sub2api');
    }

    await sleep(300);

    // 点击登录
    const loginKws = ['login', 'sign in', 'submit', '登录', '提交'];
    const clicked = await tryClickStrategies(page, loginKws, wlog, 'sub2api_login');
    if (!clicked) {
        await page.keyboard.press('Enter');
    }

    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(() => { });
    await sleep(2000);

    wlog.success('  sub2api login complete');
}

// ============ 添加单个账号到 sub2api ============
async function addAccountToSub2api(page, memberEmail, refreshToken, wlog) {
    wlog.info(`  Adding account: ${memberEmail}`);

    // 导航到添加账号页面（或点击添加按钮）
    const addKws = [
        'add', 'new', 'create', 'add account', 'new account',
        '添加', '新增', '创建', '添加账号', '新建账号',
    ];

    let addClicked = await tryClickStrategies(page, addKws, wlog, 'add_account_btn');
    if (!addClicked) {
        // 尝试导航到添加账号的 URL
        const addUrls = [
            `${SUB2API_URL}/account/add`,
            `${SUB2API_URL}/accounts/add`,
            `${SUB2API_URL}/add`,
        ];
        for (const url of addUrls) {
            try {
                await page.goto(url, { waitUntil: 'networkidle2', timeout: 10000 });
                const text = await page.evaluate(() => document.body ? document.body.innerText.substring(0, 500).toLowerCase() : '').catch(() => '');
                if (text.includes('account') || text.includes('token') || text.includes('账号')) {
                    addClicked = true;
                    break;
                }
            } catch (_) { }
        }
    }

    await sleep(1500);

    // 选择账号类型为 antigravity
    const typeKws = ['antigravity', 'type', '类型'];
    const selectElements = await page.$$('select, [role="combobox"], [role="listbox"]');
    for (const sel of selectElements) {
        try {
            const text = await page.evaluate(el => (el.textContent || '').toLowerCase(), sel).catch(() => '');
            if (text.includes('type') || text.includes('类型') || text.includes('antigravity')) {
                await fastClick(page, sel);
                await sleep(500);
                // 选择 antigravity 选项
                await page.evaluate(() => {
                    const options = document.querySelectorAll('option, li[role="option"], [role="option"]');
                    for (const opt of options) {
                        if ((opt.textContent || '').toLowerCase().includes('antigravity')) {
                            if (opt.tagName === 'OPTION') {
                                opt.selected = true;
                                opt.parentElement.dispatchEvent(new Event('change', { bubbles: true }));
                            } else {
                                opt.click();
                            }
                            return true;
                        }
                    }
                    return false;
                }).catch(() => false);
                break;
            }
        } catch (_) { }
    }

    // 也尝试直接点击 antigravity 文本
    await tryClickStrategies(page, ['antigravity'], wlog, 'select_type');
    await sleep(500);

    // 填入 refresh_token 或 Google Auth 信息
    // 查找 token/auth 相关输入框
    const tokenSelectors = [
        'input[name*="token" i]', 'input[name*="refresh" i]',
        'input[placeholder*="token" i]', 'input[placeholder*="refresh" i]',
        'textarea[name*="token" i]', 'textarea[placeholder*="token" i]',
        'input[name*="auth" i]', 'input[placeholder*="auth" i]',
    ];

    let tokenEntered = false;
    for (const sel of tokenSelectors) {
        try {
            const el = await page.$(sel);
            if (el) {
                const isVis = await page.evaluate(node => {
                    const r = node.getBoundingClientRect();
                    return r.width > 0 && r.height > 0;
                }, el).catch(() => false);
                if (isVis) {
                    await fastType(page, sel, refreshToken, wlog);
                    tokenEntered = true;
                    wlog.debug(`  Entered token via selector: ${sel}`);
                    break;
                }
            }
        } catch (_) { }
    }

    // 如果没找到 token 输入框，尝试所有可见的 text/textarea
    if (!tokenEntered) {
        const allInputs = await page.$$('input[type="text"], textarea, input:not([type])');
        for (const inp of allInputs) {
            try {
                const info = await page.evaluate(el => {
                    const r = el.getBoundingClientRect();
                    const placeholder = (el.placeholder || '').toLowerCase();
                    const name = (el.name || '').toLowerCase();
                    const label = el.closest('label') ? (el.closest('label').textContent || '').toLowerCase() : '';
                    return {
                        visible: r.width > 0 && r.height > 0,
                        placeholder, name, label,
                        value: el.value,
                    };
                }, inp).catch(() => null);
                if (!info || !info.visible || info.value) continue;
                if (info.placeholder.includes('token') || info.name.includes('token') ||
                    info.label.includes('token') || info.placeholder.includes('refresh') ||
                    info.name.includes('refresh') || info.label.includes('refresh')) {
                    await fastClick(page, inp);
                    await sleep(100);
                    await inp.type(refreshToken, { delay: 0 });
                    tokenEntered = true;
                    break;
                }
            } catch (_) { }
        }
    }

    if (!tokenEntered) {
        await takeScreenshot(page, `sub2api_no_token_input_${memberEmail}`, wlog);
        wlog.warn('  Could not find token input, taking screenshot for manual review');
    }

    // 填入邮箱（如果有邮箱输入框）
    const emailSelectors = [
        'input[name*="email" i]', 'input[type="email"]',
        'input[placeholder*="email" i]', 'input[name*="account" i]',
    ];
    for (const sel of emailSelectors) {
        try {
            const el = await page.$(sel);
            if (el) {
                const isVis = await page.evaluate(node => {
                    const r = node.getBoundingClientRect();
                    return r.width > 0 && r.height > 0;
                }, el).catch(() => false);
                if (isVis) {
                    await fastType(page, sel, memberEmail, wlog);
                    wlog.debug(`  Entered email via: ${sel}`);
                    break;
                }
            }
        } catch (_) { }
    }

    await sleep(500);

    // 点击提交/保存
    const submitKws = [
        'save', 'submit', 'add', 'create', 'confirm', 'ok',
        '保存', '提交', '添加', '创建', '确认', '确定',
    ];
    const submitted = await tryClickStrategies(page, submitKws, wlog, 'submit_account');
    if (!submitted) {
        await page.keyboard.press('Enter');
    }

    await sleep(3000);

    // 检查是否添加成功
    const resultText = await page.evaluate(() =>
        document.body ? document.body.innerText.substring(0, 1000).toLowerCase() : ''
    ).catch(() => '');

    if (resultText.includes('success') || resultText.includes('成功') ||
        resultText.includes('added') || resultText.includes('已添加')) {
        wlog.success(`  Account added successfully: ${memberEmail}`);
        return true;
    }

    // 即使没有明确的成功提示，只要没有错误信息也认为成功
    if (!resultText.includes('error') && !resultText.includes('fail') &&
        !resultText.includes('错误') && !resultText.includes('失败')) {
        wlog.info('  No explicit success/error message, assuming success');
        return true;
    }

    await takeScreenshot(page, `sub2api_add_result_${memberEmail}`, wlog);
    throw new Error(`Add account may have failed: ${resultText.substring(0, 200)}`);
}

// ============ 浏览器清理（支持 KEEP_BROWSER_OPEN） ============
const keepBrowserOpen = (process.env.KEEP_BROWSER_OPEN || '').toLowerCase() === 'true';
let _chrome = null;

function cleanupChrome() {
    if (!_chrome) return;
    if (keepBrowserOpen) {
        try { _chrome.browser.disconnect(); } catch (_) { }
        log('Browser kept open (KEEP_BROWSER_OPEN=true)');
    } else {
        try { _chrome.browser.close(); } catch (_) { }
        try { _chrome.proc.kill(); } catch (_) { }
    }
}

process.on('SIGINT', () => {
    log('\nInterrupted (Ctrl+C). Cleaning up...', 'WARN');
    cleanupChrome();
    process.exit();
});

// ============ main ============
async function main() {
    const chromePath = findChrome();
    if (!chromePath) { console.error('Chrome not found'); process.exit(1); }

    log('');
    log(`${'='.repeat(60)}`);
    log(`  Stage 3: Add Accounts to sub2api`);
    log(`${'='.repeat(60)}`);
    log(`  Chrome:     ${chromePath}`);
    log(`  sub2api:    ${SUB2API_URL}`);
    log(`  User:       ${SUB2API_USER}`);
    log(`${'='.repeat(60)}`);
    log('');

    const state = await loadState();

    if (state.length === 0) {
        log('No state found. Run stage 1 and 2 first.', 'ERROR');
        process.exit(1);
    }

    // 收集所有需要添加的成员
    const pendingMembers = [];
    for (const group of state) {
        for (let i = 0; i < group.members.length; i++) {
            if (group.stage2_accepted[i] && !group.stage3_added[i]) {
                const email = group.members[i];
                const refreshToken = group.refreshTokens[email];
                if (!refreshToken) {
                    log(`No refresh_token for ${email}, skipping (run auth.js first)`, 'WARN');
                    continue;
                }
                pendingMembers.push({
                    groupId: group.groupId,
                    memberIdx: i,
                    email,
                    refreshToken,
                });
            }
        }
    }

    log(`Pending members to add: ${pendingMembers.length}`);

    if (pendingMembers.length === 0) {
        log('All accounts already added. Exiting.', 'SUCCESS');
        return;
    }

    // 启动 Chrome（串行操作，只需1个）
    const chrome = _chrome = await launchRealChrome(chromePath, 0);
    const wlog = createWorkerLogger(0);

    try {
        const page = await newPage(chrome.browser);

        // 登录 sub2api
        await loginSub2api(page, wlog);

        const stats = { ok: 0, ng: 0 };

        for (const pending of pendingMembers) {
            try {
                // 每次添加前导航回主页
                await page.goto(SUB2API_URL, { waitUntil: 'networkidle2', timeout: 15000 }).catch(() => { });
                await sleep(1000);

                const success = await addAccountToSub2api(page, pending.email, pending.refreshToken, wlog);

                if (success) {
                    await updateState(state => {
                        const g = state.find(s => s.groupId === pending.groupId);
                        if (g) g.stage3_added[pending.memberIdx] = true;
                    });
                    stats.ok++;
                }
            } catch (e) {
                wlog.error(`Add failed [${pending.email}]: ${e.message}`, e);
                stats.ng++;
                await addFailedRecord({
                    stage: 3,
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
        log(`  Stage 3 Complete`, 'SUCCESS');
        log(`  OK: ${stats.ok}  FAIL: ${stats.ng}`);
        log(`${'='.repeat(60)}`);
        log('');

    } finally {
        cleanupChrome();
    }
}

main().catch(e => {
    log(`Fatal: ${e.message}`, 'ERROR');
    if (e.stack) console.error(e.stack);
    process.exit(1);
});
