/**
 * Pipeline runs module.
 */
const db = require('./index');

async function createRun({ launched_by, stages, host_filter, concurrency, pid, worker_id }) {
    // host_filter 是 JSONB 列；pg 会把 JS 数组转成 PostgreSQL array literal（非 JSON），
    // 非空数组会在 jsonb 解析时报错。用 JSON.stringify + ::jsonb 显式转换。
    // worker_id 是新加的多租户隔离字段；最初的 last_heartbeat_at 直接置 NOW() 让
    // boot reaper 不会立刻把刚创建出来的 run 误判成 stale。
    const sql = `
        INSERT INTO pipeline_runs (launched_by, stages, host_filter, concurrency, pid, worker_id, last_heartbeat_at)
        VALUES ($1, $2, $3::jsonb, $4, $5, $6, NOW())
        RETURNING *
    `;
    const { rows } = await db.query(sql, [
        launched_by, stages, JSON.stringify(host_filter || []), concurrency || 1, pid || null,
        worker_id || null,
    ]);
    return rows[0];
}

// Backwards-compatible: returns ANY running row (used in places that don't
// care about isolation, e.g. the original /api/status before multi-tenant).
// New callers that need isolation should use getCurrentRunForWorker.
async function getCurrentRun() {
    const { rows } = await db.query(
        "SELECT * FROM pipeline_runs WHERE status='running' ORDER BY id DESC LIMIT 1"
    );
    return rows[0] || null;
}

// Multi-tenant variant — only returns running rows owned by this worker.
// This is what the /api/status, /api/pipeline/start guard, and dashboard use
// so multiple users sharing one DB don't block each other.
async function getCurrentRunForWorker(workerId) {
    if (!workerId) return null;
    const { rows } = await db.query(
        "SELECT * FROM pipeline_runs WHERE status='running' AND worker_id=$1 ORDER BY id DESC LIMIT 1",
        [workerId]
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

async function listRunningRuns() {
    const { rows } = await db.query(
        "SELECT id, pid, started_at, stages, worker_id, last_heartbeat_at FROM pipeline_runs WHERE status='running'"
    );
    return rows;
}

// Cheap UPDATE called by the orchestrator every ~10s. The boot reaper / cancel
// route uses staleness as the cross-machine liveness signal; if an orchestrator
// goes silent for >60s we assume it's gone (heartbeat is just a setInterval, so
// an alive process should never miss this many beats unless the event loop is
// completely jammed). Conditional on status='running' so a finishing run that
// already wrote 'completed'/'failed' doesn't accidentally bounce back to a
// fresh heartbeat.
async function heartbeatRun(id) {
    const { rowCount } = await db.query(
        "UPDATE pipeline_runs SET last_heartbeat_at = NOW() WHERE id = $1 AND status = 'running'",
        [id]
    );
    return rowCount > 0;
}

// Race-safe variant of "mark this run as cancelled". The reaper paths (cancel
// route + boot reaper) read the row, then later decide to mark it cancelled
// based on a stale snapshot. If the orchestrator finishes between the read
// and the write — writing 'completed' or 'failed' — an unconditional UPDATE
// here would clobber the real terminal status. The WHERE status='running'
// guard makes it a no-op in that case. Returns the updated row, or null if
// the row was already terminal (caller should treat null as "nothing to do").
async function cancelStaleRunIfStillRunning(id, reason) {
    const sql = `
        UPDATE pipeline_runs
        SET status = 'cancelled',
            finished_at = NOW(),
            error = COALESCE($2, error)
        WHERE id = $1 AND status = 'running'
        RETURNING *
    `;
    const { rows } = await db.query(sql, [id, reason || null]);
    return rows[0] || null;
}

module.exports = {
    createRun, getCurrentRun, getCurrentRunForWorker, getRunById,
    updateRunStatus, setRunPid, listRuns, listRunningRuns,
    heartbeatRun, cancelStaleRunIfStillRunning,
};
