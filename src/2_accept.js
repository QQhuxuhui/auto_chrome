/**
 * 阶段2 — 成员接受家庭邀请
 *
 * 成员账号登录 Gmail → 搜索邀请邮件 → 点击接受链接
 */

require('dotenv').config();
const path = require('path');
const { log, createWorkerLogger, setVerbose, LOG_COLORS, StepTimer } = require('./common/logger');
const {
    sleep, rand, findChrome, launchRealChrome, restartChrome,
    isChromeAlive, clearBrowserSession, newPage,
    tryClickStrategies, takeScreenshot, detectPageState,
} = require('./common/chrome');
const { parseAccounts, loadState, updateState, addFailedRecord } = require('./common/state');
const { googleLogin } = require('./common/google-login');

// ============ CLI 参数 ============
const args = process.argv.slice(2);
if (args.includes('--verbose') || args.includes('-v')) setVerbose(true);

let concurrency = parseInt(process.env.CONCURRENCY, 10) || 3;
for (let i = 0; i < args.length; i++) {
    if ((args[i] === '--concurrency' || args[i] === '-c') && args[i + 1]) {
        concurrency = parseInt(args[i + 1], 10) || 3;
    }
}

const INVITE_WAIT_TIMEOUT = parseInt(process.env.INVITE_WAIT_TIMEOUT, 10) || 600;
const INVITE_POLL_INTERVAL = parseInt(process.env.INVITE_POLL_INTERVAL, 10) || 30;

const GMAIL_URL = 'https://mail.google.com/mail/u/0/';

// ============ 单个成员接受邀请 ============
async function acceptInvite(memberAccount, browser, workerId) {
    const wlog = createWorkerLogger(workerId);
    const timer = new StepTimer(wlog);

    wlog.info(`>> Accept invite: ${memberAccount.email}`);

    // 0. 先清除旧 session，避免残留上一阶段或上一个账号的登录态
    await clearBrowserSession(browser, wlog);

    const page = await newPage(browser);

    try {
        // 1. 登录 Gmail
        wlog.info('  Navigating to Gmail...');
        await page.goto(GMAIL_URL, { waitUntil: 'networkidle2', timeout: 30000 })
            .catch(e => wlog.warn(`Page load timeout: ${e.message}`));
        timer.step('Page load');

        // 清除 session 后必然需要登录，但仍做检查以防万一
        const currentUrl = page.url();
        if (currentUrl.includes('accounts.google.com') ||
            currentUrl.includes('signin')) {
            wlog.info('  Logging in...');
            await googleLogin(page, memberAccount, wlog);
            timer.step('Login');
            await sleep(2000);

            // 登录后可能需要重新导航
            if (!page.url().includes('mail.google.com')) {
                await page.goto(GMAIL_URL, { waitUntil: 'networkidle2', timeout: 30000 })
                    .catch(() => { });
            }
        } else {
            // 如果 Gmail 直接打开了（不太可能，但保险起见），检查是否是正确的账号
            wlog.warn('  Gmail opened without login prompt, verifying account...');
            const loggedInEmail = await page.evaluate(() => {
                // Gmail 页面标题或头像区域通常包含邮箱
                const el = document.querySelector('a[aria-label*="@"], [data-email]');
                return el ? (el.getAttribute('data-email') || el.getAttribute('aria-label') || '') : '';
            }).catch(() => '');

            if (!loggedInEmail.toLowerCase().includes(memberAccount.email.toLowerCase())) {
                wlog.warn(`  Wrong account logged in (got: ${loggedInEmail}), forcing re-login...`);
                // 登出并重新登录
                await page.goto('https://accounts.google.com/Logout', { waitUntil: 'networkidle2', timeout: 15000 }).catch(() => { });
                await sleep(1000);
                await page.goto(GMAIL_URL, { waitUntil: 'networkidle2', timeout: 30000 }).catch(() => { });
                await sleep(1000);
                wlog.info('  Logging in...');
                await googleLogin(page, memberAccount, wlog);
                timer.step('Login');
                await sleep(2000);

                if (!page.url().includes('mail.google.com')) {
                    await page.goto(GMAIL_URL, { waitUntil: 'networkidle2', timeout: 30000 }).catch(() => { });
                }
            }
        }

        await sleep(2000);
        timer.step('Gmail loaded');

        // 2. 搜索邀请邮件（轮询）
        const searchKeywords = ['Google One', 'family group', '家庭组', 'family plan'];
        const startTime = Date.now();
        let inviteFound = false;

        for (let poll = 0; ; poll++) {
            const elapsed = (Date.now() - startTime) / 1000;
            if (elapsed > INVITE_WAIT_TIMEOUT) {
                wlog.warn(`  Invite email not found after ${INVITE_WAIT_TIMEOUT}s`);
                throw new Error('invite_email_timeout');
            }

            if (poll > 0) {
                wlog.info(`  Poll ${poll}: refreshing inbox (${Math.round(elapsed)}s elapsed)...`);
                await page.goto(GMAIL_URL, { waitUntil: 'networkidle2', timeout: 30000 }).catch(() => { });
                await sleep(2000);
            }

            // 尝试在收件箱搜索邀请邮件
            // 方法1：使用 Gmail 搜索功能
            try {
                const searchInput = await page.$('input[aria-label="Search mail"], input[aria-label="搜索邮件"], input[name="q"]');
                if (searchInput) {
                    await searchInput.click();
                    await sleep(300);

                    // 清空搜索框
                    const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
                    await page.keyboard.down(mod);
                    await page.keyboard.press('KeyA');
                    await page.keyboard.up(mod);
                    await page.keyboard.press('Backspace');
                    await sleep(100);

                    await searchInput.type('Google One family', { delay: 0 });
                    await page.keyboard.press('Enter');
                    await sleep(3000);
                }
            } catch (e) {
                wlog.debug(`  Search failed: ${e.message}`);
            }

            // 方法2：直接在页面中查找邀请邮件
            const emailClicked = await page.evaluate((keywords) => {
                const rows = document.querySelectorAll('tr, div[role="row"], div[class*="zA"]');
                for (const row of rows) {
                    const text = (row.textContent || '').toLowerCase();
                    if (keywords.some(k => text.includes(k.toLowerCase()))) {
                        // 找到可点击的子元素
                        const clickable = row.querySelector('td, span[id], div[role="link"], a');
                        if (clickable) {
                            clickable.click();
                            return text.substring(0, 80);
                        }
                        row.click();
                        return text.substring(0, 80);
                    }
                }
                return null;
            }, searchKeywords).catch(() => null);

            if (emailClicked) {
                wlog.success(`  Found invite email: "${emailClicked}"`);
                inviteFound = true;
                await sleep(2000);
                break;
            }

            // 没找到，等待下一次轮询
            if (poll === 0) {
                wlog.info(`  Invite email not found yet, polling every ${INVITE_POLL_INTERVAL}s...`);
            }
            await sleep(INVITE_POLL_INTERVAL * 1000);
        }

        if (!inviteFound) {
            throw new Error('invite_email_not_found');
        }

        timer.step('Found invite email');

        // 3. 在邮件中点击接受链接
        await sleep(2000);

        // 查找接受邀请的链接/按钮
        const acceptKws = [
            'accept', 'join', 'accept invitation', 'join family',
            '接受', '加入', '接受邀请', '加入家庭组',
            'get started', '开始',
        ];

        // 先尝试在邮件内容中查找链接
        let accepted = false;

        // 方法1：找到邮件中的接受链接并点击
        const acceptLink = await page.evaluate((keywords) => {
            const links = document.querySelectorAll('a[href]');
            for (const link of links) {
                const text = (link.textContent || '').toLowerCase();
                const href = (link.href || '').toLowerCase();
                if (keywords.some(k => text.includes(k)) ||
                    href.includes('one.google.com') ||
                    href.includes('families.google.com') ||
                    href.includes('myaccount.google.com/family')) {
                    return link.href;
                }
            }
            return null;
        }, acceptKws).catch(() => null);

        if (acceptLink) {
            wlog.info(`  Found accept link: ${acceptLink.substring(0, 80)}`);
            await page.goto(acceptLink, { waitUntil: 'networkidle2', timeout: 30000 })
                .catch(e => wlog.warn(`Accept link navigation timeout: ${e.message}`));
            await sleep(3000);
            accepted = true;
        }

        // 方法2：直接在页面点击接受按钮
        if (!accepted) {
            const clicked = await tryClickStrategies(page, acceptKws, wlog, 'accept_invite');
            if (clicked) {
                await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(() => { });
                await sleep(2000);
                accepted = true;
            }
        }

        if (!accepted) {
            await takeScreenshot(page, `accept_no_link_${memberAccount.email}`, wlog);
            throw new Error('Cannot find accept link in invite email');
        }

        timer.step('Clicked accept link');

        // 4. 在接受页面处理可能的确认操作
        for (let confirmStep = 0; confirmStep < 5; confirmStep++) {
            await sleep(1500);
            const pageText = await page.evaluate(() =>
                document.body ? document.body.innerText.substring(0, 1000).toLowerCase() : ''
            ).catch(() => '');

            // 检查是否已成功加入
            if (pageText.includes('you\'re now part of') || pageText.includes('已加入') ||
                pageText.includes('welcome to') || pageText.includes('family group') ||
                pageText.includes('you\'ve joined') || pageText.includes('已成为')) {
                wlog.success(`  Successfully joined family group!`);
                break;
            }

            // 点击确认按钮
            const confirmKws = [
                'accept', 'join', 'confirm', 'continue', 'agree', 'ok', 'done',
                '接受', '加入', '确认', '继续', '同意', '确定', '完成',
            ];
            const confirmClicked = await tryClickStrategies(page, confirmKws, wlog, 'accept_confirm');
            if (confirmClicked) {
                await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 8000 }).catch(() => { });
            } else {
                break;
            }
        }

        timer.step('Accept confirmed');
        wlog.success(`>> Invite accepted: ${memberAccount.email} (${(timer.total() / 1000).toFixed(1)}s)`);
        return true;

    } finally {
        await page.close().catch(() => { });
        await clearBrowserSession(browser, wlog);
    }
}

// ============ main ============
async function main() {
    const membersFile = path.resolve(__dirname, '..', 'members.txt');

    const chromePath = findChrome();
    if (!chromePath) { console.error('Chrome not found'); process.exit(1); }

    log('');
    log(`${'='.repeat(60)}`);
    log(`  Stage 2: Accept Family Invitations`);
    log(`${'='.repeat(60)}`);
    log(`  Chrome:       ${chromePath}`);
    log(`  Members:      ${membersFile}`);
    log(`  Concurrency:  ${concurrency}`);
    log(`  Poll interval: ${INVITE_POLL_INTERVAL}s`);
    log(`  Poll timeout:  ${INVITE_WAIT_TIMEOUT}s`);
    log(`${'='.repeat(60)}`);
    log('');

    const allMembers = parseAccounts(membersFile);
    const state = await loadState();

    if (state.length === 0) {
        log('No state found. Run stage 1 first.', 'ERROR');
        process.exit(1);
    }

    // 收集所有需要接受邀请的成员
    const pendingMembers = [];
    for (const group of state) {
        if (!group.stage1_invited) continue;
        for (let i = 0; i < group.members.length; i++) {
            if (!group.stage2_accepted[i]) {
                const memberAccount = allMembers.find(m => m.email === group.members[i]);
                if (memberAccount) {
                    pendingMembers.push({
                        groupId: group.groupId,
                        memberIdx: i,
                        account: memberAccount,
                    });
                } else {
                    log(`Member account not found in file: ${group.members[i]}`, 'WARN');
                }
            }
        }
    }

    log(`Pending members to accept: ${pendingMembers.length}`);

    if (pendingMembers.length === 0) {
        log('All invitations already accepted. Exiting.', 'SUCCESS');
        return;
    }

    // 启动 Chrome
    const workers = [];
    for (let w = 0; w < Math.min(concurrency, pendingMembers.length); w++) {
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

    let memberIdx = 0;
    const stats = { ok: 0, ng: 0 };

    async function workerFn(worker) {
        const wlog = createWorkerLogger(worker.id);
        while (true) {
            const idx = memberIdx++;
            if (idx >= pendingMembers.length) break;

            const pending = pendingMembers[idx];

            try {
                const alive = await isChromeAlive(worker);
                if (!alive) await restartChrome(chromePath, worker);

                const success = await acceptInvite(pending.account, worker.browser, worker.id);

                if (success) {
                    await updateState(state => {
                        const g = state.find(s => s.groupId === pending.groupId);
                        if (g) g.stage2_accepted[pending.memberIdx] = true;
                    });
                    stats.ok++;
                }
            } catch (e) {
                wlog.error(`Accept failed [${pending.account.email}]: ${e.message}`, e);
                stats.ng++;
                await addFailedRecord({
                    stage: 2,
                    groupId: pending.groupId,
                    memberEmail: pending.account.email,
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
    log(`  Stage 2 Complete`, 'SUCCESS');
    log(`  OK: ${stats.ok}  FAIL: ${stats.ng}`);
    log(`${'='.repeat(60)}`);
    log('');
}

main().catch(e => {
    log(`Fatal: ${e.message}`, 'ERROR');
    if (e.stack) console.error(e.stack);
    process.exit(1);
});
