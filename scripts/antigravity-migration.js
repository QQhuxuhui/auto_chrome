#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// Load .env file manually
const envPath = path.resolve(__dirname, '..', '.env');
const envContent = fs.readFileSync(envPath, 'utf-8');
const env = {};
envContent.split('\n').forEach(line => {
    const [key, value] = line.split('=');
    if (key && value) env[key] = value;
});

try {
    const cmd = `PGPASSWORD='${env.PG_PASSWORD}' psql -h ${env.PG_HOST} -p ${env.PG_PORT} -U ${env.PG_USER} -d ${env.PG_DATABASE} -c "ALTER TABLE members ADD COLUMN IF NOT EXISTS antigravity JSONB"`;
    execSync(cmd, { stdio: 'inherit' });
    console.log('Added members.antigravity column (idempotent).');
} catch (e) {
    console.error(e);
    process.exit(1);
}
