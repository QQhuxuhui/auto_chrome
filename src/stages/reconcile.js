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
 * 在 Google Family 详情页点「Remove member」按钮并确认。
 * 前提：当前 page URL 已经是 /family/member/g/{id} 详情页。
 */
async function clickRemoveAndConfirm(page, tag, wlog) {
    const warn = (m) => wlog && wlog.warn && wlog.warn(`${tag} ${m}`);
    const log = (m) => wlog && wlog.info && wlog.info(`${tag} ${m}`);

    // 点「Remove member」/「Cancel invitation」/ 中文等价按钮
    const step2 = await page.evaluate(() => {
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
        const clickables = document.querySelectorAll('button, a, [role="button"], [role="menuitem"]');
        const matchAny = (s, patterns) => patterns.some(p => p.test(s));

        for (const el of clickables) {
            if (!visible(el)) continue;
            if (el.closest('[role="dialog"], [role="alertdialog"]')) continue;
            const t = (el.textContent || '').trim();
            const aria = el.getAttribute('aria-label') || '';
            if (matchAny(t, STRONG) || matchAny(aria, STRONG)) {
                el.scrollIntoView({ block: 'center' });
                el.click();
                return { ok: true, via: 'strong', text: t.substring(0, 80) };
            }
        }
        for (const el of clickables) {
            if (!visible(el)) continue;
            if (el.closest('[role="dialog"], [role="alertdialog"]')) continue;
            const t = (el.textContent || '').trim();
            const aria = el.getAttribute('aria-label') || '';
            if (matchAny(t, WEAK) || matchAny(aria, WEAK)) {
                el.scrollIntoView({ block: 'center' });
                el.click();
                return { ok: true, via: 'weak', text: t.substring(0, 80) };
            }
        }
        return { ok: false };
    }).catch(e => ({ ok: false, error: e.message }));

    if (!step2.ok) {
        warn(`clickRemove failed: ${JSON.stringify(step2)}`);
        await takeScreenshot(page, `remove_noremovebtn`, wlog);
        return false;
    }
    log(`clicked remove button (${step2.via}): "${step2.text}"`);
    await sleep(2500);

    // 确认对话框
    const step3 = await page.evaluate(() => {
        const dialog = document.querySelector('[role="dialog"], [role="alertdialog"]');
        const scope = dialog || document;
        const buttons = scope.querySelectorAll('button, [role="button"]');
        const CONFIRM = [
            /^\s*remove\s*$/i, /^\s*delete\s*$/i, /^\s*confirm\s*$/i, /^\s*ok\s*$/i, /^\s*yes\s*$/i,
            /^\s*cancel.*invit/i,
            /^移除$/, /^删除$/, /^确认$/, /^确定$/, /^是$/, /^取消邀请$/,
            /remove from family/i, /^remove member$/i,
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
        return { ok: false };
    }).catch(e => ({ ok: false, error: e.message }));

    if (!step3.ok) {
        warn(`confirm failed: ${JSON.stringify(step3)}`);
        await takeScreenshot(page, `remove_noconfirm`, wlog);
        return false;
    }
    log(`confirmed: "${step3.text}" (in dialog: ${step3.inDialog})`);
    await sleep(3500);
    return true;
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
async function removeFamilyMember(page, memberEmail, wlog) {
    const tag = `[removeFamilyMember ${memberEmail}]`;
    const log = (m) => wlog && wlog.info && wlog.info(`${tag} ${m}`);
    const warn = (m) => wlog && wlog.warn && wlog.warn(`${tag} ${m}`);
    const targetLower = memberEmail.toLowerCase();

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
        const ok = await clickRemoveAndConfirm(page, tag, wlog);
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
        const ok = await clickRemoveAndConfirm(page, tag, wlog);
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
