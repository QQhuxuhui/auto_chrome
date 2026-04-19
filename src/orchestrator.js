#!/usr/bin/env node
/**
 * Orchestrator — runnable as child_process.fork from server, OR directly
 * from CLI (run_pipeline.sh).
 *
 * Flags:
 *   --run-id <N>       : pipeline_runs.id (required)
 *   --stages "1,2,3"   : comma-separated stages
 *   --hosts "a@x,b@x"  : optional host email filter
 *   --concurrency <N>  : worker count (default 1)
 *   --reconcile-only   : skip stages, run reconcile only
 *   --host-ids "1,2"   : only for --reconcile-only, restrict host IDs
 */
require('dotenv').config({ path: require('path').resolve(__dirname, '..', '.env') });
const { log, createWorkerLogger } = require('./common/logger');
const { findChrome, launchRealChrome } = require('./common/chrome');
const hostsDb = require('./db/hosts');
const runsDb  = require('./db/runs');
const db = require('./db');

const { runStage1 } = require('./1_invite');
const { runStage2 } = require('./2_accept');
const { runStage3 } = require('./3_local_oauth');
const { reconcileHost } = require('./stages/reconcile');

function parseFlags(argv) {
    const out = {};
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (!a.startsWith('--')) continue;
        const key = a.slice(2);
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith('--')) {
            out[key] = next;
            i++;
        } else {
            out[key] = true;
        }
    }
    return out;
}

async function runReconcilePhase({ runId, hostFilter, hostIds }) {
    const chromePath = findChrome();
    if (!chromePath) throw new Error('Chrome not found');

    let targetHosts;
    if (hostIds && hostIds.length) {
        targetHosts = [];
        for (const id of hostIds) {
            const h = await hostsDb.getHostById(id);
            if (h) targetHosts.push(h);
        }
    } else if (hostFilter && hostFilter.length) {
        const all = await hostsDb.listHosts({ pageSize: 10000 });
        targetHosts = all.filter(h => hostFilter.map(s => s.toLowerCase()).includes(h.email.toLowerCase()));
    } else {
        targetHosts = (await hostsDb.listHosts({ pageSize: 10000 })).filter(h => !h.disabled);
    }

    log(`Reconcile: ${targetHosts.length} host(s)`);
    const totalChanges = [];
    for (const host of targetHosts) {
        const chrome = await launchRealChrome(chromePath, 0);
        try {
            const wlog = createWorkerLogger(0);
            const { changes } = await reconcileHost(host, chrome.browser, runId, wlog);
            totalChanges.push(...changes);
        } catch (e) {
            log(`Reconcile host ${host.email} failed: ${e.message}`, 'WARN');
        } finally {
            try { chrome.browser.close(); } catch (_) { }
            try { chrome.proc.kill(); } catch (_) { }
        }
    }
    log(`Reconcile: ${totalChanges.length} state change(s)`);
    return totalChanges;
}

async function main() {
    const flags = parseFlags(process.argv.slice(2));
    const runId = flags['run-id'] ? parseInt(flags['run-id'], 10) : null;
    if (!runId) { log('orchestrator: --run-id is required', 'ERROR'); process.exit(2); }

    const stages = (flags.stages || '1,2,3').split(',').map(s => s.trim()).filter(Boolean);
    const hostFilter = flags.hosts ? flags.hosts.split(',').map(s => s.trim()).filter(Boolean) : [];
    const concurrency = flags.concurrency ? parseInt(flags.concurrency, 10) : 1;
    const reconcileOnly = !!flags['reconcile-only'];
    const hostIds = flags['host-ids'] ? flags['host-ids'].split(',').map(s => parseInt(s, 10)).filter(Boolean) : [];

    const stats = { reconcile: null, stage1: null, stage2: null, stage3: null };
    let finalStatus = 'completed';
    let finalError = null;

    const onSig = (sig) => {
        log(`orchestrator: received ${sig}, will update run to cancelled then exit`);
        runsDb.updateRunStatus(runId, 'cancelled').catch(() => { })
            .finally(() => process.exit(sig === 'SIGTERM' ? 143 : 130));
    };
    process.on('SIGTERM', () => onSig('SIGTERM'));
    process.on('SIGINT',  () => onSig('SIGINT'));

    try {
        if (reconcileOnly) {
            stats.reconcile = await runReconcilePhase({ runId, hostFilter, hostIds });
        } else {
            stats.reconcile = await runReconcilePhase({ runId, hostFilter });
            if (stages.includes('1')) stats.stage1 = await runStage1({ runId, hostFilter, concurrency });
            if (stages.includes('2')) stats.stage2 = await runStage2({ runId, concurrency });
            if (stages.includes('3')) stats.stage3 = await runStage3({ runId, concurrency });
        }
    } catch (e) {
        finalStatus = 'failed';
        finalError = e.message;
        log(`orchestrator: ${e.message}`, 'ERROR');
        if (e.stack) console.error(e.stack);
    }

    await runsDb.updateRunStatus(runId, finalStatus, {
        stats: {
            reconcile: Array.isArray(stats.reconcile) ? { changes: stats.reconcile.length } : null,
            stage1: stats.stage1, stage2: stats.stage2, stage3: stats.stage3,
        },
        error: finalError,
    });
    await db.close();
    process.exit(finalStatus === 'completed' ? 0 : 1);
}

if (require.main === module) {
    main().catch(e => {
        log(`orchestrator fatal: ${e.message}`, 'ERROR');
        process.exit(1);
    });
}

module.exports = { parseFlags, runReconcilePhase };
