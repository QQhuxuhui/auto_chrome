const path = require('path');
const { fork } = require('child_process');
const runs = require('../db/runs');
const events = require('../db/events');

const activeChildren = new Map();  // runId -> child_process

module.exports = async function routes(app) {
    app.post('/api/pipeline/start', async (req, reply) => {
        const { stages = '1,2,3', hostFilter = [], concurrency = 1, dryRun = false } = req.body || {};
        const current = await runs.getCurrentRun();
        if (current) return reply.code(409).send({ error: `run #${current.id} already running`, runId: current.id });

        const run = await runs.createRun({
            launched_by: 'ui',
            stages,
            host_filter: hostFilter,
            concurrency,
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
        const child = fork(orchestratorPath, args, {
            stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
            detached: false,
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
        const child = activeChildren.get(id);
        if (child) {
            child.kill('SIGTERM');
            setTimeout(() => {
                if (activeChildren.has(id)) {
                    try { child.kill('SIGKILL'); } catch (_) { }
                }
            }, 30000).unref();
        } else if (run.pid) {
            try { process.kill(run.pid, 'SIGTERM'); } catch (_) { }
        }
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
