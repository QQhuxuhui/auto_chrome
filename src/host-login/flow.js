/**
 * Manual "open Chrome logged in as host X" flow, owned by the 登录 button on
 * the hosts page.
 *
 * Kept separate from the pipeline login path on purpose: the shared state
 * machine in common/google-login.js has a "unknown-state" branch that treats
 * any non-accounts.google.com URL as "logged in", which mis-fires when the
 * opening page.goto lands on chrome-error:// (transient network / cold Chrome
 * start). Fixing that centrally would ripple into stage 1/2/3 + reconcile, so
 * we wrap around it here and never touch pipeline code.
 *
 * The underlying googleLogin() is still imported read-only; the orchestration
 * (retry on chrome-error, verify URL after the state machine, navigate to the
 * family page, wait for the user to close Chrome) lives in this file.
 */

const path = require('path');
const { findChrome, launchRealChrome, sleep } = require('../common/chrome');
const { createWorkerLogger } = require('../common/logger');
const { googleLogin } = require('../common/google-login');

// Mirrors the URL reconcile.js uses. Going deeper into
// /signin/v2/identifier?flowName=GlifWebSignIn bypasses Google's natural
// redirect chain and trips its bot-detection → "Something went wrong" overlay,
// leaving the state machine stuck on `email`.
const SIGNIN_URL = 'https://accounts.google.com/signin';
const FAMILY_URL = 'https://myaccount.google.com/family/details?utm_source=g1web&utm_medium=default';

function isErrorOrBlank(url) {
    if (!url) return true;
    return url.startsWith('chrome-error://')
        || url.startsWith('chrome://')
        || url === 'about:blank'
        || url.startsWith('data:');
}

function isSignedInContext(url) {
    if (!url || isErrorOrBlank(url)) return false;
    // still in the signin / challenge / recovery funnels → not done
    if (/accounts\.google\.com\/(signin|v3\/signin|ServiceLogin|challenge|rejected|recovery)/i.test(url)) return false;
    // anywhere on google.com after signin = signed in
    return /google\.com|googleusercontent/i.test(url);
}

async function gotoWithRetry(page, url, wlog, { tries = 4, cooldownMs = 2000 } = {}) {
    for (let i = 1; i <= tries; i++) {
        try {
            await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
        } catch (e) {
            wlog.warn(`goto ${url} attempt ${i}/${tries} threw: ${e.message}`);
        }
        await sleep(500);
        const current = page.url();
        if (!isErrorOrBlank(current)) return current;
        wlog.warn(`goto ${url} attempt ${i}/${tries} landed on ${current}, retrying`);
        await sleep(cooldownMs);
    }
    return page.url();
}

async function runLoginStateMachine(page, host, wlog) {
    await googleLogin(page, {
        email: host.email,
        pass: host.password,
        recovery: host.recovery_email || '',
        totp_secret: host.totp_secret || undefined,
    }, wlog);
}

/**
 * Run the open-Chrome-then-login flow for a single host. Returns a promise that
 * resolves only when the Chrome process exits (user closed the window).
 */
async function openHostLoginSession(host, { chromePath } = {}) {
    const resolvedChromePath = chromePath || findChrome();
    if (!resolvedChromePath) throw new Error('Chrome binary not found (set PUPPETEER_EXECUTABLE_PATH)');

    // workerId 1000+ keeps debug port / data dir out of the pipeline worker
    // range (0..concurrency-1). Per-host data dir so repeated logins reuse
    // cookies and don't prompt 2FA every time.
    const hostId = Number(host.id);
    const workerId = 1000 + hostId;
    const dataDir = path.resolve(__dirname, '..', `chrome_data_temp_host_login_${hostId}`);
    const wlog = createWorkerLogger(workerId);

    wlog.info(`host-login: ${host.email} (host_id=${hostId}), dataDir=${dataDir}`);
    const chrome = await launchRealChrome(resolvedChromePath, workerId, { dataDir });

    try {
        const page = await chrome.browser.newPage();

        // Step 1 — navigate to signin. Retry aggressively; landing on
        // chrome-error breaks the googleLogin state machine because its
        // "unknown" branch sees a non-google URL and returns "signed in".
        let url = await gotoWithRetry(page, SIGNIN_URL, wlog, { tries: 5, cooldownMs: 3000 });

        // If we're already signed in (cookies from a prior session), goto
        // signin just bounces to myaccount/gmail etc. Fast-path skips login.
        if (isSignedInContext(url)) {
            wlog.info(`already signed in (URL=${url.substring(0, 80)}), skipping login state machine`);
        } else if (isErrorOrBlank(url)) {
            wlog.warn(`still on ${url} after retries — skipping login state machine; user must handle manually`);
        } else {
            // Step 2 — run the login state machine.
            await runLoginStateMachine(page, host, wlog);
            url = page.url();

            // Step 3 — verify we actually ended up signed in.
            if (!isSignedInContext(url)) {
                wlog.warn(`after googleLogin URL=${url} — not signed in, retrying once`);
                await gotoWithRetry(page, SIGNIN_URL, wlog, { tries: 3 });
                await runLoginStateMachine(page, host, wlog);
                url = page.url();
            }

            if (isSignedInContext(url)) {
                wlog.info(`login confirmed (URL=${url.substring(0, 80)})`);
            } else {
                wlog.warn(`login not confirmed after retry (URL=${url}); leaving Chrome open for manual completion`);
            }
        }

        // Step 4 — navigate to family page regardless. If we're signed in it
        // renders; if not it bounces to signin — either way user sees the
        // right destination and can continue manually.
        await gotoWithRetry(page, FAMILY_URL, wlog, { tries: 3 });
        wlog.info(`ready on ${page.url().substring(0, 80)} — close Chrome to end the session`);
    } catch (e) {
        wlog.warn(`setup error: ${e.message}. Chrome stays open for manual work.`);
    }

    // Block until the user closes Chrome.
    await new Promise((resolve) => {
        let done = false;
        const finish = (why) => {
            if (done) return;
            done = true;
            wlog.info(`session end (${why})`);
            resolve();
        };
        chrome.browser.on('disconnected', () => finish('browser disconnected'));
        chrome.proc.on('exit', () => finish('chrome proc exit'));
    });
}

module.exports = {
    openHostLoginSession,
    // exported for tests / introspection
    isErrorOrBlank,
    isSignedInContext,
    gotoWithRetry,
    SIGNIN_URL,
    FAMILY_URL,
};
