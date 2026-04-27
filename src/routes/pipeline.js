const path = require('path');
const { fork } = require('child_process');
const runs = require('../db/runs');
const events = require('../db/events');
const { isPidAlive } = require('../common/pid');

const activeChildren = new Map();  // runId -> child_process

module.exports = async function routes(app) {
    app.post('/api/pipeline/start', async (req, reply) => {
        const { stages = '1,2,3', hostFilter = [], concurrency = 1, dryRun = false, removeUnknownMembers = false, manualMode = false } = req.body || {};
        // pipeline_runs is partitioned by worker — block only on this install's
        // own running pipeline, not another machine's.
        const current = await runs.getCurrentRunForWorker(app.workerId);
        if (current) return reply.code(409).send({ error: `run #${current.id} already running`, runId: current.id });

        const run = await runs.createRun({
            launched_by: 'ui',
            stages,
            host_filter: hostFilter,
            concurrency,
            worker_id: app.workerId,
        });

        if (dryRun) {
            return { runId: run.id, pid: null, dryRun: true };
        }

        const orchestratorPath = path.resolve(__dirname, '..', 'orchestrator.js');
        const args = [
            '--run-id', String(run.id),
            '--stages', stages,
            '--concurrency', String(concurrency),
        ];
        if (Array.isArray(hostFilter) && hostFilter.length) {
            args.push('--hosts', hostFilter.join(','));
        }
        if (removeUnknownMembers) {
            args.push('--remove-unknown');
        }
        if (manualMode) {
            args.push('--manual');
        }
        const child = fork(orchestratorPath, args, {
            stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
            detached: false,
            // Pass WORKER_ID so the orchestrator can stamp pipeline_runs.worker_id
            // and write heartbeats. Hosts/members are shared so no owner filtering.
            env: { ...process.env, WORKER_ID: app.workerId },
        });
        activeChildren.set(run.id, child);
        await runs.setRunPid(run.id, child.pid);

        child.on('exit', (code, signal) => {
            activeChildren.delete(run.id);
            app.log.info(`orchestrator run #${run.id} exited code=${code} signal=${signal}`);
        });

        return { runId: run.id, pid: child.pid, dryRun: false };
    });

    app.post('/api/pipeline/runs/:id/cancel', async (req, reply) => {
        const id = parseInt(req.params.id, 10);
        const run = await runs.getRunById(id);
        if (!run) return reply.code(404).send({ error: 'not found' });
        if (run.status !== 'running') {
            return reply.code(400).send({ error: `run is ${run.status}` });
        }
        // Multi-tenant guard: only the worker that owns the run can cancel it.
        // Cross-machine cancel would be unsafe (we'd send signals to local pids
        // that mean nothing for foreign rows) and against user expectation.
        if (run.worker_id && run.worker_id !== app.workerId) {
            return reply.code(403).send({
                error: `cannot cancel: run #${id} owned by another worker (${run.worker_id})`,
                ownedBy: run.worker_id,
            });
        }

        // Pid is gone (orchestrator crashed / killed -9 / server-restart-orphan).
        // Sending SIGTERM and waiting for the orchestrator to write 'cancelled'
        // is pointless — nobody's listening. Mark the row directly so the UI
        // unblocks and the user can start a new run. Use the conditional helper
        // so a real terminal status (orchestrator finished between our read
        // and write) wins over our 'cancelled' overwrite.
        if (!run.pid || !isPidAlive(run.pid)) {
            const updated = await runs.cancelStaleRunIfStillRunning(
                id,
                `cancel: pid ${run.pid || 'null'} not alive at request time`,
            );
            activeChildren.delete(id);
            if (!updated) {
                const fresh = await runs.getRunById(id);
                app.log.info(`cancel race: run #${id} already ${fresh ? fresh.status : 'gone'}, no-op`);
                return { cancelRequested: true, reaped: false, reason: 'already_terminal', status: fresh ? fresh.status : null };
            }
            return { cancelRequested: true, reaped: true, reason: 'pid_dead' };
        }

        const child = activeChildren.get(id);
        if (child) {
            child.kill('SIGTERM');
            setTimeout(() => {
                if (activeChildren.has(id)) {
                    try { child.kill('SIGKILL'); } catch (_) { }
                }
            }, 30000).unref();
        } else {
            try { process.kill(run.pid, 'SIGTERM'); } catch (_) { }
        }

        // Belt-and-suspenders: if SIGTERM kills the process but its handler
        // never gets to write 'cancelled' (e.g. it was already wedged), check
        // back in 3s and reap if the row is still 'running' but pid is dead.
        // The conditional UPDATE inside cancelStaleRunIfStillRunning guards
        // against the race where the orchestrator just barely managed to
        // write its own terminal status between our isPidAlive check and the
        // UPDATE landing.
        setTimeout(async () => {
            try {
                const fresh = await runs.getRunById(id);
                if (!fresh || fresh.status !== 'running') return;
                if (fresh.pid && isPidAlive(fresh.pid)) return;
                const updated = await runs.cancelStaleRunIfStillRunning(
                    id,
                    `cancel: pid ${fresh.pid || 'null'} dead 3s after SIGTERM, reaped by route`,
                );
                activeChildren.delete(id);
                if (updated) {
                    app.log.warn(`reaped run #${id} after cancel: pid was dead post-signal`);
                } else {
                    app.log.info(`cancel-followup race for run #${id}: row already terminal, no-op`);
                }
            } catch (e) {
                app.log.warn({ err: e.message }, `cancel-followup reap failed for run #${id}`);
            }
        }, 3000).unref();

        return { cancelRequested: true };
    });

    app.get('/api/pipeline/runs', async () => runs.listRuns(50));

    app.get('/api/pipeline/runs/:id', async (req, reply) => {
        const id = parseInt(req.params.id, 10);
        const run = await runs.getRunById(id);
        if (!run) return reply.code(404).send({ error: 'not found' });
        const evts = await events.listEventsForRun(id, 500);
        return { ...run, events: evts };
    });
};
