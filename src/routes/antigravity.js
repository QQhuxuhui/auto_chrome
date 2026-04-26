const sync = require('../sync/antigravity-sync');
const antigravityClient = require('../common/antigravity');
const membersDb = require('../db/members');
const events = require('../db/events');

module.exports = async function routes(app) {
    app.post('/api/antigravity/sync', async () => {
        return sync.syncFromRemote({ ownerId: app.workerId });
    });

    app.post('/api/antigravity/push/:id', async (req, reply) => {
        const id = parseInt(req.params.id, 10);
        const r = await sync.pushAccount(id, { ownerId: app.workerId });
        if (!r.success) return reply.code(400).send(r);
        return r;
    });

    app.post('/api/antigravity/push-all', async () => {
        return sync.pushAllPending({ ownerId: app.workerId });
    });

    app.delete('/api/antigravity/account/:id', async (req, reply) => {
        const id = parseInt(req.params.id, 10);
        const r = await sync.deleteAccount(id, { ownerId: app.workerId });
        if (!r.success) return reply.code(400).send(r);
        return r;
    });

    // 只读 orphans: 平台有、本地（owner=我）没有的账号。多租户下 orphan 可能是
    // 别的 worker 推上去的——本机看不到他们的 local 行,所以无法可靠区分"我自己
    // 丢了 local"和"别人的账号"。这里只做信息展示,清理路径不再 orphan_delete。
    app.get('/api/antigravity/orphans', async () => {
        const { accounts = [] } = await antigravityClient.listAccounts();
        const emails = accounts.map(a => a.email).filter(Boolean);
        const locals = await membersDb.listMembersByEmailLower(emails, { ownerId: app.workerId });
        const localSet = new Set(locals.map(m => m.email.toLowerCase()));
        const orphans = accounts
            .filter(a => !localSet.has(String(a.email).toLowerCase()))
            .map(a => ({ id: a.id, email: a.email, disabled: a.disabled, validation_blocked: a.validation_blocked }));
        return orphans;
    });

    // 简化清理（dashboard "执行清理" 用）：
    //   1. 拉 Antigravity 账号列表
    //   2. 找出"不可用"账号:disabled / quota.is_forbidden / proxy_disabled
    //   3. 从平台 DELETE 这些账号
    //   4. 本地匹配到的 member：host_id=null + status='abandoned' + 清 antigravity JSONB
    // 这是一条纯 API 路径，不登录 Chrome、不扫 family 页 —— 跟 /api/reconcile 的
    // Chrome 家庭组重对账是两件事。那个还在，给将来需要同步 Google 家庭组用。
    app.post('/api/antigravity/cleanup', async (req) => {
        const { dryRun = false } = req.body || {};
        const owner = { ownerId: app.workerId };
        const { accounts = [] } = await antigravityClient.listAccounts();
        const unusable = accounts.filter(a =>
            a.disabled
            || (a.quota && a.quota.is_forbidden)
            || a.proxy_disabled
        );

        const emailsLower = unusable.map(a => String(a.email || '').toLowerCase()).filter(Boolean);
        // Only match against local members owned by this worker. Foreign-owned
        // platform accounts intentionally appear as `local=null` below — we
        // skip platform DELETE for them too, because we can't tell whether
        // they're truly orphan or owned by another worker.
        const locals = emailsLower.length ? await membersDb.listMembersByEmailLower(emailsLower, owner) : [];
        const localByEmail = new Map(locals.map(m => [m.email.toLowerCase(), m]));

        const out = {
            total_unusable: unusable.length,
            platform_deleted: [],
            platform_delete_failed: [],
            local_updated: [],
            local_unchanged: [],
            skipped_foreign: [],  // multi-tenant safety: not ours, didn't touch
            dry_run: !!dryRun,
        };

        for (const acct of unusable) {
            const email = acct.email;
            const emailLower = String(email || '').toLowerCase();
            const local = localByEmail.get(emailLower);
            // Reason precedence:disabled > is_forbidden > proxy_disabled。
            // 一个账号可能多旗标同时为真,展示用最严重的那个。
            const reason = acct.disabled
                ? `disabled: ${acct.disabled_reason || 'unknown'}`
                : (acct.quota && acct.quota.is_forbidden)
                    ? 'quota_forbidden'
                    : `proxy_disabled: ${acct.proxy_disabled_reason || 'unknown'}`;

            // No matching local owned by this worker → could be foreign,
            // could be true orphan. Either way, refuse to delete platform
            // account that isn't tied to a local row we own. Operators on
            // dedicated installs can still clean up via direct API if needed.
            if (!local) {
                out.skipped_foreign.push({ email, id: acct.id, reason });
                continue;
            }

            // 1) 先 DELETE 平台
            if (!dryRun) {
                try {
                    await antigravityClient.deleteAccount(acct.id);
                    out.platform_deleted.push({ email, id: acct.id, reason });
                } catch (e) {
                    out.platform_delete_failed.push({ email, id: acct.id, error: e.message, status: e.status });
                    // DELETE 失败就不碰本地了，避免本地已废弃但平台没删的错位
                    continue;
                }
            } else {
                out.platform_deleted.push({ email, id: acct.id, reason, dry_run: true });
            }

            // 2) 再更本地（仅 matched）
            const needsStatusChange = !['abandoned', 'removed_from_family'].includes(local.status);
            const needsUnbind = local.host_id != null;

            if (!needsStatusChange && !needsUnbind) {
                out.local_unchanged.push({ email, reason: 'already abandoned + unbound' });
                continue;
            }

            if (!dryRun) {
                try {
                    const patch = {};
                    if (needsUnbind) patch.host_id = null;
                    if (needsStatusChange) patch.status = 'abandoned';
                    await membersDb.updateMember(local.id, patch, owner);
                    // 清 antigravity JSONB 里残留的平台 id / 各种禁用旗标
                    await membersDb.updateAntigravity(local.id, {
                        id: null,
                        disabled: false, disabled_reason: null,
                        is_forbidden: false, forbidden_reason: null,
                        proxy_disabled: false, proxy_disabled_reason: null, proxy_disabled_at: null,
                    }, owner);
                    try {
                        await events.logEvent({
                            memberId: local.id,
                            hostId: local.host_id || null,
                            stage: 'cleanup',
                            eventType: 'note',
                            message: `antigravity cleanup: ${reason}; unbind+abandoned`,
                        });
                    } catch (_) { /* audit failure must not break main path */ }
                    out.local_updated.push({ email, previous_status: local.status, previous_host_id: local.host_id });
                } catch (e) {
                    out.local_unchanged.push({ email, error: e.message });
                }
            } else {
                out.local_updated.push({
                    email, previous_status: local.status, previous_host_id: local.host_id, dry_run: true,
                });
            }
        }

        return out;
    });

    app.get('/api/antigravity/stats', async () => {
        const { accounts = [] } = await antigravityClient.listAccounts();
        const total = accounts.length;
        const disabled = accounts.filter(a => a.disabled).length;
        const proxy_disabled = accounts.filter(a => a.proxy_disabled).length;
        const validation_blocked = accounts.filter(a => a.validation_blocked).length;
        const is_forbidden = accounts.filter(a => a.quota && a.quota.is_forbidden).length;
        const emails = accounts.map(a => a.email).filter(Boolean);
        // Owner-filtered orphan count: platform accounts not in MY local. May
        // include foreign-owned (other workers' pushes); informational only.
        const locals = await membersDb.listMembersByEmailLower(emails, { ownerId: app.workerId });
        const localSet = new Set(locals.map(m => m.email.toLowerCase()));
        const orphans = accounts.filter(a => !localSet.has(String(a.email).toLowerCase())).length;
        return { total, disabled, proxy_disabled, validation_blocked, is_forbidden, orphans };
    });
};
