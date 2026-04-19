const sync = require('../sync/antigravity-sync');
const antigravityClient = require('../common/antigravity');
const membersDb = require('../db/members');

module.exports = async function routes(app) {
    app.post('/api/antigravity/sync', async () => {
        return sync.syncFromRemote();
    });

    app.post('/api/antigravity/push/:id', async (req, reply) => {
        const id = parseInt(req.params.id, 10);
        const r = await sync.pushAccount(id);
        if (!r.success) return reply.code(400).send(r);
        return r;
    });

    app.post('/api/antigravity/push-all', async () => {
        return sync.pushAllPending();
    });

    app.delete('/api/antigravity/account/:id', async (req, reply) => {
        const id = parseInt(req.params.id, 10);
        const r = await sync.deleteAccount(id);
        if (!r.success) return reply.code(400).send(r);
        return r;
    });

    // 只读 orphans: 远程有、本地没有
    app.get('/api/antigravity/orphans', async () => {
        const { accounts = [] } = await antigravityClient.listAccounts();
        const emails = accounts.map(a => a.email).filter(Boolean);
        const locals = await membersDb.listMembersByEmailLower(emails);
        const localSet = new Set(locals.map(m => m.email.toLowerCase()));
        const orphans = accounts
            .filter(a => !localSet.has(String(a.email).toLowerCase()))
            .map(a => ({ id: a.id, email: a.email, disabled: a.disabled, validation_blocked: a.validation_blocked }));
        return orphans;
    });
};
