#!/usr/bin/env node
const path = require('path');
const fs = require('fs');

// Add src/node_modules to module search path
const srcDir = path.resolve(__dirname, '..', 'src');
module.paths.unshift(path.join(srcDir, 'node_modules'));

require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });
const { Client } = require('pg');

async function main() {
    const cfg = {
        host: process.env.PG_HOST,
        port: parseInt(process.env.PG_PORT, 10) || 5432,
        user: process.env.PG_USER,
        password: process.env.PG_PASSWORD,
        database: process.env.PG_DATABASE,
    };
    for (const k of ['host', 'user', 'password', 'database']) {
        if (!cfg[k]) {
            console.error(`PG_${k.toUpperCase()} missing in .env`);
            process.exit(1);
        }
    }
    const schemaPath = path.resolve(__dirname, '..', 'src', 'db', 'schema.sql');
    const sql = fs.readFileSync(schemaPath, 'utf-8');

    const client = new Client(cfg);
    await client.connect();
    try {
        await client.query(sql);
        console.log('Schema applied OK.');
        const { rows } = await client.query(
            "SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename"
        );
        console.log('Tables:', rows.map(r => r.tablename).join(', '));
    } finally {
        await client.end();
    }
}

main().catch(e => {
    console.error('init-db failed:', e.message);
    process.exit(1);
});
