/**
 * 阶段2 — 成员接受家庭邀请
 *
 * 成员账号登录 Gmail → 搜索邀请邮件 → 点击接受链接
 */

require('dotenv').config({ path: require('path').resolve(__dirname, '.env') });
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
                // 登出并重新登录 — 直接导航到 Google 登录页（避免跳转到营销页）
                await page.goto('https://accounts.google.com/Logout', { waitUntil: 'networkidle2', timeout: 15000 }).catch(() => { });
                await sleep(1000);
                await page.goto('https://accounts.google.com/signin', { waitUntil: 'networkidle2', timeout: 30000 }).catch(() => { });
                await sleep(1000);
                wlog.info('  Logging in...');
                await googleLogin(page, memberAccount, wlog);
                timer.step('Login');
                await sleep(2000);

                await page.goto(GMAIL_URL, { waitUntil: 'networkidle2', timeout: 30000 }).catch(() => { });
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

            // 检查是否还在 Gmail 页面（可能跳转到验证页面或其他页面）
            const currentPollUrl = page.url();
            if (!currentPollUrl.includes('mail.google.com')) {
                wlog.warn(`  Not on Gmail (URL: ${currentPollUrl.substring(0, 80)}), handling...`);

                // 检查是否需要登录或验证
                const pageState = await detectPageState(page, wlog);
                if (pageState.state === 'identity_verify' || pageState.state === 'verify_phone' ||
                    pageState.state === 'verify_recovery_email' || pageState.state === 'challenge' ||
                    pageState.state === 'email' || pageState.state === 'password') {
                    wlog.info(`  Detected ${pageState.state}, re-running login...`);
                    await googleLogin(page, memberAccount, wlog);
                    await sleep(2000);
                    await page.goto(GMAIL_URL, { waitUntil: 'networkidle2', timeout: 30000 }).catch(() => { });
                    await sleep(2000);
                } else {
                    // 尝试直接导航回 Gmail
                    await page.goto(GMAIL_URL, { waitUntil: 'networkidle2', timeout: 30000 }).catch(() => { });
                    await sleep(2000);
                }
                continue;
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
            const emailFound = await page.evaluate((keywords) => {
                const rows = document.querySelectorAll('tr, div[role="row"], div[class*="zA"]');
                for (const row of rows) {
                    const text = (row.textContent || '').toLowerCase();
                    if (keywords.some(k => text.includes(k.toLowerCase()))) {
                        return text.substring(0, 80);
                    }
                }
                return null;
            }, searchKeywords).catch(() => null);

            if (emailFound) {
                wlog.success(`  Found invite email: "${emailFound}"`);

                // 用 tryClickStrategies 点击邮件行（比 evaluate 中 el.click() 更可靠）
                const emailKws = ['family group', 'google one', '家庭组', 'family plan',
                    "join bond's family", "join", 'family'];
                const rowClicked = await tryClickStrategies(page, emailKws, wlog, 'open_email');

                if (!rowClicked) {
                    // 退回 evaluate 点击
                    await page.evaluate((keywords) => {
                        const rows = document.querySelectorAll('tr, div[role="row"], div[class*="zA"]');
                        for (const row of rows) {
                            const text = (row.textContent || '').toLowerCase();
                            if (keywords.some(k => text.includes(k.toLowerCase()))) {
                                const clickable = row.querySelector('td, span[id], div[role="link"], a');
                                if (clickable) { clickable.click(); return; }
                                row.click();
                                return;
                            }
                        }
                    }, searchKeywords).catch(() => { });
                }

                await sleep(3000);

                // 验证是否已进入邮件内容页面（URL 应包含邮件 ID 或页面有邮件正文）
                const inEmailView = await page.evaluate(() => {
                    // 邮件内容页面通常有 h2 标题、或者 email body
                    const hasBody = document.querySelector('div[data-message-id], div[class*="adn"], div.a3s');
                    const url = location.href;
                    return !!(hasBody || url.includes('#inbox/') || url.includes('#search/'));
                }).catch(() => false);

                if (!inEmailView) {
                    wlog.warn('  Email row clicked but may not have opened, retrying...');
                    // 再尝试一次键盘方式：点击搜索结果中第一条
                    await page.keyboard.press('Enter');
                    await sleep(3000);
                }

                inviteFound = true;
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

        // Gmail 的邮件内容在 iframe 或特定 div 中，需要先尝试获取邮件正文区域
        // 查找接受邀请的链接/按钮
        const acceptKws = [
            'accept', 'join', 'accept invitation', 'join family',
            '接受', '加入', '接受邀请', '加入家庭组',
            'get started', '开始', 'open invitation', '打开邀请',
        ];

        let accepted = false;

        // 方法1：在邮件正文中查找链接（包括 iframe 内）
        const acceptLink = await page.evaluate((keywords) => {
            // 先在主文档中找
            function findAcceptLink(root) {
                const links = root.querySelectorAll('a[href]');
                for (const link of links) {
                    const text = (link.textContent || '').toLowerCase().trim();
                    const href = (link.href || '').toLowerCase();
                    // 按链接 URL 匹配（最可靠）
                    if (href.includes('one.google.com') ||
                        href.includes('families.google.com') ||
                        href.includes('myaccount.google.com/family') ||
                        href.includes('google.com/families')) {
                        return link.href;
                    }
                    // 按链接文本匹配
                    if (text && keywords.some(k => text.includes(k))) {
                        // 排除 Gmail 自身的导航链接（太短或在侧边栏）
                        const r = link.getBoundingClientRect();
                        if (r.width > 50 && r.height > 15) {
                            return link.href;
                        }
                    }
                }
                return null;
            }

            // 主文档
            let result = findAcceptLink(document);
            if (result) return result;

            // 检查 iframe（Gmail 渲染邮件内容有时用 iframe）
            const iframes = document.querySelectorAll('iframe');
            for (const iframe of iframes) {
                try {
                    const iframeDoc = iframe.contentDocument || iframe.contentWindow.document;
                    if (iframeDoc) {
                        result = findAcceptLink(iframeDoc);
                        if (result) return result;
                    }
                } catch (_) { }
            }

            return null;
        }, acceptKws).catch(() => null);

        if (acceptLink) {
            wlog.info(`  Found accept link: ${acceptLink.substring(0, 100)}`);
            await page.goto(acceptLink, { waitUntil: 'networkidle2', timeout: 30000 })
                .catch(e => wlog.warn(`Accept link navigation timeout: ${e.message}`));
            await sleep(3000);
            accepted = true;
        }

        // 方法2：用 tryClickStrategies 直接点击邮件中的按钮
        if (!accepted) {
            wlog.info('  Trying to click accept button in email...');
            const clicked = await tryClickStrategies(page, acceptKws, wlog, 'accept_invite');
            if (clicked) {
                await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(() => { });
                await sleep(3000);
                // 检查是否真的导航到了新页面
                const newUrl = page.url();
                if (!newUrl.includes('mail.google.com')) {
                    accepted = true;
                } else {
                    wlog.warn('  Click did not navigate away from Gmail, link may not have worked');
                }
            }
        }

        // 方法3：在邮件正文中查找所有外部链接，找到 Google 家庭相关的
        if (!accepted) {
            wlog.info('  Scanning all links in email body...');
            const allLinks = await page.evaluate(() => {
                const links = document.querySelectorAll('a[href]');
                const results = [];
                for (const link of links) {
                    const href = link.href || '';
                    const text = (link.textContent || '').trim();
                    // 只收集外部链接（排除 Gmail 内部链接）
                    if (href.startsWith('http') &&
                        !href.includes('mail.google.com') &&
                        !href.includes('support.google.com') &&
                        !href.includes('#') &&
                        text.length > 0 && text.length < 100) {
                        results.push({ href, text: text.substring(0, 60) });
                    }
                }
                return results;
            }).catch(() => []);

            wlog.debug(`  Found ${allLinks.length} external links in email`);
            for (const link of allLinks) {
                wlog.debug(`    "${link.text}" -> ${link.href.substring(0, 80)}`);
            }

            // 找到最可能的邀请链接
            const inviteLink = allLinks.find(l =>
                l.href.includes('one.google.com') ||
                l.href.includes('families.google') ||
                l.href.includes('family') ||
                l.text.toLowerCase().includes('accept') ||
                l.text.toLowerCase().includes('join') ||
                l.text.toLowerCase().includes('open') ||
                l.text.toLowerCase().includes('接受') ||
                l.text.toLowerCase().includes('加入')
            );

            if (inviteLink) {
                wlog.info(`  Found invite link: "${inviteLink.text}" -> ${inviteLink.href.substring(0, 80)}`);
                await page.goto(inviteLink.href, { waitUntil: 'networkidle2', timeout: 30000 })
                    .catch(e => wlog.warn(`Navigation timeout: ${e.message}`));
                await sleep(3000);
                accepted = true;
            }
        }

        if (!accepted) {
            await takeScreenshot(page, `accept_no_link_${memberAccount.email}`, wlog);
            throw new Error('Cannot find accept link in invite email');
        }

        timer.step('Clicked accept link');

        // 4. 在接受页面处理可能的确认操作
        // 先等页面充分加载
        await sleep(3000);
        await takeScreenshot(page, `accept_page_${memberAccount.email}`, wlog);

        for (let confirmStep = 0; confirmStep < 8; confirmStep++) {
            const pageText = await page.evaluate(() =>
                document.body ? document.body.innerText.substring(0, 2000).toLowerCase() : ''
            ).catch(() => '');

            wlog.debug(`  Confirm step ${confirmStep + 1}, page text: "${pageText.substring(0, 100)}..."`);

            // 检查是否已成功加入
            if (pageText.includes('you\'re now part of') || pageText.includes('已加入') ||
                pageText.includes('welcome to your family') ||
                pageText.includes('you\'ve joined') || pageText.includes('已成为') ||
                pageText.includes('you are now a member') || pageText.includes('成功加入') ||
                pageText.includes('you\'re in the family')) {
                wlog.success(`  Successfully joined family group!`);
                break;
            }

            // 点击确认按钮 — "join family group" 优先
            const confirmKws = [
                'join family group', 'join family', 'join group',
                '加入家庭组', '加入家庭群组',
                'accept', 'join', 'confirm', 'continue', 'agree', 'ok', 'done',
                'get started', 'accept invitation',
                '接受', '加入', '确认', '继续', '同意', '确定', '完成', '开始',
            ];
            const confirmClicked = await tryClickStrategies(page, confirmKws, wlog, 'accept_confirm');
            if (confirmClicked) {
                await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(() => { });
                await sleep(3000);
            } else {
                // 没找到按钮，等一下再试（页面可能还在加载）
                if (confirmStep < 3) {
                    await sleep(3000);
                } else {
                    break;
                }
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
