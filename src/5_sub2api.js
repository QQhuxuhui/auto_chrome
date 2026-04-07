/**
 * 阶段 — 在 sub2api 平台添加成员账号并完成 OAuth 授权
 *
 * 读取 sub2api.txt (账号密码) + members.txt (成员列表)
 * 检查 state.json 中 stage1_invited && stage2_accepted 的成员
 * 登录 sub2api → 账号管理 → 添加账号 → 填表 → 下一步 → 生成授权链接
 * → 新窗口 Google OAuth → 复制回调 URL → 完成授权
 */

require('dotenv').config();
const path = require('path');
const fs = require('fs');
const { log, createWorkerLogger, setVerbose, StepTimer } = require('./common/logger');
const {
    sleep, rand, findChrome, launchRealChrome,
    newPage, takeScreenshot, tryClickStrategies,
} = require('./common/chrome');
const { parseAccounts, loadState, updateState, addFailedRecord } = require('./common/state');
const { googleLogin } = require('./common/google-login');

// ============ CLI 参数 ============
const args = process.argv.slice(2);
if (args.includes('--verbose') || args.includes('-v')) setVerbose(true);

const SUB2API_URL = 'http://104.194.91.23:3001';

function readSub2apiCredentials() {
    const f = path.resolve(__dirname, '..', 'sub2api.txt');
    if (!fs.existsSync(f)) throw new Error('sub2api.txt not found');
    const lines = fs.readFileSync(f, 'utf-8').trim().split(/\r?\n/);
    if (lines.length < 2) throw new Error('sub2api.txt must have email on line 1 and password on line 2');
    return { user: lines[0].trim(), pass: lines[1].trim() };
}

function getDateString() {
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}${m}${day}`;
}

// ============ 精确点击按钮 (按文本) ============
async function clickButtonByText(page, text, exact = true) {
    return page.evaluate(({ text, exact }) => {
        for (const btn of document.querySelectorAll('button, [role="button"]')) {
            const r = btn.getBoundingClientRect();
            if (r.width <= 0 || r.height <= 0) continue;
            const btnText = btn.textContent.trim();
            if (exact ? btnText === text : btnText.includes(text)) {
                btn.click();
                return true;
            }
        }
        return false;
    }, { text, exact }).catch(() => false);
}

// ============ 精确点击链接 (按文本) ============
async function clickLinkByText(page, text) {
    return page.evaluate((text) => {
        for (const a of document.querySelectorAll('a')) {
            if (a.textContent.trim() === text) { a.click(); return true; }
        }
        return false;
    }, text).catch(() => false);
}

// ============ 关闭欢迎弹窗 ============
async function dismissWelcomePopup(page) {
    await page.evaluate(() => {
        // 删除 modal/overlay 元素
        for (const el of document.querySelectorAll('[class*="modal"], [class*="overlay"], [class*="backdrop"]')) {
            el.remove();
        }
        // 点击 × 按钮
        const xBtns = [...document.querySelectorAll('button')].filter(b => b.textContent.trim() === '×');
        if (xBtns.length > 0) xBtns[xBtns.length - 1].click();
    }).catch(() => {});
    await sleep(500);
    await page.keyboard.press('Escape').catch(() => {});
    await sleep(500);
    await page.keyboard.press('Escape').catch(() => {});
    await sleep(500);
}

// ============ 登录 sub2api ============
async function loginSub2api(page, creds, wlog) {
    wlog.info('  Logging in to sub2api...');
    await page.goto(SUB2API_URL, { waitUntil: 'networkidle2', timeout: 30000 })
        .catch(e => wlog.warn(`sub2api load timeout: ${e.message}`));
    await sleep(2000);

    // 检查是否已登录
    const url = page.url();
    if (url.includes('/dashboard') || url.includes('/home') || url.includes('/admin')) {
        wlog.info('  Already logged in');
        return;
    }

    const emailInput = await page.$('input[type="email"], input[name="email"], input[name="username"]');
    if (emailInput) {
        await emailInput.type(creds.user, { delay: 0 });
        const pwInput = await page.$('input[type="password"]');
        if (pwInput) await pwInput.type(creds.pass, { delay: 0 });
        await sleep(300);
        await clickButtonByText(page, '登录');
        await sleep(3000);
    }

    wlog.success('  sub2api login complete');
}

// ============ 导航到账号管理页 ============
async function navigateToAccounts(page, wlog) {
    // 先确保在 dashboard
    await page.goto(`${SUB2API_URL}/dashboard`, { waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {});
    await sleep(3000);

    // 关闭欢迎弹窗
    await dismissWelcomePopup(page);

    // 点击侧边栏 "账号管理"
    wlog.info('  Navigating to 账号管理...');
    await clickLinkByText(page, '账号管理');
    await sleep(3000);

    // 验证页面
    const text = await page.evaluate(() => document.body?.innerText?.substring(0, 500) || '').catch(() => '');
    if (!text.includes('添加账号')) {
        wlog.warn('  账号管理 page may not have loaded, retrying...');
        await clickLinkByText(page, '账号管理');
        await sleep(3000);
    }
}

// ============ 填写添加账号表单 (第一步) ============
async function fillAddAccountForm(page, memberEmail, wlog) {
    const accountName = `anti_3_${memberEmail}${getDateString()}`;
    wlog.info(`  Account name: ${accountName}`);

    // 点击 "添加账号" 按钮
    const addClicked = await clickButtonByText(page, '添加账号');
    if (!addClicked) {
        throw new Error('Cannot find 添加账号 button');
    }
    await sleep(2000);

    // 1. 填写账号名称
    const nameInput = await page.$('input[placeholder="请输入账号名称"]');
    if (!nameInput) throw new Error('Cannot find account name input');
    await nameInput.click();
    await sleep(100);
    await nameInput.type(accountName, { delay: 0 });
    wlog.debug('  Filled account name');

    // 2. 选择平台: Antigravity
    await clickButtonByText(page, 'Antigravity');
    await sleep(1000);
    wlog.debug('  Selected platform: Antigravity');

    // 3. 选择账号类型: Claude Code (OAuth)
    // 选择 Antigravity 后，第一个选项 "Claude Code" 通常已默认选中
    // 确保选择的是 OAuth 方式
    await page.evaluate(() => {
        const radios = document.querySelectorAll('input[type="radio"]');
        for (const r of radios) {
            if (r.value === 'oauth') { r.click(); return; }
        }
    }).catch(() => {});
    await sleep(500);
    wlog.debug('  Selected OAuth method');

    // 4. 选择代理: 点击 "无代理" 下拉框，选择 socks5 代理
    wlog.debug('  Selecting proxy...');
    await clickButtonByText(page, '无代理');
    await sleep(1000);

    // 在弹出的下拉列表中选择包含 "216.175.194.166" 的选项
    const proxySelected = await page.evaluate(() => {
        // 查找下拉菜单项
        const items = document.querySelectorAll('[role="option"], [role="menuitem"], li, div[class*="option"], div[class*="item"]');
        for (const item of items) {
            const text = item.textContent || '';
            if (text.includes('216.175.194.166') || text.includes('socks5')) {
                item.click();
                return text.trim().substring(0, 60);
            }
        }
        return null;
    }).catch(() => null);

    if (proxySelected) {
        wlog.debug(`  Selected proxy: ${proxySelected}`);
    } else {
        wlog.warn('  Proxy option not found in dropdown, trying text search...');
        await tryClickStrategies(page, ['216.175', 'socks5', '443'], wlog, 'proxy_select');
    }
    await sleep(500);

    // 5. 选择分组: antigravity
    wlog.debug('  Selecting group: antigravity...');
    // 滚动到分组区域
    await page.evaluate(() => {
        const labels = document.querySelectorAll('label, span, div');
        for (const el of labels) {
            const text = el.textContent.trim().toLowerCase();
            if (text.includes('分组') && text.includes('已选')) {
                el.scrollIntoView({ behavior: 'instant', block: 'center' });
                return;
            }
        }
    }).catch(() => {});
    await sleep(500);

    // 找到 antigravity 分组的 checkbox 并勾选
    const groupChecked = await page.evaluate(() => {
        const checkboxes = document.querySelectorAll('input[type="checkbox"]');
        for (const cb of checkboxes) {
            const parent = cb.closest('label, div, li');
            if (parent && parent.textContent.toLowerCase().includes('antigravity')) {
                if (!cb.checked) cb.click();
                return true;
            }
        }
        // 也尝试点击包含 antigravity 文本的元素
        for (const el of document.querySelectorAll('label, div, span')) {
            const text = el.textContent.trim().toLowerCase();
            if (text.includes('antigravity') && !text.includes('platform')) {
                el.click();
                return true;
            }
        }
        return false;
    }).catch(() => false);

    if (groupChecked) {
        wlog.debug('  Selected group: antigravity');
    } else {
        wlog.warn('  antigravity group not found, continuing without group selection');
    }
    await sleep(500);

    // 6. 点击 "下一步"
    wlog.info('  Clicking 下一步...');
    await clickButtonByText(page, '下一步');
    await sleep(3000);

    return accountName;
}

// ============ 第二步: 生成授权链接并完成 OAuth ============
async function completeOAuthAuthorization(page, browser, memberAccount, wlog) {
    const timer = new StepTimer(wlog);

    // 等待第二步页面加载
    wlog.info('  Waiting for authorization step...');
    let authPageReady = false;
    for (let i = 0; i < 10; i++) {
        const text = await page.evaluate(() => document.body?.innerText?.substring(0, 2000) || '').catch(() => '');
        if (text.includes('生成授权链接') || text.includes('授权') || text.includes('authorization')) {
            authPageReady = true;
            break;
        }
        await sleep(1000);
    }

    if (!authPageReady) {
        await takeScreenshot(page, `sub2api_no_auth_step_${memberAccount.email}`, wlog);
        throw new Error('Authorization step did not load');
    }
    timer.step('Auth page loaded');

    // 点击 "生成授权链接"
    wlog.info('  Generating authorization link...');
    await clickButtonByText(page, '生成授权链接', false);
    await sleep(3000);

    // 提取生成的授权 URL
    const authUrl = await page.evaluate(() => {
        const text = document.body?.innerText || '';
        // 匹配 URL
        const urlPattern = /https?:\/\/[^\s<>"']+/gi;
        const urls = text.match(urlPattern) || [];
        for (const url of urls) {
            if (url.includes('accounts.google.com') ||
                url.includes('oauth') ||
                url.includes('auth') ||
                url.includes('consent')) {
                return url;
            }
        }
        // 也检查 input 中的 URL
        for (const input of document.querySelectorAll('input, textarea')) {
            const val = input.value || '';
            if (val.startsWith('http') && (val.includes('google') || val.includes('oauth'))) {
                return val;
            }
        }
        // 查找链接元素
        for (const a of document.querySelectorAll('a[href]')) {
            if (a.href.includes('accounts.google.com') || a.href.includes('oauth')) {
                return a.href;
            }
        }
        return null;
    }).catch(() => null);

    if (!authUrl) {
        await takeScreenshot(page, `sub2api_no_auth_url_${memberAccount.email}`, wlog);
        throw new Error('Cannot find authorization URL');
    }

    wlog.info(`  Auth URL: ${authUrl.substring(0, 100)}...`);
    timer.step('Got auth URL');

    // 在新标签页中打开授权 URL
    wlog.info('  Opening auth URL in new tab...');
    const authPage = await browser.newPage();

    try {
        await authPage.goto(authUrl, { waitUntil: 'networkidle2', timeout: 30000 })
            .catch(e => wlog.warn(`Auth page load timeout: ${e.message}`));
        await sleep(3000);

        // 检查是否需要选择 "使用其他账号"
        const useOtherClicked = await authPage.evaluate(() => {
            // 查找 "使用其他账号" 或 "Use another account"
            for (const el of document.querySelectorAll('div, li, button, a')) {
                const text = (el.textContent || '').toLowerCase();
                if (text.includes('use another account') || text.includes('使用其他账号') ||
                    text.includes('使用其他帐号') || text.includes('other account')) {
                    el.click();
                    return true;
                }
            }
            return false;
        }).catch(() => false);

        if (useOtherClicked) {
            wlog.debug('  Clicked "Use another account"');
            await sleep(2000);
        }

        // 使用 googleLogin 完成 Google 登录
        wlog.info('  Completing Google login...');
        await googleLogin(authPage, memberAccount, wlog);
        await sleep(3000);
        timer.step('Google login');

        // 登录完成后，页面可能变成 "无法访问此页面" (ERR_CONNECTION_REFUSED)
        // 或者重定向到一个 callback URL
        // 需要获取当前 URL 作为回调
        const callbackUrl = authPage.url();
        wlog.info(`  Callback URL: ${callbackUrl.substring(0, 100)}...`);

        // 关闭授权标签页
        await authPage.close().catch(() => {});
        timer.step('Got callback URL');

        // 回到 sub2api 页面，粘贴回调 URL
        wlog.info('  Pasting callback URL to sub2api...');

        // 找到 "输入授权链接或 Code" 输入框
        const codeInput = await page.evaluate(() => {
            // 查找包含 "授权" 或 "code" 的输入框
            for (const input of document.querySelectorAll('input[type="text"], input:not([type]), textarea')) {
                const r = input.getBoundingClientRect();
                if (r.width <= 0 || r.height <= 0) continue;
                const placeholder = (input.placeholder || '').toLowerCase();
                const ariaLabel = (input.getAttribute('aria-label') || '').toLowerCase();
                const nearby = (input.closest('label, div')?.textContent || '').toLowerCase();
                if (placeholder.includes('code') || placeholder.includes('授权') ||
                    ariaLabel.includes('code') || ariaLabel.includes('授权') ||
                    nearby.includes('code') || nearby.includes('授权链接')) {
                    return true;
                }
            }
            return false;
        }).catch(() => false);

        if (codeInput) {
            // 使用精确选择器找到并填入
            await page.evaluate((url) => {
                for (const input of document.querySelectorAll('input[type="text"], input:not([type]), textarea')) {
                    const r = input.getBoundingClientRect();
                    if (r.width <= 0 || r.height <= 0) continue;
                    const nearby = (input.closest('label, div')?.textContent || '').toLowerCase();
                    if (nearby.includes('code') || nearby.includes('授权链接') || nearby.includes('授权')) {
                        input.focus();
                        input.value = url;
                        input.dispatchEvent(new Event('input', { bubbles: true }));
                        input.dispatchEvent(new Event('change', { bubbles: true }));
                        return;
                    }
                }
            }, callbackUrl).catch(() => {});
        } else {
            // Fallback: 找任何空的可见 text input
            await page.evaluate((url) => {
                for (const input of document.querySelectorAll('input[type="text"], input:not([type]), textarea')) {
                    const r = input.getBoundingClientRect();
                    if (r.width <= 0 || r.height <= 0) continue;
                    if (input.value) continue; // 跳过已有值的
                    const placeholder = (input.placeholder || '').toLowerCase();
                    if (placeholder.includes('名称') || placeholder.includes('搜索')) continue; // 跳过名称和搜索框
                    input.focus();
                    input.value = url;
                    input.dispatchEvent(new Event('input', { bubbles: true }));
                    input.dispatchEvent(new Event('change', { bubbles: true }));
                    return;
                }
            }, callbackUrl).catch(() => {});
        }
        await sleep(1000);

        // 点击 "完成授权"
        wlog.info('  Clicking 完成授权...');
        const finishClicked = await clickButtonByText(page, '完成授权', false);
        if (!finishClicked) {
            // 尝试其他文本
            await tryClickStrategies(page, ['完成', '提交', 'submit', 'finish', '确认'], wlog, 'finish_auth');
        }
        await sleep(5000);

        // 验证授权结果
        const resultText = await page.evaluate(() =>
            document.body?.innerText?.substring(0, 2000).toLowerCase() || ''
        ).catch(() => '');

        if (resultText.includes('成功') || resultText.includes('success') ||
            resultText.includes('已添加') || resultText.includes('added')) {
            wlog.success(`  Authorization completed successfully`);
            return true;
        }

        if (resultText.includes('错误') || resultText.includes('error') ||
            resultText.includes('失败') || resultText.includes('fail')) {
            await takeScreenshot(page, `sub2api_auth_error_${memberAccount.email}`, wlog);
            throw new Error('Authorization failed');
        }

        // 没有明确成功/失败，假设成功
        wlog.info('  No explicit result message, assuming success');
        await takeScreenshot(page, `sub2api_auth_result_${memberAccount.email}`, wlog);
        return true;

    } catch (e) {
        await authPage.close().catch(() => {});
        throw e;
    }
}

// ============ 处理单个成员 ============
async function addMemberToSub2api(page, browser, memberAccount, wlog) {
    const timer = new StepTimer(wlog);
    wlog.info(`>> Adding member: ${memberAccount.email}`);

    // 导航到账号管理页
    await navigateToAccounts(page, wlog);
    timer.step('Navigate to accounts');

    // 填写添加账号表单
    const accountName = await fillAddAccountForm(page, memberAccount.email, wlog);
    timer.step('Fill add form');

    // 完成 OAuth 授权
    const success = await completeOAuthAuthorization(page, browser, memberAccount, wlog);
    timer.step('OAuth authorization');

    if (success) {
        wlog.success(`>> Member added: ${memberAccount.email} (name: ${accountName})`);
    }

    return success;
}

// ============ main ============
async function main() {
    const chromePath = findChrome();
    if (!chromePath) { console.error('Chrome not found'); process.exit(1); }

    const creds = readSub2apiCredentials();
    const membersFile = path.resolve(__dirname, '..', 'members.txt');
    const members = parseAccounts(membersFile);

    log('');
    log(`${'='.repeat(60)}`);
    log(`  Sub2API: Add Accounts & OAuth Authorization`);
    log(`${'='.repeat(60)}`);
    log(`  Chrome:     ${chromePath}`);
    log(`  sub2api:    ${SUB2API_URL}`);
    log(`  User:       ${creds.user}`);
    log(`  Members:    ${members.length}`);
    log(`${'='.repeat(60)}`);
    log('');

    // 从 state.json 中找出已完成 stage1+stage2 的成员
    const state = await loadState();
    const pendingMembers = [];

    if (state.length === 0) {
        // 没有 state.json，直接用 members.txt 中的所有成员
        log('No state.json found, using all members from members.txt');
        for (const m of members) {
            pendingMembers.push({ email: m.email, pass: m.pass, recovery: m.recovery || '' });
        }
    } else {
        for (const group of state) {
            for (let i = 0; i < group.members.length; i++) {
                if (group.stage1_invited && group.stage2_accepted[i]) {
                    const email = group.members[i];
                    const memberAccount = members.find(m => m.email === email);
                    if (memberAccount) {
                        pendingMembers.push({
                            email: memberAccount.email,
                            pass: memberAccount.pass,
                            recovery: memberAccount.recovery || '',
                        });
                    } else {
                        log(`Member ${email} not found in members.txt, skipping`, 'WARN');
                    }
                }
            }
        }
    }

    log(`Pending members to add: ${pendingMembers.length}`);

    if (pendingMembers.length === 0) {
        log('No members to add. Exiting.', 'SUCCESS');
        return;
    }

    // 启动 Chrome
    const chrome = await launchRealChrome(chromePath, 0);
    const wlog = createWorkerLogger(0);

    try {
        const page = await newPage(chrome.browser);

        // 登录 sub2api
        await loginSub2api(page, creds, wlog);

        const stats = { ok: 0, ng: 0 };

        for (const member of pendingMembers) {
            try {
                const success = await addMemberToSub2api(page, chrome.browser, member, wlog);
                if (success) stats.ok++;
            } catch (e) {
                wlog.error(`Add failed [${member.email}]: ${e.message}`, e);
                stats.ng++;
                await addFailedRecord({
                    stage: 'sub2api',
                    memberEmail: member.email,
                    reason: e.message,
                });
                await takeScreenshot(page, `sub2api_error_${member.email}`, wlog);
            }

            await sleep(rand(2000, 4000));
        }

        await page.close().catch(() => {});

        log('');
        log(`${'='.repeat(60)}`);
        log(`  Sub2API Complete`, 'SUCCESS');
        log(`  OK: ${stats.ok}  FAIL: ${stats.ng}`);
        log(`${'='.repeat(60)}`);
        log('');

    } finally {
        try { chrome.browser.close(); } catch (_) {}
        try { chrome.proc.kill(); } catch (_) {}
    }
}

main().catch(e => {
    log(`Fatal: ${e.message}`, 'ERROR');
    if (e.stack) console.error(e.stack);
    process.exit(1);
});
