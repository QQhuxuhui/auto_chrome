const members = require('../db/members');
const hosts = require('../db/hosts');
const runs = require('../db/runs');

module.exports = async function routes(app) {
    app.get('/api/status', async () => {
        // Hosts/members are shared across installs; only the "current run"
        // is per-worker so each install's UI reflects its own pipeline state.
        const [byStatus, allHosts, currentRun] = await Promise.all([
            members.countByStatus(),
            hosts.listHosts({ pageSize: 10000 }),
            runs.getCurrentRunForWorker(app.workerId),
        ]);
        const total = allHosts.length;
        const disabled = allHosts.filter(h => h.disabled).length;
        const usable = allHosts.filter(h => !h.disabled);
        const withFreeSlot = usable.filter(h => h.slot_free > 0).length;
        const freeSlotsTotal = usable.reduce((s, h) => s + (h.slot_free || 0), 0);
        return {
            byStatus,
            hosts: { total, disabled, withFreeSlot, freeSlotsTotal },
            currentRun,
        };
    });
};
