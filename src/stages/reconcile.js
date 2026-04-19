/**
 * Reconcile: fetch Google family members for a host, diff with DB, patch states.
 *
 * Exposed:
 *   scrapeFamilyMembers(page, wlog) -> [{ email, displayName }]  (strings list)
 *   reconcileAgainstDB(hostRecord, googleEmails, runId) -> { changes: [] }
 *   reconcileHost(hostRecord, browser, runId, wlog) -> { changes }  (full flow)
 */
const { sleep, newPage, clearBrowserSession } = require('../common/chrome');
const { googleLogin } = require('../common/google-login');
const membersDb = require('../db/members');
const eventsDb = require('../db/events');

const FAMILY_URL = 'https://myaccount.google.com/family/details?utm_source=g1web&utm_medium=default';

async function scrapeFamilyMembers(page, wlog) {
    await page.goto(FAMILY_URL, { waitUntil: 'networkidle2', timeout: 30000 }).catch(e =>
        wlog && wlog.warn && wlog.warn(`family page load: ${e.message}`));
    await sleep(2000);

    // Google Family UI renders email text inside each member row; exact DOM
    // classes are unstable — rely on text extraction + email regex filter.
    const emails = await page.evaluate(() => {
        const EMAIL_RE = /([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/g;
        const text = document.body ? document.body.innerText : '';
        const hits = new Set();
        let m;
        while ((m = EMAIL_RE.exec(text)) !== null) hits.add(m[1].toLowerCase());
        return Array.from(hits);
    }).catch(() => []);
    return emails;
}

async function reconcileAgainstDB(hostRecord, googleEmails, runId) {
    const changes = [];
    const all = await membersDb.listMembers({ hostId: hostRecord.id, pageSize: 10000 });
    const googleSet = new Set(googleEmails.map(e => e.toLowerCase()));

    for (const m of all) {
        const emailLower = (m.email || '').toLowerCase();
        const inFamily = googleSet.has(emailLower);

        if (inFamily && m.status === 'invite_pending') {
            await membersDb.transitionToJoined(m.id);
            await eventsDb.logEvent({
                memberId: m.id, hostId: hostRecord.id, runId,
                stage: 'reconcile', eventType: 'note',
                message: 'invite_pending → joined via family page',
            });
            changes.push({ id: m.id, from: 'invite_pending', to: 'joined' });
        } else if (!inFamily && (m.status === 'joined' || m.status === 'done')) {
            await membersDb.markRemovedFromFamily(m.id);
            await eventsDb.logEvent({
                memberId: m.id, hostId: hostRecord.id, runId,
                stage: 'reconcile', eventType: 'note',
                message: `${m.status} → removed_from_family (not in google family)`,
            });
            changes.push({ id: m.id, from: m.status, to: 'removed_from_family' });
        }
    }
    return { changes };
}

async function reconcileHost(hostRecord, browser, runId, wlog) {
    if (hostRecord.disabled) {
        wlog && wlog.info && wlog.info(`reconcile: skip disabled host ${hostRecord.email}`);
        return { changes: [] };
    }
    await clearBrowserSession(browser, wlog);
    const page = await newPage(browser);
    try {
        wlog && wlog.info && wlog.info(`reconcile: login host ${hostRecord.email}`);
        await page.goto('https://accounts.google.com/signin', { waitUntil: 'networkidle2', timeout: 30000 }).catch(() => { });
        await googleLogin(page, {
            email: hostRecord.email,
            pass: hostRecord.password,
            recovery: hostRecord.recovery_email || '',
            totp_secret: hostRecord.totp_secret || undefined,
        }, wlog);
        await sleep(2000);
        const emails = await scrapeFamilyMembers(page, wlog);
        wlog && wlog.info && wlog.info(`reconcile: host ${hostRecord.email} has ${emails.length} family members`);
        return reconcileAgainstDB(hostRecord, emails, runId);
    } finally {
        await page.close().catch(() => { });
        await clearBrowserSession(browser, wlog);
    }
}

module.exports = { scrapeFamilyMembers, reconcileAgainstDB, reconcileHost, FAMILY_URL };
