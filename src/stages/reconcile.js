/**
 * Reconcile: fetch Google family members for a host, diff with DB, patch states.
 *
 * Exposed:
 *   scrapeFamilyMembers(page, wlog) -> [{ email, displayName }]  (strings list)
 *   reconcileAgainstDB(hostRecord, googleEmails, runId) -> { changes: [] }
 *   reconcileHost(hostRecord, browser, runId, wlog) -> { changes }  (full flow)
 */
const { sleep, newPage, clearBrowserSession, takeScreenshot } = require('../common/chrome');
const { googleLogin } = require('../common/google-login');
const membersDb = require('../db/members');
const eventsDb = require('../db/events');
const antigravityClient = require('../common/antigravity');
const antigravitySync = require('../sync/antigravity-sync');

const FAMILY_URL = 'https://myaccount.google.com/family/details?utm_source=g1web&utm_medium=default';

function computeUnknownEmails(familyEmails, localMembers, hostEmail) {
    const knownSet = new Set();
    knownSet.add(String(hostEmail || '').toLowerCase());
    for (const m of localMembers || []) {
        if (m && m.email) knownSet.add(String(m.email).toLowerCase());
    }
    const out = [];
    for (const e of familyEmails || []) {
        const lower = String(e || '').toLowerCase();
        if (!lower) continue;
        if (!knownSet.has(lower)) out.push(e);
    }
    return out;
}

/**
 * 抓取 Google Family 页面上所有家庭成员（含 pending invitations）。
 *
 * 返回 Array<{ email, href, name, isPending }>：
 *   - pending invite: email 列表页直接可见
 *   - joined member: 必须 visit 详情页才拿到 email
 *
 * 副作用：为了拿到 joined member 的 email，会依次 goto 每个 a[href*="family/member"]
 * 详情页。N 个成员 ≈ 3N 秒。最后 page 会被导航回 family/details。
 */
async function scrapeFamilyMembers(page, wlog) {
    await page.goto(FAMILY_URL, { waitUntil: 'networkidle2', timeout: 30000 }).catch(e =>
        wlog && wlog.warn && wlog.warn(`family page load: ${e.message}`));
    await sleep(2000);

    // 1. 列表页枚举所有候选 anchor（含 member 和 pending invitation）
    const anchorInfo = await page.evaluate(() => {
        const out = [];
        const seen = new Set();
        // 同时覆盖 /family/member/ 和 /family/invit... 两类 href
        for (const a of document.querySelectorAll('a[href*="family/"]')) {
            const href = a.getAttribute('href') || '';
            if (!href || seen.has(href)) continue;
            // 过滤无关链接（如 Family Group 侧栏、Learn more 等）
            if (!/family\/(member|invit)/i.test(href)) continue;
            seen.add(href);
            const text = (a.textContent || '').trim();
            // 跳过 host 自己（"Family manager" 标记）
            if (/family manager|家庭管理员/i.test(text)) continue;
            // 列表页可见邮箱（pending invite 的情况）
            const emailMatch = text.match(/([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/);
            out.push({
                href,
                text: text.substring(0, 120),
                listPageEmail: emailMatch ? emailMatch[1].toLowerCase() : null,
            });
        }
        return out;
    }).catch(() => []);

    wlog && wlog.info && wlog.info(`scrape: ${anchorInfo.length} family anchor(s) on list page`);

    const results = [];
    for (const info of anchorInfo) {
        if (info.listPageEmail) {
            // pending invite：列表就能看到邮箱，不用进详情
            results.push({
                email: info.listPageEmail,
                href: info.href,
                name: null,
                isPending: true,
            });
            continue;
        }
        // joined member：visit detail 页抽邮箱
        const absUrl = info.href.startsWith('http')
            ? info.href
            : `https://myaccount.google.com/${info.href.replace(/^\/+/, '')}`;
        await page.goto(absUrl, { waitUntil: 'networkidle2', timeout: 20000 }).catch(() => { });
        await sleep(2500);
        const email = await extractDetailEmail(page);
        if (email) {
            results.push({
                email,
                href: info.href,
                name: info.text || null,
                isPending: false,
            });
            wlog && wlog.info && wlog.info(`scrape: joined ${email} (${info.text})`);
        } else {
            wlog && wlog.warn && wlog.warn(`scrape: could not parse email on detail ${absUrl}`);
        }
    }

    // 回到列表页，下一次 evaluate 拿到的是最新 DOM
    await page.goto(FAMILY_URL, { waitUntil: 'networkidle2', timeout: 20000 }).catch(() => { });
    await sleep(1500);

    return results;
}

async function reconcileAgainstDB(hostRecord, googleEmails, runId) {
    const changes = [];
    const all = await membersDb.listMembers({ hostId: hostRecord.id, pageSize: 10000 });
    const googleSet = new Set(googleEmails.map(e => e.toLowerCase()));

    for (const m of all) {
        const emailLower = (m.email || '').toLowerCase();
        const inFamily = googleSet.has(emailLower);

        if (inFamily && m.status === 'invite_pending') {
            await membersDb.transitionToJoined(m.id);
            await eventsDb.logEvent({
                memberId: m.id, hostId: hostRecord.id, runId,
                stage: 'reconcile', eventType: 'note',
                message: 'invite_pending → joined via family page',
            });
            changes.push({ id: m.id, from: 'invite_pending', to: 'joined' });
        } else if (!inFamily && (m.status === 'joined' || m.status === 'done')) {
            await membersDb.markRemovedFromFamily(m.id);
            await eventsDb.logEvent({
                memberId: m.id, hostId: hostRecord.id, runId,
                stage: 'reconcile', eventType: 'note',
                message: `${m.status} → removed_from_family (not in google family)`,
            });
            changes.push({ id: m.id, from: m.status, to: 'removed_from_family' });
        }
    }
    return { changes };
}

/**
 * 检测当前页是否跳到了 "verify it's you" / 2FA 挑战页，若是则
 * 调用 googleLogin 走一遍状态机（它能读 hostAccount.totp_secret 自动
 * 填 TOTP 验证码）。
 *
 * Google 的敏感操作二次验证可能：
 *   - URL: /signin/challenge/... 或 /v3/signin/challenge/... 或 /signin/v2/challenge/...
 *   - URL: /verifyit / /verify / /gaia/s/challenge 等
 *   - 有时是同域 overlay，URL 不变但页面内容含 "Verify it's you"
 *
 * 所以双重检测 + 长轮询（最多 10 秒）。
 */
async function solveMidflowChallenge(page, hostAccount, tag, wlog) {
    const CHALLENGE_URL_RE = /\/(?:signin|sign_in|v3|v2|webauthn)\/.*challenge|verifyit|verify-account|accountrecovery|\/2sv|\/challenge\//i;
    const CHALLENGE_TEXT_RE = /verify it'?s you|verify your identity|for your security|confirm your identity|protect your account|验证您的身份|确认是您本人|为了保护您|安全验证|请验证/i;

    // 长轮询等挑战出现（Google 有时要等 2-5 秒才跳到挑战页）
    let detected = null;
    for (let i = 0; i < 20; i++) {
        const url = page.url();
        if (CHALLENGE_URL_RE.test(url)) {
            detected = { by: 'url', url };
            break;
        }
        const hasVerifyText = await page.evaluate((pattern) => {
            const re = new RegExp(pattern, 'i');
            const text = document.body ? document.body.innerText : '';
            return re.test(text);
        }, CHALLENGE_TEXT_RE.source).catch(() => false);
        if (hasVerifyText) {
            detected = { by: 'content', url };
            break;
        }
        // 也可能已经成功跳回 family 列表/详情页（表示 remove 完成无需验证）
        if (/\/family\/details/.test(url) || /\/family\/member/.test(url)) {
            if (i >= 3) {
                // 多次都在 family 页，没挑战
                wlog && wlog.info && wlog.info(`${tag} settled back to family page, no challenge needed`);
                return true;
            }
        }
        await sleep(500);
    }

    if (!detected) {
        const url = page.url();
        wlog && wlog.info && wlog.info(`${tag} no challenge detected after 10s, continuing (url=${url.substring(0, 120)})`);
        return true;
    }

    wlog && wlog.info && wlog.info(`${tag} challenge detected via ${detected.by}: ${detected.url}`);
    await takeScreenshot(page, `remove_challenge_before_solve`, wlog);

    if (!hostAccount) {
        wlog && wlog.warn && wlog.warn(`${tag} challenge detected but no hostAccount passed — cannot auto-solve`);
        return false;
    }

    try {
        await googleLogin(page, {
            email: hostAccount.email,
            pass: hostAccount.password,
            recovery: hostAccount.recovery_email || '',
            totp_secret: hostAccount.totp_secret || undefined,
        }, wlog);
        wlog && wlog.info && wlog.info(`${tag} mid-flow challenge solved; final url=${page.url().substring(0, 120)}`);
        await takeScreenshot(page, `remove_challenge_after_solve`, wlog);
        return true;
    } catch (e) {
        wlog && wlog.warn && wlog.warn(`${tag} challenge solving failed: ${e.message}`);
        await takeScreenshot(page, `remove_challenge_solve_failed`, wlog);
        return false;
    }
}

/**
 * 在 Google Family 详情页点「Remove member」按钮并确认。
 * 前提：当前 page URL 已经是 /family/member/g/{id} 详情页。
 * 确认后如遇 2FA 挑战会自动用 hostAccount.totp_secret 解开。
 */
async function clickRemoveAndConfirm(page, tag, wlog, hostAccount) {
    const warn = (m) => wlog && wlog.warn && wlog.warn(`${tag} ${m}`);
    const log = (m) => wlog && wlog.info && wlog.info(`${tag} ${m}`);

    const beforeUrl = page.url();

    // ========== Step 2: 找并标记「Remove member」/「Cancel invitation」按钮，用 CDP 真实点击 ==========
    // Material Design 按钮靠 pointerdown/pointerup，DOM 的 .click() 触发不了。
    // 必须用 ElementHandle.click() 走 CDP 发真实鼠标事件。
    const REMOVE_BTN_MARK = 'data-auto-remove-btn';
    const step2mark = await page.evaluate((attr) => {
        document.querySelectorAll(`[${attr}]`).forEach(el => el.removeAttribute(attr));
        const STRONG = [
            /remove.*member/i, /remove.*from.*family/i, /remove.*family.*group/i,
            /cancel.*invit/i, /revoke.*invit/i, /withdraw.*invit/i,
            /从家庭.*(移除|移出|删除)/, /(移除|移出|删除).*家庭.*成员/,
            /取消邀请/, /撤销邀请/,
        ];
        const WEAK = [
            /^\s*remove\s*member\s*$/i, /^\s*remove\s*$/i, /^\s*cancel\s*$/i,
            /^移除成员$/, /^移除$/, /^删除成员$/, /^取消$/,
        ];
        const visible = (el) => {
            const r = el.getBoundingClientRect();
            const s = window.getComputedStyle(el);
            return r.width > 20 && r.height > 10 &&
                   s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0';
        };
        const matchAny = (s, patterns) => patterns.some(p => p.test(s));
        const clickables = document.querySelectorAll('button, a, [role="button"], [role="menuitem"]');

        for (const el of clickables) {
            if (!visible(el)) continue;
            if (el.closest('[role="dialog"], [role="alertdialog"]')) continue;
            const t = (el.textContent || '').trim();
            const aria = el.getAttribute('aria-label') || '';
            if (matchAny(t, STRONG) || matchAny(aria, STRONG)) {
                el.setAttribute(attr, '1');
                el.scrollIntoView({ block: 'center' });
                return { ok: true, via: 'strong', text: t.substring(0, 80), aria: aria.substring(0, 80) };
            }
        }
        for (const el of clickables) {
            if (!visible(el)) continue;
            if (el.closest('[role="dialog"], [role="alertdialog"]')) continue;
            const t = (el.textContent || '').trim();
            const aria = el.getAttribute('aria-label') || '';
            if (matchAny(t, WEAK) || matchAny(aria, WEAK)) {
                el.setAttribute(attr, '1');
                el.scrollIntoView({ block: 'center' });
                return { ok: true, via: 'weak', text: t.substring(0, 80), aria: aria.substring(0, 80) };
            }
        }
        return { ok: false };
    }, REMOVE_BTN_MARK).catch(e => ({ ok: false, error: e.message }));

    if (!step2mark.ok) {
        warn(`clickRemove no matching button: ${JSON.stringify(step2mark)}`);
        await takeScreenshot(page, `remove_noremovebtn`, wlog);
        return false;
    }

    // CDP 真实点击
    const rmHandle = await page.$(`[${REMOVE_BTN_MARK}]`).catch(() => null);
    if (!rmHandle) {
        warn('clickRemove handle lost');
        await takeScreenshot(page, `remove_handlemiss`, wlog);
        return false;
    }
    try {
        await rmHandle.click({ delay: 50 });
    } catch (e) {
        warn(`clickRemove CDP click failed: ${e.message}; falling back to DOM click`);
        await page.evaluate((attr) => {
            const el = document.querySelector(`[${attr}]`);
            if (el) el.click();
        }, REMOVE_BTN_MARK).catch(() => { });
    } finally {
        await rmHandle.dispose().catch(() => { });
    }
    log(`clicked remove button (${step2mark.via}): "${step2mark.text || step2mark.aria}"`);
    await sleep(2500);

    // ========== Step 2.5: 点 Remove 后，检测是否直接跳到了 challenge / /family/remove ==========
    // Google 很多情况下「Remove member」点击不弹 dialog，而是**直接**走 POST → 跳 challenge 页。
    // 这时候跳过 step 3（没 dialog 可找），直接去 solveMidflowChallenge。
    const urlAfterRemove = page.url();
    const urlChanged = urlAfterRemove !== beforeUrl;
    const navigatedAway = /\/challenge\/|\/family\/remove\/|verifyit|verify-account|\/2sv/i.test(urlAfterRemove);

    log(`post-remove url=${urlAfterRemove.substring(0, 120)} changed=${urlChanged} navigatedAway=${navigatedAway}`);

    if (navigatedAway) {
        log(`skipping step 3 (no dialog expected) — going straight to challenge solver`);
        await takeScreenshot(page, `remove_after_remove_click`, wlog);
        const solved = await solveMidflowChallenge(page, hostAccount, tag, wlog);
        if (!solved) {
            await takeScreenshot(page, `remove_challenge_unsolved`, wlog);
            return false;
        }
        await sleep(2000);
        return await clickFinalRemoveConfirmIfAny(page, tag, hostAccount, wlog);
    }

    // ========== Step 3: 确认对话框（仅当 step 2.5 未导航离开时） ==========
    // 关键：只在 role=dialog 作用域内搜，避免在 document 上误点回"Remove member"自身。
    const step3 = await page.evaluate(() => {
        const dialog = document.querySelector('[role="dialog"], [role="alertdialog"]');
        if (!dialog) return { ok: false, reason: 'no_dialog' };
        const buttons = dialog.querySelectorAll('button, [role="button"]');
        const CONFIRM = [
            /^\s*remove\s*$/i, /^\s*delete\s*$/i, /^\s*confirm\s*$/i, /^\s*ok\s*$/i, /^\s*yes\s*$/i,
            /^\s*cancel.*invit/i,
            /^移除$/, /^删除$/, /^确认$/, /^确定$/, /^是$/, /^取消邀请$/,
            /remove from family/i,
        ];
        const visible = (el) => {
            const r = el.getBoundingClientRect();
            const s = window.getComputedStyle(el);
            return r.width > 20 && r.height > 10 &&
                   s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0';
        };
        for (const btn of buttons) {
            if (!visible(btn)) continue;
            const t = (btn.textContent || '').trim();
            if (!t) continue;
            if (CONFIRM.some(p => p.test(t))) {
                btn.scrollIntoView({ block: 'center' });
                btn.click();
                return { ok: true, text: t.substring(0, 80) };
            }
        }
        return { ok: false, reason: 'no_confirm_btn_in_dialog' };
    }).catch(e => ({ ok: false, error: e.message }));

    if (!step3.ok) {
        // step 2.5 没导航 + 没 dialog = 点击没触发任何反应，或者页面结构变了
        warn(`step 3 no confirm dialog: ${JSON.stringify(step3)} (url=${page.url().substring(0, 100)})`);
        await takeScreenshot(page, `remove_noconfirm`, wlog);
        // 即使这里找不到 dialog，也尝试继续 solve challenge —— 万一导航延迟了
        const solved = await solveMidflowChallenge(page, hostAccount, tag, wlog);
        if (!solved) return false;
        return await clickFinalRemoveConfirmIfAny(page, tag, hostAccount, wlog);
    }
    log(`confirmed in dialog: "${step3.text}"`);

    // 点完确认等页面稳定 1.5s，然后打一张截图看 Google 跳到哪（debug 用）
    await sleep(1500);
    log(`post-confirm url=${page.url().substring(0, 120)}`);
    await takeScreenshot(page, `remove_after_confirm`, wlog);

    // 检测并解开 2FA/verify-it's-you 挑战
    const solved = await solveMidflowChallenge(page, hostAccount, tag, wlog);
    if (!solved) {
        await takeScreenshot(page, `remove_challenge_unsolved`, wlog);
        return false;
    }
    await sleep(2000);

    // 到这里可能在 /family/remove/g/{id} 最终确认页，还要点一次 Remove
    const finalOk = await clickFinalRemoveConfirmIfAny(page, tag, hostAccount, wlog);
    return finalOk;
}

/**
 * TOTP 验证通过后有时会落到 /family/remove/g/{id}?rapt=... 页面，这是 Google 的
 * 最终二次确认页，上面还有一个单独的 Remove 按钮。不点它成员就不会真正被移除。
 *
 * 此函数循环处理：只要当前 URL 还是 /family/remove/ 就找按钮 + CDP 点 + 等导航；
 * 最多循环 2 次（防止死循环）。
 */
async function clickFinalRemoveConfirmIfAny(page, tag, hostAccount, wlog) {
    const warn = (m) => wlog && wlog.warn && wlog.warn(`${tag} ${m}`);
    const log = (m) => wlog && wlog.info && wlog.info(`${tag} ${m}`);

    for (let attempt = 0; attempt < 3; attempt++) {
        const url = page.url();
        if (!/\/family\/remove\//i.test(url)) {
            log(`final-confirm: already past /family/remove/ (url=${url.substring(0, 100)})`);
            return true;
        }
        log(`final-confirm page detected (attempt ${attempt + 1}): ${url.substring(0, 120)}`);
        await takeScreenshot(page, `remove_final_before_${attempt}`, wlog);

        const MARK = 'data-final-remove-btn';
        const marked = await page.evaluate((attr) => {
            document.querySelectorAll(`[${attr}]`).forEach(el => el.removeAttribute(attr));
            const PATTERNS = [
                /^\s*remove\s*$/i,
                /^\s*remove\s*member\s*$/i,
                /^\s*confirm\s*$/i,
                /remove.*family.*member/i,
                /remove from family/i,
                /^移除$/,
                /^确认$/, /^确定$/,
                /^移除成员$/, /^移除家庭成员$/,
            ];
            const visible = (el) => {
                const r = el.getBoundingClientRect();
                const s = window.getComputedStyle(el);
                return r.width > 20 && r.height > 10 &&
                       s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0';
            };
            for (const el of document.querySelectorAll('button, a, [role="button"]')) {
                if (!visible(el)) continue;
                const t = (el.textContent || '').trim();
                if (!t) continue;
                if (PATTERNS.some(p => p.test(t))) {
                    el.setAttribute(attr, '1');
                    el.scrollIntoView({ block: 'center' });
                    return { ok: true, text: t.substring(0, 80) };
                }
            }
            return { ok: false };
        }, MARK).catch(e => ({ ok: false, error: e.message }));

        if (!marked.ok) {
            warn(`final-confirm no button found: ${JSON.stringify(marked)}`);
            await takeScreenshot(page, `remove_final_nobtn_${attempt}`, wlog);
            return false;
        }

        const h = await page.$(`[${MARK}]`).catch(() => null);
        if (!h) {
            warn(`final-confirm handle lost`);
            return false;
        }
        try { await h.click({ delay: 50 }); }
        catch (e) {
            warn(`final-confirm CDP click failed: ${e.message}; falling back to DOM click`);
            await page.evaluate((attr) => document.querySelector(`[${attr}]`)?.click(), MARK).catch(() => { });
        } finally {
            await h.dispose().catch(() => { });
        }
        log(`final-confirm clicked: "${marked.text}"`);
        await sleep(3500);

        // 点完可能再次跳到 challenge（极少但防御性）或直接到 /family/details
        const afterUrl = page.url();
        log(`final-confirm post-click url=${afterUrl.substring(0, 120)}`);
        if (/\/challenge\/|verifyit|verify-account|\/2sv/i.test(afterUrl)) {
            log(`final-confirm triggered another challenge; solving`);
            const solved = await solveMidflowChallenge(page, hostAccount, tag, wlog);
            if (!solved) return false;
            await sleep(2000);
        }
        // 回到循环顶 check URL —— 如果不再是 /family/remove/ 就退出
    }

    warn(`final-confirm loop exceeded max attempts, still on /family/remove/`);
    return false;
}

const EMAIL_RE = /([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/g;

/**
 * 抓取当前 detail 页面上显示的成员 email（带 data-email 属性或 text node）。
 */
async function extractDetailEmail(page) {
    return page.evaluate((emailPattern) => {
        const re = new RegExp(emailPattern);
        // 优先从 main content 区域找
        const main = document.querySelector('main, [role="main"]') || document.body;
        const text = main.innerText || '';
        const m = text.match(re);
        return m ? m[0].toLowerCase() : null;
    }, EMAIL_RE.source).catch(() => null);
}

/**
 * 在 Google Family 页面上移除指定 email 的成员。
 *
 * 策略（兼容两种成员形态）：
 *   A. 列表页**已直接显示邮箱**（pending invite）→ 直接找 text 含该邮箱的 <a>，点进详情
 *   B. 列表页**只显示姓名**（joined member）→ 枚举所有 <a href="family/member/..."> 逐个
 *      visit detail 页 → 比对 detail 页显示的邮箱 → 匹配则执行移除动作
 *
 * 两种情况到达详情页后都走同样的「Remove member / 确认」流程。
 */
async function removeFamilyMember(page, memberEmail, wlog, opts = {}) {
    const tag = `[removeFamilyMember ${memberEmail}]`;
    const log = (m) => wlog && wlog.info && wlog.info(`${tag} ${m}`);
    const warn = (m) => wlog && wlog.warn && wlog.warn(`${tag} ${m}`);
    const targetLower = memberEmail.toLowerCase();

    // ========== Fast path: 上层已经知道 href（来自 scrapeFamilyMembers 缓存） ==========
    if (opts.href) {
        const absUrl = opts.href.startsWith('http')
            ? opts.href
            : `https://myaccount.google.com/${opts.href.replace(/^\/+/, '')}`;
        log(`fast path via cached href: ${opts.href}`);
        await page.goto(absUrl, { waitUntil: 'networkidle2', timeout: 20000 }).catch(() => { });
        await sleep(2500);
        const ok = await clickRemoveAndConfirm(page, tag, wlog, opts.hostAccount);
        await page.goto(FAMILY_URL, { waitUntil: 'networkidle2', timeout: 20000 }).catch(() => { });
        await sleep(1500);
        return ok;
    }

    // 确保在 family 列表页
    if (!/\/family\/details/.test(page.url())) {
        await page.goto(FAMILY_URL, { waitUntil: 'networkidle2', timeout: 20000 }).catch(() => { });
        await sleep(2000);
    }

    // ========== 策略 A：列表页已有该 email（pending invite） ==========
    const fastAnchor = await page.evaluate((emailLower) => {
        const anchors = document.querySelectorAll('a[href*="family/"]');
        for (const a of anchors) {
            const t = (a.textContent || '').toLowerCase();
            if (t.includes(emailLower)) {
                a.setAttribute('data-rm-fast-target', '1');
                return { found: true, href: a.getAttribute('href') };
            }
        }
        return { found: false };
    }, targetLower).catch(() => ({ found: false }));

    if (fastAnchor.found) {
        log(`strategy A: found direct anchor on list page, href=${fastAnchor.href}`);
        const h = await page.$('[data-rm-fast-target]').catch(() => null);
        if (h) {
            try { await h.click({ delay: 40 }); }
            catch (_) {
                await page.evaluate(() => document.querySelector('[data-rm-fast-target]')?.click()).catch(() => { });
            }
            await h.dispose().catch(() => { });
        }
        await sleep(3500);
        const ok = await clickRemoveAndConfirm(page, tag, wlog, opts.hostAccount);
        await page.goto(FAMILY_URL, { waitUntil: 'networkidle2', timeout: 20000 }).catch(() => { });
        await sleep(2000);
        return ok;
    }

    // ========== 策略 B：列表页只有姓名（joined member）→ 枚举 visit detail 查邮箱 ==========
    log('strategy B: enumerating member anchors to match by detail-page email');
    const anchors = await page.evaluate(() => {
        const set = new Map();
        for (const a of document.querySelectorAll('a[href*="family/member"]')) {
            const href = a.getAttribute('href') || '';
            if (!href) continue;
            // textContent 第一段通常是姓名；避免 "Family manager" 的 row
            const text = (a.textContent || '').trim();
            if (/family manager|家庭管理员/i.test(text)) continue;
            if (!set.has(href)) set.set(href, text.substring(0, 100));
        }
        return Array.from(set.entries()).map(([href, text]) => ({ href, text }));
    }).catch(() => []);

    log(`strategy B: ${anchors.length} member anchor(s) to inspect`);
    if (!anchors.length) {
        warn('no member anchors on family page; nothing to try');
        await takeScreenshot(page, `remove_no_anchors_${memberEmail}`, wlog);
        return false;
    }

    for (const { href, text } of anchors) {
        const absUrl = href.startsWith('http')
            ? href
            : `https://myaccount.google.com/${href.replace(/^\/+/, '')}`;
        log(`strategy B: visiting ${text} (${href})`);
        await page.goto(absUrl, { waitUntil: 'networkidle2', timeout: 20000 }).catch(() => { });
        await sleep(2500);

        const detailEmail = await extractDetailEmail(page);
        if (!detailEmail) {
            log(`  detail page has no parseable email; skipping`);
            continue;
        }
        if (detailEmail !== targetLower) {
            log(`  detail email=${detailEmail} (no match)`);
            continue;
        }
        log(`  detail email matches target — removing`);
        const ok = await clickRemoveAndConfirm(page, tag, wlog, opts.hostAccount);
        await page.goto(FAMILY_URL, { waitUntil: 'networkidle2', timeout: 20000 }).catch(() => { });
        await sleep(2000);
        if (ok) log('removal succeeded');
        else warn('remove button/confirm step failed');
        return ok;
    }

    warn(`target email ${memberEmail} not matched on any member detail page`);
    return false;
}

async function reconcileHost(hostRecord, browser, runId, wlog, options = {}) {
    if (hostRecord.disabled) {
        wlog && wlog.info && wlog.info(`reconcile: skip disabled host ${hostRecord.email}`);
        return { changes: [] };
    }
    await clearBrowserSession(browser, wlog);
    const page = await newPage(browser);
    try {
        wlog && wlog.info && wlog.info(`reconcile: login host ${hostRecord.email}`);
        await page.goto('https://accounts.google.com/signin', { waitUntil: 'networkidle2', timeout: 30000 }).catch(() => { });
        await googleLogin(page, {
            email: hostRecord.email,
            pass: hostRecord.password,
            recovery: hostRecord.recovery_email || '',
            totp_secret: hostRecord.totp_secret || undefined,
        }, wlog);
        await sleep(2000);

        // ========== 1. 预加载决策输入（避免每个成员重复查 DB） ==========
        try {
            const syncResult = await antigravitySync.syncFromRemote();
            wlog && wlog.info && wlog.info(`reconcile sync: matched=${syncResult.matched} newly_disabled=${syncResult.newly_disabled.length}`);
        } catch (e) {
            wlog && wlog.warn && wlog.warn(`reconcile sync failed: ${e.message}`);
        }

        const toRemoveByDisabled = await membersDb.listMembersNeedingFamilyRemoval(hostRecord.id);
        const disabledByEmail = new Map(toRemoveByDisabled.map(m => [m.email.toLowerCase(), m]));

        let knownSet = null;
        if (options.removeUnknown) {
            const localMembers = await membersDb.listMembers({ hostId: hostRecord.id, pageSize: 10000 });
            knownSet = new Set([hostRecord.email.toLowerCase(), ...localMembers.map(m => m.email.toLowerCase())]);
        }

        // hostAccount 供 clickRemoveAndConfirm 遇到 2FA 挑战时用
        const hostAccount = {
            email: hostRecord.email,
            password: hostRecord.password,
            recovery_email: hostRecord.recovery_email || '',
            totp_secret: hostRecord.totp_secret || undefined,
        };

        // ========== 2. 列表页枚举所有 anchor ==========
        await page.goto(FAMILY_URL, { waitUntil: 'networkidle2', timeout: 30000 }).catch(() => { });
        await sleep(2000);

        const anchorInfo = await page.evaluate(() => {
            const out = [];
            const seen = new Set();
            for (const a of document.querySelectorAll('a[href*="family/"]')) {
                const href = a.getAttribute('href') || '';
                if (!href || seen.has(href)) continue;
                if (!/family\/(member|invit)/i.test(href)) continue;
                seen.add(href);
                const text = (a.textContent || '').trim();
                if (/family manager|家庭管理员/i.test(text)) continue;
                const emailMatch = text.match(/([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/);
                out.push({
                    href, text: text.substring(0, 120),
                    listPageEmail: emailMatch ? emailMatch[1].toLowerCase() : null,
                });
            }
            return out;
        }).catch(() => []);

        wlog && wlog.info && wlog.info(`reconcile: ${anchorInfo.length} family anchor(s) on list page`);

        // ========== 3. 一次性遍历：visit detail → 决策 → 当场移除 ==========
        const seenEmails = [];  // 用于末尾 reconcileAgainstDB
        const removedCount = { disabled: 0, unknown: 0, failed: 0 };

        for (const info of anchorInfo) {
            let email = info.listPageEmail;
            let onDetailPage = false;
            const absUrl = info.href.startsWith('http')
                ? info.href
                : `https://myaccount.google.com/${info.href.replace(/^\/+/, '')}`;

            if (!email) {
                // joined member: 必须 visit detail 拿邮箱
                await page.goto(absUrl, { waitUntil: 'networkidle2', timeout: 20000 }).catch(() => { });
                await sleep(2500);
                email = await extractDetailEmail(page);
                onDetailPage = true;
            }

            if (!email) {
                wlog && wlog.warn && wlog.warn(`reconcile: could not extract email for ${info.href} (text="${info.text}")`);
                if (onDetailPage) {
                    await page.goto(FAMILY_URL, { waitUntil: 'networkidle2', timeout: 20000 }).catch(() => { });
                    await sleep(1500);
                }
                continue;
            }

            seenEmails.push(email);

            const emailLower = email.toLowerCase();
            const disabledLocal = disabledByEmail.get(emailLower);
            const isUnknown = knownSet && !knownSet.has(emailLower);

            if (!disabledLocal && !isUnknown) {
                // 保留：不需要动。如果在详情页就回去列表
                if (onDetailPage) {
                    await page.goto(FAMILY_URL, { waitUntil: 'networkidle2', timeout: 20000 }).catch(() => { });
                    await sleep(1500);
                }
                continue;
            }

            // 需要移除
            const reason = disabledLocal ? 'platform disabled' : 'unknown';
            const tag = `[remove ${email}/${reason}]`;
            wlog && wlog.info && wlog.info(`${tag} will remove from ${hostRecord.email}'s family`);

            if (!onDetailPage) {
                await page.goto(absUrl, { waitUntil: 'networkidle2', timeout: 20000 }).catch(() => { });
                await sleep(2500);
            }

            const ok = await clickRemoveAndConfirm(page, tag, wlog, hostAccount);

            if (!ok) {
                wlog && wlog.warn && wlog.warn(`${tag} remove UI failed, will retry next round`);
                removedCount.failed++;
            } else if (disabledLocal) {
                // 删平台记录 + 更新本地 DB
                const agId = disabledLocal.antigravity && disabledLocal.antigravity.id;
                if (agId) {
                    try { await antigravityClient.deleteAccount(agId); }
                    catch (e) { wlog && wlog.warn && wlog.warn(`DELETE platform ${agId} failed: ${e.message}`); }
                }
                await membersDb.markRemovedFromFamily(disabledLocal.id);
                await membersDb.updateAntigravity(disabledLocal.id, { id: null, disabled: false, disabled_reason: null });
                await eventsDb.logEvent({
                    memberId: disabledLocal.id, hostId: hostRecord.id, runId,
                    stage: 'reconcile', eventType: 'note',
                    message: `removed from family + antigravity (platform disabled: ${disabledLocal.antigravity?.disabled_reason || 'unknown'})`,
                });
                removedCount.disabled++;
            } else {
                // unknown
                await eventsDb.logEvent({
                    memberId: null, hostId: hostRecord.id, runId,
                    stage: 'reconcile', eventType: 'note',
                    message: `removed unknown family member: ${email}`,
                });
                removedCount.unknown++;
            }

            // 保证下一轮迭代从列表页开始
            if (!/\/family\/details/.test(page.url())) {
                await page.goto(FAMILY_URL, { waitUntil: 'networkidle2', timeout: 20000 }).catch(() => { });
                await sleep(1500);
            }
        }

        wlog && wlog.info && wlog.info(`reconcile: host ${hostRecord.email} — saw ${seenEmails.length} member(s), removed disabled=${removedCount.disabled} unknown=${removedCount.unknown} failed=${removedCount.failed}`);

        // 4. 对本地 DB 做最终 reconcile（本地有但 Google 没有的 joined/done → removed_from_family）
        return reconcileAgainstDB(hostRecord, seenEmails, runId);
    } finally {
        await page.close().catch(() => { });
        await clearBrowserSession(browser, wlog);
    }
}

module.exports = { scrapeFamilyMembers, reconcileAgainstDB, reconcileHost, computeUnknownEmails, FAMILY_URL };
