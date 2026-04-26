/**
 * Host (母号) query module.
 * Slot counts derived live from members table (see spec §3).
 *
 * Multi-tenant: every read/write accepts an optional `ownerId`. When provided,
 * SELECTs filter on `owner_worker_id = $ownerId` and writes set/check it.
 * When omitted (e.g. legacy callers or tests), behavior is unchanged: queries
 * see all rows. All production routes pass `app.workerId` from the per-install
 * worker identity; failing to do so re-introduces the cross-tenant race that
 * the multi-tenant migration was meant to fix.
 */
const db = require('./index');
const { currentOwnerId } = require('../common/owner-context');

const SLOT_STATUSES = ['invite_pending', 'accept_failed', 'oauth_failed', 'joined', 'done'];
const FAMILY_CAP = 5;

// Resolve the effective ownerId for a query. Explicit > ALS context > null.
// Returning null means "no filter" (legacy behavior; tests rely on this).
function effectiveOwnerId(passed) {
    if (passed !== undefined) return passed;
    return currentOwnerId();
}

function mapRow(row) {
    if (!row) return null;
    return {
        id: row.id,
        email: row.email,
        password: row.password,
        recovery_email: row.recovery_email,
        totp_secret: row.totp_secret,
        notes: row.notes,
        disabled: row.disabled,
        owner_worker_id: row.owner_worker_id,
        created_at: row.created_at,
        updated_at: row.updated_at,
        slot_used: row.slot_used !== undefined ? Number(row.slot_used) : undefined,
        slot_free: row.slot_used !== undefined ? FAMILY_CAP - Number(row.slot_used) : undefined,
    };
}

async function listHosts({ disabled, search, page = 1, pageSize = 500, ownerId } = {}) {
    ownerId = effectiveOwnerId(ownerId);
    const params = [SLOT_STATUSES];
    const where = ['TRUE'];
    if (ownerId !== undefined && ownerId !== null) {
        params.push(ownerId);
        where.push(`h.owner_worker_id = $${params.length}`);
    }
    if (disabled === 0 || disabled === '0' || disabled === false) {
        where.push('h.disabled = false');
    } else if (disabled === 1 || disabled === '1' || disabled === true) {
        where.push('h.disabled = true');
    }
    if (search) {
        params.push(`%${search}%`);
        where.push(`h.email ILIKE $${params.length}`);
    }
    const offset = (page - 1) * pageSize;
    params.push(pageSize, offset);
    const sql = `
        SELECT h.*,
               COALESCE((SELECT COUNT(*) FROM members m
                          WHERE m.host_id = h.id AND m.status = ANY($1)), 0) AS slot_used
        FROM hosts h
        WHERE ${where.join(' AND ')}
        ORDER BY h.id ASC
        LIMIT $${params.length - 1} OFFSET $${params.length}
    `;
    const { rows } = await db.query(sql, params);
    return rows.map(mapRow);
}

async function getHostById(id, { ownerId } = {}) {
    ownerId = effectiveOwnerId(ownerId);
    const params = [id, SLOT_STATUSES];
    let ownerClause = '';
    if (ownerId !== undefined && ownerId !== null) {
        params.push(ownerId);
        ownerClause = ` AND h.owner_worker_id = $${params.length}`;
    }
    const sql = `
        SELECT h.*,
               COALESCE((SELECT COUNT(*) FROM members m
                          WHERE m.host_id = h.id AND m.status = ANY($2)), 0) AS slot_used
        FROM hosts h
        WHERE h.id = $1${ownerClause}
    `;
    const { rows } = await db.query(sql, params);
    return rows[0] ? mapRow(rows[0]) : null;
}

async function upsertHost({ email, password, recovery_email, totp_secret, notes, disabled, owner_worker_id }) {
    if (owner_worker_id === undefined) owner_worker_id = currentOwnerId();
    const sql = `
        INSERT INTO hosts (email, password, recovery_email, totp_secret, notes, disabled, owner_worker_id)
        VALUES ($1, $2, $3, $4, $5, COALESCE($6, false), $7)
        ON CONFLICT (email) DO NOTHING
        RETURNING *
    `;
    const { rows } = await db.query(sql, [
        email, password, recovery_email || null, totp_secret || null,
        notes || null, disabled || false, owner_worker_id || null,
    ]);
    if (rows.length === 0) {
        const existing = await db.query('SELECT * FROM hosts WHERE email = $1', [email]);
        return { inserted: false, skipped: true, host: mapRow(existing.rows[0]) };
    }
    return { inserted: true, skipped: false, host: mapRow(rows[0]) };
}

async function updateHost(id, patch, { ownerId } = {}) {
    ownerId = effectiveOwnerId(ownerId);
    const allowed = ['password', 'recovery_email', 'totp_secret', 'notes', 'disabled'];
    const sets = [];
    const params = [];
    for (const k of allowed) {
        if (patch[k] !== undefined) {
            params.push(patch[k]);
            sets.push(`${k} = $${params.length}`);
        }
    }
    if (sets.length === 0) return getHostById(id, { ownerId });
    sets.push(`updated_at = NOW()`);
    params.push(id);
    let ownerClause = '';
    if (ownerId !== undefined && ownerId !== null) {
        params.push(ownerId);
        ownerClause = ` AND owner_worker_id = $${params.length}`;
    }
    const sql = `UPDATE hosts SET ${sets.join(', ')} WHERE id = $${params.length - (ownerClause ? 1 : 0)}${ownerClause} RETURNING *`;
    const { rows } = await db.query(sql, params);
    return rows[0] ? mapRow(rows[0]) : null;
}

async function deleteHost(id, { ownerId } = {}) {
    ownerId = effectiveOwnerId(ownerId);
    const params = [id];
    let ownerClause = '';
    if (ownerId !== undefined && ownerId !== null) {
        params.push(ownerId);
        ownerClause = ` AND owner_worker_id = $${params.length}`;
    }
    await db.query(`DELETE FROM hosts WHERE id = $1${ownerClause}`, params);
}

module.exports = {
    listHosts,
    getHostById,
    upsertHost,
    updateHost,
    deleteHost,
    SLOT_STATUSES,
    FAMILY_CAP,
};
