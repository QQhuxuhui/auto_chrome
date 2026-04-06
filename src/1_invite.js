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

async function getInviteDialogRootHandle(page) {
    const handle = await page.evaluateHandle(() => {
        function isVisible(el) {
            if (!el || !el.getBoundingClientRect) return false;
            const r = el.getBoundingClientRect();
            const s = window.getComputedStyle(el);
            return r.width > 0 && r.height > 0 &&
                s.display !== 'none' &&
                s.visibility !== 'hidden' &&
                s.opacity !== '0';
        }

        function searchDialogs(root) {
            const dialogSelectors = [
                '[role="dialog"]',
                'dialog',
                '[aria-modal="true"]',
                '[data-dialog-id]',
            ];

            for (const sel of dialogSelectors) {
                for (const el of root.querySelectorAll(sel)) {
                    if (isVisible(el)) return el;
                }
            }

            for (const el of root.querySelectorAll('*')) {
                if (el.shadowRoot) {
                    const found = searchDialogs(el.shadowRoot);
                    if (found) return found;
                }
            }

            return null;
        }

        return searchDialogs(document) || document.body;
    });

    return handle.asElement();
}

async function getInviteInputHandle(page) {
    const handle = await page.evaluateHandle(() => {
        function isVisible(el) {
            if (!el || !el.getBoundingClientRect) return false;
            const r = el.getBoundingClientRect();
            const s = window.getComputedStyle(el);
            return r.width > 0 && r.height > 0 &&
                s.display !== 'none' &&
                s.visibility !== 'hidden' &&
                s.opacity !== '0';
        }

        function findDialogRoot(root) {
            const dialogSelectors = ['[role="dialog"]', 'dialog', '[aria-modal="true"]', '[data-dialog-id]'];
            for (const sel of dialogSelectors) {
                for (const el of root.querySelectorAll(sel)) {
                    if (isVisible(el)) return el;
                }
            }
            for (const el of root.querySelectorAll('*')) {
                if (el.shadowRoot) {
                    const found = findDialogRoot(el.shadowRoot);
                    if (found) return found;
                }
            }
            return null;
        }

        function findInput(root) {
            const selectors = [
                'input[role="combobox"]',
                'input[type="email"]',
                'input[type="text"]',
                'input:not([type])',
                'textarea',
                '[contenteditable="true"]',
                '[role="textbox"]',
            ];

            for (const sel of selectors) {
                for (const el of root.querySelectorAll(sel)) {
                    if (!isVisible(el)) continue;
                    // Skip search bar inputs (Google Account search)
                    const aria = (el.getAttribute('aria-label') || '').toLowerCase();
                    const placeholder = (el.getAttribute('placeholder') || '').toLowerCase();
                    const val = (el.value || '').toLowerCase();
                    if (aria.includes('search') || aria.includes('搜索') ||
                        placeholder.includes('search') || placeholder.includes('搜索') ||
                        val.includes('search') || val.includes('搜索')) continue;
                    return el;
                }
            }

            for (const el of root.querySelectorAll('*')) {
                if (el.shadowRoot) {
                    const found = findInput(el.shadowRoot);
                    if (found) return found;
                }
            }

            return null;
        }

        const dialogRoot = findDialogRoot(document);
        return findInput(dialogRoot || document);
    });

    return handle.asElement();
}

async function isInviteEmailAdded(page, email) {
    return page.evaluate((targetEmail) => {
        const emailLower = targetEmail.toLowerCase();

        function isVisible(el) {
            if (!el || !el.getBoundingClientRect) return false;
            const r = el.getBoundingClientRect();
            const s = window.getComputedStyle(el);
            return r.width > 0 && r.height > 0 &&
                s.display !== 'none' &&
                s.visibility !== 'hidden' &&
                s.opacity !== '0';
        }

        function findDialogRoot(root) {
            const dialogSelectors = ['[role="dialog"]', 'dialog', '[aria-modal="true"]', '[data-dialog-id]'];
            for (const sel of dialogSelectors) {
                for (const el of root.querySelectorAll(sel)) {
                    if (isVisible(el)) return el;
                }
            }
            for (const el of root.querySelectorAll('*')) {
                if (el.shadowRoot) {
                    const found = findDialogRoot(el.shadowRoot);
                    if (found) return found;
                }
            }
            return null;
        }

        function scan(root) {
            const selectors = [
                'div', 'span', 'li', 'button', 'a', '[role="button"]',
                '[role="listitem"]', '[role="option"]', '[data-email]', '[aria-label]',
            ];

            for (const sel of selectors) {
                for (const el of root.querySelectorAll(sel)) {
                    if (!isVisible(el)) continue;
                    const tag = (el.tagName || '').toLowerCase();
                    if (tag === 'input' || tag === 'textarea') continue;
                    const text = [
                        el.textContent || '',
                        el.getAttribute('aria-label') || '',
                        el.getAttribute('data-email') || '',
                        el.getAttribute('title') || '',
                    ].join(' ').toLowerCase();
                    if (text.includes(emailLower)) return true;
                }
            }

            for (const el of root.querySelectorAll('*')) {
                if (el.shadowRoot) {
                    const found = scan(el.shadowRoot);
                    if (found) return true;
                }
            }

            return false;
        }

        const dialogRoot = findDialogRoot(document);
        return scan(dialogRoot || document);
    }, email).catch(() => false);
}

async function isSendButtonEnabled(page) {
    return page.evaluate(() => {
        function isVisible(el) {
            if (!el || !el.getBoundingClientRect) return false;
            const r = el.getBoundingClientRect();
            const s = window.getComputedStyle(el);
            return r.width > 0 && r.height > 0 &&
                s.display !== 'none' &&
                s.visibility !== 'hidden' &&
                s.opacity !== '0';
        }

        function scan(root) {
            const keywords = [
                'send', 'invite', 'confirm', 'next',
                '\u53d1\u9001', '\u9080\u8bf7', '\u786e\u8ba4', '\u4e0b\u4e00\u6b65',
            ];
            for (const el of root.querySelectorAll('button, a, [role="button"], input[type="submit"]')) {
                if (!isVisible(el)) continue;
                const txt = [
                    el.textContent || '',
                    el.getAttribute('aria-label') || '',
                    el.getAttribute('value') || '',
                    el.getAttribute('title') || '',
                ].join(' ').toLowerCase();
                if (keywords.some(k => txt.includes(k))) {
                    const disabled = !!el.disabled || el.getAttribute('aria-disabled') === 'true';
                    return !disabled;
                }
            }
            for (const el of root.querySelectorAll('*')) {
                if (el.shadowRoot) {
                    const found = scan(el.shadowRoot);
                    if (found !== null) return found;
                }
            }
            return null;
        }

        return scan(document);
    }).catch(() => null);
}

async function tryAddInviteEmail(page, email) {
    const input = await getInviteInputHandle(page);
    if (!input) return false;

    try {
        // Focus and clear the input
        await page.evaluate((el) => {
            el.focus();
            if ('value' in el) {
                el.value = '';
                el.dispatchEvent(new Event('input', { bubbles: true }));
                el.dispatchEvent(new Event('change', { bubbles: true }));
            } else if (el.isContentEditable) {
                el.textContent = '';
            }
        }, input).catch(() => { });

        await input.click().catch(() => { });
        await sleep(100);

        const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
        await page.keyboard.down(mod).catch(() => { });
        await page.keyboard.press('KeyA').catch(() => { });
        await page.keyboard.up(mod).catch(() => { });
        await page.keyboard.press('Backspace').catch(() => { });
        await sleep(100);

        // Type email via keyboard
        await page.keyboard.type(email, { delay: 20 });
        await sleep(1000);

        // Verify email was typed into the input
        let typed = await page.evaluate((el) => {
            return (el.value || el.textContent || '').trim();
        }, input).catch(() => '');

        // If keyboard typing didn't work, try native setter as fallback
        if (!typed.toLowerCase().includes(email.toLowerCase())) {
            await input.click().catch(() => { });
            await sleep(100);
            await page.evaluate((el, emailVal) => {
                el.focus();
                const nativeSetter = Object.getOwnPropertyDescriptor(
                    window.HTMLInputElement.prototype, 'value'
                )?.set;
                if (nativeSetter) {
                    nativeSetter.call(el, emailVal);
                } else {
                    el.value = emailVal;
                }
                el.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
                el.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
            }, input, email).catch(() => { });
            await sleep(500);
            typed = await page.evaluate((el) => {
                return (el.value || el.textContent || '').trim();
            }, input).catch(() => '');
        }

        if (!typed.toLowerCase().includes(email.toLowerCase())) {
            return false;
        }

        // Press Enter to confirm the email as a recipient.
        // This clears the input and adds the email as a chip/tag,
        // which also enables the Send button.
        await page.keyboard.press('Enter');
        await sleep(1500);

        // Verify: the email should now appear as page text (chip)
        // and the input should be cleared
        if (await isInviteEmailAdded(page, email)) {
            return true;
        }

        // Also accept if Send button became enabled (email was added)
        if (await isSendButtonEnabled(page)) {
            return true;
        }

        return false;
    } finally {
        await input.dispose().catch(() => { });
    }
}

async function clickInviteSendButton(page, wlog) {
    // Retry up to a few times in case the button is initially disabled
    for (let attempt = 0; attempt < 5; attempt++) {
        const clicked = await page.evaluate(() => {
            function isVisible(el) {
                if (!el || !el.getBoundingClientRect) return false;
                const r = el.getBoundingClientRect();
                const s = window.getComputedStyle(el);
                return r.width > 0 && r.height > 0 &&
                    s.display !== 'none' &&
                    s.visibility !== 'hidden' &&
                    s.opacity !== '0';
            }

            function findDialogRoot(root) {
                const dialogSelectors = ['[role="dialog"]', 'dialog', '[aria-modal="true"]', '[data-dialog-id]'];
                for (const sel of dialogSelectors) {
                    for (const el of root.querySelectorAll(sel)) {
                        if (isVisible(el)) return el;
                    }
                }
                for (const el of root.querySelectorAll('*')) {
                    if (el.shadowRoot) {
                        const found = findDialogRoot(el.shadowRoot);
                        if (found) return found;
                    }
                }
                return null;
            }

            function scan(root, keywords) {
                const sels = 'button, a, [role="button"], input[type="submit"]';
                for (const el of root.querySelectorAll(sels)) {
                    if (!isVisible(el)) continue;
                    if (el.disabled || el.getAttribute('aria-disabled') === 'true') continue;
                    const txt = [
                        el.textContent || '',
                        el.getAttribute('aria-label') || '',
                        el.getAttribute('value') || '',
                        el.getAttribute('title') || '',
                    ].join(' ').toLowerCase();
                    if (keywords.some(k => txt.includes(k))) {
                        el.click();
                        return txt.substring(0, 80);
                    }
                }

                for (const el of root.querySelectorAll('*')) {
                    if (el.shadowRoot) {
                        const found = scan(el.shadowRoot, keywords);
                        if (found) return found;
                    }
                }

                return null;
            }

            const dialogRoot = findDialogRoot(document);
            return scan(dialogRoot || document, [
                'send', 'invite', 'confirm', 'next',
                '\u53d1\u9001', '\u9080\u8bf7', '\u786e\u8ba4', '\u4e0b\u4e00\u6b65',
            ]);
        }).catch(() => null);

        if (clicked) {
            wlog.debug(`  Clicked send button: "${clicked}"`);
            return true;
        }

        if (attempt < 4) {
            wlog.debug(`  Send button not found or disabled, retrying... (${attempt + 1}/5)`);
            await sleep(2000);
        }
    }

    const dialogRoot = await getInviteDialogRootHandle(page);
    if (!dialogRoot) return false;

    try {
        const buttons = await dialogRoot.$$('button, a, [role="button"], input[type="submit"]');
        for (const btn of buttons) {
            const info = await page.evaluate((el) => {
                const r = el.getBoundingClientRect();
                const s = window.getComputedStyle(el);
                return {
                    visible: r.width > 0 && r.height > 0 &&
                        s.display !== 'none' &&
                        s.visibility !== 'hidden' &&
                        s.opacity !== '0',
                    disabled: !!el.disabled || el.getAttribute('aria-disabled') === 'true',
                    text: [
                        el.textContent || '',
                        el.getAttribute('aria-label') || '',
                        el.getAttribute('value') || '',
                        el.getAttribute('title') || '',
                    ].join(' ').toLowerCase(),
                };
            }, btn).catch(() => null);

            if (!info || !info.visible || info.disabled) continue;
            if (![
                'send', 'invite', 'confirm', 'next',
                '\u53d1\u9001', '\u9080\u8bf7', '\u786e\u8ba4', '\u4e0b\u4e00\u6b65',
            ].some(k => info.text.includes(k))) continue;

            await btn.click().catch(() => { });
            await sleep(500);
            return true;
        }
    } finally {
        await dialogRoot.dispose().catch(() => { });
    }

    return false;
}

async function verifyInviteSubmission(page, memberEmails) {
    return page.evaluate((emails) => {
        const pageText = document.body ? document.body.innerText.toLowerCase() : '';
        const successKeywords = [
            'invitation sent', 'invite sent', 'sent', 'done', 'success',
            '\u9080\u8bf7\u5df2\u53d1\u9001', '\u5df2\u53d1\u9001', '\u6210\u529f', '\u5b8c\u6210',
        ];
        const errorKeywords = [
            'error', 'failed', 'invalid', 'try again',
            '\u9519\u8bef', '\u5931\u8d25', '\u65e0\u6548', '\u91cd\u8bd5',
        ];

        return {
            hasSuccess: successKeywords.some(k => pageText.includes(k)),
            hasError: errorKeywords.some(k => pageText.includes(k)),
            stillShowsEmail: emails.some(email => pageText.includes(email.toLowerCase())),
            textPreview: pageText.substring(0, 400),
        };
    }, memberEmails).catch(() => ({
        hasSuccess: false,
        hasError: false,
        stillShowsEmail: false,
        textPreview: '',
    }));
}

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

        // 点击"邀请家庭成员"按钮 (这是一个链接，会导航到 /family/invitemembers)
        const inviteKws = [
            'invite', 'add member', 'add family', 'invite member',
            '邀请', '添加成员', '添加家庭成员', '邀请家庭成员',
            'family member', 'manage family',
            '发送邀请',
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

        // Wait for navigation to the invite members page
        wlog.info('  Waiting for invite page to load...');
        for (let wait = 0; wait < 15; wait++) {
            await sleep(1000);
            const url = page.url();
            if (url.includes('invitemembers')) {
                wlog.debug(`  Invite page loaded after ${wait + 1}s`);
                break;
            }
            if (wait % 5 === 4) {
                wlog.debug(`  Still waiting for invite page... URL: ${url}`);
            }
        }
        await sleep(2000); // extra wait for page content to render

        // 等待邀请页面中的邮箱输入框加载
        wlog.info('  Waiting for email input on invite page...');
        let inputReady = false;
        for (let wait = 0; wait < 30; wait++) {
            await sleep(1000);

            const input = await getInviteInputHandle(page);
            if (input) {
                await input.dispose().catch(() => { });
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
            const added = await tryAddInviteEmail(page, memberEmail);
            if (!added) {
                await takeScreenshot(page, `invite_add_email_failed_g${groupState.groupId}_${i + 1}`, wlog);
                throw new Error(`Failed to add invite email to dialog: ${memberEmail}`);
            }
            wlog.debug(`  Added email ${i + 1}/${memberEmails.length}: ${memberEmail}`);
        }

        wlog.info(`  All ${memberEmails.length} emails entered, sending invite...`);
        await sleep(1000);

        // 点击发送按钮
        const sendClickedSafe = await clickInviteSendButton(page, wlog);
        if (!sendClickedSafe) {
            await takeScreenshot(page, `invite_send_not_found_g${groupState.groupId}`, wlog);
            throw new Error('Cannot find send/invite confirm button in dialog');
        }

        // Wait for the page to process the invite (may navigate or show confirmation)
        wlog.debug('  Waiting for invite to be processed...');
        for (let wait = 0; wait < 15; wait++) {
            await sleep(2000);
            const url = page.url();
            // If page navigated away from invitemembers, invite was processed
            if (!url.includes('invitemembers')) {
                wlog.debug(`  Page navigated to: ${url}`);
                break;
            }
            // Check if page text changed (no longer shows "正在加载")
            const loadingText = await page.evaluate(() => {
                const text = document.body ? document.body.innerText.toLowerCase() : '';
                return text.includes('正在加载') || text.includes('loading');
            }).catch(() => false);
            if (!loadingText) {
                wlog.debug(`  Loading completed after ${(wait + 1) * 2}s`);
                break;
            }
        }
        await sleep(2000);

        // Try clicking confirmation dialog if any
        const confirmKwsSafe = [
            'ok', 'done', 'got it', 'close',
            '\u786e\u5b9a', '\u5b8c\u6210', '\u77e5\u9053\u4e86', '\u5173\u95ed',
        ];
        await tryClickStrategies(page, confirmKwsSafe, wlog, 'post_invite_confirm');
        await sleep(1000);

        // Verify invite was submitted — retry a few times
        let inviteResult;
        for (let attempt = 0; attempt < 3; attempt++) {
            inviteResult = await verifyInviteSubmission(page, memberEmails);
            // If page navigated back to family details, invite was sent
            if (page.url().includes('family/details') || page.url().includes('family/member')) {
                wlog.debug('  Page returned to family details — invite was sent');
                inviteResult.hasSuccess = true;
                break;
            }
            if (inviteResult.hasSuccess) break;
            if (inviteResult.hasError) break;
            // If email is no longer on the page, it was likely sent
            if (!inviteResult.stillShowsEmail) {
                inviteResult.hasSuccess = true;
                break;
            }
            await sleep(3000);
        }
        if (inviteResult.hasError) {
            await takeScreenshot(page, `invite_submit_error_g${groupState.groupId}`, wlog);
            throw new Error(`Invite submission error: ${inviteResult.textPreview.substring(0, 200)}`);
        }
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
