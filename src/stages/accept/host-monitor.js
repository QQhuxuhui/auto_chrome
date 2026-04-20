/**
 * HostMonitor — dedicated Chrome that stays logged into a host account,
 * periodically scrapes myaccount.google.com/family/details, and emits
 * 'scrape-done' events so member workers can subscribe via
 * awaitHostConfirmation().
 *
 * Life cycle:
 *   new HostMonitor(opts)
 *   await hm.start()     // login + first scrape (calibration)
 *   // ... subscribers use hm.on('scrape-done', ...) or awaitHostConfirmation
 *   await hm.stop()      // stops the polling loop; caller owns browser teardown
 *
 * Dependency injection for tests:
 *   opts.loginFn(page, hostAccount, wlog)
 *   opts.scrapeFn(page, wlog) → { pending, joinedHrefs, scrapedAt }
 *
 * Degradation triggers (hm.degraded=true + emit 'degraded'):
 *   - start() login throws
 *   - consecutive scrape errors ≥ maxScrapeFails (default 3)
 */
const EventEmitter = require('events');

const DEFAULT_POLL_INTERVAL_MS = parseInt(process.env.HOST_MONITOR_POLL_INTERVAL_MS, 10) || 60_000;
const DEFAULT_MAX_SCRAPE_FAILS = parseInt(process.env.HOST_MONITOR_MAX_SCRAPE_FAILS, 10) || 3;

class HostMonitor extends EventEmitter {
    constructor(opts) {
        super();
        this.host = opts.host;
        this.browser = opts.fakeBrowser || opts.browser;
        this.page = opts.fakePage || opts.page;
        this.loginFn = opts.loginFn;
        this.scrapeFn = opts.scrapeFn;
        this.wlog = opts.wlog || { info() {}, warn() {}, error() {}, debug() {}, success() {} };
        this.intervalMs = opts.intervalMs || DEFAULT_POLL_INTERVAL_MS;
        this.maxScrapeFails = opts.maxScrapeFails || DEFAULT_MAX_SCRAPE_FAILS;
        this.state = { ...(opts.initialFamilyMap || {}) };
        this.degraded = false;
        this.stopped = false;
        this._consecutiveFails = 0;
        this._timer = null;
        this._scrapeInFlight = null;
    }

    async start() {
        try {
            await this.loginFn(this.page, this.host, this.wlog);
        } catch (e) {
            this.wlog.warn(`HostMonitor ${this.host.email}: login failed: ${e.message} — degrading`);
            this._setDegraded();
            return;
        }
        try {
            await this._scrapeOnce();
        } catch (_) {
            // counted by _scrapeOnce; may already be degraded if maxScrapeFails=1
        }
        this._scheduleNext();
    }

    _scheduleNext() {
        if (this.stopped || this.degraded) return;
        // Idempotent: replace any existing pending timer rather than leaking one.
        if (this._timer) clearTimeout(this._timer);
        this._timer = setTimeout(() => {
            this._timer = null;
            this._scrapeOnce().catch(() => {}).finally(() => this._scheduleNext());
        }, this.intervalMs);
    }

    async _scrapeOnce() {
        // Mutex: real Puppeteer pages can't serve two concurrent scrapes safely
        // (page.goto / page.evaluate would race). If a scrape is already running,
        // hand the in-flight promise back so callers observe the same result.
        if (this._scrapeInFlight) return this._scrapeInFlight;
        this._scrapeInFlight = (async () => {
            try {
                const result = await this.scrapeFn(this.page, this.wlog);
                this._consecutiveFails = 0;
                this._applyScrape(result);
                this.emit('scrape-done', result);
                return result;
            } catch (e) {
                this._consecutiveFails++;
                this.wlog.warn(`HostMonitor ${this.host.email}: scrape #${this._consecutiveFails} failed: ${e.message}`);
                if (this._consecutiveFails >= this.maxScrapeFails) {
                    this._setDegraded();
                }
                throw e;
            } finally {
                this._scrapeInFlight = null;
            }
        })();
        return this._scrapeInFlight;
    }

    _applyScrape({ pending, joinedHrefs }) {
        const pendingHrefs = new Set((pending || []).map(p => p.href));
        const joinedSet = new Set(joinedHrefs || []);

        for (const email of Object.keys(this.state)) {
            const entry = this.state[email];
            if (!entry.href) continue;
            if (pendingHrefs.has(entry.href)) {
                entry.status = 'pending';
                entry.lastSeenAt = Date.now();
            } else if (joinedSet.has(entry.href)) {
                entry.status = 'joined';
                entry.lastSeenAt = Date.now();
            } else {
                entry.status = 'unknown';
            }
        }

        for (const p of pending || []) {
            if (!p.email) continue;
            if (!this.state[p.email]) {
                this.state[p.email] = { status: 'pending', href: p.href, lastSeenAt: Date.now() };
            }
        }
    }

    _setDegraded() {
        if (this.degraded) return;
        this.degraded = true;
        if (this._timer) { clearTimeout(this._timer); this._timer = null; }
        this.emit('degraded');
    }

    async stop() {
        this.stopped = true;
        if (this._timer) { clearTimeout(this._timer); this._timer = null; }
    }

    /**
     * Force a fresh scrape right now — cancels the pending scheduled scrape,
     * runs scrape immediately (emitting scrape-done on success), then reschedules
     * the next tick. No-op on stopped/degraded monitors.
     *
     * Used by manual-accept flow so subscribers (awaitHostConfirmation) can see
     * the post-manual-click state without waiting the full poll interval.
     */
    async triggerScrape() {
        if (this.stopped || this.degraded) return;
        if (this._scrapeInFlight) {
            // A scrape is already running (from either the periodic timer or a
            // concurrent triggerScrape). Its result will reflect current state,
            // and its owning path will reschedule — just ride along.
            await this._scrapeInFlight.catch(() => { });
            return;
        }
        if (this._timer) { clearTimeout(this._timer); this._timer = null; }
        try {
            await this._scrapeOnce();
        } catch (_) { /* already counted/logged by _scrapeOnce */ }
        this._scheduleNext();
    }
}

/**
 * Subscribe to a HostMonitor and resolve when:
 *   - hm.state[email].status === 'joined' → returns 'joined'
 *   - hm fires 'degraded' or is already degraded → returns 'degraded'
 *   - timeoutMs elapses → returns current status ('pending'|'unknown') or 'timeout' if unknown-email
 */
function awaitHostConfirmation(hm, email, { timeoutMs }) {
    return new Promise((resolve) => {
        const cur = hm.state[email];
        if (cur && cur.status === 'joined') return resolve('joined');
        if (hm.degraded) return resolve('degraded');

        let settled = false;
        const finish = (v) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            hm.off('scrape-done', onScrape);
            hm.off('degraded', onDegrade);
            resolve(v);
        };
        const onScrape = () => {
            const s = hm.state[email];
            if (s && s.status === 'joined') finish('joined');
        };
        const onDegrade = () => finish('degraded');
        const timer = setTimeout(() => {
            const s = hm.state[email];
            finish(s ? s.status : 'timeout');
        }, timeoutMs);

        hm.on('scrape-done', onScrape);
        hm.on('degraded', onDegrade);
    });
}

module.exports = { HostMonitor, awaitHostConfirmation, DEFAULT_POLL_INTERVAL_MS };
