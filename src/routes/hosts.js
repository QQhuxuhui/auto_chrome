const hosts = require('../db/hosts');

function parseLinesToAccounts(text) {
    // Minimal inline parser for bulk upload. Supports `email:pass[:recovery[:totp]]`.
    // common/state.js#parseAccounts reads from a file path; we duplicate the minimal
    // logic here rather than refactor that function to accept strings.
    const lines = text.split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith('#'));
    const out = [];
    for (const line of lines) {
        const normalized = line.replace(/\uff1a/g, ':');
        const parts = normalized.split(':').map(s => s.trim());
        if (parts.length < 2) continue;
        const email = parts[0];
        const password = parts[1];
        if (!email.includes('@')) continue;
        const recovery = parts[2] || '';
        const totpRaw = parts.slice(3).join(':');
        let totp_secret = '';
        const m = (totpRaw || '').match(/^[A-Za-z2-7]+/);
        if (m && m[0].length >= 16) totp_secret = m[0];
        out.push({ email, password, recovery_email: recovery || null, totp_secret: totp_secret || null });
    }
    return out;
}

module.exports = async function routes(app) {
    app.get('/api/hosts', async (req) => {
        const { disabled, search, page, pageSize } = req.query;
        return hosts.listHosts({
            disabled,
            search,
            page: page ? parseInt(page, 10) : undefined,
            pageSize: pageSize ? parseInt(pageSize, 10) : undefined,
        });
    });

    app.post('/api/hosts/bulk', async (req, reply) => {
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
                const r = await hosts.upsertHost({
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
};

module.exports.parseLinesToAccounts = parseLinesToAccounts;
