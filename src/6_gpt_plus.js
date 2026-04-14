/**
 * GPT Plus — 在 sub2api 注册 OpenAI OAuth 账号
 *
 * 流程（每个 plus.txt 账号一次）：
 *   1. 按 name=plus_<email> 查 sub2api；存在则跳过
 *   2. POST /api/v1/admin/openai/oauth/auth-url → {session_id, state, auth_url}
 *   3. puppeteer 打开 auth_url：填邮箱 → 密码 → TOTP → 授权页 "继续"
 *   4. 请求拦截 http://localhost:1455/auth/callback?code=xxx 抓 code
 *   5. POST /api/v1/admin/openai/oauth/exchange-code → tokens
 *   6. POST /api/v1/admin/accounts（platform=openai，proxy_id=2，concurrency=4，
 *      group_ids=[OPENAI_GROUP_ID]，extra.unschedulable_codes=[429,503,529]）
 *   7. 写 gpt_plus_state.json
 *
 * 可配置环境变量：
 *   OPENAI_OAUTH_AUTH_URL_PATH   默认 /api/v1/admin/openai/oauth/auth-url
 *   OPENAI_OAUTH_EXCHANGE_PATH   默认 /api/v1/admin/openai/oauth/exchange-code
 *   OPENAI_PROXY_ID              默认 2
 *   OPENAI_CONCURRENCY           默认 4
 *   OPENAI_GROUP_IDS             默认 1（逗号分隔多个）
 *   OPENAI_UNSCHEDULABLE_CODES   默认 429,503,529
 *   GPT_PLUS_HARD_TIMEOUT_MS     默认 300000
 */

const fs = require('fs');
const path = require('path');
const { log, createWorkerLogger, setVerbose, StepTimer } = require('./common/logger');
const {
    sleep, rand, findChrome, launchRealChrome, restartChrome,
    isChromeAlive, clearBrowserSession, newPage, takeScreenshot,
} = require('./common/chrome');
const { addFailedRecord } = require('./common/state');

// plus.txt 格式: email----pass--totp_secret
function parsePlusAccounts(filePath) {
    if (!fs.existsSync(filePath)) throw new Error(`plus file not found: ${filePath}`);
    let raw = fs.readFileSync(filePath, 'utf-8');
    if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
    const out = [];
    const lines = raw.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
        const t = lines[i].trim();
        if (!t || t.startsWith('#')) continue;
        const p1 = t.indexOf('----');
        if (p1 < 0) { log(`  plus line ${i + 1}: missing "----", skipping`, 'WARN'); continue; }
        const email = t.slice(0, p1).trim();
        const afterEmail = t.slice(p1 + 4);
        const p2 = afterEmail.indexOf('--');
        if (p2 < 0) { log(`  plus line ${i + 1}: missing "--" before totp, skipping`, 'WARN'); continue; }
        const pass = afterEmail.slice(0, p2).trim();
        const totp = afterEmail.slice(p2 + 2).trim();
        if (!email.includes('@') || !pass || !totp) {
            log(`  plus line ${i + 1}: invalid fields, skipping`, 'WARN'); continue;
        }
        out.push({ idx: i + 1, email, pass, totp_secret: totp });
    }
    return out;
}
const { generateTOTP, getTOTPWithTTL } = require('./common/totp');

// ============ CLI ============
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

const CLI_OPTS = {
    concurrency: parseIntArg(['-c', '--concurrency'], parseInt(process.env.CONCURRENCY, 10) || 3),
    limit: parseIntArg(['-n', '--limit'], 0),
    start: parseIntArg(['-s', '--start'], 1), // 1-based index
};

const HARD_TIMEOUT_MS = parseInt(process.env.GPT_PLUS_HARD_TIMEOUT_MS, 10) || 300000;

// ============ sub2api config ============
function parseSub2apiConfig(filePath) {
    if (!fs.existsSync(filePath)) throw new Error(`sub2api config not found: ${filePath}`);
    let raw = fs.readFileSync(filePath, 'utf-8');
    if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
    const result = {};
    for (const line of raw.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eq = trimmed.indexOf('=');
        if (eq <= 0) continue;
        const k = trimmed.slice(0, eq).trim();
        const v = trimmed.slice(eq + 1).trim();
        if (k === 'url') result.url = v;
        else if (k === 'api_key') result.apiKey = v;
    }
    if (!result.url) throw new Error(`sub2api config: missing "url"`);
    if (!result.apiKey) throw new Error(`sub2api config: missing "api_key"`);
    return result;
}

// ============ gpt_plus_state.json ============
const STATE_FILE = path.resolve(__dirname, '..', 'gpt_plus_state.json');

function loadGptState() {
    if (!fs.existsSync(STATE_FILE)) return {};
    try {
        const raw = fs.readFileSync(STATE_FILE, 'utf-8').trim();
        return raw ? JSON.parse(raw) : {};
    } catch (_) { return {}; }
}

function saveGptState(obj) {
    fs.writeFileSync(STATE_FILE, JSON.stringify(obj, null, 2), 'utf-8');
}

function updateGptState(email, patch) {
    const state = loadGptState();
    // Replace (not merge) so a fresh success wipes a stale `reason` from
    // an earlier failed run.
    state[email] = { ...patch, ts: new Date().toISOString() };
    saveGptState(state);
}

// ============ sub2api REST client ============
class Sub2apiError extends Error {
    constructor(endpoint, httpStatus, bizCode, message) {
        super(`[sub2api] ${endpoint} http=${httpStatus} code=${bizCode}: ${message}`);
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
        try { res = await fetch(url, init); }
        catch (e) { throw new Sub2apiError(pathname, 0, -1, `network: ${e.message}`); }
        const text = await res.text();
        let json = null;
        try { json = text ? JSON.parse(text) : null; } catch (_) { }
        if (!res.ok) {
            throw new Sub2apiError(pathname, res.status, json?.code ?? -1, json?.message || text || res.statusText);
        }
        if (json && typeof json === 'object' && 'code' in json && json.code !== 0) {
            throw new Sub2apiError(pathname, res.status, json.code, json.message || 'non-zero biz code');
        }
        return json?.data ?? null;
    }

    async getAuthUrl(proxyId) {
        const endpoint = process.env.OPENAI_OAUTH_AUTH_URL_PATH || '/api/v1/admin/openai/generate-auth-url';
        const data = await this._request('POST', endpoint, { proxy_id: proxyId });
        if (!data || !data.auth_url) {
            throw new Sub2apiError(endpoint, 200, -1, 'malformed auth-url response');
        }
        // state is embedded in auth_url's query (matches admin UI behavior)
        let state = '';
        try { state = new URL(data.auth_url).searchParams.get('state') || ''; } catch (_) { }
        return {
            sessionId: data.session_id,
            state,
            authUrl: data.auth_url,
        };
    }

    async exchangeCode({ sessionId, state, code, proxyId }) {
        const endpoint = process.env.OPENAI_OAUTH_EXCHANGE_PATH || '/api/v1/admin/openai/exchange-code';
        return this._request('POST', endpoint, {
            session_id: sessionId,
            state,
            code,
            proxy_id: proxyId,
        });
    }

    async findAccountByName(name) {
        const qs = new URLSearchParams({ search: name, page: '1', page_size: '50' }).toString();
        const data = await this._request('GET', `/api/v1/admin/accounts?${qs}`, undefined);
        const list = Array.isArray(data?.items) ? data.items
            : Array.isArray(data?.list) ? data.list
            : Array.isArray(data) ? data : [];
        return list.find(a => a && a.name === name) || null;
    }

    async createAccount({ name, credentials, proxyId, concurrency, groupIds, unschedulableCodes }) {
        return this._request('POST', '/api/v1/admin/accounts', {
            name,
            platform: 'openai',
            type: 'oauth',
            credentials,
            concurrency,
            priority: 1,
            proxy_id: proxyId,
            group_ids: groupIds,
            extra: {
                allow_overages: true,
                unschedulable_codes: unschedulableCodes,
            },
        });
    }
}

// ============ OAuth callback capture (localhost:1455) ============
const CALLBACK_PREFIX = 'http://localhost:1455/auth/callback';

async function captureCallbackCode(page, authUrl, wlog, { timeoutMs = 180000 } = {}) {
    await page.setRequestInterception(true);

    let resolveCode, rejectCode;
    const codePromise = new Promise((resolve, reject) => {
        resolveCode = resolve;
        rejectCode = reject;
    });

    const onRequest = (req) => {
        const url = req.url();
        if (url.startsWith(CALLBACK_PREFIX)) {
            try {
                const u = new URL(url);
                const code = u.searchParams.get('code');
                const err = u.searchParams.get('error');
                if (err) rejectCode(new Error(`oauth_denied:${err}`));
                else if (code) resolveCode(code);
                else rejectCode(new Error('oauth_callback_missing_code'));
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
        page.goto(authUrl, { waitUntil: 'domcontentloaded', timeout: timeoutMs })
            .catch((e) => {
                if (e && /ERR_ABORTED/i.test(e.message || '')) return;
                rejectCode(e);
            });
        const code = await Promise.race([codePromise, timeoutPromise]);
        wlog.debug(`  OAuth code captured (${code.length} chars)`);
        return code;
    } finally {
        clearTimeout(timeoutId);
        page.off('request', onRequest);
        await page.setRequestInterception(false).catch(() => { });
    }
}

// ============ page helpers ============
async function waitForSelectorAny(page, selectors, timeoutMs) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        for (const sel of selectors) {
            const el = await page.$(sel).catch(() => null);
            if (el) {
                const visible = await page.evaluate(e => {
                    const r = e.getBoundingClientRect();
                    const cs = window.getComputedStyle(e);
                    return r.width > 0 && r.height > 0 && cs.display !== 'none' && cs.visibility !== 'hidden' && !e.disabled;
                }, el).catch(() => false);
                if (visible) return { selector: sel, element: el };
            }
        }
        await sleep(500);
    }
    return null;
}

async function typeIntoInput(page, selector, value) {
    await page.focus(selector).catch(() => { });
    await page.evaluate((sel) => {
        const el = document.querySelector(sel);
        if (el) { el.value = ''; el.focus(); }
    }, selector);
    await sleep(150);
    await page.keyboard.type(value, { delay: 40 });
}

async function clickButtonByText(page, keywords) {
    return page.evaluate((kws) => {
        function isVisible(el) {
            if (!el || !el.getBoundingClientRect) return false;
            const r = el.getBoundingClientRect();
            if (r.width <= 0 || r.height <= 0) return false;
            const cs = window.getComputedStyle(el);
            return cs.display !== 'none' && cs.visibility !== 'hidden';
        }
        const btns = document.querySelectorAll('button, [role="button"], input[type="submit"], a');
        for (const el of btns) {
            if (!isVisible(el)) continue;
            const txt = (el.textContent || el.value || '').trim().toLowerCase();
            if (!txt) continue;
            if (kws.some(k => txt.includes(k))) { el.click(); return txt.substring(0, 60); }
        }
        return null;
    }, keywords).catch(() => null);
}

const CONTINUE_KEYWORDS = ['continue', '继续', 'next', '下一步', 'verify', '验证', 'submit', 'log in', 'sign in', '登录', 'authorize', '授权'];
const RETRY_KEYWORDS = ['try again', 'retry', '重试', '再试一次'];

// ============ OpenAI login flow ============
async function performOpenAILogin(page, member, wlog) {
    // step 1: wait for email input
    wlog.info('  [oauth] waiting for email input...');
    const emailHit = await waitForSelectorAny(page, [
        'input[name="username"]',
        'input[type="email"]',
        'input#email-input',
        'input#username',
    ], 60000);
    if (!emailHit) throw new Error('email_input_not_found');

    await typeIntoInput(page, emailHit.selector, member.email);
    await sleep(300);
    let clicked = await clickButtonByText(page, CONTINUE_KEYWORDS);
    if (!clicked) await page.keyboard.press('Enter');
    wlog.info(`  [oauth] email submitted (${clicked || 'Enter'})`);
    await sleep(2500);

    // possible error page: click retry and refill once
    const retryClicked = await clickButtonByText(page, RETRY_KEYWORDS);
    if (retryClicked) {
        wlog.info(`  [oauth] retry clicked: ${retryClicked}`);
        await sleep(2000);
        const emailHit2 = await waitForSelectorAny(page, [
            'input[name="username"]', 'input[type="email"]', 'input#email-input', 'input#username',
        ], 30000);
        if (emailHit2) {
            await typeIntoInput(page, emailHit2.selector, member.email);
            await sleep(300);
            if (!(await clickButtonByText(page, CONTINUE_KEYWORDS))) await page.keyboard.press('Enter');
            await sleep(2500);
        }
    }

    // step 2: password
    wlog.info('  [oauth] waiting for password input...');
    const pwHit = await waitForSelectorAny(page, [
        'input[name="password"]',
        'input[type="password"]',
        'input#password',
    ], 60000);
    if (!pwHit) throw new Error('password_input_not_found');

    await typeIntoInput(page, pwHit.selector, member.pass);
    await sleep(300);
    if (!(await clickButtonByText(page, CONTINUE_KEYWORDS))) await page.keyboard.press('Enter');
    wlog.info('  [oauth] password submitted');
    await sleep(3000);

    // step 3: TOTP
    if (!member.totp_secret) throw new Error('missing_totp_secret');

    wlog.info('  [oauth] waiting for TOTP input...');
    const totpHit = await waitForSelectorAny(page, [
        'input[name="code"]',
        'input[name="one-time-code"]',
        'input[autocomplete="one-time-code"]',
        'input[type="tel"]',
        'input[inputmode="numeric"]',
        'input#code',
    ], 60000);
    if (!totpHit) throw new Error('totp_input_not_found');

    let { code, remainingSeconds } = getTOTPWithTTL(member.totp_secret);
    if (remainingSeconds < 5) {
        wlog.info(`  [oauth] TOTP expiring in ${remainingSeconds}s, waiting for next window...`);
        await sleep((remainingSeconds + 1) * 1000);
        code = generateTOTP(member.totp_secret);
    }

    await typeIntoInput(page, totpHit.selector, code);
    await sleep(300);
    if (!(await clickButtonByText(page, CONTINUE_KEYWORDS))) await page.keyboard.press('Enter');
    wlog.info(`  [oauth] TOTP ${code} submitted`);
    await sleep(3000);

    // step 4: "使用 ChatGPT 登录到 Codex" → 继续
    //    The callback redirect to localhost:1455 is what ends this flow;
    //    a background poller clicks any remaining "Continue / 继续" buttons
    //    while captureCallbackCode waits for the interception.
}

// ============ per-account orchestration ============
async function processAccount({ member, client, browser, workerId, runOpts }) {
    const wlog = createWorkerLogger(workerId);
    const timer = new StepTimer(wlog);
    const name = `plus_${member.email}`;
    wlog.info(`>> ${name}`);

    // 1. Existence check
    const existing = await client.findAccountByName(name);
    timer.step('findAccountByName');
    if (existing) {
        wlog.success(`  [skip] already exists (id=${existing.id})`);
        updateGptState(member.email, { status: 'skipped', account_id: existing.id });
        return { status: 'skipped' };
    }

    // 2. Auth URL
    const { sessionId, state, authUrl } = await client.getAuthUrl(runOpts.proxyId);
    timer.step('getAuthUrl');
    wlog.info(`  authUrl len=${authUrl.length}`);

    // 3. Browser flow
    await clearBrowserSession(browser, wlog);
    const page = await newPage(browser);

    // performOpenAILogin drives email / password / TOTP sequentially. After
    // it finishes the page sits on a "使用 ChatGPT 登录到 Codex → 继续" screen
    // (or similar) before redirecting to localhost:1455. A consent poller
    // clicks those trailing Continue buttons — but MUST NOT run during
    // typing, otherwise it submits the form with a half-typed password.
    let keepPolling = true;
    let code;
    try {
        const loginTask = (async () => {
            await sleep(3000); // let captureCallbackCode's page.goto start
            await performOpenAILogin(page, member, wlog);
        })();

        const consentPoller = (async () => {
            // Wait for login to finish (or fail) before touching any buttons
            try { await loginTask; } catch (_) { /* still poll — may still reach callback */ }
            await sleep(500);
            while (keepPolling) {
                try {
                    const hit = await clickButtonByText(page, CONTINUE_KEYWORDS);
                    if (hit) {
                        wlog.debug(`  [consent] click: ${hit}`);
                        await sleep(2000);
                    }
                } catch (_) { }
                await sleep(1500);
            }
        })();

        const captureTask = captureCallbackCode(page, authUrl, wlog, { timeoutMs: 240000 });

        try {
            code = await captureTask;
        } catch (e) {
            await takeScreenshot(page, `gpt_plus_oauth_fail_${member.email.replace(/[^a-z0-9]/gi, '_')}`, wlog);
            throw e;
        } finally {
            keepPolling = false;
            await consentPoller.catch(() => { });
            await loginTask.catch(() => { });
        }
        timer.step('captureCallbackCode');
    } finally {
        await page.close().catch(() => { });
        await clearBrowserSession(browser, wlog).catch(() => { });
    }

    // 4. Exchange
    const tokens = await client.exchangeCode({ sessionId, state, code, proxyId: runOpts.proxyId });
    timer.step('exchangeCode');
    if (!tokens) throw new Error('exchange_code_returned_empty');

    // 5. Build credentials (carry through whatever fields sub2api returned)
    const credentials = { ...tokens };
    if (credentials.expires_at !== undefined) credentials.expires_at = String(credentials.expires_at);

    // 6. Create account
    const account = await client.createAccount({
        name,
        credentials,
        proxyId: runOpts.proxyId,
        concurrency: runOpts.concurrency,
        groupIds: runOpts.groupIds,
        unschedulableCodes: runOpts.unschedulableCodes,
    });
    timer.step('createAccount');
    wlog.success(`  created: id=${account.id}`);

    updateGptState(member.email, { status: 'ok', account_id: account.id });
    return { status: 'created', accountId: account.id };
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

function parseCsvInts(envVal, fallback) {
    if (!envVal) return fallback;
    const out = String(envVal).split(',').map(s => parseInt(s.trim(), 10)).filter(n => !Number.isNaN(n));
    return out.length ? out : fallback;
}

async function main() {
    const repoRoot = path.resolve(__dirname, '..');
    const sub2apiFile = path.join(repoRoot, 'sub2api.txt');
    const plusFile = path.join(repoRoot, 'plus.txt');

    const cfg = parseSub2apiConfig(sub2apiFile);
    const client = new Sub2apiClient(cfg.url, cfg.apiKey);

    let accounts = parsePlusAccounts(plusFile);
    if (CLI_OPTS.start > 1) {
        const skipped = CLI_OPTS.start - 1;
        accounts = accounts.slice(skipped);
        log(`  [start] skipping first ${skipped} account(s), starting from #${CLI_OPTS.start}`);
    }
    if (CLI_OPTS.limit > 0) {
        accounts = accounts.slice(0, CLI_OPTS.limit);
        log(`  [limit] processing up to ${accounts.length} account(s)`);
    }

    const runOpts = {
        proxyId: parseInt(process.env.OPENAI_PROXY_ID, 10) || 4,
        concurrency: parseInt(process.env.OPENAI_CONCURRENCY, 10) || 4,
        groupIds: parseCsvInts(process.env.OPENAI_GROUP_IDS, [3]),
        unschedulableCodes: parseCsvInts(process.env.OPENAI_UNSCHEDULABLE_CODES, [429, 503, 529]),
    };

    const chromePath = findChrome();
    if (!chromePath) { console.error('Chrome not found'); process.exit(1); }

    log('');
    log('='.repeat(60));
    log('  GPT Plus: Register OpenAI Accounts in sub2api');
    log('='.repeat(60));
    log(`  sub2api URL:          ${cfg.url}`);
    log(`  plus.txt:             ${plusFile}`);
    log(`  Pending:              ${accounts.length}`);
    log(`  Concurrency:          ${CLI_OPTS.concurrency}`);
    log(`  openai proxy_id:      ${runOpts.proxyId}`);
    log(`  openai concurrency:   ${runOpts.concurrency}`);
    log(`  openai group_ids:     [${runOpts.groupIds.join(',')}]`);
    log(`  unschedulable_codes:  [${runOpts.unschedulableCodes.join(',')}]`);
    log('='.repeat(60));
    log('');

    if (accounts.length === 0) {
        log('No accounts to process. Exiting.', 'SUCCESS');
        return;
    }

    // Validate totp_secret on every row up front — fails loud before any
    // Chrome gets started, so the operator knows plus.txt is malformed.
    const missingTotp = accounts.filter(a => !a.totp_secret).map(a => a.email);
    if (missingTotp.length) {
        log(`plus.txt rows missing totp_secret: ${missingTotp.join(', ')}`, 'ERROR');
        process.exit(1);
    }

    // Launch workers
    const workers = _workers = [];
    for (let w = 0; w < Math.min(CLI_OPTS.concurrency, accounts.length); w++) {
        try {
            const chrome = await launchRealChrome(chromePath, 500 + w); // offset profile dir to avoid clashing w/ stages 1-4
            workers.push({ id: w, ...chrome });
            if (w < CLI_OPTS.concurrency - 1) await sleep(rand(2000, 3000));
        } catch (e) {
            log(`Worker${w} launch failed: ${e.message}`, 'ERROR');
        }
    }
    if (workers.length === 0) { console.error('All Chrome instances failed to start'); process.exit(1); }

    let idx = 0;
    const stats = { created: 0, skipped: 0, failed: 0 };

    async function workerFn(worker) {
        const wlog = createWorkerLogger(worker.id);
        while (true) {
            const myIdx = idx++;
            if (myIdx >= accounts.length) break;
            const member = accounts[myIdx];

            try {
                const alive = await isChromeAlive(worker);
                if (!alive) await restartChrome(chromePath, worker);

                const result = await Promise.race([
                    processAccount({ member, client, browser: worker.browser, workerId: worker.id, runOpts }),
                    new Promise((_, rej) => setTimeout(
                        () => rej(new Error(`gpt_plus_hard_timeout: exceeded ${HARD_TIMEOUT_MS / 1000}s`)),
                        HARD_TIMEOUT_MS
                    )),
                ]);
                if (result.status === 'created') stats.created++;
                else if (result.status === 'skipped') stats.skipped++;
            } catch (e) {
                wlog.error(`processAccount failed [${member.email}]: ${e.message}`);
                stats.failed++;
                updateGptState(member.email, { status: 'failed', reason: e.message });
                await addFailedRecord({
                    stage: 'gpt_plus',
                    email: member.email,
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
    log('  GPT Plus Complete', 'SUCCESS');
    log(`  Created: ${stats.created}  Skipped: ${stats.skipped}  Failed: ${stats.failed}`);
    log('='.repeat(60));
    log('');
}

if (require.main === module) {
    main().catch(e => {
        log(`Fatal: ${e.message}`, 'ERROR');
        if (e.stack) console.error(e.stack);
        process.exit(1);
    });
}

module.exports = { Sub2apiClient, captureCallbackCode, performOpenAILogin };
