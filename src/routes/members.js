const members = require('../db/members');
const events = require('../db/events');
const { parseLinesToAccounts } = require('./hosts');

module.exports = async function routes(app) {
    app.get('/api/members', async (req) => {
        const { status, host_id, unbound, search, has_token, page, pageSize } = req.query;
        return members.listMembers({
            status,
            hostId: host_id ? parseInt(host_id, 10) : undefined,
            unbound: unbound === '1' || unbound === 'true',
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
        if (action === 'clear_fail_count') {
            const before = await members.getMemberById(id);
            if (!before) return reply.code(404).send({ error: 'not found' });
            const row = await members.clearFailCount(id);
            if (before.fail_count && row) {
                try {
                    await events.logEvent({
                        memberId: id,
                        hostId: row.host_id || null,
                        stage: 'manual',
                        eventType: 'note',
                        message: `manual edit: fail_count cleared (${before.fail_count} → 0)`,
                    });
                } catch (_) { /* audit failure must not break main path */ }
            }
            return row;
        }

        const before = await members.getMemberById(id);
        if (!before) return reply.code(404).send({ error: 'not found' });

        let row;
        try {
            row = await members.updateMember(id, req.body || {});
        } catch (e) {
            return reply.code(400).send({ error: e.message });
        }
        if (!row) return reply.code(404).send({ error: 'not found' });

        // 手动改 status / host_id 时写一条 audit 事件，便于在详情页时间线看到
        const patch = req.body || {};
        const notes = [];
        if (patch.status !== undefined && patch.status !== before.status) {
            notes.push(`status: ${before.status} → ${row.status}`);
        }
        if (patch.host_id !== undefined && Number(patch.host_id || 0) !== Number(before.host_id || 0)) {
            notes.push(`host_id: ${before.host_id || '—'} → ${row.host_id || '—'}`);
        }
        if (notes.length) {
            try {
                await events.logEvent({
                    memberId: id,
                    hostId: row.host_id || null,
                    stage: 'manual',
                    eventType: 'note',
                    message: `manual edit: ${notes.join('; ')}`,
                });
            } catch (_) { /* 审计事件写失败不影响主请求 */ }
        }
        return row;
    });

    app.delete('/api/members/:id', async (req, reply) => {
        const id = parseInt(req.params.id, 10);
        await members.deleteMember(id);
        reply.code(204).send();
    });

    // Batch delete: body { ids: [1,2,...] }. 一次 SQL 搞定，避免前端 loop。
    // 注意：没开事务 —— DELETE 是幂等的，部分成功也无副作用。
    app.post('/api/members/bulk-delete', async (req, reply) => {
        const body = req.body || {};
        const raw = Array.isArray(body.ids) ? body.ids : [];
        const ids = raw
            .map(x => parseInt(x, 10))
            .filter(n => Number.isInteger(n) && n > 0);
        if (!ids.length) return reply.code(400).send({ error: 'ids required (non-empty array)' });
        const deleted = await members.deleteMembersByIds(ids);
        return { requested: ids.length, deleted };
    });
};
