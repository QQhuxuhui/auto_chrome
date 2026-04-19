/**
 * pg Pool singleton + query helper.
 * All DB access in this project goes through this module.
 */
require('dotenv').config({ path: require('path').resolve(__dirname, '..', '..', '.env') });
const { Pool } = require('pg');

const pool = new Pool({
    host: process.env.PG_HOST,
    port: parseInt(process.env.PG_PORT, 10) || 5432,
    user: process.env.PG_USER,
    password: process.env.PG_PASSWORD,
    database: process.env.PG_DATABASE,
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
});

pool.on('error', (err) => {
    console.error('[db] unexpected pool error:', err.message);
});

async function query(text, params) {
    const res = await pool.query(text, params);
    return res;
}

async function tx(fn) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const out = await fn(client);
        await client.query('COMMIT');
        return out;
    } catch (e) {
        try { await client.query('ROLLBACK'); } catch (_) { }
        throw e;
    } finally {
        client.release();
    }
}

async function close() {
    await pool.end();
}

module.exports = { pool, query, tx, close };
