#!/usr/bin/env node
/**
 * Orchestrator — runnable as child_process.fork from server, OR directly
 * from CLI (run_pipeline.sh).
 *
 * Flags:
 *   --run-id <N>             : pipeline_runs.id (required)
 *   --stages "1,2,3"         : comma-separated stages
 *   --stages "reconcile,3"   : optional inline reconcile before selected stages
 *   --hosts "a@x,b@x"        : optional host email filter
 *   --concurrency <N>        : worker count (default 1)
 *   --reconcile-only         : skip stages, run reconcile only
 *   --host-ids "1,2"         : only for --reconcile-only, restrict host IDs
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

function parseEmailFilter(value) {
    if (value === undefined) return undefined;
    const raw = value === true ? '' : String(value);
    return raw.split(',').map(s => s.trim()).filter(Boolean);
}

function parseHostIdFilter(value) {
    if (value === undefined) return undefined;
    const raw = value === true ? '' : String(value);
    return raw.split(',')
        .map(s => parseInt(s.trim(), 10))
        .filter(n => Number.isInteger(n) && n > 0);
}

function parseExplicitHostSelection(flags) {
    const hostFilter = parseEmailFilter(flags.hosts);
    const hostIds = parseHostIdFilter(flags['host-ids']);
    return {
        hostFilter,
        hostIds,
        explicitFilter: hostFilter !== undefined || hostIds !== undefined,
    };
}

function parseStageSelection(value) {
    const stages = String(value || '1,2,3').split(',').map(s => s.trim()).filter(Boolean);
    const set = new Set(stages);
    return {
        stages,
        runInlineReconcile: set.has('reconcile'),
        runStage1: set.has('1'),
        runStage2: set.has('2'),
        runStage3: set.has('3'),
    };
}

async function runReconcilePhase({ runId, hostFilter, hostIds, removeUnknown }) {
    const chromePath = findChrome();
    if (!chromePath) throw new Error('Chrome not found');

    let targetHosts;
    if (Array.isArray(hostIds)) {
        targetHosts = [];
        for (const id of hostIds) {
            const h = await hostsDb.getHostById(id);
            if (h) targetHosts.push(h);
        }
    } else if (Array.isArray(hostFilter)) {
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
            const { changes } = await reconcileHost(host, chrome.browser, runId, wlog, { removeUnknown });
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

    const stageSelection = parseStageSelection(flags.stages);
    const concurrency = flags.concurrency ? parseInt(flags.concurrency, 10) : 1;
    const reconcileOnly = !!flags['reconcile-only'];
    const removeUnknown = !!flags['remove-unknown'];
    const { hostFilter, hostIds, explicitFilter } = parseExplicitHostSelection(flags);

    // Resolve hostFilter (emails) → hostIds for stage 2/3 filtering.
    // Stage 1 uses hostFilter (emails) directly via pickHost; no change there.
    let resolvedHostIds = Array.isArray(hostIds) ? hostIds.slice() : [];
    if (Array.isArray(hostFilter) && hostFilter.length && resolvedHostIds.length === 0) {
        const all = await hostsDb.listHosts({ pageSize: 10000 });
        const filterLower = hostFilter.map(s => s.toLowerCase());
        resolvedHostIds = all.filter(h => filterLower.includes(h.email.toLowerCase())).map(h => h.id);
    }

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
            if (explicitFilter && resolvedHostIds.length === 0) {
                log('orchestrator: --hosts/--host-ids filter resolved to zero hosts; reconcile will have zero work', 'WARN');
            }
            const reconcileOpts = explicitFilter
                ? { runId, hostFilter, hostIds: resolvedHostIds, removeUnknown }
                : { runId, removeUnknown };
            stats.reconcile = await runReconcilePhase(reconcileOpts);
        } else {
            const stage3Only = stageSelection.stages.length === 1 && stageSelection.stages[0] === '3';
            const shouldReconcile = stageSelection.runInlineReconcile || !stage3Only;
            if (shouldReconcile) {
                const reconcileOpts = explicitFilter
                    ? { runId, hostFilter, hostIds: resolvedHostIds, removeUnknown }
                    : { runId, removeUnknown };
                stats.reconcile = await runReconcilePhase(reconcileOpts);
            } else {
                log('orchestrator: stage 3 only, skipping reconcile prelude');
            }
            if (explicitFilter && resolvedHostIds.length === 0) {
                log(`orchestrator: --hosts/--host-ids filter resolved to zero hosts; stage 2/3 will have zero work`, 'WARN');
            }
            const stage23Opts = explicitFilter
                ? { runId, concurrency, hostIds: resolvedHostIds }
                : { runId, concurrency };

            if (stageSelection.runStage1) stats.stage1 = await runStage1({ runId, hostFilter, concurrency });
            if (stageSelection.runStage2) stats.stage2 = await runStage2(stage23Opts);
            if (stageSelection.runStage3) stats.stage3 = await runStage3(stage23Opts);
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

module.exports = { parseFlags, parseExplicitHostSelection, parseStageSelection, runReconcilePhase };
