const path = require('path');
const { fork } = require('child_process');
const hosts = require('../db/hosts');
const members = require('../db/members');
const events = require('../db/events');
const { parseAccounts } = require('../common/state');

const FAMILY_CAP = 5;

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
                    owner_worker_id: app.workerId,
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
        const row = await hosts.updateHost(id, req.body || {}, { ownerId: app.workerId });
        if (!row) return reply.code(404).send({ error: 'not found' });
        return row;
    });

    app.delete('/api/hosts/:id', async (req, reply) => {
        const id = parseInt(req.params.id, 10);
        await hosts.deleteHost(id, { ownerId: app.workerId });
        reply.code(204).send();
    });

    app.get('/api/hosts', async (req) => {
        const { disabled, search, page, pageSize } = req.query;
        return hosts.listHosts({
            disabled,
            search,
            page: page ? parseInt(page, 10) : undefined,
            pageSize: pageSize ? parseInt(pageSize, 10) : undefined,
            ownerId: app.workerId,
        });
    });

    // Spawn a manual-login session for the host: forks host-login.js which
    // launches Chrome, auto-logs-in, opens the family page, then blocks until
    // the user closes the Chrome window. The HTTP request returns as soon as
    // Chrome is spawned — it doesn't wait for the session to end.
    app.post('/api/hosts/:id/login', async (req, reply) => {
        const id = parseInt(req.params.id, 10);
        const host = await hosts.getHostById(id, { ownerId: app.workerId });
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

    // "一键添加子号": batch-bind N 个 status=new 未绑 member 到这个 host，转成
    // invite_pending。不动 Chrome、不发真实邀请 —— 纯 DB 操作，让操作员跳过
    // Stage 1 直接准备 Stage 2。N 默认 = 5 - slot_used（填满家庭上限），也可以
    // 通过 body { count: N } 覆盖（仍被 slot_free clamp）。
    app.post('/api/hosts/:id/quick-bind', async (req, reply) => {
        const id = parseInt(req.params.id, 10);
        const host = await hosts.getHostById(id, { ownerId: app.workerId });
        if (!host) return reply.code(404).send({ error: 'host not found' });
        if (host.disabled) return reply.code(400).send({ error: `host ${host.email} is disabled` });

        const slotFree = Math.max(0, FAMILY_CAP - Number(host.slot_used || 0));
        if (slotFree <= 0) {
            return reply.code(400).send({
                error: `host ${host.email} already at ${host.slot_used}/${FAMILY_CAP}, no slot free`,
                slot_used: host.slot_used,
            });
        }

        const body = req.body || {};
        const requested = Number.isFinite(Number(body.count)) && Number(body.count) > 0
            ? Math.floor(Number(body.count))
            : slotFree;
        const take = Math.min(requested, slotFree);

        const bound = await members.quickBindNewMembersToHost(id, take, { ownerId: app.workerId });

        // Audit 事件：每个被绑定的 member 写一条 manual 记录
        for (const m of bound) {
            try {
                await events.logEvent({
                    memberId: m.id,
                    hostId: id,
                    stage: 'manual',
                    eventType: 'note',
                    message: `quick-bind: status new → invite_pending, bound to host ${host.email}`,
                });
            } catch (_) { /* audit failure must not break main path */ }
        }

        return {
            hostId: id,
            email: host.email,
            slot_was_free: slotFree,
            requested: take,
            bound: bound.length,
            shortfall: take - bound.length,  // >0 means pool ran out mid-operation
            members: bound,
        };
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
