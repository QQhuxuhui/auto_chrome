const hosts = require('../db/hosts');
const { parseAccounts } = require('../common/state');

function adaptAccount(a) {
    return {
        email: a.email,
        password: a.password || a.pass,
        recovery_email: a.recovery_email || a.recovery,
        totp_secret: a.totp_secret,
        notes: a.notes,
    };
}

module.exports = async function routes(app) {
    app.post('/api/hosts/bulk', async (req, reply) => {
        const { lines, accounts } = req.body || {};
        let items = [];
        if (typeof lines === 'string' && lines.trim()) {
            items = parseAccounts(lines).map(adaptAccount);
        } else if (Array.isArray(accounts)) {
            items = accounts.map(adaptAccount);
        } else {
            return reply.code(400).send({ error: 'either `lines` or `accounts` is required' });
        }
        if (items.length === 0) {
            return { inserted: 0, skipped: 0, errors: [], parsedZero: true };
        }
        const out = { inserted: 0, skipped: 0, errors: [] };
        for (const it of items) {
            try {
                const r = await hosts.upsertHost({
                    email: it.email,
                    password: it.password,
                    recovery_email: it.recovery_email,
                    totp_secret: it.totp_secret,
                    notes: it.notes,
                });
                if (r.inserted) out.inserted++; else out.skipped++;
            } catch (e) {
                out.errors.push({ email: it.email, error: e.message });
            }
        }
        return out;
    });

    app.patch('/api/hosts/:id', async (req, reply) => {
        const id = parseInt(req.params.id, 10);
        const row = await hosts.updateHost(id, req.body || {});
        if (!row) return reply.code(404).send({ error: 'not found' });
        return row;
    });

    app.delete('/api/hosts/:id', async (req, reply) => {
        const id = parseInt(req.params.id, 10);
        await hosts.deleteHost(id);
        reply.code(204).send();
    });

    app.get('/api/hosts', async (req) => {
        const { disabled, search, page, pageSize } = req.query;
        return hosts.listHosts({
            disabled,
            search,
            page: page ? parseInt(page, 10) : undefined,
            pageSize: pageSize ? parseInt(pageSize, 10) : undefined,
        });
    });
};

// Backward-compat export (members route imports parseLinesToAccounts from here;
// it's now a thin wrapper over parseAccounts)
module.exports.parseLinesToAccounts = function(text) {
    return parseAccounts(text).map(adaptAccount);
};
