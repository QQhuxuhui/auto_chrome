const members = require('../db/members');
const events = require('../db/events');
const { parseLinesToAccounts } = require('./hosts');

module.exports = async function routes(app) {
    app.get('/api/members', async (req) => {
        const { status, host_id, search, has_token, page, pageSize } = req.query;
        return members.listMembers({
            status,
            hostId: host_id ? parseInt(host_id, 10) : undefined,
            search,
            hasToken: has_token !== undefined ? (has_token === '1' || has_token === 'true') : undefined,
            page: page ? parseInt(page, 10) : undefined,
            pageSize: pageSize ? parseInt(pageSize, 10) : undefined,
        });
    });

    app.get('/api/members/:id', async (req, reply) => {
        const id = parseInt(req.params.id, 10);
        const m = await members.getMemberById(id);
        if (!m) return reply.code(404).send({ error: 'not found' });
        const evts = await events.listEventsForMember(id, 50);
        return { ...m, events: evts };
    });

    app.post('/api/members/bulk', async (req, reply) => {
        const { lines, accounts } = req.body || {};
        let items = [];
        if (typeof lines === 'string' && lines.trim()) {
            items = parseLinesToAccounts(lines);
        } else if (Array.isArray(accounts)) {
            items = accounts;
        } else {
            return reply.code(400).send({ error: 'either `lines` or `accounts` is required' });
        }
        const out = { inserted: 0, skipped: 0, errors: [] };
        for (const it of items) {
            try {
                const r = await members.upsertMember({
                    email: it.email,
                    password: it.password || it.pass,
                    recovery_email: it.recovery_email || it.recovery,
                    totp_secret: it.totp_secret,
                    notes: it.notes,
                });
                if (r.inserted) out.inserted++;
                else out.skipped++;
            } catch (e) {
                out.errors.push({ email: it.email, error: e.message });
            }
        }
        return out;
    });

    app.patch('/api/members/:id', async (req, reply) => {
        const id = parseInt(req.params.id, 10);
        const action = req.query.action;
        if (action === 'reset') return members.resetMember(id);
        if (action === 'abandon') return members.abandonMember(id);
        const row = await members.updateMember(id, req.body || {});
        if (!row) return reply.code(404).send({ error: 'not found' });
        return row;
    });

    app.delete('/api/members/:id', async (req, reply) => {
        const id = parseInt(req.params.id, 10);
        await members.deleteMember(id);
        reply.code(204).send();
    });
};
