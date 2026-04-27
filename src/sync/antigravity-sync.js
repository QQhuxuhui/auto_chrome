/**
 * Antigravity 同步逻辑。
 * 从平台 pull 账号状态并 merge 到本地 members.antigravity JSONB。
 * Push：把本地 status='done' 的子号推到平台。
 */
const antigravity = require('../common/antigravity');
const membersDb = require('../db/members');

function pickMirror(acct) {
    return {
        id: acct.id,
        disabled: !!acct.disabled,
        disabled_reason: acct.disabled_reason || null,
        disabled_at: acct.disabled_at || null,
        // proxy_disabled 是平台另一种"软禁用":refresh_token 还在,但代理配置被批量
        // 关掉 → 实际不可用。运营上视同 disabled,纳入 cleanup 范围。
        proxy_disabled: !!acct.proxy_disabled,
        proxy_disabled_reason: acct.proxy_disabled_reason || null,
        proxy_disabled_at: acct.proxy_disabled_at || null,
        validation_blocked: !!acct.validation_blocked,
        validation_blocked_until: acct.validation_blocked_until || null,
        validation_blocked_reason: acct.validation_blocked_reason || null,
        is_forbidden: !!(acct.quota && acct.quota.is_forbidden),
        forbidden_reason: (acct.quota && acct.quota.forbidden_reason) || null,
        last_synced_at: new Date().toISOString(),
    };
}

async function syncFromRemote() {
    const { accounts = [] } = await antigravity.listAccounts();
    const emailsLower = accounts.map(a => String(a.email || '').toLowerCase()).filter(Boolean);
    const locals = await membersDb.listMembersByEmailLower(emailsLower);
    const localByEmail = new Map(locals.map(m => [m.email.toLowerCase(), m]));

    const out = { matched: 0, updated: 0, newly_disabled: [], newly_forbidden: [], newly_proxy_disabled: [], orphans: [] };

    for (const acct of accounts) {
        const emailLower = String(acct.email || '').toLowerCase();
        if (!emailLower) continue;
        const local = localByEmail.get(emailLower);
        if (!local) {
            out.orphans.push(acct.email);
            continue;
        }
        out.matched++;
        const wasDisabled = !!(local.antigravity && local.antigravity.disabled);
        const wasForbidden = !!(local.antigravity && local.antigravity.is_forbidden);
        const wasProxyDisabled = !!(local.antigravity && local.antigravity.proxy_disabled);
        const mirror = pickMirror(acct);
        await membersDb.updateAntigravity(local.id, mirror);
        out.updated++;
        if (!wasDisabled && mirror.disabled) {
            out.newly_disabled.push({ memberId: local.id, email: local.email, reason: mirror.disabled_reason });
        }
        // quota.is_forbidden 0→1 也当封禁上报（运营上视同 disabled）
        if (!wasForbidden && mirror.is_forbidden) {
            out.newly_forbidden.push({ memberId: local.id, email: local.email, reason: mirror.forbidden_reason });
        }
        if (!wasProxyDisabled && mirror.proxy_disabled) {
            out.newly_proxy_disabled.push({ memberId: local.id, email: local.email, reason: mirror.proxy_disabled_reason });
        }
    }
    return out;
}

async function pushAccount(memberId) {
    const member = await membersDb.getMemberById(memberId);
    if (!member) return { success: false, error: 'member not found' };
    if (member.status !== 'done') {
        return { success: false, error: `member status=${member.status}, expected 'done'` };
    }
    if (!member.token) {
        return { success: false, error: 'member has no token' };
    }
    try {
        const resp = await antigravity.pushAccount({ refreshToken: member.token });
        const partial = {
            id: resp.id,
            pushed_at: new Date().toISOString(),
            push_error: null,
            disabled: !!resp.disabled,
            disabled_reason: resp.disabled_reason || null,
            validation_blocked: !!resp.validation_blocked,
            last_synced_at: new Date().toISOString(),
        };
        await membersDb.updateAntigravity(memberId, partial);
        return { success: true };
    } catch (e) {
        const partial = {
            push_error: {
                at: new Date().toISOString(),
                status: e.status || 0,
                message: e.message || String(e),
            },
        };
        await membersDb.updateAntigravity(memberId, partial);
        return { success: false, error: e.message };
    }
}

async function pushAllPending() {
    const pending = await membersDb.listMembersNeedingPush();
    const out = { total: pending.length, pushed: 0, failed: 0, errors: [] };
    for (const m of pending) {
        const r = await pushAccount(m.id);
        if (r.success) out.pushed++;
        else {
            out.failed++;
            out.errors.push({ memberId: m.id, email: m.email, error: r.error });
        }
    }
    return out;
}

async function deleteAccount(memberId) {
    const member = await membersDb.getMemberById(memberId);
    if (!member) return { success: false, error: 'member not found' };
    const agId = member.antigravity && member.antigravity.id;
    if (!agId) return { success: false, error: 'member has no antigravity.id' };
    try {
        await antigravity.deleteAccount(agId);
        await membersDb.updateAntigravity(memberId, { id: null, disabled: false, disabled_reason: null });
        return { success: true };
    } catch (e) {
        return { success: false, error: e.message, status: e.status };
    }
}

module.exports = { syncFromRemote, pushAccount, pushAllPending, deleteAccount, pickMirror };
