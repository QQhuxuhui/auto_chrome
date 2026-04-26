/**
 * Member (子号) query module.
 * Implements the state-machine transitions from spec §3.
 *
 * Multi-tenant: every read/write accepts an optional `ownerId` (the per-install
 * worker_id; see common/worker-id.js). When provided, SELECTs filter and INSERTs
 * stamp `owner_worker_id`. When omitted (legacy callers/tests), behavior is
 * unchanged — the row pool is global. All production routes / orchestrator
 * stages MUST pass ownerId so users sharing the cloud DB don't see or mutate
 * each other's accounts. Forgetting it silently disables isolation.
 */
const db = require('./index');
const { currentOwnerId } = require('../common/owner-context');

const ABANDON_THRESHOLD = 3;

function mapRow(row) {
    if (!row) return null;
    return { ...row };
}

// Resolve the effective ownerId for a query. Explicit > ALS context > null.
// Returning null means "no filter" (legacy behavior; tests rely on this).
function effectiveOwnerId(passed) {
    if (passed !== undefined) return passed;
    return currentOwnerId();
}

// Helper: when ownerId is provided (or available via ALS), push it to params
// and return the SQL fragment to append. When neither, returns empty string
// so the query stays unfiltered (legacy behavior).
function ownerAndClause(ownerId, params, column = 'owner_worker_id') {
    const eff = effectiveOwnerId(ownerId);
    if (eff === undefined || eff === null) return '';
    params.push(eff);
    return ` AND ${column} = $${params.length}`;
}

async function listMembers({ status, hostId, unbound, search, hasToken, ownerId, page = 1, pageSize = 500 } = {}) {
    ownerId = effectiveOwnerId(ownerId);
    const params = [];
    const where = ['TRUE'];
    if (ownerId !== undefined && ownerId !== null) {
        params.push(ownerId);
        where.push(`owner_worker_id = $${params.length}`);
    }
    if (status) {
        const arr = Array.isArray(status) ? status : String(status).split(',').map(s => s.trim()).filter(Boolean);
        params.push(arr);
        where.push(`status = ANY($${params.length})`);
    }
    // `unbound` 比 hostId 优先：调用方要么指定 host，要么明确要"没绑 host 的"，
    // 两者互斥，同时给就只看 unbound。
    if (unbound) {
        where.push(`host_id IS NULL`);
    } else if (hostId) {
        params.push(hostId);
        where.push(`host_id = $${params.length}`);
    }
    if (search) {
        params.push(`%${search}%`);
        where.push(`email ILIKE $${params.length}`);
    }
    if (hasToken !== undefined) {
        if (hasToken === true || hasToken === 1 || hasToken === '1') {
            where.push(`token IS NOT NULL`);
        } else {
            where.push(`token IS NULL`);
        }
    }
    const offset = (page - 1) * pageSize;
    params.push(pageSize, offset);
    const sql = `
        SELECT * FROM members
        WHERE ${where.join(' AND ')}
        ORDER BY id ASC
        LIMIT $${params.length - 1} OFFSET $${params.length}
    `;
    const { rows } = await db.query(sql, params);
    return rows.map(mapRow);
}

async function getMemberById(id, { ownerId } = {}) {
    const params = [id];
    const ownerClause = ownerAndClause(ownerId, params);
    const { rows } = await db.query(
        `SELECT * FROM members WHERE id = $1${ownerClause}`,
        params
    );
    return rows[0] ? mapRow(rows[0]) : null;
}

async function upsertMember({ email, password, recovery_email, totp_secret, notes, owner_worker_id }) {
    if (owner_worker_id === undefined) owner_worker_id = currentOwnerId();
    const sql = `
        INSERT INTO members (email, password, recovery_email, totp_secret, notes, owner_worker_id)
        VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT (email) DO NOTHING
        RETURNING *
    `;
    const { rows } = await db.query(sql, [
        email, password, recovery_email || null, totp_secret || null, notes || null,
        owner_worker_id || null,
    ]);
    if (rows.length === 0) {
        // Email is globally unique. If a different tenant already owns this
        // email, return a "skipped" result without leaking their row data.
        const existing = await db.query('SELECT * FROM members WHERE email = $1', [email]);
        const row = existing.rows[0];
        if (owner_worker_id && row && row.owner_worker_id && row.owner_worker_id !== owner_worker_id) {
            return { inserted: false, skipped: true, member: null, conflict: 'foreign_owner' };
        }
        return { inserted: false, skipped: true, member: mapRow(row) };
    }
    return { inserted: true, skipped: false, member: mapRow(rows[0]) };
}

const VALID_STATUSES = new Set([
    'new', 'invite_pending', 'invite_failed', 'joined',
    'accept_failed', 'oauth_failed', 'done', 'abandoned', 'removed_from_family',
    'join_failed_region', 'sold',
]);

// Archived terminal states semantically mean "no longer in this host's family".
// Setting one of these via the generic patch path must also clear host_id,
// otherwise the row stays bound but is excluded from SLOT_STATUSES — so the
// host appears to have a free slot in the UI / quick-bind / Stage 1 picker
// while still being at 5/5 on Google's side.
const ARCHIVED_STATUSES = new Set(['sold', 'abandoned', 'removed_from_family']);

async function updateMember(id, patch, { ownerId } = {}) {
    const allowed = ['password', 'recovery_email', 'totp_secret', 'notes', 'status', 'host_id'];
    const sets = [];
    const params = [];
    let archivingTransition = false;
    for (const k of allowed) {
        if (patch[k] === undefined) continue;
        let v = patch[k];
        if (k === 'status') {
            if (!VALID_STATUSES.has(v)) {
                throw new Error(`invalid status: ${v}`);
            }
            if (ARCHIVED_STATUSES.has(v)) archivingTransition = true;
        }
        if (k === 'host_id') {
            v = v === null || v === '' ? null : parseInt(v, 10);
            if (v !== null && (!Number.isInteger(v) || v <= 0)) {
                throw new Error(`invalid host_id: ${patch[k]}`);
            }
        }
        params.push(v);
        sets.push(`${k} = $${params.length}`);
    }
    // Archived state semantically means "no longer in this host's family" —
    // it's a logical contradiction to keep host_id non-null. Force-clear
    // unconditionally (overriding any host_id the caller passed), otherwise
    // SLOT_STATUSES misses the row and the host appears to have a free slot
    // while the member is still bound. The frontend edit drawer always
    // submits both fields, which used to bypass an "if host_id absent" guard.
    if (archivingTransition) {
        const hostIdSetIdx = sets.findIndex(s => s.startsWith('host_id ='));
        if (hostIdSetIdx >= 0) {
            const matched = sets[hostIdSetIdx].match(/^host_id = \$(\d+)$/);
            if (matched) {
                params[parseInt(matched[1], 10) - 1] = null;
            }
        } else {
            params.push(null);
            sets.push(`host_id = $${params.length}`);
        }
    }
    if (sets.length === 0) return getMemberById(id, { ownerId });
    sets.push(`updated_at = NOW()`);
    params.push(id);
    const idIdx = params.length;
    const ownerClause = ownerAndClause(ownerId, params);
    const sql = `UPDATE members SET ${sets.join(', ')} WHERE id = $${idIdx}${ownerClause} RETURNING *`;
    const { rows } = await db.query(sql, params);
    return rows[0] ? mapRow(rows[0]) : null;
}

async function deleteMember(id, { ownerId } = {}) {
    const params = [id];
    const ownerClause = ownerAndClause(ownerId, params);
    await db.query(`DELETE FROM members WHERE id = $1${ownerClause}`, params);
}

async function deleteMembersByIds(ids, { ownerId } = {}) {
    if (!Array.isArray(ids) || ids.length === 0) return 0;
    const params = [ids];
    const ownerClause = ownerAndClause(ownerId, params);
    const { rowCount } = await db.query(
        `DELETE FROM members WHERE id = ANY($1::bigint[])${ownerClause}`,
        params
    );
    return rowCount || 0;
}

/**
 * Batch-bind up to `count` members (status='new' AND host_id IS NULL) to a
 * given host, transitioning them to 'invite_pending' in a single UPDATE.
 * Used by the "一键添加子号" button on the hosts page — skips Stage 1 Chrome
 * invite; Stage 2 / manual ops pick them up from here.
 * Returns the rows actually bound (may be fewer than `count` if the pool is
 * smaller). Caller is responsible for family-cap enforcement.
 */
async function quickBindNewMembersToHost(hostId, count, { ownerId } = {}) {
    if (!Number.isInteger(count) || count <= 0) return [];
    ownerId = effectiveOwnerId(ownerId);
    const params = [hostId, count];
    let ownerClause = '';
    if (ownerId !== undefined && ownerId !== null) {
        params.push(ownerId);
        ownerClause = ` AND owner_worker_id = $${params.length}`;
    }
    const sql = `
        UPDATE members m
        SET status = 'invite_pending',
            host_id = $1,
            invited_at = NOW(),
            updated_at = NOW()
        FROM (
            SELECT id FROM members
            WHERE status = 'new' AND host_id IS NULL${ownerClause}
            ORDER BY id ASC
            LIMIT $2
            FOR UPDATE SKIP LOCKED
        ) AS pick
        WHERE m.id = pick.id
        RETURNING m.id, m.email
    `;
    const { rows } = await db.query(sql, params);
    return rows;
}

async function transitionToInvitePending(memberId, hostId, { ownerId } = {}) {
    const params = [memberId, hostId];
    const ownerClause = ownerAndClause(ownerId, params);
    const sql = `
        UPDATE members
        SET status = 'invite_pending', host_id = $2, invited_at = NOW(), updated_at = NOW()
        WHERE id = $1${ownerClause}
        RETURNING *
    `;
    const { rows } = await db.query(sql, params);
    return mapRow(rows[0]);
}

async function transitionToJoined(memberId, { ownerId } = {}) {
    const params = [memberId];
    const ownerClause = ownerAndClause(ownerId, params);
    const sql = `
        UPDATE members
        SET status = 'joined', joined_at = NOW(), updated_at = NOW()
        WHERE id = $1${ownerClause}
        RETURNING *
    `;
    const { rows } = await db.query(sql, params);
    return mapRow(rows[0]);
}

async function transitionToDone(memberId, token, tokenMeta, { ownerId } = {}) {
    const params = [memberId, token, tokenMeta || {}];
    const ownerClause = ownerAndClause(ownerId, params);
    const sql = `
        UPDATE members
        SET status = 'done', token = $2, token_meta = $3, done_at = NOW(), updated_at = NOW()
        WHERE id = $1${ownerClause}
        RETURNING *
    `;
    const { rows } = await db.query(sql, params);
    return mapRow(rows[0]);
}

async function transitionToFailed(memberId, { newStatus, error, releaseHost, ownerId }) {
    const params = [memberId, newStatus, error || null, ABANDON_THRESHOLD, !!releaseHost];
    const ownerClause = ownerAndClause(ownerId, params);
    const sql = `
        UPDATE members
        SET status = CASE WHEN fail_count + 1 >= $4 THEN 'abandoned' ELSE $2 END,
            fail_count = fail_count + 1,
            last_error = $3,
            last_error_at = NOW(),
            host_id = CASE WHEN $5 THEN NULL ELSE host_id END,
            updated_at = NOW()
        WHERE id = $1${ownerClause}
        RETURNING *
    `;
    const { rows } = await db.query(sql, params);
    return mapRow(rows[0]);
}

async function markRemovedFromFamily(memberId, { ownerId } = {}) {
    const params = [memberId];
    const ownerClause = ownerAndClause(ownerId, params);
    const sql = `
        UPDATE members
        SET status = 'removed_from_family', host_id = NULL, updated_at = NOW()
        WHERE id = $1${ownerClause}
        RETURNING *
    `;
    const { rows } = await db.query(sql, params);
    return mapRow(rows[0]);
}

async function resetMember(memberId, { ownerId } = {}) {
    const params = [memberId];
    const ownerClause = ownerAndClause(ownerId, params);
    const sql = `
        UPDATE members
        SET status = 'new',
            host_id = NULL,
            fail_count = 0,
            last_error = NULL,
            last_error_at = NULL,
            invited_at = NULL,
            joined_at = NULL,
            done_at = NULL,
            updated_at = NOW()
        WHERE id = $1${ownerClause}
        RETURNING *
    `;
    const { rows } = await db.query(sql, params);
    return mapRow(rows[0]);
}

/**
 * Clear fail_count + last_error without touching status/host_id. Lets an
 * operator take a member that crossed the ABANDON_THRESHOLD and put it back
 * in play for the next stage run without losing any other state.
 */
async function clearFailCount(memberId, { ownerId } = {}) {
    const params = [memberId];
    const ownerClause = ownerAndClause(ownerId, params);
    const sql = `
        UPDATE members
        SET fail_count = 0, last_error = NULL, last_error_at = NULL, updated_at = NOW()
        WHERE id = $1${ownerClause}
        RETURNING *
    `;
    const { rows } = await db.query(sql, params);
    return mapRow(rows[0]);
}

async function abandonMember(memberId, { ownerId } = {}) {
    const params = [memberId];
    const ownerClause = ownerAndClause(ownerId, params);
    const sql = `
        UPDATE members
        SET status = 'abandoned', host_id = NULL, updated_at = NOW()
        WHERE id = $1${ownerClause}
        RETURNING *
    `;
    const { rows } = await db.query(sql, params);
    return mapRow(rows[0]);
}

async function updateAntigravity(memberId, partial, { ownerId } = {}) {
    const params = [memberId, partial];
    const ownerClause = ownerAndClause(ownerId, params);
    // JSONB 合并: 已有值 || partial（partial 优先）
    const sql = `
        UPDATE members
        SET antigravity = COALESCE(antigravity, '{}'::jsonb) || $2::jsonb,
            updated_at = NOW()
        WHERE id = $1${ownerClause}
        RETURNING *
    `;
    const { rows } = await db.query(sql, params);
    return mapRow(rows[0]);
}

async function listMembersByEmailLower(emails, { ownerId } = {}) {
    if (!emails || !emails.length) return [];
    const lowered = emails.map(e => String(e).toLowerCase());
    const params = [lowered];
    const ownerClause = ownerAndClause(ownerId, params);
    const { rows } = await db.query(
        `SELECT * FROM members WHERE LOWER(email) = ANY($1)${ownerClause}`,
        params
    );
    return rows.map(mapRow);
}

async function listMembersNeedingPush({ ownerId } = {}) {
    ownerId = effectiveOwnerId(ownerId);
    const params = [];
    let ownerClause = '';
    if (ownerId !== undefined && ownerId !== null) {
        params.push(ownerId);
        ownerClause = ` AND owner_worker_id = $${params.length}`;
    }
    const sql = `
        SELECT * FROM members
        WHERE status = 'done'
          AND token IS NOT NULL
          AND (antigravity IS NULL OR antigravity->>'id' IS NULL)${ownerClause}
        ORDER BY done_at ASC
    `;
    const { rows } = await db.query(sql, params);
    return rows.map(mapRow);
}

/**
 * Return distinct host_ids that currently own at least one member qualifying
 * for family-removal. Used by "执行清理" to avoid logging into every enabled
 * host when only a few carry banned members.
 */
async function listHostIdsNeedingCleanup({ ownerId } = {}) {
    ownerId = effectiveOwnerId(ownerId);
    const params = [];
    let ownerClause = '';
    if (ownerId !== undefined && ownerId !== null) {
        params.push(ownerId);
        ownerClause = ` AND owner_worker_id = $${params.length}`;
    }
    const sql = `
        SELECT DISTINCT host_id
        FROM members
        WHERE host_id IS NOT NULL
          AND status IN ('joined','done','oauth_failed')
          AND (
            antigravity->>'disabled' = 'true'
            OR antigravity->>'is_forbidden' = 'true'
            OR antigravity->>'proxy_disabled' = 'true'
          )${ownerClause}
        ORDER BY host_id
    `;
    const { rows } = await db.query(sql, params);
    return rows.map(r => r.host_id);
}

async function listMembersNeedingFamilyRemoval(hostId, { ownerId } = {}) {
    // "需要清理" = 平台已不可恢复:
    //   - disabled=true (refresh_token invalid_grant 等)
    //   - quota.is_forbidden=true (credits 耗尽,运营上视同封禁)
    //   - proxy_disabled=true (平台代理被批量禁用,也视同不可用)
    // 这些 reconcile 都会从 host 家庭组踢掉 + 从平台 DELETE + 本地标 removed_from_family。
    const params = [hostId];
    const ownerClause = ownerAndClause(ownerId, params);
    const sql = `
        SELECT * FROM members
        WHERE host_id = $1
          AND status IN ('joined','done','oauth_failed')
          AND (
            antigravity->>'disabled' = 'true'
            OR antigravity->>'is_forbidden' = 'true'
            OR antigravity->>'proxy_disabled' = 'true'
          )${ownerClause}
        ORDER BY id ASC
    `;
    const { rows } = await db.query(sql, params);
    return rows.map(mapRow);
}

async function listMembersForStage(stage, { hostIds, ownerId } = {}) {
    const s = String(stage);
    const useHostFilter = Array.isArray(hostIds);
    let sql, params;
    // Owner clause is appended inline (different param positions per stage).
    if (s === '1') {
        params = [ABANDON_THRESHOLD];
        const ownerClause = ownerAndClause(ownerId, params);
        // Stage 1: host assigned at runtime via pickHost; host filter not applicable here.
        sql = `
            SELECT * FROM members
            WHERE status IN ('new','invite_failed') AND fail_count < $1${ownerClause}
            ORDER BY created_at ASC
        `;
    } else if (s === '2') {
        if (useHostFilter) {
            params = [hostIds];
            const ownerClause = ownerAndClause(ownerId, params);
            sql = `
                SELECT * FROM members
                WHERE status = 'invite_pending' AND host_id = ANY($1)${ownerClause}
                ORDER BY invited_at ASC NULLS FIRST
            `;
        } else {
            params = [];
            const ownerClause = ownerAndClause(ownerId, params);
            sql = `
                SELECT * FROM members
                WHERE status = 'invite_pending' AND host_id IS NOT NULL${ownerClause}
                ORDER BY invited_at ASC NULLS FIRST
            `;
        }
    } else if (s === '3') {
        if (useHostFilter) {
            params = [ABANDON_THRESHOLD, hostIds];
            const ownerClause = ownerAndClause(ownerId, params);
            sql = `
                SELECT * FROM members
                WHERE status IN ('joined','oauth_failed') AND fail_count < $1 AND host_id = ANY($2)${ownerClause}
                ORDER BY joined_at ASC NULLS LAST, updated_at ASC
            `;
        } else {
            params = [ABANDON_THRESHOLD];
            const ownerClause = ownerAndClause(ownerId, params);
            sql = `
                SELECT * FROM members
                WHERE status IN ('joined','oauth_failed') AND fail_count < $1${ownerClause}
                ORDER BY joined_at ASC NULLS LAST, updated_at ASC
            `;
        }
    } else {
        throw new Error(`listMembersForStage: invalid stage ${stage}`);
    }
    const { rows } = await db.query(sql, params);
    return rows.map(mapRow);
}

async function countByStatus({ ownerId } = {}) {
    ownerId = effectiveOwnerId(ownerId);
    const params = [];
    let where = '';
    if (ownerId !== undefined && ownerId !== null) {
        params.push(ownerId);
        where = `WHERE owner_worker_id = $${params.length}`;
    }
    const { rows } = await db.query(
        `SELECT status, COUNT(*)::int AS n FROM members ${where} GROUP BY status`,
        params
    );
    const out = {};
    for (const r of rows) out[r.status] = r.n;
    return out;
}

module.exports = {
    listMembers,
    getMemberById,
    upsertMember,
    updateMember,
    deleteMember,
    deleteMembersByIds,
    transitionToInvitePending,
    transitionToJoined,
    transitionToDone,
    transitionToFailed,
    markRemovedFromFamily,
    resetMember,
    abandonMember,
    clearFailCount,
    updateAntigravity,
    listMembersByEmailLower,
    listMembersNeedingPush,
    listMembersNeedingFamilyRemoval,
    listHostIdsNeedingCleanup,
    quickBindNewMembersToHost,
    listMembersForStage,
    countByStatus,
    ABANDON_THRESHOLD,
};
