/**
 * Ops endpoints — reconcile, etc.
 * Reconcile launches a one-shot fork of orchestrator.js with --reconcile-only flag.
 */
const path = require('path');
const { fork } = require('child_process');
const runs = require('../db/runs');
const members = require('../db/members');

module.exports = async function routes(app) {
    app.post('/api/reconcile', async (req, reply) => {
        const body = req.body || {};
        const explicitHostIds = Array.isArray(body.hostIds) ? body.hostIds : [];
        // allHosts=true 保留旧语义（兜底：扫全部 enabled host，用于一般 reconcile
        // 例如把漂移的 invite_pending 翻成 joined）。默认不再扫全部 —— 因为
        // 仪表盘 "立即清理" 按钮的唯一诉求是移除封禁账号，挨个登没工作量的 host
        // 会浪费 Chrome login + 2FA。
        const allHosts = body.allHosts === true;

        let hostIds = explicitHostIds;
        let autoFiltered = false;
        if (!hostIds.length && !allHosts) {
            hostIds = await members.listHostIdsNeedingCleanup();
            autoFiltered = true;
            if (!hostIds.length) {
                return { runId: null, skipped: true, reason: 'no host has cleanup work' };
            }
        }

        // pipeline_runs is partitioned by worker — block only on this install's
        // own running pipeline, not another machine's.
        const current = await runs.getCurrentRunForWorker(app.workerId);
        if (current) return reply.code(409).send({ error: `run #${current.id} already running` });

        const run = await runs.createRun({
            launched_by: 'ui',
            stages: 'reconcile',
            host_filter: hostIds,
            concurrency: 1,
            worker_id: app.workerId,
        });

        const orchestratorPath = path.resolve(__dirname, '..', 'orchestrator.js');
        const args = [
            '--run-id', String(run.id),
            '--reconcile-only',
        ];
        if (hostIds.length) args.push('--host-ids', hostIds.join(','));

        let child;
        try {
            child = fork(orchestratorPath, args, {
                stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
                env: { ...process.env, WORKER_ID: app.workerId },
            });
        } catch (e) {
            app.log.error({ err: e.message }, 'fork orchestrator (ops) failed');
            return reply.code(500).send({ error: 'fork orchestrator 失败', detail: e.message });
        }
        await runs.setRunPid(run.id, child.pid);
        return { runId: run.id, pid: child.pid, hostIds, autoFiltered };
    });
};
