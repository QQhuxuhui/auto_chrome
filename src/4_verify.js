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

// ============ Phase 1: HTTP-only test (no browser) ============

/**
 * Format milliseconds as a short human string: "1234ms" or "5.2s".
 */
function fmtMs(ms) {
    if (ms < 1000) return `${ms}ms`;
    return `${(ms / 1000).toFixed(1)}s`;
}

/**
 * Find the sub2api account for a member and run the test endpoint once.
 * Pure HTTP — does NOT launch Chrome, does NOT log into Google.
 */
async function phase1TestOne({ member, host, client, opts, tag }) {
    const name = accountName(host.email, member.email);
    log(`${tag} ▶ START  ${name}  <${member.email}>`);

    const t0 = Date.now();
    let account;
    try {
        account = await client.findAccountByName(name);
    } catch (e) {
        log(`${tag} ✗ FAIL   findAccountByName failed: ${e.message}`, 'ERROR');
        return { member, host, name, status: 'failed', error: e.message };
    }
    const t1 = Date.now();
    log(`${tag} ·  lookup: ${fmtMs(t1 - t0)} → ${account ? `id=${account.id} status=${account.status}` : 'NOT FOUND'}`);

    if (!account) {
        log(`${tag} ⚠ SKIP   account not registered on sub2api — run stage 3 first`, 'WARN');
        return { member, host, name, status: 'not_found' };
    }

    log(`${tag} ·  testing model=${opts.modelId} on id=${account.id}...`);
    const result = await client.testAccount(account.id, { modelId: opts.modelId });
    const t2 = Date.now();
    log(`${tag} ·  test:   ${fmtMs(t2 - t1)}`);

    if (result.ok) {
        log(`${tag} ✓ OK     id=${account.id} — ready to use (total ${fmtMs(t2 - t0)})`, 'SUCCESS');
        return { member, host, name, account, status: 'ok_first_try' };
    }

    if (result.validationUrl) {
        log(`${tag} ↻ VERIFY id=${account.id} — 403 VALIDATION_REQUIRED, will drive browser in phase 2`, 'WARN');
        log(`${tag} ·  validation_url: ${result.validationUrl.slice(0, 110)}...`);
        return {
            member, host, name, account,
            status: 'needs_validation',
            validationUrl: result.validationUrl,
            error: result.error,
        };
    }

    const snippet = (result.error || '').slice(0, 200);
    log(`${tag} ✗ FAIL   id=${account.id} — unrecoverable error (no validation URL)`, 'ERROR');
    log(`${tag} ·  error: ${snippet}`, 'ERROR');
    return {
        member, host, name, account,
        status: 'failed_no_url',
        error: result.error,
    };
}

/**
 * Run phase1TestOne on all members in parallel with a concurrency limit.
 * Order-preserving (results[i] matches pending[i]). Each in-flight test
 * gets a `[phase1 k/n]` tag where k is the overall completion counter so
 * logs stay readable even when interleaved.
 */
async function phase1TestAll(pending, client, opts, limit) {
    const results = new Array(pending.length);
    let next = 0;
    let completed = 0;
    const total = pending.length;

    async function worker() {
        while (true) {
            const i = next++;
            if (i >= total) return;
            const tag = `[phase1 ${String(i + 1).padStart(String(total).length, ' ')}/${total}]`;
            try {
                results[i] = await phase1TestOne({ ...pending[i], client, opts, tag });
            } catch (e) {
                log(`${tag} ✗ UNCAUGHT ${pending[i].member.email}: ${e.message}`, 'ERROR');
                results[i] = {
                    ...pending[i],
                    name: accountName(pending[i].host.email, pending[i].member.email),
                    status: 'failed',
                    error: e.message,
                };
            }
            completed++;
            log(`[phase1] progress: ${completed}/${total} done`);
        }
    }

    const workerCount = Math.min(limit, pending.length);
    await Promise.all(Array.from({ length: workerCount }, worker));
    return results;
}

// ============ Phase 2: browser-side validation ============

/**
 * For a single member that needs validation: log into Google as the
 * member, drive completeValidationFlow, then re-test. Mutates the
 * `item.status` in-place from 'needs_validation' to one of:
 *   'ok_after_verify' | 'still_failing' | 'validation_stuck'
 */
async function phase2VerifyOne(item, { client, browser, workerId, opts }) {
    const wlog = createWorkerLogger(workerId);
    const timer = new StepTimer(wlog);
    wlog.info(`>> [phase2] ${item.name} (id=${item.account.id})`);

    await clearBrowserSession(browser, wlog);
    const page = await newPage(browser);
    try {
        await page.goto('https://accounts.google.com/signin', {
            waitUntil: 'domcontentloaded',
            timeout: 30000,
        }).catch(e => wlog.warn(`  [phase2] signin nav warning: ${e.message}`));
        await sleep(1000);
        await googleLogin(page, item.member, wlog);
        timer.step('googleLogin');

        const verified = await completeValidationFlow(page, item.validationUrl, item.member, wlog);
        timer.step('completeValidationFlow');
        if (!verified) {
            wlog.warn(`  [phase2] validation flow timed out (id=${item.account.id})`);
            item.status = 'validation_stuck';
            return;
        }

        const retry = await client.testAccount(item.account.id, { modelId: opts.modelId });
        timer.step('testAccount (retry)');
        if (retry.ok) {
            wlog.success(`  [phase2] test PASSED after validation (id=${item.account.id})`);
            item.status = 'ok_after_verify';
        } else {
            const snippet = (retry.error || '').slice(0, 200);
            wlog.warn(`  [phase2] test STILL FAILING after validation (id=${item.account.id}): ${snippet}`);
            item.status = 'still_failing';
            item.error = retry.error;
        }
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

    // ---------- Phase 1: pure HTTP test (no Chrome) ----------
    log('');
    log('─'.repeat(60));
    log(`  Phase 1 — HTTP test ${pending.length} accounts (no browser)`);
    log('─'.repeat(60));
    log(`  Model:       ${CLI_OPTS.modelId}`);
    log(`  Parallelism: up to ${Math.min(CLI_OPTS.concurrency, pending.length)} concurrent sub2api test calls`);
    log('─'.repeat(60));

    const p1Started = Date.now();
    const results = await phase1TestAll(pending, client, CLI_OPTS, CLI_OPTS.concurrency);
    const p1Elapsed = Date.now() - p1Started;

    const summary = {
        ok_first_try: 0,
        needs_validation: 0,
        failed_no_url: 0,
        not_found: 0,
        failed: 0,
    };
    for (const r of results) {
        if (summary[r.status] !== undefined) summary[r.status]++;
    }
    log('');
    log('─'.repeat(60));
    log(`  Phase 1 done in ${fmtMs(p1Elapsed)}`);
    log(`    ✓ ok_first_try     = ${summary.ok_first_try}  (ready to use)`);
    log(`    ↻ needs_validation = ${summary.needs_validation}  (will drive browser in phase 2)`);
    log(`    ✗ failed_no_url    = ${summary.failed_no_url}  (unrecoverable)`);
    log(`    ⚠ not_found        = ${summary.not_found}  (run stage 3 first)`);
    if (summary.failed) log(`    ✗ failed           = ${summary.failed}  (uncaught errors)`);
    log('─'.repeat(60));
    log('');

    // Record failed_no_url and not_found to failed.json
    for (const r of results) {
        if (r.status === 'failed_no_url' || r.status === 'failed') {
            await addFailedRecord({
                stage: 4,
                memberEmail: r.member.email,
                hostEmail: r.host.email,
                accountId: r.account?.id,
                reason: (r.error || 'unknown').slice(0, 500),
            });
        }
    }

    // ---------- Phase 2: browser-side validation (only for needs_validation) ----------
    const needsValidation = results.filter(r => r.status === 'needs_validation');

    if (needsValidation.length === 0) {
        log('[phase2] Nothing needs browser validation — skipping.');
    } else if (CLI_OPTS.skipValidation) {
        log(`[phase2] ${needsValidation.length} members need validation but --skip-validation set — skipping.`);
        for (const r of needsValidation) {
            r.status = 'skipped_validation';
            log(`  ${r.name}: validation_url = ${r.validationUrl}`);
        }
    } else {
        log(`[phase2] Launching browser workers for ${needsValidation.length} members needing validation...`);

        const chromePath = findChrome();
        if (!chromePath) { console.error('Chrome not found'); process.exit(1); }

        const workers = _workers = [];
        const workerCount = Math.min(CLI_OPTS.concurrency, needsValidation.length);
        for (let w = 0; w < workerCount; w++) {
            try {
                const chrome = await launchRealChrome(chromePath, w);
                workers.push({ id: w, ...chrome });
                if (w < workerCount - 1) await sleep(rand(2000, 3000));
            } catch (e) {
                log(`Worker${w} launch failed: ${e.message}`, 'ERROR');
            }
        }
        if (workers.length === 0) {
            console.error('All Chrome instances failed to start');
            process.exit(1);
        }

        let idx = 0;
        async function phase2Worker(worker) {
            const wlog = createWorkerLogger(worker.id);
            while (true) {
                const myIdx = idx++;
                if (myIdx >= needsValidation.length) break;
                const item = needsValidation[myIdx];
                try {
                    const alive = await isChromeAlive(worker);
                    if (!alive) await restartChrome(chromePath, worker);

                    await Promise.race([
                        phase2VerifyOne(item, {
                            client,
                            browser: worker.browser,
                            workerId: worker.id,
                            opts: CLI_OPTS,
                        }),
                        new Promise((_, rej) => setTimeout(
                            () => rej(new Error(`stage4_hard_timeout: exceeded ${HARD_TIMEOUT_MS / 1000}s`)),
                            HARD_TIMEOUT_MS
                        )),
                    ]);
                } catch (e) {
                    wlog.error(`phase2VerifyOne failed [${item.member.email}]: ${e.message}`);
                    item.status = 'failed';
                    item.error = e.message;
                    await addFailedRecord({
                        stage: 4,
                        memberEmail: item.member.email,
                        hostEmail: item.host.email,
                        accountId: item.account?.id,
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

        await Promise.all(workers.map(phase2Worker));
        cleanupWorkers(workers);
    }

    // ---------- Final stats ----------
    const final = {
        ok_first_try: 0,
        ok_after_verify: 0,
        still_failing: 0,
        failed_no_url: 0,
        not_found: 0,
        validation_stuck: 0,
        skipped_validation: 0,
        failed: 0,
    };
    for (const r of results) {
        if (final[r.status] !== undefined) final[r.status]++;
        else final.failed++;
    }

    log('');
    log('='.repeat(60));
    log('  Stage 4 Complete', 'SUCCESS');
    log(`  ok_first_try:      ${final.ok_first_try}`);
    log(`  ok_after_verify:   ${final.ok_after_verify}`);
    log(`  still_failing:     ${final.still_failing}`);
    log(`  failed_no_url:     ${final.failed_no_url}`);
    log(`  not_found:         ${final.not_found}`);
    log(`  validation_stuck:  ${final.validation_stuck}`);
    log(`  skipped_validation:${final.skipped_validation}`);
    log(`  failed:            ${final.failed}`);
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
