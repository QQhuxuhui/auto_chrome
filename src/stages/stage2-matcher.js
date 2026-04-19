/**
 * Stage 2 invite-email matcher. Pure functions (no DOM access)
 * so they can be unit-tested. Adapters in 2_accept.js feed them
 * { text, hrefs } extracted from Gmail rows.
 *
 * Fix for bug surfaced 2026-04-19:
 *   Old matcher used loose keywords like 'google one' / 'family group'
 *   which false-matched welcome-after-join emails and host-side
 *   "X joined your family group" notifications. Fix: require
 *   family/join URL OR strong invite keywords AND explicitly
 *   exclude confirmation phrases.
 */

const INVITE_URL_MARKERS = ['family/join', 'families.google.com/join', 'one.google.com/family/join'];

const EXCLUDE_PHRASES = [
    'welcome to google one',
    "you've been added to",
    'you have been added to',
    'joined your family',
    'your new family group member',
    '你已加入',
    '加入了你的家庭组',
    '欢迎加入 google one',
];

const STRONG_INVITE_KEYWORDS = [
    'invited you to',
    'wants to add you',
    'invitation to join',
    'join the family',
    '邀请你加入',
    'a invité',
    'te invitó',
    'ha invitado',
    'zaprasza cię',
];

function normalize(s) {
    return (s || '').toLowerCase();
}

function isInviteRow(row) {
    const text = normalize(row && row.text);
    const hrefs = (row && row.hrefs) || [];
    if (!text && !hrefs.length) return false;

    if (EXCLUDE_PHRASES.some(p => text.includes(p))) return false;

    for (const h of hrefs) {
        const hl = normalize(h);
        if (INVITE_URL_MARKERS.some(m => hl.includes(m))) return true;
    }

    if (STRONG_INVITE_KEYWORDS.some(k => text.includes(k))) {
        if (hrefs.some(h => /google\.com/i.test(h) || /googleusercontent\.com/i.test(h))) return true;
    }

    return false;
}

function findAcceptLinkInRows(rows) {
    for (const row of rows || []) {
        if (!isInviteRow(row)) continue;
        for (const h of row.hrefs || []) {
            if (INVITE_URL_MARKERS.some(m => normalize(h).includes(m))) return h;
        }
        if (row.hrefs && row.hrefs.length) return row.hrefs[0];
    }
    return null;
}

module.exports = {
    isInviteRow,
    findAcceptLinkInRows,
    INVITE_URL_MARKERS,
    EXCLUDE_PHRASES,
    STRONG_INVITE_KEYWORDS,
};
