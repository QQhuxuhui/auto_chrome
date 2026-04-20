/**
 * Accurate host-side family-page scraper for HostMonitor.
 *
 * Why not family-scrape-fast.js?
 *   Google's new family UI renders both pending invites and joined members
 *   under /family/member/g/... hrefs, and the list page shows the same
 *   "Name + Member" template for each. parseFamilyListDOM() classified by
 *   href pattern alone and therefore flipped pending → joined on every poll.
 *
 * This adapter uses reconcile.scrapeFamilyMembers (which visits each anchor's
 * detail page and reads button text "Remove member" vs "Cancel invitation")
 * and reshapes the output into the { pending, joinedHrefs } contract that
 * HostMonitor._applyScrape expects.
 *
 * Tradeoff: ~1-3s per anchor because of the detail-page visit. For small
 * families (≤10) and a 60s poll interval this is comfortably fine; operators
 * with larger families should raise HOST_MONITOR_POLL_INTERVAL_MS.
 */
const { scrapeFamilyMembers } = require('../reconcile');

function buildHostScrapeResult(members) {
    const pending = [];
    const joinedHrefs = [];
    for (const m of members || []) {
        if (!m || !m.email) continue;
        if (m.isPending) {
            pending.push({ href: m.href, email: m.email });
        } else {
            joinedHrefs.push(m.href);
        }
    }
    return { pending, joinedHrefs };
}

async function hostScrapeFn(page, wlog) {
    const members = await scrapeFamilyMembers(page, wlog);
    return { ...buildHostScrapeResult(members), scrapedAt: Date.now() };
}

module.exports = { buildHostScrapeResult, hostScrapeFn };
