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
    // 需要滚动到代理区域先
    await page.evaluate(() => {
        const labels = document.querySelectorAll('label, span, div');
        for (const el of labels) {
            if (el.textContent.trim() === '代理') {
                el.scrollIntoView({ behavior: 'instant', block: 'center' });
                return;
            }
        }
    }).catch(() => {});
    await sleep(500);

    await clickButtonByText(page, '无代理');
    await sleep(1500);

    // 在弹出的下拉列表中精确选择包含 "216.175.194.166" 的选项
    // 需要找到列表中单独的选项元素，而非整个容器
    const proxySelected = await page.evaluate(() => {
        // 找到所有可点击的下拉选项 — 通常是直接子元素
        const allElements = document.querySelectorAll('*');
        for (const el of allElements) {
            const r = el.getBoundingClientRect();
            if (r.width <= 0 || r.height <= 0) continue;
            const text = el.textContent?.trim() || '';
            const ownText = el.childElementCount === 0 ? text : '';
            // 匹配包含目标IP的叶子节点或浅层元素
            if (text.includes('216.175.194.166') && !text.includes('216.151') && r.height < 60) {
                el.click();
                return text.substring(0, 80);
            }
            if (ownText.includes('216.175.194.166')) {
                el.click();
                return ownText.substring(0, 80);
            }
        }
        return null;
    }).catch(() => null);

    if (proxySelected) {
        wlog.debug(`  Selected proxy: ${proxySelected}`);
    } else {
        wlog.warn('  Proxy 216.175.194.166 not found in dropdown');
        // 点击任意位置关闭下拉
        await page.keyboard.press('Escape');
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
    // 先滚动到下一步按钮
    await page.evaluate(() => {
        for (const btn of document.querySelectorAll('button')) {
            if (btn.textContent.trim() === '下一步') {
                btn.scrollIntoView({ behavior: 'instant', block: 'center' });
                return;
            }
        }
    }).catch(() => {});
    await sleep(500);
    await clickButtonByText(page, '下一步');
    await sleep(3000);
    await takeScreenshot(page, `sub2api_after_next_${memberEmail.split('@')[0]}`, wlog);

    return accountName;
}

// ============ 第二步: 生成授权链接并完成 OAuth ============
async function completeOAuthAuthorization(page, browser, memberAccount, wlog) {
    const timer = new StepTimer(wlog);

    // 等待第二步页面加载
    wlog.info('  Waiting for authorization step...');
    let authPageReady = false;
    for (let i = 0; i < 15; i++) {
        // Search the ENTIRE page text, not just first 3000 chars
        const text = await page.evaluate(() => document.body?.innerText || '').catch(() => '');
        // 第二步特有的文本: "生成授权链接", "输入授权链接", "完成授权"
        if (text.includes('生成授权链接') || text.includes('输入授权链接') || text.includes('完成授权')) {
            authPageReady = true;
            break;
        }
        // 也检查是否有错误提示
        if (i === 5) {
            wlog.debug(`  Still waiting... page text preview: ${text.substring(0, 200)}`);
            await takeScreenshot(page, `sub2api_waiting_auth_${memberAccount.email.split('@')[0]}`, wlog);
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
        const urlPattern = /https?:\/\/[^\s<>"']+/gi;
        const urls = text.match(urlPattern) || [];

        // 优先匹配 Google OAuth URL
        for (const url of urls) {
            if (url.includes('accounts.google.com')) return url;
        }
        // 其次匹配其他 Google 相关 URL (排除 localhost)
        for (const url of urls) {
            if (url.includes('localhost') || url.includes('127.0.0.1')) continue;
            if (url.includes('google.com/o/oauth') || url.includes('consent')) return url;
        }

        // 检查 input/textarea 中的 URL
        for (const input of document.querySelectorAll('input, textarea')) {
            const val = input.value || '';
            if (val.startsWith('http') && val.includes('accounts.google.com')) return val;
        }
        // 检查链接元素
        for (const a of document.querySelectorAll('a[href]')) {
            if (a.href.includes('accounts.google.com')) return a.href;
        }

        // 最后: 返回任何非 localhost/sub2api 的 OAuth URL
        for (const url of urls) {
            if (url.includes('localhost') || url.includes('127.0.0.1') || url.includes('104.194.91.23')) continue;
            if (url.includes('oauth') || url.includes('auth')) return url;
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

        // 处理 Google 账号选择页面
        wlog.info('  Handling Google account chooser...');
        for (let step = 0; step < 3; step++) {
            await sleep(1500);
            const pageText = await authPage.evaluate(() =>
                document.body?.innerText?.substring(0, 1000).toLowerCase() || ''
            ).catch(() => '');

            if (!pageText.includes('choose an account') && !pageText.includes('选择帐号') &&
                !pageText.includes('选择账号')) {
                break;
            }

            // 用坐标点击 "Use another account" — 更可靠
            const clickPos = await authPage.evaluate(() => {
                const allEls = document.querySelectorAll('li, div[role="link"], div[data-identifier], button');
                for (const el of allEls) {
                    const text = (el.textContent || '').toLowerCase().trim();
                    // 精确匹配 "use another account" 的最内层可点击元素
                    if ((text === 'use another account' || text === '使用其他账号' || text === '使用其他帐号') ||
                        (text.startsWith('use another') && text.length < 30)) {
                        const r = el.getBoundingClientRect();
                        if (r.width > 0 && r.height > 0) {
                            return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
                        }
                    }
                }
                return null;
            }).catch(() => null);

            if (clickPos) {
                wlog.debug(`  Clicking "Use another account" at (${clickPos.x}, ${clickPos.y})`);
                await authPage.mouse.click(clickPos.x, clickPos.y);
                await authPage.waitForNavigation({ waitUntil: 'networkidle2', timeout: 10000 }).catch(() => {});
                await sleep(2000);
            } else {
                wlog.warn('  "Use another account" element not found');
                break;
            }
        }

        // 使用 googleLogin 完成 Google 登录
        wlog.info('  Completing Google login...');
        await googleLogin(authPage, memberAccount, wlog);
        await sleep(2000);

        // googleLogin 到达 oauth_consent 就返回了，需要继续点击同意按钮
        // 直到页面重定向到 localhost callback (会显示"无法访问此页面")
        wlog.info('  Handling OAuth consent...');
        let callbackUrl = '';

        // 监听导航请求，捕获 localhost callback URL (Chrome 会因为连接失败变成 chrome-error)
        const capturedUrls = [];
        const requestHandler = (req) => {
            const url = req.url();
            if (url.includes('localhost') || url.includes('127.0.0.1')) {
                capturedUrls.push(url);
            }
        };
        authPage.on('request', requestHandler);

        for (let step = 0; step < 10; step++) {
            // 检查是否已经捕获到 callback URL
            if (capturedUrls.length > 0) {
                callbackUrl = capturedUrls[capturedUrls.length - 1];
                break;
            }

            const currentUrl = authPage.url();
            if (currentUrl.includes('localhost') || currentUrl.includes('127.0.0.1')) {
                callbackUrl = currentUrl;
                break;
            }

            // 点击同意/允许/继续/Sign in 按钮
            const consentClicked = await authPage.evaluate(() => {
                const keywords = [
                    'continue', 'allow', 'accept', 'confirm', 'agree', 'sign in',
                    'approve', 'grant', 'yes', 'ok',
                    '继续', '允许', '接受', '确认', '同意', '登录', '授权', '是',
                ];
                for (const btn of document.querySelectorAll('button, [role="button"], input[type="submit"], a')) {
                    const r = btn.getBoundingClientRect();
                    if (r.width <= 0 || r.height <= 0) continue;
                    if (btn.disabled) continue;
                    const text = (btn.textContent || '').trim().toLowerCase();
                    if (keywords.some(k => text.includes(k))) {
                        btn.click();
                        return text.substring(0, 40);
                    }
                }
                return null;
            }).catch(() => null);

            if (consentClicked) {
                wlog.debug(`  Clicked consent button: "${consentClicked}"`);
                await sleep(5000);
                // 再次检查捕获的URL
                if (capturedUrls.length > 0) {
                    callbackUrl = capturedUrls[capturedUrls.length - 1];
                    break;
                }
            } else {
                await sleep(3000);
                if (capturedUrls.length > 0) {
                    callbackUrl = capturedUrls[capturedUrls.length - 1];
                    break;
                }
                // chrome-error 页面说明已经重定向过了
                if (authPage.url().includes('chrome-error')) {
                    wlog.warn('  Page shows chrome-error but callback URL was not captured');
                    break;
                }
                if (step >= 3) break;
            }
        }

        authPage.off('request', requestHandler);

        wlog.info(`  Callback URL: ${callbackUrl.substring(0, 120)}...`);
        timer.step('Google login + consent');

        // 从 callback URL 中提取 code 参数
        let authCode = '';
        try {
            const urlObj = new URL(callbackUrl);
            authCode = urlObj.searchParams.get('code') || '';
        } catch (_) {
            // URL 解析失败，尝试正则提取
            const m = callbackUrl.match(/[?&]code=([^&]+)/);
            if (m) authCode = decodeURIComponent(m[1]);
        }

        if (!authCode) {
            await takeScreenshot(authPage, `sub2api_no_code_${memberAccount.email}`, wlog);
            await authPage.close().catch(() => {});
            throw new Error(`Cannot extract code from callback URL: ${callbackUrl.substring(0, 100)}`);
        }

        wlog.info(`  Auth code: ${authCode.substring(0, 20)}...`);

        // 关闭授权标签页
        await authPage.close().catch(() => {});
        timer.step('Got auth code');

        // 回到 sub2api 页面，粘贴 code 到 "输入授权链接或 Code" 输入框
        wlog.info('  Pasting auth code to sub2api...');

        // 找到 "输入授权链接或 Code" 输入框并填入 code
        const codePasted = await page.evaluate((code) => {
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
                    input.focus();
                    input.value = code;
                    input.dispatchEvent(new Event('input', { bubbles: true }));
                    input.dispatchEvent(new Event('change', { bubbles: true }));
                    return true;
                }
            }
            // Fallback: 找任何空的可见 text input (排除名称和搜索框)
            for (const input of document.querySelectorAll('input[type="text"], input:not([type]), textarea')) {
                const r = input.getBoundingClientRect();
                if (r.width <= 0 || r.height <= 0) continue;
                if (input.value) continue;
                const placeholder = (input.placeholder || '').toLowerCase();
                if (placeholder.includes('名称') || placeholder.includes('搜索')) continue;
                input.focus();
                input.value = code;
                input.dispatchEvent(new Event('input', { bubbles: true }));
                input.dispatchEvent(new Event('change', { bubbles: true }));
                return true;
            }
            return false;
        }, authCode).catch(() => false);

        if (!codePasted) {
            wlog.warn('  Could not find code input, trying keyboard input...');
            // 尝试键盘输入
            await page.keyboard.type(authCode, { delay: 0 });
        }
        await sleep(1000);

        // 点击 "完成授权"
        wlog.info('  Clicking 完成授权...');
        const finishClicked = await clickButtonByText(page, '完成授权', false);
        if (!finishClicked) {
            await tryClickStrategies(page, ['完成', '提交', 'submit', 'finish', '确认'], wlog, 'finish_auth');
        }
        await sleep(8000);

        // 验证授权结果 — 查找 toast/notification 或抽屉面板内的提示
        const resultCheck = await page.evaluate(() => {
            const text = document.body?.innerText || '';
            // 查找 toast 消息或最近出现的提示
            const toasts = document.querySelectorAll('[class*="toast"], [class*="notification"], [class*="alert"], [class*="message"], [role="alert"]');
            for (const t of toasts) {
                const r = t.getBoundingClientRect();
                if (r.width <= 0 || r.height <= 0) continue;
                const tText = t.textContent.toLowerCase();
                if (tText.includes('成功') || tText.includes('success')) return 'success';
                if (tText.includes('失败') || tText.includes('error') || tText.includes('错误')) return 'error: ' + t.textContent.trim().substring(0, 100);
            }
            // 检查授权成功的标志: 抽屉是否关闭了（回到了账号列表）
            const hasDrawer = document.querySelector('[class*="drawer"], [class*="panel"], [class*="slide"]');
            if (!hasDrawer) return 'success'; // 抽屉关闭了 = 成功
            return 'unknown';
        }).catch(() => 'unknown');

        if (resultCheck === 'success') {
            wlog.success(`  Authorization completed successfully`);
            return true;
        }

        if (resultCheck.startsWith('error')) {
            await takeScreenshot(page, `sub2api_auth_error_${memberAccount.email}`, wlog);
            throw new Error(`Authorization failed: ${resultCheck}`);
        }

        // 结果不确定 — 截图后假设成功
        wlog.info('  Authorization result unclear, assuming success');
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
