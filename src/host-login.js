#!/usr/bin/env node
/**
 * Fork entry point for the "登录 母号" button.
 *
 * POST /api/hosts/:id/login fork()s this script with --host-id <n>. All the
 * real work lives in src/host-login/flow.js so pipeline stages never import
 * anything from here. This file only handles: arg parsing, DB lookup, wiring
 * up the graceful shutdown, and closing the DB pool on exit.
 */
require('dotenv').config({ path: require('path').resolve(__dirname, '..', '.env') });

const hostsDb = require('./db/hosts');
const db = require('./db');
const { openHostLoginSession } = require('./host-login/flow');

function getArg(name) {
    const i = process.argv.indexOf(name);
    return i > -1 ? process.argv[i + 1] : null;
}

async function main() {
    const hostId = parseInt(getArg('--host-id'), 10);
    if (!Number.isInteger(hostId) || hostId <= 0) throw new Error('--host-id <int> required');

    const host = await hostsDb.getHostById(hostId);
    if (!host) throw new Error(`host ${hostId} not found`);

    await openHostLoginSession(host);
}

main()
    .then(async () => { try { await db.close(); } catch (_) { } process.exit(0); })
    .catch(async (e) => {
        console.error(`host-login fatal: ${e.message}`);
        if (e.stack) console.error(e.stack);
        try { await db.close(); } catch (_) { }
        process.exit(1);
    });
