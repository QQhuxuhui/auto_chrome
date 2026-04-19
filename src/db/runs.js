/**
 * Pipeline runs module.
 */
const db = require('./index');

async function createRun({ launched_by, stages, host_filter, concurrency, pid }) {
    const sql = `
        INSERT INTO pipeline_runs (launched_by, stages, host_filter, concurrency, pid)
        VALUES ($1, $2, $3, $4, $5)
        RETURNING *
    `;
    const { rows } = await db.query(sql, [
        launched_by, stages, host_filter || [], concurrency || 1, pid || null,
    ]);
    return rows[0];
}

async function getCurrentRun() {
    const { rows } = await db.query(
        "SELECT * FROM pipeline_runs WHERE status='running' ORDER BY id DESC LIMIT 1"
    );
    return rows[0] || null;
}

async function getRunById(id) {
    const { rows } = await db.query('SELECT * FROM pipeline_runs WHERE id = $1', [id]);
    return rows[0] || null;
}

async function updateRunStatus(id, status, extras = {}) {
    const { stats, error, pid } = extras;
    const sql = `
        UPDATE pipeline_runs
        SET status = $2,
            finished_at = CASE WHEN $2 IN ('completed','failed','cancelled') THEN NOW() ELSE finished_at END,
            stats = COALESCE($3, stats),
            error = COALESCE($4, error),
            pid = COALESCE($5, pid)
        WHERE id = $1
        RETURNING *
    `;
    const { rows } = await db.query(sql, [
        id, status, stats || null, error || null, pid || null,
    ]);
    return rows[0];
}

async function setRunPid(id, pid) {
    await db.query('UPDATE pipeline_runs SET pid = $2 WHERE id = $1', [id, pid]);
}

async function listRuns(limit = 50) {
    const sql = `SELECT * FROM pipeline_runs ORDER BY id DESC LIMIT $1`;
    const { rows } = await db.query(sql, [limit]);
    return rows;
}

module.exports = { createRun, getCurrentRun, getRunById, updateRunStatus, setRunPid, listRuns };
