/**
 * 阶段3 — 在 sub2api 注册 antigravity OAuth 账号
 *
 * 流程：对 members.txt 里的每个成员，按 name=ultra_<hostLocal>_<memberLocal>
 * 查 sub2api；没有则新建、非 active 则自动重授权、active 则跳过。
 * OAuth callback 通过 puppeteer 请求拦截捕获，不起本地 HTTP 服务器。
 *
 * 详见 docs/superpowers/specs/2026-04-09-stage3-sub2api-design.md
 */

const fs = require('fs');
const path = require('path');
const { log, createWorkerLogger, setVerbose, StepTimer } = require('./common/logger');
const {
    sleep, rand, findChrome, launchRealChrome, restartChrome,
    isChromeAlive, clearBrowserSession, newPage, takeScreenshot, tryClickStrategies,
} = require('./common/chrome');
const { parseAccounts, addFailedRecord } = require('./common/state');
const { googleLogin } = require('./common/google-login');
const { generateTOTP } = require('./common/totp');

// ============ CLI 参数 ============
const args = process.argv.slice(2);
if (args.includes('--verbose') || args.includes('-v')) setVerbose(true);

function parseIntArg(names, fallback) {
    for (let i = 0; i < args.length; i++) {
        if (names.includes(args[i]) && args[i + 1]) {
            const n = parseInt(args[i + 1], 10);
            if (!Number.isNaN(n)) return n;
        }
    }
    return fallback;
}

function parseListArg(prefix) {
    for (const a of args) {
        if (a.startsWith(prefix)) {
            return a.slice(prefix.length).split(',').map(s => s.trim()).filter(Boolean);
        }
    }
    return [];
}

const CLI_OPTS = {
    concurrency: parseIntArg(['-c', '--concurrency'], parseInt(process.env.CONCURRENCY, 10) || 3),
    reauthAll: args.includes('--reauth-all'),
    reauthList: parseListArg('--reauth='),
};

const HARD_TIMEOUT_MS = parseInt(process.env.SUB2API_HARD_TIMEOUT_MS, 10) || 300000;

// ============ 条件暂停 ============
const PAUSE_POINTS = (process.env.PAUSE_AT || '')
    .split(',').map(s => s.trim()).filter(Boolean);
const _pauseLock = { busy: false };

async function maybePause(label, wlog) {
    if (!PAUSE_POINTS.includes('all') && !PAUSE_POINTS.includes(label)) return;
    if (!process.stdin.isTTY) {
        (wlog || console).warn && (wlog || console).warn(`[pause:${label}] stdin 非 TTY，跳过暂停`);
        return;
    }
    while (_pauseLock.busy) await sleep(500);
    _pauseLock.busy = true;
    try {
        process.stdout.write(`\n>>> [pause:${label}] 已暂停，人工干预完成后按回车继续...\n`);
        await new Promise(resolve => {
            process.stdin.resume();
            process.stdin.once('data', () => {
                process.stdin.pause();
                resolve();
            });
        });
        (wlog || console).info && (wlog || console).info(`[pause:${label}] 继续执行`);
    } finally {
        _pauseLock.busy = false;
    }
}

function accountName(hostEmail, memberEmail) {
    const localOf = (e) => String(e).split('@')[0];
    return `ultra_${localOf(hostEmail)}_${localOf(memberEmail)}`;
}

function parseSub2apiConfig(filePath) {
    if (!fs.existsSync(filePath)) {
        throw new Error(`sub2api config not found: ${filePath}`);
    }
    let raw = fs.readFileSync(filePath, 'utf-8');
    if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);

    const result = {};
    for (const line of raw.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eqPos = trimmed.indexOf('=');
        if (eqPos <= 0) continue;
        const key = trimmed.slice(0, eqPos).trim();
        const value = trimmed.slice(eqPos + 1).trim();
        if (key === 'url') result.url = value;
        else if (key === 'api_key') result.apiKey = value;
    }

    if (!result.url) throw new Error(`sub2api config: missing "url" in ${filePath}`);
    if (!result.apiKey) throw new Error(`sub2api config: missing "api_key" in ${filePath}`);
    return result;
}

function shouldForceReauth(memberEmail, opts) {
    if (opts.reauthAll) return true;
    const target = String(memberEmail).toLowerCase();
    return (opts.reauthList || []).some(e => String(e).toLowerCase() === target);
}

/**
 * Extract a Google account-verification URL from a sub2api test error
 * string. The typical failure mode for newly-added antigravity accounts
 * is a 403 PERMISSION_DENIED with reason=VALIDATION_REQUIRED, whose
 * response body (passed through verbatim by sub2api at the form
 * `API 返回 403: {...json...}`) contains:
 *
 *   error.details[].metadata.validation_url
 *
 * or, equivalently, a `google.rpc.Help` link carrying the same URL.
 * Returns the URL string on the first match, or null when:
 *  - input is empty / not a string
 *  - no JSON payload can be extracted
 *  - JSON parses but contains no validation URL
 */
function extractValidationUrl(errorString) {
    if (!errorString || typeof errorString !== 'string') return null;

    // Locate the first `{` and try to parse from there. This tolerates both
    // `API 返回 403: {...}` and `API 返回 403：{...}` (full/half-width colon)
    // as well as a bare JSON body with no prefix.
    const braceIdx = errorString.indexOf('{');
    if (braceIdx < 0) return null;
    const jsonCandidate = errorString.slice(braceIdx);

    let payload;
    try { payload = JSON.parse(jsonCandidate); }
    catch (_) { return null; }

    const details = payload?.error?.details;
    if (!Array.isArray(details)) return null;

    // Priority 1: ErrorInfo.metadata.validation_url (the canonical field)
    for (const d of details) {
        const url = d && d.metadata && d.metadata.validation_url;
        if (typeof url === 'string' && url.startsWith('http')) return url;
    }
    // Priority 2: Help.links[].url matching an accounts.google.com signin URL
    for (const d of details) {
        if (!d || !Array.isArray(d.links)) continue;
        for (const link of d.links) {
            const url = link && link.url;
            if (typeof url !== 'string') continue;
            if (url.includes('accounts.google.com/signin')) return url;
        }
    }
    return null;
}

// ============ REST client ============

class Sub2apiError extends Error {
    constructor(endpoint, httpStatus, bizCode, message) {
        super(`[sub2api] ${endpoint} http=${httpStatus} code=${bizCode}: ${message}`);
        this.name = 'Sub2apiError';
        this.endpoint = endpoint;
        this.httpStatus = httpStatus;
        this.bizCode = bizCode;
    }
}

class Sub2apiClient {
    constructor(baseUrl, apiKey) {
        this.baseUrl = String(baseUrl).replace(/\/+$/, '');
        this.apiKey = apiKey;
    }

    async _request(method, pathname, body) {
        const url = `${this.baseUrl}${pathname}`;
        const headers = { 'x-api-key': this.apiKey };
        const init = { method, headers };
        if (body !== undefined) {
            headers['content-type'] = 'application/json';
            init.body = JSON.stringify(body);
        }
        let res;
        try {
            res = await fetch(url, init);
        } catch (e) {
            throw new Sub2apiError(pathname, 0, -1, `network: ${e.message}`);
        }
        const text = await res.text();
        let json = null;
        try { json = text ? JSON.parse(text) : null; } catch (_) { /* keep null */ }
        if (!res.ok) {
            throw new Sub2apiError(pathname, res.status, json?.code ?? -1, json?.message || text || res.statusText);
        }
        if (json && typeof json === 'object' && 'code' in json && json.code !== 0) {
            throw new Sub2apiError(pathname, res.status, json.code, json.message || 'non-zero biz code');
        }
        return json?.data ?? null;
    }

    async getAuthUrl(proxyId = null) {
        const endpoint = '/api/v1/admin/antigravity/oauth/auth-url';
        const data = await this._request('POST', endpoint, { proxy_id: proxyId });
        if (!data || !data.session_id || !data.auth_url) {
            throw new Sub2apiError(endpoint, 200, -1, 'empty or malformed data in response');
        }
        return {
            sessionId: data.session_id,
            state: data.state,
            authUrl: data.auth_url,
        };
    }

    async exchangeCode({ sessionId, state, code, proxyId = null }) {
        return this._request('POST', '/api/v1/admin/antigravity/oauth/exchange-code', {
            session_id: sessionId,
            state,
            code,
            proxy_id: proxyId,
        });
    }

    /**
     * Exact-match lookup by account name. Server search is substring; we fetch
     * and filter client-side. Returns the account object or null.
     *
     * Only the first 50 results are inspected. If sub2api reports a larger total,
     * we log a warning — with the `ultra_<host>_<member>` naming scheme, substring
     * collisions beyond 50 are rare enough that we rely on the operator noticing
     * the warning rather than paginating exhaustively.
     */
    async findAccountByName(name) {
        const pageSize = 50;
        const qs = new URLSearchParams({ search: name, page: '1', page_size: String(pageSize) }).toString();
        const data = await this._request('GET', `/api/v1/admin/accounts?${qs}`, undefined);
        const list = Array.isArray(data?.items) ? data.items
            : Array.isArray(data?.list) ? data.list
            : Array.isArray(data) ? data
            : [];
        const total = typeof data?.total === 'number' ? data.total : null;
        if (total !== null && total > pageSize) {
            console.warn(`[sub2api] findAccountByName(${name}): total=${total} > page_size=${pageSize}; only the first page is searched. Manual verification recommended.`);
        }
        return list.find(a => a && a.name === name) || null;
    }

    async createAccount({ name, credentials }) {
        return this._request('POST', '/api/v1/admin/accounts', {
            name,
            platform: 'antigravity',
            type: 'oauth',
            credentials,
        });
    }

    async updateAccountCredentials(id, credentials) {
        return this._request('PUT', `/api/v1/admin/accounts/${encodeURIComponent(id)}`, { credentials });
    }

    /**
     * Runs the test endpoint against a specific model and consumes the SSE
     * stream. Returns:
     *   {
     *     ok:            boolean — true only when a test_complete with
     *                              success=true was observed
     *     error:         string | null — the error message from the last
     *                                    error event (if any), which for
     *                                    antigravity accounts often embeds
     *                                    a raw Google 4xx JSON body
     *     validationUrl: string | null — parsed Google account-verification
     *                                    URL extracted from the error body
     *                                    (see extractValidationUrl)
     *   }
     * Non-fatal by design — callers decide what to do with the result.
     */
    async testAccount(id, { modelId = 'claude-sonnet-4-6' } = {}) {
        const url = `${this.baseUrl}/api/v1/admin/accounts/${encodeURIComponent(id)}/test`;
        const fail = (error) => ({
            ok: false,
            error,
            validationUrl: extractValidationUrl(error),
        });

        let res;
        try {
            res = await fetch(url, {
                method: 'POST',
                headers: { 'x-api-key': this.apiKey, 'content-type': 'application/json' },
                body: JSON.stringify({ model_id: modelId }),
            });
        } catch (e) {
            return fail(`network: ${e.message}`);
        }
        if (!res.ok) return fail(`http ${res.status} ${res.statusText}`);
        if (!res.body) return fail('empty response body');

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = '';
        let lastError = null;
        let sawSuccess = false;

        const parseEvent = (evt) => {
            // A single SSE event may contain multiple lines; we only care
            // about the "data: {...}" payload line.
            for (const line of evt.split('\n')) {
                const m = line.match(/^data:\s*(.*)$/);
                if (!m) continue;
                const raw = m[1];
                if (!raw) continue;
                let obj;
                try { obj = JSON.parse(raw); } catch (_) { continue; }
                if (!obj || typeof obj !== 'object') continue;
                if (obj.type === 'error' && typeof obj.error === 'string') {
                    lastError = obj.error;
                }
                if (obj.type === 'test_complete' && obj.success === true) {
                    sawSuccess = true;
                }
            }
        };

        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                buf += decoder.decode(value, { stream: true })
                    .replace(/\r\n/g, '\n')
                    .replace(/\r/g, '\n');
                let idx;
                while ((idx = buf.indexOf('\n\n')) >= 0) {
                    parseEvent(buf.slice(0, idx));
                    buf = buf.slice(idx + 2);
                }
            }
            if (buf.trim()) parseEvent(buf); // trailing event without blank line
        } catch (e) {
            return fail(lastError || `stream read failed: ${e.message}`);
        }

        if (sawSuccess && !lastError) return { ok: true, error: null, validationUrl: null };
        return fail(lastError || 'test did not emit a success event');
    }
}

// ============ OAuth code capture via request interception ============

/**
 * Opens authUrl in `page`, intercepts the redirect to
 * http://localhost:8085/callback, and returns the OAuth `code`.
 * Throws on timeout (60s default) or if the callback URL carries `error=`.
 *
 * Relies on request interception, so port 8085 is never actually contacted
 * and multiple workers can run in parallel without collision.
 */
async function captureOAuthCode(page, authUrl, wlog, { timeoutMs = 60000 } = {}) {
    await page.setRequestInterception(true);

    let resolveCode, rejectCode;
    const codePromise = new Promise((resolve, reject) => {
        resolveCode = resolve;
        rejectCode = reject;
    });

    const onRequest = (req) => {
        const url = req.url();
        if (url.startsWith('http://localhost:8085/callback')) {
            try {
                const u = new URL(url);
                const code = u.searchParams.get('code');
                const err = u.searchParams.get('error');
                if (err) {
                    rejectCode(new Error(`oauth_denied:${err}`));
                } else if (code) {
                    resolveCode(code);
                } else {
                    rejectCode(new Error('oauth_callback_missing_code'));
                }
            } catch (e) {
                rejectCode(new Error(`oauth_callback_parse: ${e.message}`));
            }
            req.abort().catch(() => { });
            return;
        }
        req.continue().catch(() => { });
    };

    page.on('request', onRequest);

    let timeoutId;
    const timeoutPromise = new Promise((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error('oauth_capture_timeout')), timeoutMs);
    });

    try {
        // Kick off navigation but do not await it — the redirect to
        // localhost:8085 will fire request interception first and we resolve
        // via the promise, not via goto's return value. The expected failure
        // here is net::ERR_ABORTED (from our own req.abort on the callback);
        // anything else is a real navigation failure we should surface.
        page.goto(authUrl, { waitUntil: 'domcontentloaded', timeout: timeoutMs })
            .catch((e) => {
                if (e && /ERR_ABORTED/i.test(e.message || '')) return;
                rejectCode(e);
            });

        const code = await Promise.race([codePromise, timeoutPromise]);
        if (wlog) wlog.debug(`  OAuth code captured (${code.length} chars)`);
        return code;
    } finally {
        clearTimeout(timeoutId);
        page.off('request', onRequest);
        await page.setRequestInterception(false).catch(() => { });
    }
}

// ============ OAuth consent helpers ============

/**
 * Detect a Google 2FA/TOTP challenge that re-appears mid-OAuth flow and
 * auto-fill the code using member.totp_secret. Returns true if a TOTP
 * input was found and a code was entered (caller should wait for the
 * page to settle afterwards). Returns false when no TOTP input is
 * present on the current page.
 */
async function handleTotpChallenge(page, member, wlog) {
    if (!member || !member.totp_secret) return false;
    const hasInput = await page.evaluate(() => {
        const sels = [
            'input[type="tel"]', 'input[type="number"]',
            'input[name*="totpPin" i]', 'input[name*="pin" i]', 'input[name*="code" i]',
            'input[aria-label*="code" i]', 'input[aria-label*="验证码" i]', 'input[aria-label*="mã" i]',
            '#totpPin', '#idvPin',
        ];
        for (const sel of sels) {
            for (const inp of document.querySelectorAll(sel)) {
                const r = inp.getBoundingClientRect();
                if (r.width > 0 && r.height > 0 && !inp.disabled) return true;
            }
        }
        return false;
    }).catch(() => false);
    if (!hasInput) return false;

    let code;
    try { code = generateTOTP(member.totp_secret); }
    catch (e) { wlog.warn(`  [consent] TOTP generation failed: ${e.message}`); return false; }

    wlog.info(`  [consent] TOTP challenge detected, filling code ${code}`);
    // Focus + clear
    await page.evaluate(() => {
        const sels = [
            'input[type="tel"]', 'input[type="number"]',
            'input[name*="totpPin" i]', 'input[name*="pin" i]', 'input[name*="code" i]',
            'input[aria-label*="code" i]', 'input[aria-label*="验证码" i]', 'input[aria-label*="mã" i]',
            '#totpPin', '#idvPin',
        ];
        for (const sel of sels) {
            for (const inp of document.querySelectorAll(sel)) {
                const r = inp.getBoundingClientRect();
                if (r.width > 0 && r.height > 0 && !inp.disabled) {
                    inp.focus();
                    inp.value = '';
                    return;
                }
            }
        }
    }).catch(() => { });
    await sleep(200);
    await page.keyboard.type(code, { delay: 40 });
    await sleep(500);

    // Click the "Next / 下一步 / Tiếp theo / ..." button. Use a button-only
    // click strategy — we explicitly do NOT match email text here because
    // the account chip also shows the email.
    const clicked = await page.evaluate(() => {
        const keywords = [
            'next', 'verify', 'continue', 'confirm', 'submit',
            '下一步', '继续', '确认', '验证',
            'tiếp theo', 'xác minh', 'tiếp tục',
            'siguiente', 'verificar', 'continuar',
            'suivant', 'vérifier', 'continuer',
            'lanjut', 'verifikasi', 'weiter', 'bestätigen',
        ];
        function isVisible(el) {
            if (!el || !el.getBoundingClientRect) return false;
            const r = el.getBoundingClientRect();
            if (r.width <= 0 || r.height <= 0) return false;
            const cs = window.getComputedStyle(el);
            return cs.display !== 'none' && cs.visibility !== 'hidden';
        }
        const btns = document.querySelectorAll('button, [role="button"], input[type="submit"]');
        for (const el of btns) {
            if (!isVisible(el)) continue;
            const txt = (el.textContent || el.value || '').trim().toLowerCase();
            if (keywords.some(k => txt.includes(k))) {
                el.click();
                return txt.substring(0, 40);
            }
        }
        return null;
    }).catch(() => null);
    if (!clicked) await page.keyboard.press('Enter').catch(() => { });
    return true;
}

/**
 * Click past a Google OAuth consent / account-picker page. Scans for
 * elements whose visible text contains the target email (account picker)
 * or common "allow/continue/confirm" labels in multiple languages, and
 * walks up to a clickable ancestor before clicking. Returns a short
 * description on success, or null.
 */
async function clickOAuthConsentTarget(page, email) {
    return page.evaluate((targetEmail) => {
        const lower = (s) => (s || '').toLowerCase();
        const KEYWORDS = [
            // Forward-style (continue, next, allow, authorize, sign in)
            'continue', 'allow', 'accept', 'confirm', 'next', 'authorize', 'sign in', 'log in',
            '继续', '允许', '同意', '确认', '下一步', '授权', '登录', '登入',
            'tiếp tục', 'tiếp theo', 'cho phép', 'chấp nhận', 'xác nhận', 'đăng nhập',
            'continuar', 'permitir', 'aceptar', 'aceitar', 'iniciar sesión', 'entrar',
            'continuer', 'autoriser', 'accepter', 'se connecter',
            'lanjutkan', 'izinkan', 'terima', 'masuk',
            'weiter', 'zulassen', 'bestätigen', 'anmelden',
        ];
        // Deny-style: NEVER click these by accident
        const NEGATIVE_KEYWORDS = [
            'cancel', 'deny', 'no thanks', 'not now', 'back',
            '取消', '拒绝', '返回',
            'huỷ', 'hủy', 'từ chối', 'quay lại',
            'cancelar', 'recusar', 'rechazar', 'volver', 'voltar',
            'annuler', 'refuser', 'retour',
            'batal', 'tolak', 'kembali',
            'abbrechen', 'ablehnen', 'zurück',
        ];
        const emailLower = lower(targetEmail);

        function isVisible(el) {
            if (!el || !el.getBoundingClientRect) return false;
            const r = el.getBoundingClientRect();
            if (r.width <= 0 || r.height <= 0) return false;
            const cs = window.getComputedStyle(el);
            return cs.display !== 'none' && cs.visibility !== 'hidden' && cs.opacity !== '0';
        }

        function clickableAncestor(el) {
            let cur = el;
            for (let i = 0; i < 6 && cur; i++) {
                const tag = cur.tagName && cur.tagName.toLowerCase();
                if (tag === 'a' || tag === 'button') return cur;
                if (cur.getAttribute && (cur.getAttribute('role') === 'button' || cur.getAttribute('role') === 'link')) return cur;
                if (cur.hasAttribute && (cur.hasAttribute('jsaction') || cur.hasAttribute('data-identifier'))) return cur;
                try {
                    const cs = window.getComputedStyle(cur);
                    if (cs && cs.cursor === 'pointer') return cur;
                } catch (_) { }
                cur = cur.parentElement;
            }
            return el;
        }

        // Priority 1: explicit forward-style button/link labels. These are
        // the most reliable — they exist on both intermediate consent pages
        // and the final "confirm this is the right app" page.
        {
            const btns = document.querySelectorAll('button, [role="button"], a[role="link"], input[type="submit"]');
            for (const el of btns) {
                if (!isVisible(el)) continue;
                const txt = lower((el.textContent || el.value || '').trim());
                if (!txt) continue;
                if (NEGATIVE_KEYWORDS.some(k => txt.includes(k))) continue;
                if (KEYWORDS.some(k => txt.includes(k))) {
                    el.click();
                    return `keyword button: "${txt.substring(0, 40)}"`;
                }
            }
        }

        // Priority 2: data-identifier attribute (Google's canonical account
        // picker — only fires on the account-chooser page, not the final
        // confirm page).
        if (emailLower) {
            const byData = document.querySelector(`[data-identifier="${targetEmail}" i], [data-email="${targetEmail}" i]`);
            if (byData && isVisible(byData)) {
                byData.click();
                return `data-identifier match: ${targetEmail}`;
            }
        }

        // Priority 3: any visible leaf-ish element whose text contains the
        // email and is inside what looks like a clickable row. Fallback only.
        if (emailLower) {
            const all = document.querySelectorAll('li a, li button, div[role="button"], div[role="link"]');
            for (const el of all) {
                if (!isVisible(el)) continue;
                const txt = lower(el.textContent || '');
                if (!txt.includes(emailLower)) continue;
                el.click();
                return `email-row match: ${el.tagName.toLowerCase()}`;
            }
        }

        return null;
    }, email).catch(() => null);
}

/**
 * Drive a Google account-verification URL to completion inside an
 * already-logged-in `page`. Used after a sub2api test fails with a
 * VALIDATION_REQUIRED error: Google sent us a signin/continue URL that,
 * once visited, shows a "verify your account" confirmation page. This
 * function navigates to that URL and then reuses the same TOTP +
 * consent-click pollers as the OAuth flow to click past the prompts,
 * waiting until Google redirects to a success page
 * (auth_success_gemini / myaccount / about:blank).
 *
 * Returns true when the flow appears to have completed, false on timeout.
 */
async function completeValidationFlow(page, validationUrl, member, wlog, { timeoutMs = 90000 } = {}) {
    wlog.info(`  [validate] navigating to account-verification URL...`);
    wlog.debug(`  [validate] url: ${validationUrl.slice(0, 120)}...`);

    await page.goto(validationUrl, { waitUntil: 'domcontentloaded', timeout: 30000 })
        .catch(e => wlog.warn(`  [validate] initial nav warning: ${e.message}`));
    await sleep(2000);

    const startedAt = Date.now();
    let lastUrl = '';
    let idleRounds = 0;

    while (Date.now() - startedAt < timeoutMs) {
        // 1) auto-fill TOTP if Google asks for another 2FA challenge
        try {
            const totpHandled = await handleTotpChallenge(page, member, wlog);
            if (totpHandled) {
                await sleep(4000);
                continue;
            }
        } catch (_) { /* keep polling */ }

        // 2) click "Continue / Verify / Tiếp tục / ..." buttons
        try {
            const hit = await clickOAuthConsentTarget(page, member.email);
            if (hit) {
                wlog.info(`  [validate] click: ${hit}`);
                await sleep(2500);
                continue;
            }
        } catch (_) { /* keep polling */ }

        // 3) detect success: either the target redirect (auth_success_gemini)
        //    or a settled non-signin page (myaccount / gstatic / about:blank)
        let url;
        try { url = page.url(); } catch (_) { url = lastUrl; }
        if (url && url !== lastUrl) {
            wlog.debug(`  [validate] url -> ${url.slice(0, 100)}`);
            lastUrl = url;
            idleRounds = 0;
        } else {
            idleRounds++;
        }

        if (url && /auth_success_gemini/i.test(url)) {
            wlog.success(`  [validate] success landing reached`);
            return true;
        }
        // Settled on a non-signin Google page for several idle rounds — treat as done
        if (idleRounds >= 4 && url && !/accounts\.google\.com\/signin/i.test(url)) {
            wlog.success(`  [validate] settled on ${url.slice(0, 80)} — treating as done`);
            return true;
        }

        await sleep(1500);
    }

    wlog.warn(`  [validate] timed out after ${timeoutMs / 1000}s`);
    return false;
}

// ============ 单 member 编排 ============

const SESSION_SAFETY_WINDOW_MS = 25 * 60 * 1000; // sub2api SessionTTL = 30min, keep 5min buffer

async function processMember({ member, host, client, browser, workerId, opts }) {
    const wlog = createWorkerLogger(workerId);
    const timer = new StepTimer(wlog);
    const name = accountName(host.email, member.email);
    wlog.info(`>> processMember name=${name} email=${member.email}`);

    // 1. Check existence + decide mode
    const existing = await client.findAccountByName(name);
    timer.step('findAccountByName');

    const forceReauth = shouldForceReauth(member.email, opts);
    let mode;
    if (!existing) {
        mode = 'create';
    } else if (forceReauth) {
        mode = 'reauth';
        wlog.info(`  forced re-auth requested (id=${existing.id})`);
    } else if (existing.status === 'active') {
        wlog.success(`  [skip] already active (id=${existing.id})`);
        return { status: 'skipped', accountId: existing.id, mode: 'skip' };
    } else {
        mode = 'reauth';
        wlog.info(`  auto re-auth: status=${existing.status} (id=${existing.id})`);
    }

    // 2. Get auth url (starts sub2api session 30min countdown)
    const authStartedAt = Date.now();
    const { sessionId, state, authUrl } = await client.getAuthUrl();
    timer.step('getAuthUrl');

    // 3. Browser login as the member.
    //    Mirror stage 2's pattern: clear browser session first to wipe any
    //    residual cookies/storage from a previous account, then navigate to
    //    the Google signin page so googleLogin (which drives an existing
    //    signin page, it does not navigate on its own) has something to act
    //    on. The trailing clearBrowserSession in finally keeps successive
    //    members from bleeding into each other.
    await clearBrowserSession(browser, wlog);
    const page = await newPage(browser);
    try {
        await page.goto('https://accounts.google.com/signin', {
            waitUntil: 'domcontentloaded',
            timeout: 30000,
        }).catch(e => wlog.warn(`  signin nav warning: ${e.message}`));
        await sleep(1000);
        await googleLogin(page, member, wlog);
        timer.step('googleLogin');

        // 4. Manual intervention point
        await maybePause('before-oauth', wlog);

        // Session TTL safety check after (potentially long) pause
        if (Date.now() - authStartedAt > SESSION_SAFETY_WINDOW_MS) {
            throw new Error(`sub2api session nearly expired (${Math.round((Date.now() - authStartedAt) / 1000)}s elapsed, limit ${SESSION_SAFETY_WINDOW_MS / 1000}s) — re-run stage 3 to restart`);
        }

        // 5. Capture OAuth code via request interception.
        //    Google's consent flow frequently stops on an account-picker page
        //    or a "Continue / Allow" confirm page. Run a background poller
        //    that auto-clicks past those while captureOAuthCode waits for the
        //    localhost:8085/callback redirect.
        let keepPolling = true;
        let clickAttempts = 0;
        const consentPoller = (async () => {
            await sleep(2500); // let goto settle first
            while (keepPolling) {
                clickAttempts++;
                try {
                    // 1) TOTP re-challenge (OAuth re-verifies identity on risk triggers)
                    const totpHandled = await handleTotpChallenge(page, member, wlog);
                    if (totpHandled) {
                        await sleep(4000); // wait for verify + nav
                        continue;
                    }
                    // 2) account picker / continue-allow page
                    const hit = await clickOAuthConsentTarget(page, member.email);
                    if (hit) {
                        wlog.info(`  [consent] click (attempt ${clickAttempts}): ${hit}`);
                        await sleep(2500);
                    } else if (clickAttempts === 1 || clickAttempts % 5 === 0) {
                        wlog.debug(`  [consent] idle (attempt ${clickAttempts}, url=${page.url().slice(0, 80)})`);
                    }
                } catch (_) { /* ignore click errors; we're just probing */ }
                await sleep(1500);
            }
        })();

        let code;
        try {
            code = await captureOAuthCode(page, authUrl, wlog);
        } catch (e) {
            await takeScreenshot(page, `sub2api_oauth_fail_${member.email.replace(/[^a-z0-9]/gi, '_')}`, wlog);
            throw e;
        } finally {
            keepPolling = false;
            await consentPoller.catch(() => { });
        }
        timer.step('captureOAuthCode');

        // 6. Exchange code -> tokens
        const tokens = await client.exchangeCode({ sessionId, state, code });
        timer.step('exchangeCode');

        // 7. Build credentials (expires_at must be string per spec note)
        const credentials = {
            access_token: tokens.access_token,
            refresh_token: tokens.refresh_token,
            expires_at: String(tokens.expires_at),
            token_type: tokens.token_type || 'Bearer',
            email: tokens.email,
            project_id: tokens.project_id,
        };

        // 8. Create or update
        let account;
        if (mode === 'create') {
            try {
                account = await client.createAccount({ name, credentials });
            } catch (e) {
                // Race fallback: maybe someone else created it between our lookup and now
                if (e instanceof Sub2apiError) {
                    const again = await client.findAccountByName(name);
                    if (again) {
                        wlog.warn(`  create collided, falling back to PUT id=${again.id}`);
                        account = await client.updateAccountCredentials(again.id, credentials);
                    } else {
                        throw e;
                    }
                } else {
                    throw e;
                }
            }
            timer.step('createAccount');
        } else {
            account = await client.updateAccountCredentials(existing.id, credentials);
            timer.step('updateAccountCredentials');
        }

        // Account is registered; model testing + validation flow are the
        // responsibility of stage 4 (src/4_verify.js). Keeping stage 3 as a
        // pure register-only path lets concurrency stay high without the
        // per-account verification back-and-forth.
        wlog.success(`  ${mode} done: id=${account.id}`);
        return {
            status: mode === 'create' ? 'created' : 'updated',
            accountId: account.id,
            mode,
        };
    } finally {
        await page.close().catch(() => { });
        await clearBrowserSession(browser, wlog).catch(() => { });
    }
}

// ============ main ============

const keepBrowserOpen = (process.env.KEEP_BROWSER_OPEN || '').toLowerCase() === 'true';
let _workers = [];

function cleanupWorkers(workers) {
    for (const w of workers) {
        if (keepBrowserOpen) {
            try { w.browser.disconnect(); } catch (_) { }
        } else {
            try { w.browser.close(); } catch (_) { }
            try { w.proc.kill(); } catch (_) { }
        }
    }
    if (keepBrowserOpen && workers.length > 0) log('Browsers kept open (KEEP_BROWSER_OPEN=true)');
}

process.on('SIGINT', () => {
    log('\nInterrupted (Ctrl+C). Cleaning up...', 'WARN');
    cleanupWorkers(_workers);
    process.exit();
});

function pairMembersWithHosts(hosts, members) {
    // Same convention as stage1 buildGroups: 5 members per host, by index.
    const pairs = [];
    for (let i = 0; i < members.length; i++) {
        const hostIdx = Math.floor(i / 5);
        if (hostIdx >= hosts.length) {
            log(`  Dropping member[${i}] ${members[i].email}: no host (members > 5 * hosts.length)`, 'WARN');
            continue;
        }
        pairs.push({ member: members[i], host: hosts[hostIdx] });
    }
    return pairs;
}

async function main() {
    const repoRoot = path.resolve(__dirname, '..');
    const sub2apiFile = path.join(repoRoot, 'sub2api.txt');
    const hostsFile = path.join(repoRoot, 'hosts.txt');
    const membersFile = path.join(repoRoot, 'members.txt');

    const cfg = parseSub2apiConfig(sub2apiFile);
    const client = new Sub2apiClient(cfg.url, cfg.apiKey);

    const hosts = parseAccounts(hostsFile);
    const members = parseAccounts(membersFile);
    const pending = pairMembersWithHosts(hosts, members);

    const chromePath = findChrome();
    if (!chromePath) { console.error('Chrome not found'); process.exit(1); }

    log('');
    log('='.repeat(60));
    log('  Stage 3: Register Accounts in sub2api');
    log('='.repeat(60));
    log(`  sub2api URL:  ${cfg.url}`);
    log(`  Hosts:        ${hostsFile}`);
    log(`  Members:      ${membersFile}`);
    log(`  Pending:      ${pending.length}`);
    log(`  Concurrency:  ${CLI_OPTS.concurrency}`);
    log(`  Reauth all:   ${CLI_OPTS.reauthAll}`);
    log(`  Reauth list:  ${CLI_OPTS.reauthList.length ? CLI_OPTS.reauthList.join(',') : '(none)'}`);
    log('='.repeat(60));
    log('');

    if (pending.length === 0) {
        log('No members to process. Exiting.', 'SUCCESS');
        return;
    }

    // Launch workers
    const workers = _workers = [];
    for (let w = 0; w < Math.min(CLI_OPTS.concurrency, pending.length); w++) {
        try {
            const chrome = await launchRealChrome(chromePath, w);
            workers.push({ id: w, ...chrome });
            if (w < CLI_OPTS.concurrency - 1) await sleep(rand(2000, 3000));
        } catch (e) {
            log(`Worker${w} launch failed: ${e.message}`, 'ERROR');
        }
    }
    if (workers.length === 0) {
        console.error('All Chrome instances failed to start');
        process.exit(1);
    }

    let idx = 0;
    const stats = { created: 0, updated: 0, skipped: 0, failed: 0 };

    async function workerFn(worker) {
        const wlog = createWorkerLogger(worker.id);
        while (true) {
            const myIdx = idx++;
            if (myIdx >= pending.length) break;
            const { member, host } = pending[myIdx];

            try {
                const alive = await isChromeAlive(worker);
                if (!alive) await restartChrome(chromePath, worker);

                const result = await Promise.race([
                    processMember({
                        member, host, client,
                        browser: worker.browser,
                        workerId: worker.id,
                        opts: CLI_OPTS,
                    }),
                    new Promise((_, rej) => setTimeout(
                        () => rej(new Error(`sub2api_hard_timeout: exceeded ${HARD_TIMEOUT_MS / 1000}s`)),
                        HARD_TIMEOUT_MS
                    )),
                ]);

                if (result.status === 'created') stats.created++;
                else if (result.status === 'updated') stats.updated++;
                else if (result.status === 'skipped') stats.skipped++;
            } catch (e) {
                wlog.error(`processMember failed [${member.email}]: ${e.message}`);
                stats.failed++;
                await addFailedRecord({
                    stage: 3,
                    memberEmail: member.email,
                    hostEmail: host.email,
                    reason: e.message,
                });
                if (/hard_timeout|Protocol error|Session closed|Target closed/i.test(e.message || '')) {
                    wlog.warn('  Restarting Chrome after hard failure...');
                    try { await restartChrome(chromePath, worker); } catch (re) {
                        wlog.error(`  Chrome restart failed: ${re.message}`);
                    }
                }
            }

            await sleep(rand(1000, 2000));
        }
    }

    await Promise.all(workers.map(w => workerFn(w)));
    cleanupWorkers(workers);

    log('');
    log('='.repeat(60));
    log('  Stage 3 Complete', 'SUCCESS');
    log(`  Created: ${stats.created}  Updated: ${stats.updated}  Skipped: ${stats.skipped}  Failed: ${stats.failed}`);
    log('='.repeat(60));
    log('');
}

// Invoke main when this file is run directly (not when imported by the test file).
if (require.main === module) {
    main().catch(e => {
        log(`Fatal: ${e.message}`, 'ERROR');
        if (e.stack) console.error(e.stack);
        process.exit(1);
    });
}

module.exports = {
    accountName,
    parseSub2apiConfig,
    shouldForceReauth,
    extractValidationUrl,
    Sub2apiClient,
    Sub2apiError,
    captureOAuthCode,
    completeValidationFlow,
};
