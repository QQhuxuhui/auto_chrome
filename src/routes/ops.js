/**
 * Ops endpoints — reconcile, etc.
 * Reconcile launches a one-shot fork of orchestrator.js with --reconcile-only flag.
 */
const path = require('path');
const { fork } = require('child_process');
const runs = require('../db/runs');

module.exports = async function routes(app) {
    app.post('/api/reconcile', async (req, reply) => {
        const { hostIds = [] } = req.body || {};
        const current = await runs.getCurrentRun();
        if (current) return reply.code(409).send({ error: `run #${current.id} already running` });

        const run = await runs.createRun({
            launched_by: 'ui',
            stages: 'reconcile',
            host_filter: hostIds,
            concurrency: 1,
        });

        const orchestratorPath = path.resolve(__dirname, '..', 'orchestrator.js');
        const args = [
            '--run-id', String(run.id),
            '--reconcile-only',
        ];
        if (hostIds.length) args.push('--host-ids', hostIds.join(','));

        const child = fork(orchestratorPath, args, {
            stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
        });
        await runs.setRunPid(run.id, child.pid);
        return { runId: run.id, pid: child.pid };
    });
};
