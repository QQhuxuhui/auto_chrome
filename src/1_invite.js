/**
 * 阶段1 — 发送家庭组邀请
 *
 * 主账号登录 Google → 访问 Google One 家庭组管理页 → 逐一输入成员邮箱发送邀请
 */

require('dotenv').config();
const path = require('path');
const { log, createWorkerLogger, setVerbose, LOG_COLORS, StepTimer } = require('./common/logger');
const {
    sleep, rand, findChrome, launchRealChrome, restartChrome,
    isChromeAlive, clearBrowserSession, newPage, fastType,
    tryClickStrategies, takeScreenshot, detectPageState,
} = require('./common/chrome');
const { parseAccounts, buildGroups, initState, updateState, addFailedRecord } = require('./common/state');
const { googleLogin } = require('./common/google-login');

// ============ CLI 参数 ============
const args = process.argv.slice(2);
if (args.includes('--verbose') || args.includes('-v')) setVerbose(true);

let concurrency = 1;
for (let i = 0; i < args.length; i++) {
    if ((args[i] === '--concurrency' || args[i] === '-c') && args[i + 1]) {
        concurrency = parseInt(args[i + 1], 10) || 1;
    }
}

const GOOGLE_ONE_FAMILY_URL = 'https://myaccount.google.com/family/details?utm_source=g1web&utm_medium=default';

// ============ 单组邀请流程 ============
async function inviteGroup(groupState, hostAccount, memberEmails, browser, workerId) {
    const wlog = createWorkerLogger(workerId);
    const timer = new StepTimer(wlog);

    wlog.info(`>> Inviting group ${groupState.groupId}: host=${hostAccount.email}, members=${memberEmails.length}`);

    const page = await newPage(browser);

    try {
        // 1. 导航到 Google 登录
        wlog.info('  Navigating to Google One family settings...');
        await page.goto(GOOGLE_ONE_FAMILY_URL, { waitUntil: 'networkidle2', timeout: 30000 })
            .catch(e => wlog.warn(`Page load timeout: ${e.message}`));
        timer.step('Page load');

        // 2. 检查是否需要登录
        const currentUrl = page.url();
        wlog.info(`  Current URL after navigation: ${currentUrl}`);

        // 获取页面文本判断登录状态
        const pageText = await page.evaluate(() =>
            document.body ? document.body.innerText.substring(0, 500).toLowerCase() : ''
        ).catch(() => '');
        wlog.debug(`  Page text preview: ${pageText.substring(0, 200)}`);

        const needsLogin = currentUrl.includes('accounts.google.com') ||
            (currentUrl.includes('signin') && !currentUrl.includes('myaccount'));

        if (needsLogin) {
            wlog.info('  Login required, logging in as host...');
            await googleLogin(page, hostAccount, wlog);
            timer.step('Login');

            // 登录后重新导航到家庭页
            await sleep(2000);
            await page.goto(GOOGLE_ONE_FAMILY_URL, { waitUntil: 'networkidle2', timeout: 30000 })
                .catch(e => wlog.warn(`Post-login navigation timeout: ${e.message}`));
            await sleep(3000);
            timer.step('Navigate to family page');
        } else {
            wlog.info('  Page loaded without login redirect, checking content...');
            // 访问 Google 登录页面先登录
            wlog.info('  Navigating to Google login first...');
            await page.goto('https://accounts.google.com/signin', { waitUntil: 'networkidle2', timeout: 30000 })
                .catch(() => { });
            await sleep(1000);
            await googleLogin(page, hostAccount, wlog);
            timer.step('Login');

            // 登录后导航到家庭页
            await sleep(2000);
            await page.goto(GOOGLE_ONE_FAMILY_URL, { waitUntil: 'networkidle2', timeout: 30000 })
                .catch(e => wlog.warn(`Post-login navigation timeout: ${e.message}`));
            await sleep(3000);
            timer.step('Navigate to family page');
        }

        await sleep(2000);

        // 3. 一次性邀请所有成员（批量填写邮箱）
        wlog.info(`  Inviting ${memberEmails.length} members in batch...`);

        // 点击"邀请家庭成员"按钮
        const inviteKws = [
            'invite', 'add member', 'add family', 'invite member',
            '邀请', '添加成员', '添加家庭成员', '邀请家庭成员',
            'family member', 'manage family',
        ];
        const clicked = await tryClickStrategies(page, inviteKws, wlog, 'invite_btn');
        if (!clicked) {
            wlog.warn(`  Could not find invite button, taking screenshot...`);
            await takeScreenshot(page, `invite_no_btn_g${groupState.groupId}`, wlog);
            await page.reload({ waitUntil: 'networkidle2', timeout: 15000 }).catch(() => { });
            await sleep(2000);
            const retryClicked = await tryClickStrategies(page, inviteKws, wlog, 'invite_btn_retry');
            if (!retryClicked) {
                throw new Error('Cannot find invite button after retry');
            }
        }

        // 等待弹窗中输入框加载
        wlog.info('  Waiting for invite dialog to load...');
        let inputReady = false;
        for (let wait = 0; wait < 30; wait++) {
            await sleep(1000);

            const found = await page.evaluate(() => {
                function findInputInShadow(root) {
                    const selectors = [
                        'input[role="combobox"]',
                        'input[type="text"]',
                        'input[type="email"]',
                        'input:not([type])',
                    ];
                    for (const sel of selectors) {
                        const inputs = root.querySelectorAll(sel);
                        for (const inp of inputs) {
                            const r = inp.getBoundingClientRect();
                            if (r.width > 0 && r.height > 0) {
                                return true;
                            }
                        }
                    }
                    const allEls = root.querySelectorAll('*');
                    for (const el of allEls) {
                        if (el.shadowRoot) {
                            const result = findInputInShadow(el.shadowRoot);
                            if (result) return result;
                        }
                    }
                    return false;
                }
                return findInputInShadow(document);
            }).catch(() => false);

            if (found) {
                inputReady = true;
                wlog.debug(`  Input found after ${wait + 1}s`);
                break;
            }

            if (wait % 5 === 4) {
                wlog.debug(`  Still waiting for input... (${wait + 1}s)`);
            }
        }

        if (!inputReady) {
            await takeScreenshot(page, `invite_no_input_g${groupState.groupId}`, wlog);
            throw new Error('Cannot find email input in invite dialog');
        }

        // 逐个输入邮箱，每个输入后按 Enter 添加到列表
        for (let i = 0; i < memberEmails.length; i++) {
            const memberEmail = memberEmails[i];

            await page.evaluate((email) => {
                function findInputInShadow(root) {
                    const selectors = [
                        'input[role="combobox"]',
                        'input[type="text"]',
                        'input[type="email"]',
                        'input:not([type])',
                    ];
                    for (const sel of selectors) {
                        const inputs = root.querySelectorAll(sel);
                        for (const inp of inputs) {
                            const r = inp.getBoundingClientRect();
                            if (r.width > 0 && r.height > 0) {
                                return inp;
                            }
                        }
                    }
                    const allEls = root.querySelectorAll('*');
                    for (const el of allEls) {
                        if (el.shadowRoot) {
                            const result = findInputInShadow(el.shadowRoot);
                            if (result) return result;
                        }
                    }
                    return null;
                }

                const input = findInputInShadow(document);
                if (input) {
                    input.focus();
                    input.click();
                    const nativeSetter = Object.getOwnPropertyDescriptor(
                        window.HTMLInputElement.prototype, 'value'
                    ).set;
                    nativeSetter.call(input, email);
                    input.dispatchEvent(new Event('input', { bubbles: true }));
                    input.dispatchEvent(new Event('change', { bubbles: true }));
                    input.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true }));
                    input.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true }));
                }
            }, memberEmail).catch(() => { });

            // 按 Enter 将当前邮箱添加到列表，准备输入下一个
            await sleep(500);
            await page.keyboard.press('Enter');
            await sleep(500);
            wlog.debug(`  Added email ${i + 1}/${memberEmails.length}: ${memberEmail}`);
        }

        wlog.info(`  All ${memberEmails.length} emails entered, sending invite...`);
        await sleep(1000);

        // 点击发送按钮（在 Shadow DOM 中搜索）
        const sendClicked = await page.evaluate(() => {
            function findButtonInShadow(root, keywords) {
                const sels = 'button, a, [role="button"], input[type="submit"]';
                const els = root.querySelectorAll(sels);
                for (const el of els) {
                    const r = el.getBoundingClientRect();
                    if (r.width <= 0 || r.height <= 0) continue;
                    const txt = (el.textContent || '').toLowerCase();
                    if (keywords.some(k => txt.includes(k))) {
                        el.click();
                        return txt.substring(0, 40);
                    }
                }
                const allEls = root.querySelectorAll('*');
                for (const el of allEls) {
                    if (el.shadowRoot) {
                        const result = findButtonInShadow(el.shadowRoot, keywords);
                        if (result) return result;
                    }
                }
                return null;
            }
            return findButtonInShadow(document, [
                'send', 'invite', '发送', '邀请', 'confirm', '确认',
            ]);
        }).catch(() => null);

        if (sendClicked) {
            wlog.debug(`  Clicked send button: "${sendClicked}"`);
        }

        await sleep(3000);

        // 等待可能的确认对话框
        const confirmKws = ['ok', 'done', 'got it', 'close', '确定', '完成', '知道了', '关闭'];
        await tryClickStrategies(page, confirmKws, wlog, 'post_invite_confirm');
        await sleep(1000);

        for (const email of memberEmails) {
            wlog.success(`  Invited: ${email}`);
        }
        timer.step(`Invite ${memberEmails.length} members`);

        wlog.success(`>> Group ${groupState.groupId} all invites sent (${(timer.total() / 1000).toFixed(1)}s)`);
        return true;

    } finally {
        await page.close().catch(() => { });
        await clearBrowserSession(browser, wlog);
    }
}

// ============ main ============
async function main() {
    const hostsFile = path.resolve(__dirname, '..', 'hosts.txt');
    const membersFile = path.resolve(__dirname, '..', 'members.txt');

    const chromePath = findChrome();
    if (!chromePath) { console.error('Chrome not found'); process.exit(1); }

    log('');
    log(`${'='.repeat(60)}`);
    log(`  Stage 1: Send Family Invitations`);
    log(`${'='.repeat(60)}`);
    log(`  Chrome:      ${chromePath}`);
    log(`  Hosts:       ${hostsFile}`);
    log(`  Members:     ${membersFile}`);
    log(`  Concurrency: ${concurrency}`);
    log(`${'='.repeat(60)}`);
    log('');

    const hosts = parseAccounts(hostsFile);
    const members = parseAccounts(membersFile);
    log(`Parsed: ${hosts.length} hosts, ${members.length} members`);

    if (hosts.length === 0) { log('No host accounts found', 'ERROR'); process.exit(1); }
    if (members.length === 0) { log('No member accounts found', 'ERROR'); process.exit(1); }

    const groups = buildGroups(hosts, members);
    log(`Built ${groups.length} groups`);

    const state = await initState(groups);

    // 筛选未完成的组
    const pendingGroups = state.filter(g => !g.stage1_invited);
    log(`Pending groups: ${pendingGroups.length}`);

    if (pendingGroups.length === 0) {
        log('All groups already invited. Exiting.', 'SUCCESS');
        return;
    }

    // 启动 Chrome
    const workers = [];
    for (let w = 0; w < Math.min(concurrency, pendingGroups.length); w++) {
        try {
            const chrome = await launchRealChrome(chromePath, w);
            workers.push({ id: w, ...chrome });
            if (w < concurrency - 1) await sleep(rand(2000, 3000));
        } catch (e) {
            log(`Worker${w} launch failed: ${e.message}`, 'ERROR');
        }
    }

    if (workers.length === 0) {
        console.error('All Chrome instances failed to start');
        process.exit(1);
    }

    let groupIdx = 0;
    const stats = { ok: 0, ng: 0 };

    async function workerFn(worker) {
        const wlog = createWorkerLogger(worker.id);
        while (true) {
            const idx = groupIdx++;
            if (idx >= pendingGroups.length) break;

            const groupState = pendingGroups[idx];
            const hostAccount = hosts.find(h => h.email === groupState.host);
            if (!hostAccount) {
                wlog.error(`Host account not found: ${groupState.host}`);
                stats.ng++;
                continue;
            }

            try {
                const alive = await isChromeAlive(worker);
                if (!alive) await restartChrome(chromePath, worker);

                const memberEmails = groupState.members;
                const success = await inviteGroup(groupState, hostAccount, memberEmails, worker.browser, worker.id);

                if (success) {
                    await updateState(state => {
                        const g = state.find(s => s.groupId === groupState.groupId);
                        if (g) g.stage1_invited = true;
                    });
                    stats.ok++;
                }
            } catch (e) {
                wlog.error(`Group ${groupState.groupId} failed: ${e.message}`, e);
                stats.ng++;
                await addFailedRecord({
                    stage: 1,
                    groupId: groupState.groupId,
                    hostEmail: groupState.host,
                    reason: e.message,
                });
            }

            await sleep(rand(1000, 2000));
        }
    }

    await Promise.all(workers.map(w => workerFn(w)));

    // 清理
    for (const w of workers) {
        try { w.browser.close(); } catch (_) { }
        try { w.proc.kill(); } catch (_) { }
    }

    log('');
    log(`${'='.repeat(60)}`);
    log(`  Stage 1 Complete`, 'SUCCESS');
    log(`  OK: ${stats.ok}  FAIL: ${stats.ng}`);
    log(`${'='.repeat(60)}`);
    log('');
}

main().catch(e => {
    log(`Fatal: ${e.message}`, 'ERROR');
    if (e.stack) console.error(e.stack);
    process.exit(1);
});
