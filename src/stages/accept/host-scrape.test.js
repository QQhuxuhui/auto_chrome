const test = require('node:test');
const assert = require('node:assert');
const { buildHostScrapeResult } = require('./host-scrape');

test('buildHostScrapeResult — pending members go to pending[], joined go to joinedHrefs', () => {
    const members = [
        { email: 'pending@x.com', href: '/family/member/g/111', isPending: true },
        { email: 'joined@x.com',  href: '/family/member/g/222', isPending: false },
    ];
    const out = buildHostScrapeResult(members);
    assert.deepEqual(out, {
        pending: [{ href: '/family/member/g/111', email: 'pending@x.com' }],
        joinedHrefs: ['/family/member/g/222'],
    });
});

test('buildHostScrapeResult — new UI pending invite (href /family/member/g/...) is not misclassified', () => {
    // The whole point of this adapter: distinguish pending vs joined by isPending
    // flag (set via detail-page button detection), not by href pattern.
    const members = [
        { email: 'pending@x.com', href: '/family/member/g/111', isPending: true },
    ];
    const out = buildHostScrapeResult(members);
    assert.deepEqual(out.pending, [{ href: '/family/member/g/111', email: 'pending@x.com' }]);
    assert.deepEqual(out.joinedHrefs, []);
});

test('buildHostScrapeResult — skips entries with no email', () => {
    const members = [
        { email: null, href: '/family/member/g/111', isPending: true },
        { email: '',   href: '/family/member/g/222', isPending: false },
        { email: 'ok@x.com', href: '/family/member/g/333', isPending: false },
    ];
    const out = buildHostScrapeResult(members);
    assert.deepEqual(out.pending, []);
    assert.deepEqual(out.joinedHrefs, ['/family/member/g/333']);
});

test('buildHostScrapeResult — empty/null input', () => {
    assert.deepEqual(buildHostScrapeResult([]), { pending: [], joinedHrefs: [] });
    assert.deepEqual(buildHostScrapeResult(null), { pending: [], joinedHrefs: [] });
    assert.deepEqual(buildHostScrapeResult(undefined), { pending: [], joinedHrefs: [] });
});
