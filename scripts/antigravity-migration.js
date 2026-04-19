#!/usr/bin/env node
const path = require('path');

// Add src/node_modules to module search path
const srcDir = path.resolve(__dirname, '..', 'src');
module.paths.unshift(path.join(srcDir, 'node_modules'));

require('dotenv').config({ path: require('path').resolve(__dirname, '..', '.env') });
const { Client } = require('pg');

async function main() {
    const cfg = {
        host: process.env.PG_HOST, port: parseInt(process.env.PG_PORT, 10) || 5432,
        user: process.env.PG_USER, password: process.env.PG_PASSWORD,
        database: process.env.PG_DATABASE,
    };
    const client = new Client(cfg);
    await client.connect();
    try {
        await client.query('ALTER TABLE members ADD COLUMN IF NOT EXISTS antigravity JSONB');
        console.log('Added members.antigravity column (idempotent).');
    } finally { await client.end(); }
}
main().catch(e => { console.error(e); process.exit(1); });
