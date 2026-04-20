/**
 * Member (子号) query module.
 * Implements the state-machine transitions from spec §3.
 */
const db = require('./index');

const ABANDON_THRESHOLD = 3;

function mapRow(row) {
    if (!row) return null;
    return { ...row };
}

async function listMembers({ status, hostId, search, hasToken, page = 1, pageSize = 500 } = {}) {
    const params = [];
    const where = ['TRUE'];
    if (status) {
        const arr = Array.isArray(status) ? status : String(status).split(',').map(s => s.trim()).filter(Boolean);
        params.push(arr);
        where.push(`status = ANY($${params.length})`);
    }
    if (hostId) {
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

async function getMemberById(id) {
    const { rows } = await db.query('SELECT * FROM members WHERE id = $1', [id]);
    return rows[0] ? mapRow(rows[0]) : null;
}

async function upsertMember({ email, password, recovery_email, totp_secret, notes }) {
    const sql = `
        INSERT INTO members (email, password, recovery_email, totp_secret, notes)
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (email) DO NOTHING
        RETURNING *
    `;
    const { rows } = await db.query(sql, [
        email, password, recovery_email || null, totp_secret || null, notes || null,
    ]);
    if (rows.length === 0) {
        const existing = await db.query('SELECT * FROM members WHERE email = $1', [email]);
        return { inserted: false, skipped: true, member: mapRow(existing.rows[0]) };
    }
    return { inserted: true, skipped: false, member: mapRow(rows[0]) };
}

const VALID_STATUSES = new Set([
    'new', 'invite_pending', 'invite_failed', 'joined',
    'accept_failed', 'oauth_failed', 'done', 'abandoned', 'removed_from_family',
]);

async function updateMember(id, patch) {
    const allowed = ['password', 'recovery_email', 'totp_secret', 'notes', 'status', 'host_id'];
    const sets = [];
    const params = [];
    for (const k of allowed) {
        if (patch[k] === undefined) continue;
        let v = patch[k];
        if (k === 'status') {
            if (!VALID_STATUSES.has(v)) {
                throw new Error(`invalid status: ${v}`);
            }
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
    if (sets.length === 0) return getMemberById(id);
    sets.push(`updated_at = NOW()`);
    params.push(id);
    const sql = `UPDATE members SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING *`;
    const { rows } = await db.query(sql, params);
    return rows[0] ? mapRow(rows[0]) : null;
}

async function deleteMember(id) {
    await db.query('DELETE FROM members WHERE id = $1', [id]);
}

async function transitionToInvitePending(memberId, hostId) {
    const sql = `
        UPDATE members
        SET status = 'invite_pending', host_id = $2, invited_at = NOW(), updated_at = NOW()
        WHERE id = $1
        RETURNING *
    `;
    const { rows } = await db.query(sql, [memberId, hostId]);
    return mapRow(rows[0]);
}

async function transitionToJoined(memberId) {
    const sql = `
        UPDATE members
        SET status = 'joined', joined_at = NOW(), updated_at = NOW()
        WHERE id = $1
        RETURNING *
    `;
    const { rows } = await db.query(sql, [memberId]);
    return mapRow(rows[0]);
}

async function transitionToDone(memberId, token, tokenMeta) {
    const sql = `
        UPDATE members
        SET status = 'done', token = $2, token_meta = $3, done_at = NOW(), updated_at = NOW()
        WHERE id = $1
        RETURNING *
    `;
    const { rows } = await db.query(sql, [memberId, token, tokenMeta || {}]);
    return mapRow(rows[0]);
}

async function transitionToFailed(memberId, { newStatus, error, releaseHost }) {
    const sql = `
        UPDATE members
        SET status = CASE WHEN fail_count + 1 >= $4 THEN 'abandoned' ELSE $2 END,
            fail_count = fail_count + 1,
            last_error = $3,
            last_error_at = NOW(),
            host_id = CASE WHEN $5 THEN NULL ELSE host_id END,
            updated_at = NOW()
        WHERE id = $1
        RETURNING *
    `;
    const { rows } = await db.query(sql, [memberId, newStatus, error || null, ABANDON_THRESHOLD, !!releaseHost]);
    return mapRow(rows[0]);
}

async function markRemovedFromFamily(memberId) {
    const sql = `
        UPDATE members
        SET status = 'removed_from_family', host_id = NULL, updated_at = NOW()
        WHERE id = $1
        RETURNING *
    `;
    const { rows } = await db.query(sql, [memberId]);
    return mapRow(rows[0]);
}

async function resetMember(memberId) {
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
        WHERE id = $1
        RETURNING *
    `;
    const { rows } = await db.query(sql, [memberId]);
    return mapRow(rows[0]);
}

/**
 * Clear fail_count + last_error without touching status/host_id. Lets an
 * operator take a member that crossed the ABANDON_THRESHOLD and put it back
 * in play for the next stage run without losing any other state.
 */
async function clearFailCount(memberId) {
    const sql = `
        UPDATE members
        SET fail_count = 0, last_error = NULL, last_error_at = NULL, updated_at = NOW()
        WHERE id = $1
        RETURNING *
    `;
    const { rows } = await db.query(sql, [memberId]);
    return mapRow(rows[0]);
}

async function abandonMember(memberId) {
    const sql = `
        UPDATE members
        SET status = 'abandoned', host_id = NULL, updated_at = NOW()
        WHERE id = $1
        RETURNING *
    `;
    const { rows } = await db.query(sql, [memberId]);
    return mapRow(rows[0]);
}

async function updateAntigravity(memberId, partial) {
    // JSONB 合并: 已有值 || partial（partial 优先）
    const sql = `
        UPDATE members
        SET antigravity = COALESCE(antigravity, '{}'::jsonb) || $2::jsonb,
            updated_at = NOW()
        WHERE id = $1
        RETURNING *
    `;
    const { rows } = await db.query(sql, [memberId, partial]);
    return mapRow(rows[0]);
}

async function listMembersByEmailLower(emails) {
    if (!emails || !emails.length) return [];
    const lowered = emails.map(e => String(e).toLowerCase());
    const { rows } = await db.query(
        `SELECT * FROM members WHERE LOWER(email) = ANY($1)`,
        [lowered]
    );
    return rows.map(mapRow);
}

async function listMembersNeedingPush() {
    const sql = `
        SELECT * FROM members
        WHERE status = 'done'
          AND token IS NOT NULL
          AND (antigravity IS NULL OR antigravity->>'id' IS NULL)
        ORDER BY done_at ASC
    `;
    const { rows } = await db.query(sql);
    return rows.map(mapRow);
}

async function listMembersNeedingFamilyRemoval(hostId) {
    const sql = `
        SELECT * FROM members
        WHERE host_id = $1
          AND status IN ('joined','done','oauth_failed')
          AND antigravity->>'disabled' = 'true'
        ORDER BY id ASC
    `;
    const { rows } = await db.query(sql, [hostId]);
    return rows.map(mapRow);
}

async function listMembersForStage(stage, { hostIds } = {}) {
    const s = String(stage);
    const useHostFilter = Array.isArray(hostIds);
    let sql, params;
    if (s === '1') {
        // Stage 1: host assigned at runtime via pickHost; host filter not applicable here.
        sql = `
            SELECT * FROM members
            WHERE status IN ('new','invite_failed') AND fail_count < $1
            ORDER BY created_at ASC
        `;
        params = [ABANDON_THRESHOLD];
    } else if (s === '2') {
        if (useHostFilter) {
            sql = `
                SELECT * FROM members
                WHERE status = 'invite_pending' AND host_id = ANY($1)
                ORDER BY invited_at ASC NULLS FIRST
            `;
            params = [hostIds];
        } else {
            sql = `
                SELECT * FROM members
                WHERE status = 'invite_pending' AND host_id IS NOT NULL
                ORDER BY invited_at ASC NULLS FIRST
            `;
            params = [];
        }
    } else if (s === '3') {
        if (useHostFilter) {
            sql = `
                SELECT * FROM members
                WHERE status IN ('joined','oauth_failed') AND fail_count < $1 AND host_id = ANY($2)
                ORDER BY joined_at ASC NULLS LAST, updated_at ASC
            `;
            params = [ABANDON_THRESHOLD, hostIds];
        } else {
            sql = `
                SELECT * FROM members
                WHERE status IN ('joined','oauth_failed') AND fail_count < $1
                ORDER BY joined_at ASC NULLS LAST, updated_at ASC
            `;
            params = [ABANDON_THRESHOLD];
        }
    } else {
        throw new Error(`listMembersForStage: invalid stage ${stage}`);
    }
    const { rows } = await db.query(sql, params);
    return rows.map(mapRow);
}

async function countByStatus() {
    const { rows } = await db.query(
        'SELECT status, COUNT(*)::int AS n FROM members GROUP BY status'
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
    listMembersForStage,
    countByStatus,
    ABANDON_THRESHOLD,
};
