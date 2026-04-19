const test = require('node:test');
const assert = require('node:assert');
const { build } = require('../server');
const db = require('../db');

let app;
test.before(async () => {
    app = await build();
    await db.query("UPDATE pipeline_runs SET status='cancelled' WHERE status='running'");
});
test.after(async () => { await app.close(); await db.close(); });

test('GET /api/pipeline/runs returns array', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/pipeline/runs' });
    assert.equal(r.statusCode, 200);
    const b = JSON.parse(r.body);
    assert.ok(Array.isArray(b));
});

test('POST /api/pipeline/start with dryRun creates a run row', async () => {
    const r = await app.inject({
        method: 'POST', url: '/api/pipeline/start',
        payload: { stages: '1', hostFilter: [], concurrency: 1, dryRun: true },
    });
    assert.equal(r.statusCode, 200);
    const b = JSON.parse(r.body);
    assert.ok(b.runId);
    assert.equal(b.dryRun, true);
    // cleanup
    await db.query('UPDATE pipeline_runs SET status=$2 WHERE id=$1', [b.runId, 'cancelled']);
    await db.query('UPDATE pipeline_runs SET finished_at=NOW() WHERE id=$1', [b.runId]);
});

test('POST /api/pipeline/start refuses concurrent run', async () => {
    const seed = await db.query(
        "INSERT INTO pipeline_runs (launched_by, stages, host_filter, concurrency, status) VALUES ('ui','1','[]',1,'running') RETURNING id"
    );
    const seedId = seed.rows[0].id;
    try {
        const r = await app.inject({
            method: 'POST', url: '/api/pipeline/start',
            payload: { stages: '1', hostFilter: [], concurrency: 1, dryRun: true },
        });
        assert.equal(r.statusCode, 409);
    } finally {
        await db.query("UPDATE pipeline_runs SET status='cancelled', finished_at=NOW() WHERE id=$1", [seedId]);
    }
});

test('POST /api/pipeline/runs/:id/cancel on non-running returns 400', async () => {
    const seed = await db.query(
        "INSERT INTO pipeline_runs (launched_by, stages, host_filter, concurrency, status, finished_at) VALUES ('ui','1','[]',1,'completed',NOW()) RETURNING id"
    );
    const r = await app.inject({ method: 'POST', url: `/api/pipeline/runs/${seed.rows[0].id}/cancel` });
    assert.equal(r.statusCode, 400);
    await db.query('DELETE FROM pipeline_runs WHERE id=$1', [seed.rows[0].id]);
});
