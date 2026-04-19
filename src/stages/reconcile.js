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

async function scrapeFamilyMembers(page, wlog) {
    await page.goto(FAMILY_URL, { waitUntil: 'networkidle2', timeout: 30000 }).catch(e =>
        wlog && wlog.warn && wlog.warn(`family page load: ${e.message}`));
    await sleep(2000);

    // Google Family UI renders email text inside each member row; exact DOM
    // classes are unstable — rely on text extraction + email regex filter.
    const emails = await page.evaluate(() => {
        const EMAIL_RE = /([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/g;
        const text = document.body ? document.body.innerText : '';
        const hits = new Set();
        let m;
        while ((m = EMAIL_RE.exec(text)) !== null) hits.add(m[1].toLowerCase());
        return Array.from(hits);
    }).catch(() => []);
    return emails;
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
 * 在 Google Family 页面上移除一个成员。
 *
 * Google Family 是 SPA，移除流程分 3 步：
 *   1. 点击成员行/链接 → 打开该成员的详情视图
 *   2. 在详情视图里点「从家庭组中移除」按钮
 *   3. 在确认对话框里点「移除」
 *
 * 每步失败都截图到 logs/screenshots/ 方便人工排查。
 */
async function removeFamilyMember(page, memberEmail, wlog) {
    const tag = `[removeFamilyMember ${memberEmail}]`;
    const log = (m) => wlog && wlog.info && wlog.info(`${tag} ${m}`);
    const warn = (m) => wlog && wlog.warn && wlog.warn(`${tag} ${m}`);

    // ========== Step 1: 打开该成员的详情视图 ==========
    // Google Family 的成员行通常是普通 <div>（无 role / 无 href），点击靠外层
    // 事件委托。用 DOM .click() 不可靠（只触发合成事件），要用 Puppeteer
    // ElementHandle.click() 走 CDP 派发真实 mousedown/mouseup。
    //
    // 策略：在 evaluate 里按 email 文本定位到**最内层**包含该邮箱的「卡片行」
    //   （避免匹配到整个文档），给它打 data-auto-remove-target 标记，
    //   然后回到 Node 侧用 page.$() + handle.click() 真实点击。
    const REMOVE_MARK = 'data-auto-remove-target';
    const beforeUrl = page.url();

    const step1mark = await page.evaluate((targetEmail, markAttr) => {
        // 清掉上轮残留
        document.querySelectorAll(`[${markAttr}]`).forEach(el => el.removeAttribute(markAttr));

        const lower = targetEmail.toLowerCase();

        // 找所有文本里直接含该 email 的元素，然后取「最深」的那个（即最具体的行）
        // 避免选中整个 document.body 之类的祖先
        const hits = [];
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        let node;
        while ((node = walker.nextNode())) {
            const t = String(node.nodeValue || '').toLowerCase();
            if (t.includes(lower)) {
                // 找能代表"一行"的祖先：向上走到有明显尺寸的元素
                let el = node.parentElement;
                while (el && el !== document.body) {
                    const r = el.getBoundingClientRect();
                    // 典型成员行：宽度 > 200, 高度 40-120
                    if (r.width > 200 && r.height >= 40 && r.height <= 200) {
                        hits.push({ el, width: r.width, height: r.height, depth: getDepth(el) });
                        break;
                    }
                    el = el.parentElement;
                }
            }
        }
        function getDepth(el) {
            let d = 0; let cur = el;
            while (cur && cur !== document.body) { d++; cur = cur.parentElement; }
            return d;
        }
        if (!hits.length) return { ok: false, reason: 'no_row_with_email' };
        // 取最深的（最内层，= 最精确的那个卡片）
        hits.sort((a, b) => b.depth - a.depth);
        const chosen = hits[0];
        chosen.el.setAttribute(markAttr, '1');
        chosen.el.scrollIntoView({ block: 'center' });
        return { ok: true, width: chosen.width, height: chosen.height, depth: chosen.depth };
    }, memberEmail, REMOVE_MARK).catch(e => ({ ok: false, error: e.message }));

    if (!step1mark.ok) {
        warn(`step 1 mark failed: ${JSON.stringify(step1mark)}`);
        await takeScreenshot(page, `remove_step1_notfound_${memberEmail}`, wlog);
        return false;
    }
    log(`step 1 marked row: ${step1mark.width}x${step1mark.height} @ depth=${step1mark.depth}`);

    // 用 ElementHandle.click 走 CDP 真实点击
    const handle = await page.$(`[${REMOVE_MARK}]`).catch(() => null);
    if (!handle) {
        warn('step 1 handle lost (mark removed during reflow?)');
        await takeScreenshot(page, `remove_step1_handlemiss_${memberEmail}`, wlog);
        return false;
    }
    try {
        await handle.click({ delay: 40 });
    } catch (e) {
        warn(`step 1 CDP click failed: ${e.message}`);
        // 兜底 DOM click
        await page.evaluate((attr) => {
            const el = document.querySelector(`[${attr}]`);
            if (el) el.click();
        }, REMOVE_MARK).catch(() => { });
    } finally {
        await handle.dispose().catch(() => { });
    }
    await sleep(3500);

    // 验证点击有效：URL 或 DOM 应该变了
    const afterUrl = page.url();
    const urlChanged = afterUrl !== beforeUrl;
    log(`step 1 clicked, url ${urlChanged ? 'changed' : 'unchanged'}: ${afterUrl}`);
    if (!urlChanged) {
        // URL 没变也可能是侧滑 drawer，再等一会看看有没有 remove/cancel 按钮出现
        await sleep(1500);
    }

    // ========== Step 2: 点「从家庭组中移除」或「取消邀请」按钮 ==========
    // pending invite 的按钮是 "Cancel invitation" / "取消邀请"；
    // full member 的按钮是 "Remove from family group" / "从家庭组中移除"
    const step2 = await page.evaluate(() => {
        // 强匹配优先：含明确短语
        const STRONG = [
            /remove.*from.*family/i,
            /remove.*family.*group/i,
            /remove.*member/i,
            /cancel.*invit/i,             // "Cancel invitation"
            /revoke.*invit/i,
            /withdraw.*invit/i,
            /从家庭.*(移除|移出|删除)/,
            /(移除|移出|删除).*家庭.*成员/,
            /将.*(移除|移出)/,
            /取消邀请/,
            /撤销邀请/,
        ];
        // 弱匹配：单独的 "Remove" / "Cancel" / "移除" 等
        const WEAK = [
            /^\s*remove\s*$/i,
            /^\s*cancel\s*$/i,
            /^移除$/,
            /^移除成员$/,
            /^删除成员$/,
            /^取消$/,
        ];

        const clickables = document.querySelectorAll('button, a, [role="button"], [role="menuitem"]');
        const visible = (el) => {
            const r = el.getBoundingClientRect();
            const s = window.getComputedStyle(el);
            return r.width > 20 && r.height > 10 &&
                   s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0';
        };
        const matchAny = (s, patterns) => patterns.some(p => p.test(s));

        // 先强匹配
        for (const el of clickables) {
            if (!visible(el)) continue;
            const t = (el.textContent || '').trim();
            const aria = el.getAttribute('aria-label') || '';
            if (matchAny(t, STRONG) || matchAny(aria, STRONG)) {
                el.scrollIntoView({ block: 'center' });
                el.click();
                return { ok: true, via: 'strong', text: t.substring(0, 80), aria: aria.substring(0, 80) };
            }
        }
        // 再弱匹配（避免误点 cancel 等）
        for (const el of clickables) {
            if (!visible(el)) continue;
            const t = (el.textContent || '').trim();
            const aria = el.getAttribute('aria-label') || '';
            if (matchAny(t, WEAK) || matchAny(aria, WEAK)) {
                // 排除 dialog 内的弱匹配（那是确认按钮，要 step 3 处理）
                if (el.closest('[role="dialog"], [role="alertdialog"]')) continue;
                el.scrollIntoView({ block: 'center' });
                el.click();
                return { ok: true, via: 'weak', text: t.substring(0, 80), aria: aria.substring(0, 80) };
            }
        }
        return { ok: false };
    }).catch(e => ({ ok: false, error: e.message }));

    if (!step2.ok) {
        warn(`step 2 failed (click remove): ${JSON.stringify(step2)}`);
        await takeScreenshot(page, `remove_step2_noremovebtn_${memberEmail}`, wlog);
        return false;
    }
    log(`step 2 clicked remove button (${step2.via}): "${step2.text || step2.aria}"`);
    await sleep(2500);

    // ========== Step 3: 确认对话框 ==========
    const step3 = await page.evaluate(() => {
        const dialog = document.querySelector('[role="dialog"], [role="alertdialog"]');
        const scope = dialog || document;
        const buttons = scope.querySelectorAll('button, [role="button"]');
        const CONFIRM = [
            /^\s*remove\s*$/i, /^\s*delete\s*$/i, /^\s*confirm\s*$/i, /^\s*ok\s*$/i, /^\s*yes\s*$/i,
            /^\s*cancel.*invit/i,  // "Cancel invitation" 作为确认按钮
            /^移除$/, /^删除$/, /^确认$/, /^确定$/, /^是$/,
            /^取消邀请$/,
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
                return { ok: true, text: t.substring(0, 80), inDialog: !!dialog };
            }
        }
        return { ok: false, hasDialog: !!dialog };
    }).catch(e => ({ ok: false, error: e.message }));

    if (!step3.ok) {
        warn(`step 3 failed (confirm): ${JSON.stringify(step3)}`);
        await takeScreenshot(page, `remove_step3_noconfirm_${memberEmail}`, wlog);
        return false;
    }
    log(`step 3 confirmed: "${step3.text}" (in dialog: ${step3.inDialog})`);
    await sleep(3500);

    // 回到 family 列表，保证下一次循环看到更新后的 DOM
    await page.goto(FAMILY_URL, { waitUntil: 'networkidle2', timeout: 20000 }).catch(() => { });
    await sleep(2500);

    log('flow complete');
    return true;
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
        const emails = await scrapeFamilyMembers(page, wlog);
        wlog && wlog.info && wlog.info(`reconcile: host ${hostRecord.email} has ${emails.length} family members`);

        // 先把远程状态同步到本地，确保下一步 listMembersNeedingFamilyRemoval 用最新数据
        try {
            const syncResult = await antigravitySync.syncFromRemote();
            wlog && wlog.info && wlog.info(`reconcile sync: matched=${syncResult.matched} newly_disabled=${syncResult.newly_disabled.length}`);
        } catch (e) {
            wlog && wlog.warn && wlog.warn(`reconcile sync failed: ${e.message}`);
        }

        // 对 host 下面所有 antigravity.disabled=true 的成员执行移除
        const toRemove = await membersDb.listMembersNeedingFamilyRemoval(hostRecord.id);
        const emailLowerSet = new Set(emails.map(e => e.toLowerCase()));
        for (const member of toRemove) {
            const stillInFamily = emailLowerSet.has(member.email.toLowerCase());
            if (!stillInFamily) {
                wlog && wlog.info && wlog.info(`${member.email} already absent from family, cleaning local state`);
            } else {
                wlog && wlog.info && wlog.info(`removing ${member.email} from ${hostRecord.email}'s family (disabled on platform)`);
                const ok = await removeFamilyMember(page, member.email, wlog);
                if (!ok) {
                    wlog && wlog.warn && wlog.warn(`skip ${member.email}: removal UI failed, will retry next round`);
                    continue;
                }
            }
            const agId = member.antigravity && member.antigravity.id;
            if (agId) {
                try {
                    await antigravityClient.deleteAccount(agId);
                } catch (e) {
                    wlog && wlog.warn && wlog.warn(`DELETE platform ${agId} failed: ${e.message}`);
                }
            }
            await membersDb.markRemovedFromFamily(member.id);
            await membersDb.updateAntigravity(member.id, { id: null, disabled: false, disabled_reason: null });
            await eventsDb.logEvent({
                memberId: member.id, hostId: hostRecord.id, runId,
                stage: 'reconcile', eventType: 'note',
                message: `removed from family + antigravity (platform disabled: ${member.antigravity?.disabled_reason || 'unknown'})`,
            });
        }

        // 可选：删除「未知」家庭成员（不在本地 DB 的、也不是 host 自己的）
        if (options.removeUnknown) {
            const localMembers = await membersDb.listMembers({ hostId: hostRecord.id, pageSize: 10000 });
            const unknown = computeUnknownEmails(emails, localMembers, hostRecord.email);
            wlog && wlog.info && wlog.info(`removeUnknown: ${unknown.length} unknown email(s) on ${hostRecord.email}'s family`);
            for (const email of unknown) {
                wlog && wlog.info && wlog.info(`removing unknown member ${email} from ${hostRecord.email}'s family`);
                const ok = await removeFamilyMember(page, email, wlog);
                if (ok) {
                    await eventsDb.logEvent({
                        memberId: null, hostId: hostRecord.id, runId,
                        stage: 'reconcile', eventType: 'note',
                        message: `removed unknown family member: ${email}`,
                    });
                } else {
                    wlog && wlog.warn && wlog.warn(`failed to remove unknown member ${email}`);
                }
            }
        }

        return reconcileAgainstDB(hostRecord, emails, runId);
    } finally {
        await page.close().catch(() => { });
        await clearBrowserSession(browser, wlog);
    }
}

module.exports = { scrapeFamilyMembers, reconcileAgainstDB, reconcileHost, computeUnknownEmails, FAMILY_URL };
