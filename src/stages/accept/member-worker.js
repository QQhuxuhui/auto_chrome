/**
 * stages/accept/member-worker.js — member-side stage 2 flow.
 *
 * Logs into the member's Gmail, finds the family-invite email, clicks the
 * accept link, and walks through the confirmation screens. Returns `true`
 * on success; throws on unrecoverable errors.
 *
 * This file performs NO database writes — the orchestrator in
 * stages/accept/index.js is responsible for persisting outcomes based on
 * both this flow's result and the host-authoritative verification from
 * host-monitor.js.
 *
 * Extracted verbatim from src/2_accept.js (the historical monolith). The
 * DB-backed runStage2/CLI bootstrap remain in 2_accept.js (soon a shim).
 */

const { createWorkerLogger, StepTimer } = require('../../common/logger');
const {
    sleep, clearBrowserSession, newPage,
    tryClickStrategies, takeScreenshot, detectPageState,
} = require('../../common/chrome');
const { googleLogin } = require('../../common/google-login');
const { isInviteRow } = require('../../stages/stage2-matcher');

const INVITE_WAIT_TIMEOUT = parseInt(process.env.INVITE_WAIT_TIMEOUT, 10) || 600;
const INVITE_POLL_INTERVAL = parseInt(process.env.INVITE_POLL_INTERVAL, 10) || 30;

// Manual mode: after Gmail loads, hand off to the user to click the invite
// link themselves. The browser being closed is the done-signal. The orchestrator
// then triggers a host-monitor scrape to confirm joined status.
function isManualMode() {
    return String(process.env.ACCEPT_MODE || '').toLowerCase() === 'manual';
}

// 用 https://gmail.com 作为入口：未登录会被 Google 301 到 accounts.google.com/signin，
// googleLogin 走完再 301 回 mail.google.com 收件箱。Chrome 启动已经带了
// --lang=en-US + --accept-lang=en-US,en，所以即便不带 ?hl=en 参数，Gmail UI
// 也会是英文（pipeline 里匹配 "Primary" tab 等依赖这个）。
const GMAIL_URL = 'https://gmail.com';

// ============ 条件暂停（人工干预） ============
// 用法：
//   PAUSE_AT=before-accept ./run_pipeline.sh --stage 2
//   PAUSE_AT=all ./run_pipeline.sh --stage 2
// 触发后，在终端按回车继续。
const PAUSE_POINTS = (process.env.PAUSE_AT || '')
    .split(',').map(s => s.trim()).filter(Boolean);
const _pauseLock = { busy: false };

async function maybePause(label, wlog) {
    if (!PAUSE_POINTS.includes('all') && !PAUSE_POINTS.includes(label)) return;
    if (!process.stdin.isTTY) {
        (wlog || console).warn && (wlog || console).warn(`[pause:${label}] stdin 非 TTY，跳过暂停`);
        return;
    }
    while (_pauseLock.busy) await sleep(500);
    _pauseLock.busy = true;
    try {
        process.stdout.write(`\n>>> [pause:${label}] 已暂停，人工干预完成后按回车继续...\n`);
        await new Promise(resolve => {
            process.stdin.resume();
            process.stdin.once('data', () => {
                process.stdin.pause();
                resolve();
            });
        });
        (wlog || console).info && (wlog || console).info(`[pause:${label}] 继续执行`);
    } finally {
        _pauseLock.busy = false;
    }
}

// ============ 严格的按钮点击器：只按 text+aria 精确匹配 ============
// one.google.com/family/join 的 "Accept invitation" 是 Material Design
// 按钮，内部绑在 pointerdown/pointerup 上，合成 el.click() 不触发。
// 做法：先在 evaluate 里按 text/aria 严格匹配并打标记，再回到 Node 侧
// 用 ElementHandle.click()（走 CDP 发真实鼠标事件）。JS click 兜底。
const CLICK_MARK_ATTR = 'data-auto-click-target';

async function clickByTextOrAria(page, keywords) {
    const label = await page.evaluate((kws, attr) => {
        document.querySelectorAll(`[${attr}]`).forEach(el => el.removeAttribute(attr));

        function isVisible(el) {
            if (!el || !el.getBoundingClientRect) return false;
            const r = el.getBoundingClientRect();
            const s = window.getComputedStyle(el);
            return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden';
        }
        const lc = kws.map(k => k.toLowerCase());
        const candidates = [];
        const sel = 'button, a, [role="button"], [role="link"], input[type="submit"], input[type="button"]';
        for (const el of document.querySelectorAll(sel)) {
            if (!isVisible(el)) continue;
            if (el.disabled || el.getAttribute('aria-disabled') === 'true') continue;
            const text = (el.textContent || '').trim().toLowerCase();
            const aria = (el.getAttribute('aria-label') || '').toLowerCase();
            const hay = (text + ' ' + aria).trim();
            if (!hay) continue;
            for (const k of lc) {
                if (hay.includes(k)) {
                    candidates.push({ el, hay, kwLen: k.length });
                    break;
                }
            }
        }
        if (candidates.length === 0) return null;
        candidates.sort((a, b) => (b.kwLen - a.kwLen) || (a.hay.length - b.hay.length));
        const best = candidates[0];
        best.el.setAttribute(attr, '1');
        return (best.el.textContent || best.el.getAttribute('aria-label') || '').trim().substring(0, 80);
    }, keywords, CLICK_MARK_ATTR).catch(() => null);

    if (label === null) return null;

    const handle = await page.$(`[${CLICK_MARK_ATTR}]`).catch(() => null);
    try {
        if (handle) {
            // ElementHandle.click 走 CDP：滚入视图 + 真实 mousedown/mouseup
            await handle.click({ delay: 30 });
        } else {
            throw new Error('handle_missing');
        }
    } catch (_) {
        // 兜底：被遮挡/脱离视口时用 JS click
        await page.evaluate((attr) => {
            const el = document.querySelector(`[${attr}]`);
            if (el) el.click();
        }, CLICK_MARK_ATTR).catch(() => { });
    } finally {
        if (handle) await handle.dispose().catch(() => { });
        await page.evaluate((attr) => {
            document.querySelectorAll(`[${attr}]`).forEach(el => el.removeAttribute(attr));
        }, CLICK_MARK_ATTR).catch(() => { });
    }

    return label;
}

// ============ 单个成员接受邀请 ============
async function acceptInvite(memberAccount, browser, workerId) {
    const wlog = createWorkerLogger(workerId);
    const timer = new StepTimer(wlog);

    wlog.info(`>> Accept invite: ${memberAccount.email}`);

    // 0. 先清除旧 session，避免残留上一阶段或上一个账号的登录态
    await clearBrowserSession(browser, wlog);

    let page = await newPage(browser);

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

        // Click "Primary" tab if Gmail has category tabs (Primary/Promotions/Social)
        await page.evaluate(() => {
            const tabs = document.querySelectorAll('div[role="tab"], td[role="tab"], span[role="tab"]');
            for (const tab of tabs) {
                const text = (tab.textContent || '').toLowerCase();
                if (text.includes('primary') || text.includes('主要')) {
                    tab.click();
                    return;
                }
            }
            // Also try clicking by aria-label or data attributes
            const primaryLink = document.querySelector(
                'a[aria-label*="Primary"], a[aria-label*="主要"], ' +
                'div[data-tooltip="Primary"], div[data-tooltip="主要"]'
            );
            if (primaryLink) primaryLink.click();
        }).catch(() => { });
        await sleep(1000);

        // Manual mode: stop here. Let the user click the invite link themselves;
        // treat browser close as the done signal. Orchestrator will trigger a
        // host-monitor scrape after this returns to confirm the joined state.
        if (isManualMode()) {
            wlog.info(`  [manual] Gmail ready for ${memberAccount.email}.`);
            wlog.info(`  [manual] 请在浏览器里点击邀请邮件的接受链接并完成确认；全部完成后关闭浏览器窗口。`);
            await new Promise((resolve) => {
                const done = () => { browser.off('disconnected', done); resolve(); };
                browser.once('disconnected', done);
            });
            wlog.success(`  [manual] browser closed — ${memberAccount.email} handed back to host-monitor for verification`);
            timer.step('Manual close');
            return true;
        }

        // 2. 搜索邀请邮件（轮询）
        // 使用多语言关键词 + URL pattern 双重匹配：URL pattern "family/join" 对所有
        // 语言的邀请邮件都有效（家庭邀请邮件体里总含 myaccount.google.com/family/join/... 链接）
        const searchKeywords = [
            'family/join',              // URL pattern — 跨语言，最稳
            'family group', 'google one', 'family plan',  // 英文
            '家庭组', '家族グループ',                      // 中/日
            'nhóm gia đình',            // 越南语
            'grupo familiar', 'grupo de familia',        // 西/葡
            'groupe familial', 'groupe de famille',      // 法
            'familiengruppe',           // 德
            'grup keluarga',            // 印尼
            'gruppo famiglia',          // 意
            'gia đình',                 // 越南语（短）
            '가족 그룹',                  // 韩
            'семейная группа',          // 俄
            'مجموعة العائلة',           // 阿
        ];
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
            // 先确保在 Primary 标签页
            await page.evaluate(() => {
                // Click Primary tab if present
                const tabs = document.querySelectorAll('div[role="tab"], td[role="tab"], span[role="tab"]');
                for (const tab of tabs) {
                    const text = (tab.textContent || '').trim().toLowerCase();
                    if (text.startsWith('primary') || text.startsWith('主要')) {
                        tab.click();
                        return;
                    }
                }
                // Try by aria-label
                const el = document.querySelector(
                    'div[data-tooltip="Primary"], div[data-tooltip="主要"]'
                );
                if (el) el.click();
            }).catch(() => { });
            await sleep(1500);

            // 直接扫描收件箱可见行 —— Gmail 的短语搜索不索引 URL，
            // 曾尝试 `in:anywhere "family/join"` 始终返回 0 结果并清空 view。
            // 对于新账号来说家庭邀请邮件通常就在最近的几十条中，row-scan 足够。

            // Scan inbox rows, extract { text, hrefs }, delegate to pure matcher (see stage2-matcher.js).
            const rowData = await page.evaluate(() => {
                const rows = document.querySelectorAll('tr.zA, tr.zE, tr[role="row"], div[role="row"], tr[draggable="true"]');
                const out = [];
                for (const row of rows) {
                    const r = row.getBoundingClientRect();
                    if (r.width < 200 || r.height < 20) continue;
                    const text = (row.textContent || '').trim();
                    if (!text) continue;
                    if (text.toLowerCase().includes('promotions') && text.toLowerCase().includes('social')) continue;
                    const hrefs = [];
                    for (const a of row.querySelectorAll('a[href]')) {
                        const h = a.getAttribute('data-saferedirecturl') || a.getAttribute('href') || '';
                        if (h) hrefs.push(h);
                    }
                    out.push({ text, hrefs });
                }
                return out;
            }).catch(() => []);

            const matched = rowData.find(r => isInviteRow(r));
            const emailFound = matched ? matched.text.substring(0, 80) : null;

            if (emailFound) {
                wlog.success(`  Found invite email: "${emailFound}"`);

                // 点击邮件行打开邮件 — 使用 gjy 的精确选择器过滤 + dev 的多层 fallback
                // 策略 1: evaluate 点击邮件行（带尺寸和标签栏过滤）
                const openedByEval = await page.evaluate((keywords) => {
                    const rows = document.querySelectorAll('tr.zA, tr.zE, tr[role="row"], div[role="row"], tr[draggable="true"]');
                    for (const row of rows) {
                        const r = row.getBoundingClientRect();
                        if (r.width < 200 || r.height < 20) continue;
                        const text = (row.textContent || '').toLowerCase();
                        if (text.includes('promotions') && text.includes('social')) continue;
                        if (keywords.some(k => text.includes(k.toLowerCase()))) {
                            // 精确点击邮件标题/摘要区域
                            const targets = [
                                ...row.querySelectorAll('span[data-thread-id], span.bog, span.bqe, td.xY a, td.yX'),
                                ...row.querySelectorAll('span[id]:not([class*="checkbox"])'),
                                ...row.querySelectorAll('td:nth-child(n+3)'),
                            ];
                            for (const target of targets) {
                                const tr = target.getBoundingClientRect();
                                if (tr.width > 50 && tr.height > 10) {
                                    target.click();
                                    return 'clicked_target';
                                }
                            }
                            row.click();
                            return 'clicked_row';
                        }
                    }
                    return null;
                }, searchKeywords).catch(() => null);

                // 策略 1 失败时，使用 tryClickStrategies fallback
                if (!openedByEval) {
                    const emailKws = ['family group', 'google one', '家庭组', 'family plan',
                        "join", 'family'];
                    await tryClickStrategies(page, emailKws, wlog, 'open_email');
                }

                if (openedByEval) {
                    wlog.debug(`  Email open attempt: ${openedByEval}`);
                }
                await sleep(3000);

                // 验证是否已进入邮件内容页面
                let inEmailView = await page.evaluate(() => {
                    // 邮件内容页面有 message body 元素
                    const hasBody = document.querySelector('div[data-message-id], div[class*="adn"], div.a3s, div.ii.gt');
                    return !!hasBody;
                }).catch(() => false);

                if (!inEmailView) {
                    wlog.warn('  Email not opened yet, trying keyboard navigation...');
                    // 策略 2: 键盘 Enter 打开第一封搜索结果
                    await page.keyboard.press('Enter');
                    await sleep(3000);

                    inEmailView = await page.evaluate(() => {
                        const hasBody = document.querySelector('div[data-message-id], div[class*="adn"], div.a3s, div.ii.gt');
                        return !!hasBody;
                    }).catch(() => false);
                }

                if (!inEmailView) {
                    // 策略 3: 用 tryClickStrategies 精确点击邮件标题
                    wlog.warn('  Still not in email view, trying tryClickStrategies...');
                    const rowClicked = await tryClickStrategies(page,
                        ['family group', 'google one', "join bond's family", 'family plan', '家庭组'],
                        wlog, 'open_email');
                    if (rowClicked) {
                        await sleep(3000);
                    }
                }

                // 最终验证
                const finalCheck = await page.evaluate(() => {
                    const hasBody = document.querySelector('div[data-message-id], div[class*="adn"], div.a3s, div.ii.gt');
                    return !!hasBody;
                }).catch(() => false);

                if (!finalCheck) {
                    wlog.warn('  Could not confirm email opened, proceeding anyway...');
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

        // 【人工干预点】邮件已打开，脚本点接受链接前 —— 你可以自己点
        await maybePause('before-accept', wlog);

        // Gmail 的邮件内容在 iframe 或特定 div 中，需要先尝试获取邮件正文区域
        // 查找接受邀请的链接/按钮
        // 多语言 accept/join 关键词
        const acceptKws = [
            // 英文
            'accept', 'join', 'accept invitation', 'join family', 'get started',
            'open invitation',
            // 中文
            '接受', '加入', '接受邀请', '加入家庭组', '开始', '打开邀请',
            // 越南
            'tham gia', 'chấp nhận', 'chap nhan',
            // 西/葡
            'aceptar', 'unirme', 'unirse', 'aceitar', 'juntar', 'entrar',
            // 法
            'accepter', 'rejoindre',
            // 德
            'akzeptieren', 'beitreten', 'annehmen',
            // 印尼
            'terima', 'bergabung', 'gabung',
            // 意
            'accetta', 'unisciti', 'partecipa',
            // 日/韩
            '承諾', '参加', '参加する', '수락', '참여', '가입',
            // 俄
            'принять', 'присоединиться', 'присоединение',
            // 阿
            'قبول', 'انضمام', 'انضم',
        ];

        let accepted = false;

        // 方法1：在邮件正文中查找链接（包括 iframe 内）
        const acceptLink = await page.evaluate((keywords) => {
            // 已知的 Google 家庭邀请链接 / 重定向包装
            const hrefPatterns = [
                'myaccount.google.com/family',
                'one.google.com',
                'families.google.com',
                'google.com/families',
                // Google 邮件重定向包装 —— accept 按钮的实际 href 往往是这些域
                'notifications.googleapis.com/email/redirect',
                'c.gle/',           // Google short URL
                's.gle/',           // Google short URL (variant)
                'google.com/url?',  // Google redirect
            ];

            // Gmail 会把邮件里的原始链接包装为跟踪 URL，放在 href 里，
            // 真实目标在 data-saferedirecturl 属性里 —— 直接访问 href 会触发
            // ERR_INVALID_REDIRECT（需要特定 referrer）。优先用 saferedirecturl。
            function getRealHref(link) {
                return (link.getAttribute('data-saferedirecturl') || link.href || '').trim();
            }

            // 先在主文档中找
            function findAcceptLink(root) {
                const links = root.querySelectorAll('a[href]');
                const cand = [];
                for (const link of links) {
                    const text = (link.textContent || '').toLowerCase().trim();
                    const realHref = getRealHref(link);
                    const href = realHref.toLowerCase();
                    if (!href) continue;
                    const r = link.getBoundingClientRect();
                    const visible = r.width > 0 && r.height > 0;
                    if (!visible) continue;
                    // 按真实 URL 匹配（最可靠）
                    if (hrefPatterns.some(p => href.includes(p))) {
                        return realHref;
                    }
                    // 按链接文本匹配（多语言）
                    if (text && keywords.some(k => text.includes(k))) {
                        if (r.width > 50 && r.height > 15) {
                            return realHref;
                        }
                    }
                    // 兜底候选：邮件正文里按钮样式 + Google 域 的链接
                    if (r.width > 80 && r.height > 20 &&
                        (href.includes('google.com') || href.includes('googleusercontent.com'))) {
                        cand.push({ href: realHref, area: r.width * r.height });
                    }
                }
                cand.sort((a, b) => b.area - a.area);
                return cand[0] ? cand[0].href : null;
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

            // 核心难点：Gmail 把邮件正文里的原始链接用多层跟踪 URL 包装
            // （google.com/url?q=... → notifications.googleapis.com/email/redirect?t=...
            //  → 真正的 myaccount.google.com/family/join/...）。
            // 直接 page.goto 这些跟踪 URL 会返回 ERR_INVALID_REDIRECT，因为要求
            // 来自 Gmail 上下文的 referer + 一次性 token。
            //
            // 正确做法：在 Gmail 页面里点击链接元素本身 —— Chrome 会用 Gmail 的
            // referer 完成整个重定向链并到达最终的 family/join 页面。

            // 先监听即将打开的 target（Gmail 通常 target="_blank" 开新 tab）
            const browser2 = page.browser();
            const targetPromise = new Promise((resolve) => {
                const onTarget = (t) => {
                    if (t.type() === 'page') {
                        browser2.off('targetcreated', onTarget);
                        resolve(t);
                    }
                };
                browser2.on('targetcreated', onTarget);
                setTimeout(() => {
                    browser2.off('targetcreated', onTarget);
                    resolve(null);
                }, 10000);
            });

            // 点击匹配到的 <a> 元素。
            // 关键：不能用 `a.click()` —— Gmail 的邮件链接是 target="_blank"，
            // 打开新 tab 依赖 window.open 被 user-gesture 允许。合成 JS click
            // 不算 user gesture，弹窗会被浏览器拦截，结果就是 href 匹配成功
            // 但 tab 没开、也没 navigation。必须走 CDP 真实鼠标事件（ElementHandle.click）。
            const MARK_ATTR = 'data-accept-link-target';
            const marked = await page.evaluate((url, attr) => {
                document.querySelectorAll(`[${attr}]`).forEach(el => el.removeAttribute(attr));
                const links = document.querySelectorAll('a[href]');
                for (const a of links) {
                    const h = a.getAttribute('data-saferedirecturl') || a.href || '';
                    if (h === url || h.includes(url.substring(0, 60))) {
                        const r = a.getBoundingClientRect();
                        if (r.width > 0 && r.height > 0) {
                            a.setAttribute(attr, '1');
                            return true;
                        }
                    }
                }
                return false;
            }, acceptLink, MARK_ATTR).catch(() => false);

            let clickOk = false;
            if (marked) {
                const linkHandle = await page.$(`[${MARK_ATTR}]`).catch(() => null);
                if (linkHandle) {
                    try {
                        // ElementHandle.click 通过 CDP 发真实 pointerdown/pointerup，
                        // 才能让 Gmail 的 jsaction + window.open(target=_blank) 正常触发。
                        await linkHandle.click({ delay: 30 });
                        clickOk = true;
                    } catch (e) {
                        wlog.debug(`  ElementHandle click failed: ${e.message}, falling back to JS click`);
                    } finally {
                        await linkHandle.dispose().catch(() => { });
                    }
                }

                // CDP 点击失败时退回 JS click（至少让链接 onClick handler 跑，有时还能同 tab 跳走）
                if (!clickOk) {
                    clickOk = await page.evaluate((attr) => {
                        const el = document.querySelector(`[${attr}]`);
                        if (el) { el.click(); return true; }
                        return false;
                    }, MARK_ATTR).catch(() => false);
                }

                await page.evaluate((attr) => {
                    document.querySelectorAll(`[${attr}]`).forEach(el => el.removeAttribute(attr));
                }, MARK_ATTR).catch(() => { });
            }

            if (clickOk) {
                wlog.info('  Clicked accept link inside Gmail');
                const newTarget = await targetPromise;
                if (newTarget) {
                    const newPage = await newTarget.page().catch(() => null);
                    if (newPage) {
                        wlog.info('  New tab opened, switching to it');
                        await newPage.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => { });
                        await sleep(2000);
                        // 把后续操作的 page 切换到新 tab
                        try { await page.close(); } catch (_) { }
                        page = newPage;
                    }
                } else {
                    // 没开新 tab —— 可能同 tab 跳转
                    await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => { });
                }
                await sleep(3000);
                accepted = true;
            } else {
                // 兜底：尝试解包 google.com/url?q= 然后 goto（大部分情况下会失败，但保留）
                let realUrl = acceptLink;
                try {
                    const u = new URL(acceptLink);
                    if (u.hostname === 'www.google.com' && u.pathname === '/url') {
                        const q = u.searchParams.get('q');
                        if (q) realUrl = q;
                    }
                } catch (_) { }
                await page.goto(realUrl, { waitUntil: 'domcontentloaded', timeout: 30000 })
                    .catch(e => wlog.warn(`Accept link fallback navigation: ${e.message}`));
                await sleep(3000);
                accepted = true;
            }
        }

        // 方法2：用 tryClickStrategies 直接点击邮件中的按钮
        if (!accepted) {
            wlog.info('  Trying to click accept button in email...');
            const clicked = await tryClickStrategies(page, acceptKws, wlog, 'accept_invite');
            if (clicked) {
                await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => { });
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
                await page.goto(inviteLink.href, { waitUntil: 'domcontentloaded', timeout: 30000 })
                    .catch(e => wlog.warn(`Navigation: ${e.message}`));
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

        // 成功状态判定：URL 命中 /family/join/success（跨语言最稳），或文本命中以下短语
        // Google 本地化成员账号页面时，成功 URL 路径保持不变，文本则会变。
        const SUCCESS_URL_RE = /\/family\/(join\/success|members|details)/i;
        const successTexts = [
            // English
            "you're now part of", "you've joined", "you are now a member",
            "you're in the family", "welcome to your family",
            // Chinese
            "你已加入", "已成为", "成功加入", "欢迎加入",
            // Vietnamese
            "chào mừng bạn tham gia", "bạn đã tham gia",
            // Spanish / Portuguese
            "te has unido", "ahora formas parte", "bem-vindo", "agora faz parte",
            // French
            "vous avez rejoint", "bienvenue dans",
            // German
            "willkommen in deiner familie", "du bist jetzt",
            // Japanese / Korean
            "ファミリーに参加しました", "ファミリーグループに参加", "가족에 참여했습니다", "가족 그룹에 참여",
            // Russian / Indonesian / Italian / Arabic
            "вы присоединились", "selamat datang", "benvenuto nella tua famiglia", "لقد انضممت",
        ];
        // 确认按钮关键词：对齐 acceptKws 的多语言覆盖面 —— 会员账号的 UI 按 Google
        // 本地化决定，要能匹配到各种语言的 Join / Accept / Continue / Confirm。
        // 按具体度排序（更具体的在前）避免误点旁边的"继续学习"等无关按钮。
        const confirmKws = [
            // 最具体："Join family group" 的各语言变体
            'join family group', 'join family', 'join group',
            '加入家庭组', '加入家庭群组', '加入家庭群',
            'tham gia nhóm gia đình', 'tham gia nhóm',
            'unirme al grupo familiar', 'unirse al grupo familiar', 'unirme a la familia',
            'juntar-se ao grupo familiar', 'aderir ao grupo',
            'rejoindre le groupe familial', 'rejoindre la famille',
            'familiengruppe beitreten', 'der familie beitreten',
            'bergabung dengan grup keluarga', 'bergabung keluarga',
            'unisciti al gruppo famiglia', 'unisciti alla famiglia',
            'ファミリーグループに参加', '家族グループに参加',
            '가족 그룹에 가입', '가족 그룹에 참여',
            'присоединиться к семейной группе', 'присоединиться к семье',
            'الانضمام إلى مجموعة العائلة',
            // 二级：通用 accept/join + 多语言
            'accept invitation', 'accept', 'join',
            '接受邀请', '接受', '加入',
            'chấp nhận lời mời', 'chấp nhận', 'tham gia',
            'aceptar invitación', 'aceptar', 'unirme', 'unirse',
            'aceitar convite', 'aceitar', 'juntar', 'entrar',
            'accepter l\'invitation', 'accepter', 'rejoindre',
            'einladung annehmen', 'annehmen', 'beitreten',
            'terima undangan', 'terima', 'bergabung', 'gabung',
            'accetta invito', 'accetta', 'unisciti', 'partecipa',
            '招待を承諾', '承諾', '参加する', '参加',
            '초대 수락', '수락', '가입', '참여',
            'принять приглашение', 'принять', 'присоединиться',
            'قبول الدعوة', 'قبول', 'انضمام', 'انضم',
            // 三级：流程推进按钮（continue/confirm/agree/get started）多语言
            'continue', 'confirm', 'get started', 'agree', 'next', 'done',
            '确认', '继续', '同意', '完成', '开始', '下一步',
            'tiếp tục', 'xác nhận', 'đồng ý', 'bắt đầu',
            'continuar', 'confirmar', 'estoy de acuerdo', 'siguiente', 'listo',
            'continuer', 'confirmer', 'je suis d\'accord', 'suivant',
            'weiter', 'bestätigen', 'zustimmen', 'fertig',
            'lanjutkan', 'konfirmasi', 'setuju', 'selesai',
            'continua', 'conferma', 'accetto', 'fine',
            '続行', '確認', '同意する', '次へ', '完了',
            '계속', '확인', '동의', '다음', '완료',
            'продолжить', 'подтвердить', 'согласен', 'далее', 'готово',
            'متابعة', 'تأكيد', 'أوافق', 'التالي', 'تم',
        ];

        let joined = false;
        for (let confirmStep = 0; confirmStep < 6; confirmStep++) {
            const pageText = await page.evaluate(() =>
                document.body ? document.body.innerText.substring(0, 2000).toLowerCase() : ''
            ).catch(() => '');
            const urlBefore = page.url();

            wlog.debug(`  Confirm step ${confirmStep + 1}: url=${urlBefore} text="${pageText.substring(0, 80)}..."`);

            // 是否已经加入 —— URL 命中成功路径优先（跨语言最稳），文本兜底
            if (SUCCESS_URL_RE.test(urlBefore) ||
                successTexts.some(t => pageText.includes(t))) {
                wlog.success('  Successfully joined family group!');
                joined = true;
                break;
            }

            // 严格点击（只按 text/aria 匹配，不走 fallback 策略）
            const clicked = await clickByTextOrAria(page, confirmKws);
            if (!clicked && clicked !== '') {
                if (confirmStep < 2) {
                    // 页面可能还在加载，等一下再试
                    await sleep(3000);
                    continue;
                }
                wlog.debug(`  No confirm button found at step ${confirmStep + 1}, stopping`);
                break;
            }
            wlog.info(`  Clicked: "${clicked}"`);

            // 轮询 URL/文本变化而不是 waitForNavigation —— 目标页可能是 SPA 原地更新
            let changed = false;
            for (let poll = 0; poll < 20; poll++) {
                await sleep(500);
                const curUrl = page.url();
                if (curUrl !== urlBefore) { changed = true; break; }
                const curText = await page.evaluate(() =>
                    document.body ? document.body.innerText.substring(0, 2000).toLowerCase() : ''
                ).catch(() => '');
                if (SUCCESS_URL_RE.test(curUrl) ||
                    successTexts.some(t => curText.includes(t))) {
                    wlog.success('  Successfully joined family group!');
                    joined = true;
                    changed = true;
                    break;
                }
                // 如果按钮/文本明显变了也算推进
                if (curText && curText !== pageText && curText.length !== pageText.length) {
                    changed = true; break;
                }
            }
            if (joined) break;
            if (!changed) {
                wlog.warn(`  Click "${clicked}" produced no visible change, stopping`);
                break;
            }
            await sleep(1500);
        }
        if (!joined) {
            // 最终再查一次是否已经实际加入（有些页面不显示成功短语，而是直接跳回 /family/details）
            const finalUrl = page.url();
            const finalText = await page.evaluate(() =>
                document.body ? document.body.innerText.substring(0, 500).toLowerCase() : ''
            ).catch(() => '');
            // Chrome 错误页直接视为失败
            if (finalUrl.startsWith('chrome-error://') || finalUrl.startsWith('chrome://network-error')) {
                await takeScreenshot(page, `accept_chrome_error_${memberAccount.email}`, wlog);
                throw new Error(`accept_navigation_failed: ${finalUrl}`);
            }
            if (SUCCESS_URL_RE.test(finalUrl) ||
                successTexts.some(t => finalText.includes(t))) {
                wlog.success('  Joined (detected via final state)');
            } else {
                await takeScreenshot(page, `accept_unconfirmed_${memberAccount.email}`, wlog);
                throw new Error(`accept_not_confirmed: final url=${finalUrl.substring(0, 120)}`);
            }
        }

        timer.step('Accept confirmed');
        wlog.success(`>> Invite accepted: ${memberAccount.email} (${(timer.total() / 1000).toFixed(1)}s)`);
        return true;

    } finally {
        await page.close().catch(() => { });
        // Manual mode: browser is already disconnected (user closed it). Any
        // CDP call will throw — swallow so we don't mask the real outcome.
        await clearBrowserSession(browser, wlog).catch(() => { });
    }
}

module.exports = { acceptInvite, GMAIL_URL, INVITE_WAIT_TIMEOUT };
