/**
 * 删除 host 账号下的所有家庭组成员（真实成员 + 未接受的邀请）
 *
 * 流程刻意写得松散：
 *  - 所有 Google 认证/reauth 一律交给 googleLogin 状态机处理
 *    （不预设是 pwd / TOTP / recovery email / phone SMS 里哪一种）
 *  - 按钮点击走 tryClickStrategies + 关键词列表（中英）
 *  - 每一步之后用 URL 校验是否到达预期，而不是盯着 DOM
 */

require('dotenv').config();
const path = require('path');
const { log, createWorkerLogger, setVerbose, StepTimer } = require('./common/logger');
const {
    sleep, rand, findChrome, launchRealChrome,
    clearBrowserSession, newPage, tryClickStrategies, takeScreenshot,
} = require('./common/chrome');
const { parseAccounts, addFailedRecord } = require('./common/state');
const { googleLogin } = require('./common/google-login');

// ============ CLI ============
const args = process.argv.slice(2);
if (args.includes('--verbose') || args.includes('-v')) setVerbose(true);

const DRY_RUN = args.includes('--dry-run');

// ============ 常量 ============
const FAMILY_URL = 'https://myaccount.google.com/family/details?utm_source=g1web&utm_medium=default';
const MEMBER_URL = id => `https://myaccount.google.com/family/member/${id.type}/${id.id}?utm_source=g1web&utm_medium=default`;

const REMOVE_KWS = [
    'remove member', 'remove from family', 'remove',
    '移除成员', '删除成员', '从家庭组中移除', '移除', '删除',
];
const CANCEL_INVITE_KWS = [
    'cancel invitation', 'cancel invite', 'cancel',
    '取消邀请', '撤销邀请', '取消',
];
const FINAL_CONFIRM_KWS = [
    'remove', 'cancel invitation', 'confirm', 'yes',
    '移除', '删除', '确认', '确定', '取消邀请',
];

// ============ 成员列表抓取 ============
// 返回 [{ type: 'g'|'i', id, label, isManager }]
// /family/details 内容通常在嵌套 iframe 里（account settings 标准布局），
// 所以要扫所有 frame，去重后返回。
async function listFamilyMembers(page) {
    const out = [];
    const seen = new Set();
    for (const frame of page.frames()) {
        const found = await frame.evaluate(() => {
            const res = [];
            for (const a of document.querySelectorAll('a[href]')) {
                const href = a.getAttribute('href') || '';
                // href 可能是绝对（/family/...）或相对（family/...）
                const m = href.match(/(?:^|\/)family\/member\/([gi])\/([-\d]+)/);
                if (!m) continue;
                const text = (a.textContent || '').replace(/\s+/g, ' ').trim();
                const isManager = /family manager|家庭组管理员|家庭管理员/i.test(text);
                res.push({
                    type: m[1],
                    id: m[2],
                    label: text.slice(0, 80),
                    isManager,
                });
            }
            return res;
        }).catch(() => []);
        for (const e of found) {
            const key = `${e.type}/${e.id}`;
            if (seen.has(key)) continue;
            seen.add(key);
            out.push(e);
        }
    }
    return out;
}

// ============ 诊断：list 为空时 dump 所有 frame 的关键信息 ============
async function dumpFamilyDiagnostics(page, wlog, round) {
    const frames = page.frames();
    wlog.warn(`  [diag r${round}] No members matched; dumping ${frames.length} frame(s)`);
    for (let i = 0; i < frames.length; i++) {
        const frame = frames[i];
        const info = await frame.evaluate(() => {
            const anchors = Array.from(document.querySelectorAll('a[href]'))
                .map(a => (a.getAttribute('href') || '').trim())
                .filter(h => h.includes('/family/') || h.includes('/member/'));
            const bodyText = (document.body ? document.body.innerText : '')
                .replace(/\s+/g, ' ').slice(0, 300);
            return { url: location.href, anchors: anchors.slice(0, 20), bodyText };
        }).catch(e => ({ error: e.message }));
        wlog.warn(`  [diag r${round}] frame[${i}] url=${info.url}`);
        wlog.warn(`  [diag r${round}] frame[${i}] body="${info.bodyText || info.error || ''}"`);
        for (const a of (info.anchors || [])) {
            wlog.warn(`  [diag r${round}] frame[${i}]   href=${a}`);
        }
    }
    await takeScreenshot(page, `delete_empty_list_r${round}`, wlog);
}

// ============ 通用：点完之后等 URL 变化 ============
async function waitForUrl(page, predicate, timeoutMs = 15000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        if (predicate(page.url())) return true;
        await sleep(500);
    }
    return false;
}

// ============ 通用：可能触发的 reauth ============
// 若当前页面是 accounts.google.com 的 challenge / identifier / pwd / totp 等，
// 就交给 googleLogin 把用户带回 continue URL。
async function maybeHandleReauth(page, hostAccount, wlog) {
    const url = page.url();
    if (!url.includes('accounts.google.com')) return false;
    wlog.info(`  reauth detected (${url.split('?')[0]}), delegating to googleLogin`);
    await googleLogin(page, hostAccount, wlog);
    // 登录成功后页面应跳回 continue URL（/family/... 等）
    await sleep(1000);
    return true;
}

// ============ 删除单个成员（或取消邀请） ============
async function removeOne(page, hostAccount, entry, wlog) {
    const isPending = entry.type === 'i';
    const verb = isPending ? 'cancel invite' : 'remove member';
    wlog.info(`  > ${verb}: ${entry.label} (${entry.type}/${entry.id})`);

    // Step 1: 进详情页
    await page.goto(MEMBER_URL(entry), { waitUntil: 'networkidle2', timeout: 30000 })
        .catch(e => wlog.warn(`    goto detail timeout: ${e.message}`));
    await sleep(1500);

    // Step 2: 点 Remove / Cancel
    const step1Kws = isPending ? CANCEL_INVITE_KWS : REMOVE_KWS;
    const urlBefore = page.url();
    const clicked = await tryClickStrategies(page, step1Kws, wlog, `${verb}_btn`);
    if (!clicked) {
        await takeScreenshot(page, `delete_no_${isPending ? 'cancel' : 'remove'}_btn_${entry.id}`, wlog);
        throw new Error(`Cannot find ${verb} button on detail page`);
    }

    // Step 3: 等 URL 变化 —— 可能跳到 reauth、也可能直接弹确认对话框（URL 不变）
    await waitForUrl(page, u => u !== urlBefore, 10000);
    await sleep(1500);

    // Step 4: 如果被拉到 accounts.google.com，让 login 状态机处理
    await maybeHandleReauth(page, hostAccount, wlog);

    // Step 5: 最终确认（可能是一个 dialog 里的 Remove / Cancel invitation 按钮）
    //          reauth 回来后 URL 形如 /family/remove/... 或 /family/details，
    //          /remove 页会显示确认对话框，/details 则说明后端已经直接处理了。
    for (let attempt = 0; attempt < 3; attempt++) {
        const u = page.url();
        if (u.includes('/family/details')) {
            // 已回到列表页，无需再点
            break;
        }
        const confirmed = await tryClickStrategies(page, FINAL_CONFIRM_KWS, wlog, 'final_confirm');
        if (confirmed) {
            await waitForUrl(page, u2 => u2.includes('/family/details'), 15000);
            break;
        }
        await sleep(1500);
    }

    // Step 6: 保险起见回列表页
    if (!page.url().includes('/family/details')) {
        await page.goto(FAMILY_URL, { waitUntil: 'networkidle2', timeout: 30000 })
            .catch(() => { });
        await sleep(1500);
    }

    wlog.success(`    done: ${entry.label}`);
}

// ============ 单 host 处理 ============
async function processHost(hostAccount, browser, workerId) {
    const wlog = createWorkerLogger(workerId);
    const timer = new StepTimer(wlog);

    wlog.info(`>> Host: ${hostAccount.email}`);
    await clearBrowserSession(browser, wlog);

    const page = await newPage(browser);

    try {
        // 1. 打开家庭页，通常会被拉去登录
        await page.goto(FAMILY_URL, { waitUntil: 'networkidle2', timeout: 30000 })
            .catch(e => wlog.warn(`  Page load timeout: ${e.message}`));
        timer.step('Open family page');

        // 2. 登录（状态机处理任意中间页）
        if (page.url().includes('accounts.google.com')) {
            await googleLogin(page, hostAccount, wlog);
            timer.step('Login');
            // 登录后回家庭页
            await page.goto(FAMILY_URL, { waitUntil: 'networkidle2', timeout: 30000 })
                .catch(e => wlog.warn(`  Post-login nav: ${e.message}`));
            await sleep(2000);
        }

        // 3. 循环清理：每轮重新抓 list，避开陈旧 DOM / 多成员之间的竞态
        const stats = { ok: 0, ng: 0 };
        for (let round = 0; round < 20; round++) {
            await page.goto(FAMILY_URL, { waitUntil: 'networkidle2', timeout: 30000 })
                .catch(() => { });
            await sleep(2000);

            // reauth 在导航过程中可能再次出现
            await maybeHandleReauth(page, hostAccount, wlog);

            wlog.debug(`  Round ${round + 1} URL: ${page.url()}`);
            wlog.debug(`  Round ${round + 1} frames: ${page.frames().length}`);

            const members = await listFamilyMembers(page);
            const victims = members.filter(m => !m.isManager);
            wlog.info(`  Round ${round + 1}: manager + ${victims.length} others (${members.length} total)`);

            if (members.length === 0) {
                // 诊断：打印所有 frame 里 /family 相关的 href，以及页面主要文本
                await dumpFamilyDiagnostics(page, wlog, round + 1);
            }

            if (victims.length === 0) {
                wlog.success('  Family group cleaned up');
                break;
            }

            const target = victims[0];
            if (DRY_RUN) {
                wlog.info(`  [dry-run] would ${target.type === 'i' ? 'cancel' : 'remove'}: ${target.label}`);
                stats.ok++;
                break; // 避免死循环
            }

            try {
                await removeOne(page, hostAccount, target, wlog);
                stats.ok++;
            } catch (e) {
                wlog.error(`    failed: ${e.message}`);
                stats.ng++;
                await addFailedRecord({
                    stage: 'delete',
                    hostEmail: hostAccount.email,
                    targetType: target.type,
                    targetId: target.id,
                    targetLabel: target.label,
                    reason: e.message,
                });
                // 失败就跳过，别让它把整轮卡死
                // 重新导航会把相同的 target 再拉出来 —— 这里用一个局部跳过集合避免无限重试
                victims[0]._skipped = true;
                // 如果所有剩余 target 都失败过，退出
                if (victims.every(v => v._skipped)) break;
            }

            await sleep(rand(1500, 3000));
        }

        wlog.info(`  Host ${hostAccount.email} stats: ok=${stats.ok} fail=${stats.ng}`);
        wlog.success(`>> Host done (${(timer.total() / 1000).toFixed(1)}s)`);
        return stats;
    } finally {
        await page.close().catch(() => { });
    }
}

// ============ cleanup ============
const keepBrowserOpen = (process.env.KEEP_BROWSER_OPEN || '').toLowerCase() === 'true';
let _workers = [];

function cleanupWorkers(workers) {
    for (const w of workers) {
        if (keepBrowserOpen) {
            try { w.browser.disconnect(); } catch (_) { }
        } else {
            try { w.browser.close(); } catch (_) { }
            try { w.proc.kill(); } catch (_) { }
        }
    }
    if (keepBrowserOpen && workers.length > 0) log('Browsers kept open (KEEP_BROWSER_OPEN=true)');
}

process.on('SIGINT', () => {
    log('\nInterrupted (Ctrl+C). Cleaning up...', 'WARN');
    cleanupWorkers(_workers);
    process.exit();
});

// ============ main ============
async function main() {
    const hostsFile = path.resolve(__dirname, '..', 'hosts.txt');
    const chromePath = findChrome();
    if (!chromePath) { console.error('Chrome not found'); process.exit(1); }

    log('');
    log(`${'='.repeat(60)}`);
    log(`  Delete Family Members`);
    log(`${'='.repeat(60)}`);
    log(`  Chrome: ${chromePath}`);
    log(`  Hosts:  ${hostsFile}`);
    log(`  Mode:   ${DRY_RUN ? 'DRY-RUN (no actual deletion)' : 'LIVE'}`);
    log(`${'='.repeat(60)}`);
    log('');

    const hosts = parseAccounts(hostsFile);
    log(`Parsed: ${hosts.length} hosts`);
    if (hosts.length === 0) { log('No host accounts found', 'ERROR'); process.exit(1); }

    const workers = _workers = [];
    try {
        const chrome = await launchRealChrome(chromePath, 0);
        workers.push({ id: 0, ...chrome });
    } catch (e) {
        log(`Chrome launch failed: ${e.message}`, 'ERROR');
        process.exit(1);
    }

    const totals = { ok: 0, ng: 0 };
    for (const host of hosts) {
        try {
            const s = await processHost(host, workers[0].browser, workers[0].id);
            totals.ok += s.ok;
            totals.ng += s.ng;
        } catch (e) {
            log(`Host ${host.email} fatal: ${e.message}`, 'ERROR');
            if (e.stack) console.error(e.stack);
            totals.ng++;
        }
    }

    cleanupWorkers(workers);

    log('');
    log(`${'='.repeat(60)}`);
    log(`  Delete Complete`, 'SUCCESS');
    log(`  OK: ${totals.ok}  FAIL: ${totals.ng}`);
    log(`${'='.repeat(60)}`);
    log('');
}

main().catch(e => {
    log(`Fatal: ${e.message}`, 'ERROR');
    if (e.stack) console.error(e.stack);
    process.exit(1);
});
