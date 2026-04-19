#!/usr/bin/env node
const path = require('path');
const fs = require('fs');

// Add src/node_modules to module search path
const srcDir = path.resolve(__dirname, '..', 'src');
module.paths.unshift(path.join(srcDir, 'node_modules'));

require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });
const { parseAccounts } = require('../src/common/state');
const hosts = require('../src/db/hosts');
const members = require('../src/db/members');
const db = require('../src/db');

async function importFile(file, table) {
    if (!fs.existsSync(file)) { console.log(`${file}: missing, skipping`); return; }
    const accts = parseAccounts(file);
    let inserted = 0, skipped = 0, failed = 0;
    for (const a of accts) {
        try {
            const r = await (table === 'hosts'
                ? hosts.upsertHost({ email: a.email, password: a.pass, recovery_email: a.recovery || null, totp_secret: a.totp_secret || null })
                : members.upsertMember({ email: a.email, password: a.pass, recovery_email: a.recovery || null, totp_secret: a.totp_secret || null }));
            if (r.inserted) inserted++; else skipped++;
        } catch (e) {
            failed++;
            console.error(`  ${a.email}: ${e.message}`);
        }
    }
    console.log(`${file}: inserted=${inserted} skipped=${skipped} failed=${failed} (total=${accts.length})`);
}

async function main() {
    const root = path.resolve(__dirname, '..');
    await importFile(path.join(root, 'hosts.txt'), 'hosts');
    await importFile(path.join(root, 'members.txt'), 'members');
    await db.close();
}

main().catch(e => { console.error(e); process.exit(1); });
