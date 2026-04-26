const members = require('../db/members');
const hosts = require('../db/hosts');
const runs = require('../db/runs');

module.exports = async function routes(app) {
    app.get('/api/status', async () => {
        // Multi-tenant: dashboard only shows hosts/members owned by THIS
        // install and the run launched by THIS install, so user A's data
        // never appears in user B's UI.
        const [byStatus, allHosts, currentRun] = await Promise.all([
            members.countByStatus({ ownerId: app.workerId }),
            hosts.listHosts({ pageSize: 10000, ownerId: app.workerId }),
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
