/**
 * Events audit log.
 */
const db = require('./index');

async function logEvent({ memberId, hostId, runId, stage, eventType, message }) {
    const sql = `
        INSERT INTO events (member_id, host_id, run_id, stage, event_type, message)
        VALUES ($1, $2, $3, $4, $5, $6)
        RETURNING *
    `;
    const { rows } = await db.query(sql, [
        memberId || null, hostId || null, runId || null,
        stage || null, eventType, message || null,
    ]);
    return rows[0];
}

async function listEventsForMember(memberId, limit = 50) {
    const sql = `
        SELECT * FROM events
        WHERE member_id = $1
        ORDER BY created_at DESC, id DESC
        LIMIT $2
    `;
    const { rows } = await db.query(sql, [memberId, limit]);
    return rows;
}

async function listEventsForRun(runId, limit = 500) {
    const sql = `
        SELECT * FROM events
        WHERE run_id = $1
        ORDER BY created_at ASC, id ASC
        LIMIT $2
    `;
    const { rows } = await db.query(sql, [runId, limit]);
    return rows;
}

module.exports = { logEvent, listEventsForMember, listEventsForRun };
