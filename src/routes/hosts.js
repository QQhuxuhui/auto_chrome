const path = require('path');
const { fork } = require('child_process');
const hosts = require('../db/hosts');
const { parseAccounts } = require('../common/state');

// In-memory registry of active "manual login" sessions keyed by hostId, so
// double-clicking 登录 doesn't spawn a second Chrome for the same host (which
// would fail to lock the shared profile dir).
const activeLoginSessions = new Map(); // hostId → { pid, startedAt }

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

    // Spawn a manual-login session for the host: forks host-login.js which
    // launches Chrome, auto-logs-in, opens the family page, then blocks until
    // the user closes the Chrome window. The HTTP request returns as soon as
    // Chrome is spawned — it doesn't wait for the session to end.
    app.post('/api/hosts/:id/login', async (req, reply) => {
        const id = parseInt(req.params.id, 10);
        const host = await hosts.getHostById(id);
        if (!host) return reply.code(404).send({ error: 'host not found' });

        const existing = activeLoginSessions.get(id);
        if (existing) {
            // Is it actually alive? If the child crashed without emitting 'exit'
            // (edge case), fall through by clearing.
            try {
                process.kill(existing.pid, 0);
                return reply.code(409).send({
                    error: `login session already active for ${host.email}`,
                    pid: existing.pid,
                    startedAt: existing.startedAt,
                });
            } catch (_) {
                activeLoginSessions.delete(id);
            }
        }

        const scriptPath = path.resolve(__dirname, '..', 'host-login.js');
        const child = fork(scriptPath, ['--host-id', String(id)], {
            stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
            detached: false,
        });
        const session = { pid: child.pid, startedAt: new Date().toISOString() };
        activeLoginSessions.set(id, session);
        child.on('exit', () => { activeLoginSessions.delete(id); });
        return { hostId: id, email: host.email, pid: child.pid, startedAt: session.startedAt };
    });

    // Expose active sessions so UI can grey out the button / show status.
    app.get('/api/hosts/login-sessions', async () => {
        return Array.from(activeLoginSessions.entries()).map(([hostId, s]) => ({
            hostId, pid: s.pid, startedAt: s.startedAt,
        }));
    });
};

// Backward-compat export (members route imports parseLinesToAccounts from here;
// it's now a thin wrapper over parseAccounts)
module.exports.parseLinesToAccounts = function(text) {
    return parseAccounts(text).map(adaptAccount);
};
