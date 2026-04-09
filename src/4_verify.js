/**
 * 阶段4 — 测试并验证 sub2api 上的账号
 *
 * 对 members.txt 里每个成员，用 accountName(host, member) 在 sub2api 上
 * 精确匹配账号，调 test 端点（默认 model: claude-sonnet-4-6）。
 *
 * 如果测试失败且 error 里包含 Google 的 validation_url（Vertex API 返回
 * 403 VALIDATION_REQUIRED 时给的二次认证链接），自动：
 *   1. clearBrowserSession
 *   2. googleLogin 该成员
 *   3. 打开 validation_url 并用 consent/TOTP poller 点击走完
 *   4. 重新调用 test 端点
 *
 * 阶段4 不创建账号 —— 跑之前需要先用阶段3 把账号注册好。
 *
 * CLI:
 *   node src/4_verify.js [-c N] [--model <id>] [--skip-validation] [--verbose]
 */

require('dotenv').config({ path: require('path').resolve(__dirname, '.env') });
const fs = require('fs');
const path = require('path');
const { log, createWorkerLogger, setVerbose, StepTimer } = require('./common/logger');
const {
    sleep, rand, findChrome, launchRealChrome, restartChrome,
    isChromeAlive, clearBrowserSession, newPage,
} = require('./common/chrome');
const { parseAccounts, addFailedRecord } = require('./common/state');
const { googleLogin } = require('./common/google-login');
const {
    accountName,
    parseSub2apiConfig,
    Sub2apiClient,
    completeValidationFlow,
} = require('./3_sub2api');

// ============ CLI 参数 ============
const args = process.argv.slice(2);
if (args.includes('--verbose') || args.includes('-v')) setVerbose(true);

function parseIntArg(names, fallback) {
    for (let i = 0; i < args.length; i++) {
        if (names.includes(args[i]) && args[i + 1]) {
            const n = parseInt(args[i + 1], 10);
            if (!Number.isNaN(n)) return n;
        }
    }
    return fallback;
}

function parseStrArg(name, fallback) {
    const i = args.indexOf(name);
    return (i >= 0 && args[i + 1]) ? args[i + 1] : fallback;
}

const CLI_OPTS = {
    concurrency: parseIntArg(['-c', '--concurrency'], parseInt(process.env.CONCURRENCY, 10) || 3),
    modelId: parseStrArg('--model', process.env.STAGE4_MODEL || 'claude-sonnet-4-6'),
    skipValidation: args.includes('--skip-validation'),
};

const HARD_TIMEOUT_MS = parseInt(process.env.STAGE4_HARD_TIMEOUT_MS, 10) || 300000;

// ============ 单 member 测试+验证编排 ============

async function verifyMember({ member, host, client, browser, workerId, opts }) {
    const wlog = createWorkerLogger(workerId);
    const timer = new StepTimer(wlog);
    const name = accountName(host.email, member.email);
    wlog.info(`>> verifyMember name=${name} email=${member.email}`);

    // 1. Find the account
    const account = await client.findAccountByName(name);
    timer.step('findAccountByName');
    if (!account) {
        wlog.warn(`  account not found on sub2api — run stage 3 first`);
        return { status: 'not_found' };
    }
    wlog.info(`  account found: id=${account.id} status=${account.status}`);

    // 2. First test (model: claude-sonnet-4-6 by default)
    let result = await client.testAccount(account.id, { modelId: opts.modelId });
    timer.step('testAccount');
    if (result.ok) {
        wlog.success(`  test passed on first try (id=${account.id})`);
        return { status: 'ok_first_try', accountId: account.id };
    }

    // 3. Test failed — inspect error
    if (!result.validationUrl) {
        const snippet = (result.error || '').slice(0, 300);
        wlog.warn(`  test failed, no validation URL (id=${account.id}). error: ${snippet}`);
        return { status: 'failed_no_url', accountId: account.id, error: result.error };
    }

    if (opts.skipValidation) {
        wlog.warn(`  validation URL present but --skip-validation set (id=${account.id})`);
        wlog.info(`  validation_url: ${result.validationUrl}`);
        return { status: 'skipped_validation', accountId: account.id, validationUrl: result.validationUrl };
    }

    // 4. Login as member and drive the validation flow
    wlog.info(`  validation required — logging in as member and running auto-verify`);
    await clearBrowserSession(browser, wlog);
    const page = await newPage(browser);
    try {
        await page.goto('https://accounts.google.com/signin', {
            waitUntil: 'domcontentloaded',
            timeout: 30000,
        }).catch(e => wlog.warn(`  signin nav warning: ${e.message}`));
        await sleep(1000);
        await googleLogin(page, member, wlog);
        timer.step('googleLogin');

        const verified = await completeValidationFlow(page, result.validationUrl, member, wlog);
        timer.step('completeValidationFlow');
        if (!verified) {
            wlog.warn(`  validation flow timed out (id=${account.id}) — non-fatal`);
            return { status: 'validation_stuck', accountId: account.id };
        }

        // 5. Re-test to confirm the account is usable now
        result = await client.testAccount(account.id, { modelId: opts.modelId });
        timer.step('testAccount (retry)');
        if (result.ok) {
            wlog.success(`  test passed after validation (id=${account.id})`);
            return { status: 'ok_after_verify', accountId: account.id };
        }
        const snippet = (result.error || '').slice(0, 300);
        wlog.warn(`  test still failing after validation (id=${account.id}): ${snippet}`);
        return { status: 'still_failing', accountId: account.id, error: result.error };
    } finally {
        await page.close().catch(() => { });
        await clearBrowserSession(browser, wlog).catch(() => { });
    }
}

// ============ main ============

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

function pairMembersWithHosts(hosts, members) {
    // 5 members per host by index — same convention as stage 1's buildGroups.
    const pairs = [];
    for (let i = 0; i < members.length; i++) {
        const hostIdx = Math.floor(i / 5);
        if (hostIdx >= hosts.length) {
            log(`  Dropping member[${i}] ${members[i].email}: no host (members > 5 * hosts.length)`, 'WARN');
            continue;
        }
        pairs.push({ member: members[i], host: hosts[hostIdx] });
    }
    return pairs;
}

async function main() {
    const repoRoot = path.resolve(__dirname, '..');
    const sub2apiFile = path.join(repoRoot, 'sub2api.txt');
    const hostsFile = path.join(repoRoot, 'hosts.txt');
    const membersFile = path.join(repoRoot, 'members.txt');

    const cfg = parseSub2apiConfig(sub2apiFile);
    const client = new Sub2apiClient(cfg.url, cfg.apiKey);

    const hosts = parseAccounts(hostsFile);
    const members = parseAccounts(membersFile);
    const pending = pairMembersWithHosts(hosts, members);

    const chromePath = findChrome();
    if (!chromePath) { console.error('Chrome not found'); process.exit(1); }

    log('');
    log('='.repeat(60));
    log('  Stage 4: Verify Accounts on sub2api');
    log('='.repeat(60));
    log(`  sub2api URL:  ${cfg.url}`);
    log(`  Hosts:        ${hostsFile}`);
    log(`  Members:      ${membersFile}`);
    log(`  Pending:      ${pending.length}`);
    log(`  Concurrency:  ${CLI_OPTS.concurrency}`);
    log(`  Model:        ${CLI_OPTS.modelId}`);
    log(`  Skip validate:${CLI_OPTS.skipValidation}`);
    log('='.repeat(60));
    log('');

    if (pending.length === 0) {
        log('No members to verify. Exiting.', 'SUCCESS');
        return;
    }

    // Launch workers
    const workers = _workers = [];
    for (let w = 0; w < Math.min(CLI_OPTS.concurrency, pending.length); w++) {
        try {
            const chrome = await launchRealChrome(chromePath, w);
            workers.push({ id: w, ...chrome });
            if (w < Math.min(CLI_OPTS.concurrency, pending.length) - 1) {
                await sleep(rand(2000, 3000));
            }
        } catch (e) {
            log(`Worker${w} launch failed: ${e.message}`, 'ERROR');
        }
    }
    if (workers.length === 0) {
        console.error('All Chrome instances failed to start');
        process.exit(1);
    }

    let idx = 0;
    const stats = {
        ok_first_try: 0,
        ok_after_verify: 0,
        still_failing: 0,
        failed_no_url: 0,
        not_found: 0,
        validation_stuck: 0,
        skipped_validation: 0,
        failed: 0,
    };

    async function workerFn(worker) {
        const wlog = createWorkerLogger(worker.id);
        while (true) {
            const myIdx = idx++;
            if (myIdx >= pending.length) break;
            const { member, host } = pending[myIdx];

            try {
                const alive = await isChromeAlive(worker);
                if (!alive) await restartChrome(chromePath, worker);

                const result = await Promise.race([
                    verifyMember({
                        member, host, client,
                        browser: worker.browser,
                        workerId: worker.id,
                        opts: CLI_OPTS,
                    }),
                    new Promise((_, rej) => setTimeout(
                        () => rej(new Error(`stage4_hard_timeout: exceeded ${HARD_TIMEOUT_MS / 1000}s`)),
                        HARD_TIMEOUT_MS
                    )),
                ]);

                if (stats[result.status] !== undefined) {
                    stats[result.status]++;
                } else {
                    wlog.warn(`  unknown result status: ${result.status}`);
                }
            } catch (e) {
                wlog.error(`verifyMember failed [${member.email}]: ${e.message}`);
                stats.failed++;
                await addFailedRecord({
                    stage: 4,
                    memberEmail: member.email,
                    hostEmail: host.email,
                    reason: e.message,
                });
                if (/hard_timeout|Protocol error|Session closed|Target closed/i.test(e.message || '')) {
                    wlog.warn('  Restarting Chrome after hard failure...');
                    try { await restartChrome(chromePath, worker); } catch (re) {
                        wlog.error(`  Chrome restart failed: ${re.message}`);
                    }
                }
            }

            await sleep(rand(1000, 2000));
        }
    }

    await Promise.all(workers.map(w => workerFn(w)));
    cleanupWorkers(workers);

    log('');
    log('='.repeat(60));
    log('  Stage 4 Complete', 'SUCCESS');
    log(`  ok_first_try:     ${stats.ok_first_try}`);
    log(`  ok_after_verify:  ${stats.ok_after_verify}`);
    log(`  still_failing:    ${stats.still_failing}`);
    log(`  failed_no_url:    ${stats.failed_no_url}`);
    log(`  not_found:        ${stats.not_found}`);
    log(`  validation_stuck: ${stats.validation_stuck}`);
    log(`  skipped_validation:${stats.skipped_validation}`);
    log(`  failed:           ${stats.failed}`);
    log('='.repeat(60));
    log('');
}

if (require.main === module) {
    main().catch(e => {
        log(`Fatal: ${e.message}`, 'ERROR');
        if (e.stack) console.error(e.stack);
        process.exit(1);
    });
}
