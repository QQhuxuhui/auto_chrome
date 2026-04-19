const test = require('node:test');
const assert = require('node:assert');
const db = require('./index');
const runs = require('./runs');

const testIds = [];
test.after(async () => {
    if (testIds.length) {
        await db.query('DELETE FROM events WHERE run_id = ANY($1)', [testIds]);
        await db.query('DELETE FROM pipeline_runs WHERE id = ANY($1)', [testIds]);
    }
    await db.close();
});

test('createRun inserts with status=running', async () => {
    const r = await runs.createRun({
        launched_by: 'cli', stages: '1,2,3', host_filter: [], concurrency: 1,
    });
    testIds.push(r.id);
    assert.equal(r.status, 'running');
    assert.equal(r.launched_by, 'cli');
});

test('getCurrentRun returns null when no running run', async () => {
    // make sure no lingering running test runs
    await db.query("UPDATE pipeline_runs SET status='cancelled', finished_at=NOW() WHERE status='running'");
    const r = await runs.getCurrentRun();
    assert.equal(r, null);
});

test('updateRunStatus marks completed', async () => {
    const r = await runs.createRun({ launched_by: 'cli', stages: '1', host_filter: null, concurrency: 1 });
    testIds.push(r.id);
    const done = await runs.updateRunStatus(r.id, 'completed', { stats: { stage1: { ok: 2, ng: 0 } } });
    assert.equal(done.status, 'completed');
    assert.ok(done.finished_at);
    assert.equal(done.stats.stage1.ok, 2);
});

test('listRuns returns rows', async () => {
    const list = await runs.listRuns(10);
    assert.ok(Array.isArray(list));
});

test('createRun accepts non-empty host_filter (jsonb roundtrip)', async () => {
    // 回归：早前 pg 把 JS 数组转成 PG array literal，非空 host_filter 会
    // 在 JSONB 解析时报错 "invalid input syntax for type json"
    const r = await runs.createRun({
        launched_by: 'cli', stages: '2', host_filter: ['a@x.com', 'b@y.com'], concurrency: 1,
    });
    testIds.push(r.id);
    assert.ok(Array.isArray(r.host_filter));
    assert.equal(r.host_filter.length, 2);
    assert.equal(r.host_filter[0], 'a@x.com');
});
