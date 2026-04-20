/**
 * stages/accept/index.js — runStage2 orchestration.
 *
 * Per host (sequential):
 *   1. Launch host-monitor Chrome (separate user-data-dir + debug port)
 *   2. HostMonitor.start() — login + initial calibration scrape
 *   3. Launch member worker Chromes per concurrency
 *   4. Member loop: for each member of this host,
 *      run acceptInvite → awaitHostConfirmation(2min) → decide → write DB+event
 *   5. Final scrape (one extra poll tick)
 *   6. Stop monitor + teardown member workers
 *
 * Inter-host boundary: fully tear down before starting the next host.
 */
const path = require('path');
const { log, createWorkerLogger } = require('../../common/logger');
const {
    sleep, rand, findChrome, launchRealChrome, restartChrome,
    isChromeAlive, newPage,
} = require('../../common/chrome');
const { googleLogin } = require('../../common/google-login');
const hostsDb = require('../../db/hosts');
const membersDb = require('../../db/members');
const eventsDb = require('../../db/events');

const { acceptInvite } = require('./member-worker');
const { HostMonitor, awaitHostConfirmation } = require('./host-monitor');
const { scrapeFamilyListPage, FAMILY_URL } = require('./family-scrape-fast');
const { decide } = require('./decide');
const { scrapeFamilyMembers } = require('../reconcile');

const HOST_MONITOR_GRACE_MS = parseInt(process.env.HOST_MONITOR_GRACE_MS, 10) || 120_000;

async function launchHostMonitorChrome(chromePath, host) {
    const dataDir = path.resolve(__dirname, '..', '..', `chrome_data_temp_pipeline_H${host.id}`);
    const debugPort = (parseInt(process.env.DEBUG_PORT, 10) || 9234) + 100 + (host.id % 50);
    const chrome = await launchRealChrome(chromePath, 'H', { dataDir, debugPort });
    return chrome;
}

async function initialFamilyMap(page, wlog) {
    // Use reconcile's slow+thorough scraper once to establish {email → {status, href}}.
    const members = await scrapeFamilyMembers(page, wlog);
    const map = {};
    for (const m of members || []) {
        if (!m.email) continue;
        map[m.email.toLowerCase()] = {
            status: m.isPending ? 'pending' : 'joined',
            href: m.href,
            lastSeenAt: Date.now(),
        };
    }
    return map;
}

async function processOneMember(member, worker, hm, chromePath, wlog, runId) {
    const memberAccount = {
        idx: member.id, email: member.email, pass: member.password,
        recovery: member.recovery_email || '',
        totp_secret: member.totp_secret || undefined,
    };

    await eventsDb.logEvent({
        memberId: member.id, hostId: member.host_id, runId,
        stage: 'stage2', eventType: 'start',
    });

    let flowResult = null, flowError = null;
    try {
        const alive = await isChromeAlive(worker);
        if (!alive) await restartChrome(chromePath, worker);
        const hardTimeoutMs = parseInt(process.env.ACCEPT_HARD_TIMEOUT_MS, 10)
            || (parseInt(process.env.INVITE_WAIT_TIMEOUT, 10) || 300) * 1000 + 300_000;
        flowResult = await Promise.race([
            acceptInvite(memberAccount, worker.browser, worker.id),
            new Promise((_, rej) => setTimeout(() => rej(new Error(`hard_timeout ${hardTimeoutMs}ms`)), hardTimeoutMs)),
        ]);
    } catch (e) {
        flowError = e;
    }

    const hostStatus = await awaitHostConfirmation(hm, member.email.toLowerCase(), {
        timeoutMs: HOST_MONITOR_GRACE_MS,
    });

    const dec = decide({ flowResult, flowError, hostStatus });

    if (dec.finalStatus === 'done') {
        await membersDb.transitionToJoined(member.id);
    } else {
        await membersDb.transitionToFailed(member.id, {
            newStatus: 'accept_failed',
            error: dec.message || 'stage2 failed',
            releaseHost: false,
        });
    }
    await eventsDb.logEvent({
        memberId: member.id, hostId: member.host_id, runId,
        stage: 'stage2', eventType: dec.eventType, message: dec.message,
    });

    wlog.info(`  decide: ${member.email} → ${dec.finalStatus}/${dec.eventType}`);
    return dec;
}

async function runHostWithoutMonitor({ host, members, concurrency, runId, chromePath }) {
    const wlog = createWorkerLogger(`H${host.id}`);
    const workers = [];
    for (let w = 0; w < Math.min(concurrency, members.length); w++) {
        const wChrome = await launchRealChrome(chromePath, w);
        workers.push({ id: w, ...wChrome });
        if (w < concurrency - 1) await sleep(rand(2000, 3000));
    }
    const fakeHm = { state: {}, degraded: true, on() {}, off() {}, once() {} };
    let idx = 0;
    const stats = { ok: 0, ng: 0 };
    await Promise.all(workers.map(async (worker) => {
        const wl = createWorkerLogger(worker.id);
        while (true) {
            const i = idx++;
            if (i >= members.length) break;
            const m = members[i];
            try {
                const dec = await processOneMember(m, worker, fakeHm, chromePath, wl, runId);
                if (dec.finalStatus === 'done') stats.ok++; else stats.ng++;
            } catch (e) {
                wl.error(`Stage2 [${m.email}]: ${e.message}`);
                stats.ng++;
            }
            await sleep(rand(1000, 2000));
        }
    }));
    for (const w of workers) {
        try { w.browser.close(); } catch (_) {}
        try { w.proc.kill(); } catch (_) {}
    }
    return stats;
}

async function processOneHost({ host, members, concurrency, runId, chromePath }) {
    const wlog = createWorkerLogger(`H${host.id}`);
    wlog.info(`Stage2 host ${host.email}: ${members.length} pending member(s)`);

    let hmChrome;
    try {
        hmChrome = await launchHostMonitorChrome(chromePath, host);
    } catch (e) {
        wlog.warn(`Could not launch host monitor Chrome: ${e.message}; falling back to no-monitor mode`);
        return runHostWithoutMonitor({ host, members, concurrency, runId, chromePath });
    }

    const workers = [];
    let hm = null;
    try {
        const hmPage = await newPage(hmChrome.browser);
        const hostAccount = {
            email: host.email, pass: host.password,
            recovery: host.recovery_email || '',
            totp_secret: host.totp_secret || undefined,
        };
        hm = new HostMonitor({
            host,
            browser: hmChrome.browser,
            page: hmPage,
            loginFn: async (page) => {
                await googleLogin(page, hostAccount, wlog);
                await page.goto(FAMILY_URL, { waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {});
                const cal = await initialFamilyMap(page, wlog);
                Object.assign(hm.state, cal);
            },
            scrapeFn: async (page) => scrapeFamilyListPage(page, wlog),
            wlog,
            initialFamilyMap: {},
        });
        await hm.start();

        for (let w = 0; w < Math.min(concurrency, members.length); w++) {
            const wChrome = await launchRealChrome(chromePath, w);
            workers.push({ id: w, ...wChrome });
            if (w < concurrency - 1) await sleep(rand(2000, 3000));
        }

        let idx = 0;
        const stats = { ok: 0, ng: 0 };
        async function workerFn(worker) {
            const wl = createWorkerLogger(worker.id);
            while (true) {
                const i = idx++;
                if (i >= members.length) break;
                const m = members[i];
                try {
                    const dec = await processOneMember(m, worker, hm, chromePath, wl, runId);
                    if (dec.finalStatus === 'done') stats.ok++; else stats.ng++;
                } catch (e) {
                    wl.error(`Stage2 [${m.email}]: ${e.message}`);
                    stats.ng++;
                }
                await sleep(rand(1000, 2000));
            }
        }
        await Promise.all(workers.map(w => workerFn(w)));

        // One extra poll-tick before teardown so any in-flight scrape can fire
        try {
            await new Promise((resolve) => {
                const to = setTimeout(resolve, Math.min(hm.intervalMs + 2000, 10_000));
                hm.once('scrape-done', () => { clearTimeout(to); resolve(); });
            });
        } catch (_) {}

        return stats;
    } finally {
        if (hm) {
            try { await hm.stop(); } catch (_) {}
        }
        try { hmChrome.browser.close(); } catch (_) {}
        try { hmChrome.proc.kill(); } catch (_) {}
        for (const w of workers) {
            try { w.browser.close(); } catch (_) {}
            try { w.proc.kill(); } catch (_) {}
        }
    }
}

async function runStage2({ runId, concurrency = 1, hostIds } = {}) {
    const chromePath = findChrome();
    if (!chromePath) throw new Error('Chrome not found');

    const work = await membersDb.listMembersForStage(2, { hostIds });
    log(`Stage2: ${work.length} pending acceptance(s) across ${new Set(work.map(m => m.host_id)).size} host(s)`);
    if (!work.length) return { ok: 0, ng: 0 };

    const byHost = new Map();
    for (const m of work) {
        if (!byHost.has(m.host_id)) byHost.set(m.host_id, []);
        byHost.get(m.host_id).push(m);
    }

    const overall = { ok: 0, ng: 0 };
    for (const [hostId, members] of byHost) {
        const host = await hostsDb.getHostById(hostId);
        if (!host) { log(`Stage2: host ${hostId} not found in DB, skipping`, 'WARN'); continue; }
        try {
            const stats = await processOneHost({ host, members, concurrency, runId, chromePath });
            overall.ok += stats.ok;
            overall.ng += stats.ng;
        } catch (e) {
            log(`Stage2 host ${host.email}: ${e.message}`, 'ERROR');
            overall.ng += members.length;
        }
    }

    log(`Stage2 done: OK=${overall.ok} FAIL=${overall.ng}`, 'SUCCESS');
    return overall;
}

module.exports = { runStage2, acceptInvite };
