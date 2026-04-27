const fs = require('fs');
const path = require('path');
const { parseAccounts } = require('../common/state');
const hostsDb = require('../db/hosts');
const membersDb = require('../db/members');

module.exports = async function routes(app) {
    app.post('/api/migrate/txt', async (req, reply) => {
        const { hostsPath, membersPath } = req.body || {};
        const root = path.resolve(__dirname, '..', '..');
        const hp = hostsPath || path.join(root, 'hosts.txt');
        const mp = membersPath || path.join(root, 'members.txt');
        const out = { hosts: null, members: null };

        if (fs.existsSync(hp)) {
            const accts = parseAccounts(hp);
            let inserted = 0, skipped = 0;
            for (const a of accts) {
                const r = await hostsDb.upsertHost({
                    email: a.email, password: a.pass,
                    recovery_email: a.recovery || null,
                    totp_secret: a.totp_secret || null,
                });
                if (r.inserted) inserted++; else skipped++;
            }
            out.hosts = { path: hp, inserted, skipped, total: accts.length };
        } else {
            out.hosts = { path: hp, missing: true };
        }

        if (fs.existsSync(mp)) {
            const accts = parseAccounts(mp);
            let inserted = 0, skipped = 0;
            for (const a of accts) {
                const r = await membersDb.upsertMember({
                    email: a.email, password: a.pass,
                    recovery_email: a.recovery || null,
                    totp_secret: a.totp_secret || null,
                });
                if (r.inserted) inserted++; else skipped++;
            }
            out.members = { path: mp, inserted, skipped, total: accts.length };
        } else {
            out.members = { path: mp, missing: true };
        }

        return out;
    });

    app.get('/api/migrate/detect', async () => {
        const root = path.resolve(__dirname, '..', '..');
        const hp = path.join(root, 'hosts.txt');
        const mp = path.join(root, 'members.txt');
        const result = { hosts: null, members: null };
        if (fs.existsSync(hp)) {
            const accts = parseAccounts(hp);
            const dbHosts = await hostsDb.listHosts({ pageSize: 10000 });
            result.hosts = { path: hp, fileCount: accts.length, dbCount: dbHosts.length, shouldImport: dbHosts.length < accts.length };
        }
        if (fs.existsSync(mp)) {
            const accts = parseAccounts(mp);
            const dbMembers = await membersDb.listMembers({ pageSize: 10000 });
            result.members = { path: mp, fileCount: accts.length, dbCount: dbMembers.length, shouldImport: dbMembers.length < accts.length };
        }
        return result;
    });
};
