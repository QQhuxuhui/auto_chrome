/**
 * Fast list-page-only scraper for Google Family page.
 *
 * Difference from stages/reconcile.scrapeFamilyMembers:
 *   - Does NOT click into each joined member's detail page (saves ~3s × N).
 *   - For joined members, returns only the href (no email). Callers that
 *     need email→href mapping should use reconcile.scrapeFamilyMembers once
 *     to build the initial map.
 *
 * Exposed:
 *   parseFamilyListDOM(anchors) → { pending: [{href,email}], joinedHrefs: [href] }
 *       pure, testable, takes {href, text} array already harvested from DOM
 *   scrapeFamilyListPage(page, wlog) → same shape + scrapedAt; navigates + harvests + parses
 */
const FAMILY_URL = 'https://myaccount.google.com/family/details?utm_source=g1web&utm_medium=default';

// TLD lookahead prevents "gmail.cominvitation" from being swallowed as one TLD.
const EMAIL_RE = /(?<![a-zA-Z])([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,10})(?![a-zA-Z])/;

function parseFamilyListDOM(anchors) {
    const pending = [];
    const joinedHrefs = [];
    const seen = new Set();

    for (const a of anchors || []) {
        const href = a.href || '';
        if (!href || seen.has(href)) continue;
        if (!/family\/(member|invitation)\//i.test(href)) continue;
        seen.add(href);

        const text = String(a.text || '').trim();
        if (/family manager|家庭管理员/i.test(text)) continue;  // host self

        if (/family\/invitation\//i.test(href)) {
            const m = text.match(EMAIL_RE);
            pending.push({ href, email: m ? m[1].toLowerCase() : null });
        } else {
            joinedHrefs.push(href);
        }
    }
    return { pending, joinedHrefs };
}

async function scrapeFamilyListPage(page, wlog) {
    if (!/\/family\/details/.test(page.url())) {
        await page.goto(FAMILY_URL, { waitUntil: 'networkidle2', timeout: 30000 })
            .catch(e => wlog && wlog.warn && wlog.warn(`scrape-fast: goto failed: ${e.message}`));
    }
    const anchors = await page.evaluate(() => {
        const out = [];
        for (const a of document.querySelectorAll('a[href*="family/"]')) {
            const href = a.getAttribute('href') || '';
            const text = (a.innerText || a.textContent || '').trim();
            out.push({ href, text: text.substring(0, 200) });
        }
        return out;
    }).catch(() => []);
    return { ...parseFamilyListDOM(anchors), scrapedAt: Date.now() };
}

module.exports = { parseFamilyListDOM, scrapeFamilyListPage, FAMILY_URL };
