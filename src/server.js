/**
 * Fastify server — local account management UI + API.
 * Bind to 127.0.0.1 only (no auth).
 */
require('dotenv').config({ path: require('path').resolve(__dirname, '..', '.env') });
const path = require('path');
const Fastify = require('fastify');
const { loadOrCreateWorkerIdentity } = require('./common/worker-id');

const PORT = parseInt(process.env.SERVER_PORT, 10) || 3000;
const HOST = process.env.SERVER_HOST || '127.0.0.1';

async function build() {
    const app = Fastify({
        logger: { level: 'info' },
        disableRequestLogging: false,
    });

    // Decorate with the per-install worker identity so routes can isolate
    // pipeline_runs queries / writes by the current machine. Doing it here
    // (not lazily inside each route) keeps it cheap and centralizes the
    // disk read on first call.
    const identity = loadOrCreateWorkerIdentity();
    app.decorate('workerId', identity.workerId);
    app.decorate('workerLabel', identity.workerLabel);

    await app.register(require('@fastify/static'), {
        root: path.resolve(__dirname, '..', 'public'),
        prefix: '/public/',
    });

    await app.register(require('./routes/hosts'));
    await app.register(require('./routes/members'));
    await app.register(require('./routes/status'));
    await app.register(require('./routes/pipeline'));
    await app.register(require('./routes/migrate'));
    await app.register(require('./routes/ops'));
    await app.register(require('./routes/antigravity'));

    app.get('/', async (_req, reply) => reply.sendFile('index.html'));
    app.get('/accounts', async (_req, reply) => reply.sendFile('accounts.html'));
    app.get('/runs', async (_req, reply) => reply.sendFile('runs.html'));

    app.get('/api/ping', async () => ({ ok: true, ts: new Date().toISOString() }));
    app.get('/api/me', async () => ({ workerId: app.workerId, workerLabel: app.workerLabel }));

    // Routes will be registered in subsequent tasks.

    app.setErrorHandler((err, _req, reply) => {
        app.log.error(err);
        const code = err.statusCode && err.statusCode >= 400 ? err.statusCode : 500;
        reply.code(code).send({ error: err.message });
    });

    return app;
}

// Cross-machine liveness: heartbeat is decoupled from work (just setInterval),
// so anything past 60s without a heartbeat is treated as dead. Conservative
// enough to survive ordinary network blips but prompt enough to unblock the UI.
const HEARTBEAT_DEAD_MS = parseInt(process.env.RUN_HEARTBEAT_DEAD_MS, 10) || 60_000;

function isHeartbeatStale(row, nowMs = Date.now()) {
    if (!row.last_heartbeat_at) return true;
    const ts = new Date(row.last_heartbeat_at).getTime();
    if (!Number.isFinite(ts)) return true;
    return (nowMs - ts) > HEARTBEAT_DEAD_MS;
}

async function reapStaleRunsOnBoot(app) {
    const runs = require('./db/runs');
    const { isPidAlive } = require('./common/pid');
    const myWorkerId = app.workerId;
    let stale;
    try {
        stale = await runs.listRunningRuns();
    } catch (e) {
        app.log.warn({ err: e.message }, 'startup reaper: listRunningRuns failed');
        return;
    }
    if (!stale.length) return;
    const now = Date.now();
    for (const r of stale) {
        const isOwn = r.worker_id && r.worker_id === myWorkerId;

        if (isOwn) {
            // Own row: pid is the strongest signal. Heartbeat is a
            // belt-and-suspenders backup if pid happened to recycle.
            if (r.pid && isPidAlive(r.pid)) {
                app.log.info(`startup reaper: own run #${r.id} pid=${r.pid} still alive, keeping`);
                continue;
            }
            await reapStaleRow(app, runs, r, `stale on server restart: pid ${r.pid || 'null'} not alive at boot (own worker)`);
            continue;
        }

        // Foreign row: cannot trust local pid (means nothing on this machine).
        // Only reap if heartbeat is stale beyond the dead threshold. Foreign
        // workers that are just temporarily offline keep their rows; only
        // confirmed-dead foreign rows get cleaned up.
        if (!r.worker_id) {
            // Legacy row from before multi-tenant. Treat as foreign-stale: if
            // heartbeat is missing/old, reap. Otherwise leave alone.
            if (isHeartbeatStale(r, now)) {
                await reapStaleRow(app, runs, r, `stale legacy run (no worker_id) with stale/missing heartbeat at boot`);
            } else {
                app.log.info(`startup reaper: legacy run #${r.id} has fresh heartbeat, leaving as running`);
            }
            continue;
        }

        if (isHeartbeatStale(r, now)) {
            await reapStaleRow(app, runs, r, `stale foreign run from worker ${r.worker_id}: heartbeat older than ${HEARTBEAT_DEAD_MS}ms at boot`);
        } else {
            app.log.info(`startup reaper: foreign run #${r.id} (worker ${r.worker_id}) heartbeat fresh, leaving alone`);
        }
    }
}

async function reapStaleRow(app, runs, r, reason) {
    try {
        const updated = await runs.cancelStaleRunIfStillRunning(r.id, reason);
        if (updated) {
            app.log.warn(`startup reaper: run #${r.id} marked cancelled (${reason})`);
        } else {
            app.log.info(`startup reaper: run #${r.id} already moved to terminal status between snapshot and update, skipped`);
        }
    } catch (e) {
        app.log.warn({ err: e.message }, `startup reaper: failed to update run #${r.id}`);
    }
}

// One-time migration: when this install boots and finds rows with NULL
// owner_worker_id (legacy rows from before the multi-tenant migration), claim
// them as ours. The assumption is that the existing DB content belongs to the
// install that boots first after the migration lands. Subsequent installs see
// no NULL rows (they're all stamped) and only see their own data.
async function claimLegacyOwnerlessRows(app) {
    const dbMod = require('./db');
    try {
        const r1 = await dbMod.query(
            "UPDATE hosts SET owner_worker_id = $1 WHERE owner_worker_id IS NULL RETURNING id",
            [app.workerId]
        );
        const r2 = await dbMod.query(
            "UPDATE members SET owner_worker_id = $1 WHERE owner_worker_id IS NULL RETURNING id",
            [app.workerId]
        );
        const r3 = await dbMod.query(
            "UPDATE pipeline_runs SET worker_id = $1 WHERE worker_id IS NULL RETURNING id",
            [app.workerId]
        );
        const total = r1.rowCount + r2.rowCount + r3.rowCount;
        if (total > 0) {
            app.log.warn(
                `legacy owner stamp: claimed ${r1.rowCount} hosts, ${r2.rowCount} members, ${r3.rowCount} runs as worker_id=${app.workerId}`
            );
        }
    } catch (e) {
        app.log.warn({ err: e.message }, 'legacy owner stamp failed');
    }
}

async function start() {
    const app = await build();
    try {
        await app.listen({ port: PORT, host: HOST });

        await claimLegacyOwnerlessRows(app);
        await reapStaleRunsOnBoot(app);

        // Antigravity 定时 sync (set SYNC_INTERVAL_MS=0 to disable)
        const SYNC_MS = parseInt(process.env.SYNC_INTERVAL_MS, 10);
        if (SYNC_MS === 0) {
            app.log.info('Antigravity scheduled sync disabled (SYNC_INTERVAL_MS=0)');
        } else {
            const ms = Number.isFinite(SYNC_MS) && SYNC_MS > 0 ? SYNC_MS : 5 * 60 * 1000;
            const sync = require('./sync/antigravity-sync');
            setInterval(() => {
                // Scheduled sync mirrors only THIS install's members. Other
                // installs run their own scheduled sync against the same
                // platform; each only touches its own owner_worker_id rows.
                sync.syncFromRemote({ ownerId: app.workerId })
                    .then(r => app.log.info({ event: 'antigravity-sync', ...r }, `antigravity sync: matched=${r.matched} orphans=${r.orphans.length}`))
                    .catch(e => app.log.warn({ err: e.message }, 'antigravity scheduled sync failed'));
            }, ms).unref();
            app.log.info(`Antigravity scheduled sync every ${ms}ms`);
        }

        app.log.info(`HTTP ready on http://${HOST}:${PORT}`);
    } catch (e) {
        app.log.error(e);
        process.exit(1);
    }
}

if (require.main === module) start();

module.exports = { build };
