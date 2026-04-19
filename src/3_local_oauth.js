/**
 * 阶段3（本地版）— 登录 → 本地 OAuth → 探测 antigravity → 验证 → 落盘 refresh_token
 *
 * 与 3_sub2api.js 的区别：完全脱离 sub2api 平台。流程：
 *   1. googleLogin(member)
 *   2. 本地起 HTTP 回调服务器，走标准 Google OAuth 拿 access_token + refresh_token
 *   3. 调 cloudcode-pa/v1internal:loadCodeAssist/onboardUser 拿 project_id
 *   4. 探测 cloudcode-pa/v1internal:streamGenerateContent —— 若 403 返
 *      validation_url，用 completeValidationFlow 驱动验证页走完
 *   5. 重新探测确认 200
 *   6. 把 {name, email, refresh_token, access_token, expires_at, project_id}
 *      写到 repo 根目录 credentials.json（按 accountName 去重 upsert）
 *
 * 请求格式与 sub2api 对齐（cloudcode-pa v1internal + User-Agent: antigravity/x.y.z）
 *
 * CLI:
 *   node src/3_local_oauth.js [-c N] [--reauth-all] [--reauth=a@b,c@d]
 *                             [--skip-validation] [--verbose]
 */

require('dotenv').config({ path: require('path').resolve(__dirname, '.env') });
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

// Node 内置 fetch (undici) 默认不读 HTTPS_PROXY 环境变量。
// 若环境里配置了代理（如 WSL2 下的 127.0.0.1:10808），需要显式注入 dispatcher。
{
    const proxyUrl = process.env.HTTPS_PROXY || process.env.https_proxy
        || process.env.HTTP_PROXY || process.env.http_proxy;
    if (proxyUrl) {
        const { setGlobalDispatcher, ProxyAgent } = require('undici');
        setGlobalDispatcher(new ProxyAgent(proxyUrl));
        console.log(`[proxy] Node fetch routed through ${proxyUrl}`);
    }
}

const { log, createWorkerLogger, setVerbose, StepTimer } = require('./common/logger');
const {
    sleep, rand, findChrome, launchRealChrome, restartChrome,
    isChromeAlive, clearBrowserSession, newPage, takeScreenshot,
} = require('./common/chrome');
const { parseAccounts, AsyncMutex } = require('./common/state');
const { googleLogin } = require('./common/google-login');
const {
    buildAuthUrl: _buildAuthUrl,
    exchangeCode: _exchangeCode,
    startCbServer: _startCbServer,
} = require('./common/oauth');
const {
    accountName,
    extractValidationUrl,
    completeValidationFlow,
    clickOAuthConsentTarget,
    handleTotpChallenge,
} = require('./3_sub2api');

// ============ 常量 ============
// Antigravity 官方 OAuth 凭证（与 sub2api/backend/internal/pkg/antigravity/oauth.go 对齐）
const CLIENT_ID = process.env.CLIENT_ID ||
    '1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com';
const CLIENT_SECRET = process.env.CLIENT_SECRET || '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';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';

// Scope 集与 sub2api 对齐（比 gemini-cli 多了 cclog 和 experimentsandconfigs）
const SCOPES = [
    'https://www.googleapis.com/auth/cloud-platform',
    'https://www.googleapis.com/auth/userinfo.email',
    'https://www.googleapis.com/auth/userinfo.profile',
    'https://www.googleapis.com/auth/cclog',
    'https://www.googleapis.com/auth/experimentsandconfigs',
].join(' ');

const ANTIGRAVITY_BASE = process.env.ANTIGRAVITY_BASE_URL || 'https://cloudcode-pa.googleapis.com';
const ANTIGRAVITY_UA = process.env.ANTIGRAVITY_UA || 'antigravity/1.20.5 windows/amd64';
const PROBE_MODEL = process.env.PROBE_MODEL || 'gemini-3-pro-high';

const REPO_ROOT = path.resolve(__dirname, '..');
const CRED_FILE = process.env.CRED_FILE || path.resolve(__dirname, 'credentials.json');

// 每个 worker 分配一段回调端口，避免并发冲突
const CB_PORT_BASE = parseInt(process.env.CB_PORT_BASE, 10) || 18900;
const PORT_RANGE_PER_WORKER = 50;
const workerPortCounters = {};
function getNextCbPort(workerId) {
    const base = CB_PORT_BASE + workerId * PORT_RANGE_PER_WORKER;
    if (workerPortCounters[workerId] === undefined) {
        workerPortCounters[workerId] = base;
    }
    const port = workerPortCounters[workerId];
    workerPortCounters[workerId]++;
    if (workerPortCounters[workerId] >= base + PORT_RANGE_PER_WORKER) {
        workerPortCounters[workerId] = base;
    }
    return port;
}

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
    skipValidation: args.includes('--skip-validation'),
};

const HARD_TIMEOUT_MS = parseInt(process.env.STAGE3_HARD_TIMEOUT_MS, 10) || 360000;

function shouldForceReauth(memberEmail, opts) {
    if (opts.reauthAll) return true;
    const target = String(memberEmail).toLowerCase();
    return (opts.reauthList || []).some(e => String(e).toLowerCase() === target);
}

// ============ OAuth 回调服务器 ============

function buildAuthUrl(port) {
    return _buildAuthUrl({ clientId: CLIENT_ID, scopes: SCOPES.split(' '), port });
}

async function exchangeCode(code, port) {
    return _exchangeCode({
        code,
        clientId: CLIENT_ID,
        clientSecret: CLIENT_SECRET,
        redirectUri: `http://localhost:${port}/callback`,
    });
}

/**
 * 在 startPort 起点上找一个可用端口监听 /callback，返回 { server, port, codePromise }。
 * codePromise 在收到 /callback?code=... 时 resolve 为 { code } 或 { error }。
 */
function startCbServer(startPort, wlog) {
    return _startCbServer(startPort, wlog);
}

// ============ 通过已登录的 page 拿 OAuth code ============

/**
 * page 已处于登录态时：打开 authUrl → Google 处理 consent（可能有
 * 账号选择器、TOTP 二次挑战、Continue/Allow 按钮）→ 最终跳转到
 * http://localhost:<port>/callback，由 cbServer 捕获 code。
 *
 * 期间由 consentPoller 自动点击 consent 元素，避免停留。
 */
async function obtainAuthCode({ page, authUrl, member, cbServer, wlog, timeoutMs = 120000 }) {
    let keepPolling = true;
    const consentPoller = (async () => {
        await sleep(2500);
        let ticks = 0;
        while (keepPolling) {
            ticks++;
            try {
                const totpHandled = await handleTotpChallenge(page, member, wlog);
                if (totpHandled) { await sleep(4000); continue; }
                const hit = await clickOAuthConsentTarget(page, member.email);
                if (hit) {
                    wlog.info(`  [consent] click (#${ticks}): ${hit}`);
                    await sleep(2500);
                } else if (ticks === 1 || ticks % 5 === 0) {
                    let cur = '';
                    try { cur = page.url(); } catch (_) { }
                    wlog.debug(`  [consent] idle #${ticks} url=${cur.slice(0, 80)}`);
                }
            } catch (_) { /* ignore */ }
            await sleep(1500);
        }
    })();

    // 启动导航（不 await，靠 codePromise 决定何时结束）
    page.goto(authUrl, { waitUntil: 'domcontentloaded', timeout: 60000 })
        .catch(e => {
            // callback 跳本地时，chrome 有可能因为连接复用报轻微错误；真正结果看 codePromise
            wlog.debug(`  authUrl goto: ${e.message}`);
        });

    let timeoutId;
    const timeoutP = new Promise((_, rej) => {
        timeoutId = setTimeout(() => rej(new Error('obtainAuthCode_timeout')), timeoutMs);
    });

    try {
        const result = await Promise.race([cbServer.codePromise, timeoutP]);
        if (result.error) throw new Error(`oauth_denied: ${result.error}`);
        if (!result.code) throw new Error('oauth_callback_missing_code');
        wlog.debug(`  OAuth code captured (${result.code.length} chars)`);
        return result.code;
    } finally {
        clearTimeout(timeoutId);
        keepPolling = false;
        await consentPoller.catch(() => { });
    }
}

// ============ 获取 project_id（loadCodeAssist / onboardUser）============

async function getProjectId(accessToken, wlog) {
    const headers = {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'User-Agent': 'geminicli-oauth/1.0',
    };
    const loadBody = JSON.stringify({
        metadata: { ideType: 'ANTIGRAVITY', platform: 'PLATFORM_UNSPECIFIED', pluginType: 'GEMINI' },
    });

    let tierId = 'LEGACY';
    // 1) loadCodeAssist
    try {
        const resp = await fetch(`${ANTIGRAVITY_BASE}/v1internal:loadCodeAssist`, {
            method: 'POST', headers, body: loadBody,
        });
        if (resp.ok) {
            const data = await resp.json();
            if (Array.isArray(data.allowedTiers)) {
                const def = data.allowedTiers.find(t => t.isDefault);
                if (def && def.id) tierId = def.id;
            }
            if (data.currentTier && data.cloudaicompanionProject) {
                return data.cloudaicompanionProject;
            }
        } else if (wlog) {
            wlog.debug(`  loadCodeAssist http=${resp.status}`);
        }
    } catch (e) { if (wlog) wlog.debug(`  loadCodeAssist err: ${e.message}`); }

    // 2) onboardUser（轮询直到 done）
    try {
        const obBody = JSON.stringify({
            tierId,
            metadata: { ideType: 'ANTIGRAVITY', platform: 'PLATFORM_UNSPECIFIED', pluginType: 'GEMINI' },
        });
        for (let attempt = 1; attempt <= 6; attempt++) {
            const resp = await fetch(`${ANTIGRAVITY_BASE}/v1internal:onboardUser`, {
                method: 'POST', headers, body: obBody,
            });
            if (!resp.ok) break;
            const data = await resp.json();
            if (data.done) {
                const p = data.response?.cloudaicompanionProject;
                const pid = typeof p === 'object' ? p?.id : p;
                if (pid) return pid;
                break;
            }
            await sleep(3000);
        }
    } catch (e) { if (wlog) wlog.debug(`  onboardUser err: ${e.message}`); }

    // 3) loadCodeAssist retry
    try {
        await sleep(2000);
        const resp = await fetch(`${ANTIGRAVITY_BASE}/v1internal:loadCodeAssist`, {
            method: 'POST', headers, body: loadBody,
        });
        if (resp.ok) {
            const data = await resp.json();
            if (data.cloudaicompanionProject) return data.cloudaicompanionProject;
        }
    } catch (e) { if (wlog) wlog.debug(`  loadCodeAssist retry err: ${e.message}`); }

    return '';
}

// ============ 探测 antigravity streamGenerateContent ============

/**
 * 复用 sub2api 的 v1internal 包装 + Gemini 最小请求体。
 * 返回 { ok, status, validationUrl, errorBody }。
 */
async function probeAntigravity(accessToken, projectId, model = PROBE_MODEL) {
    const inner = {
        contents: [{ role: 'user', parts: [{ text: '.' }] }],
        systemInstruction: {
            parts: [{ text: 'You are Antigravity, an AI assistant created by Google.' }],
        },
        generationConfig: { maxOutputTokens: 1 },
    };
    const wrapped = {
        project: projectId || '',
        requestId: 'agent-' + randomUUID(),
        userAgent: 'antigravity',
        requestType: 'agent',
        model,
        request: inner,
    };
    const url = `${ANTIGRAVITY_BASE}/v1internal:streamGenerateContent?alt=sse`;
    let resp;
    try {
        resp = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${accessToken}`,
                'User-Agent': ANTIGRAVITY_UA,
            },
            body: JSON.stringify(wrapped),
        });
    } catch (e) {
        return { ok: false, status: 0, validationUrl: null, errorBody: `network: ${e.message}` };
    }
    const body = await resp.text();
    if (resp.ok) return { ok: true, status: resp.status, validationUrl: null, errorBody: null };

    // 试 JSON 解析再抓 validation_url；extractValidationUrl 本身能兼容
    // 前缀/裸 JSON，故直接丢原始 body 进去。
    const validationUrl = extractValidationUrl(body) || extractValidationUrl(`{${body.split('{').slice(1).join('{')}`);
    return { ok: false, status: resp.status, validationUrl, errorBody: body };
}

// ============ 凭证落盘 ============
const credMutex = new AsyncMutex();

function _loadCredsUnsafe() {
    if (!fs.existsSync(CRED_FILE)) return [];
    try {
        const arr = JSON.parse(fs.readFileSync(CRED_FILE, 'utf-8').trim());
        return Array.isArray(arr) ? arr : [];
    } catch (_) { return []; }
}

function _saveCredsUnsafe(list) {
    fs.writeFileSync(CRED_FILE, JSON.stringify(list, null, 2), 'utf-8');
}

async function upsertCredential(cred) {
    return credMutex.runExclusive(() => {
        const list = _loadCredsUnsafe();
        const idx = list.findIndex(c => c.name === cred.name);
        if (idx >= 0) list[idx] = cred; else list.push(cred);
        _saveCredsUnsafe(list);
        return { total: list.length, updated: idx >= 0 };
    });
}

function findCredentialByName(name) {
    return _loadCredsUnsafe().find(c => c.name === name) || null;
}

// ============ 单 member 编排 ============

async function processMember({ member, host, browser, workerId, opts }) {
    const wlog = createWorkerLogger(workerId);
    const timer = new StepTimer(wlog);
    const name = accountName(host.email, member.email);
    wlog.info(`>> processMember name=${name} email=${member.email}`);

    // 跳过已存在且 verified 的（除非 force reauth）
    const existing = findCredentialByName(name);
    const forceReauth = shouldForceReauth(member.email, opts);
    if (existing && existing.verified_at && !forceReauth) {
        wlog.success(`  [skip] already verified (verified_at=${existing.verified_at})`);
        return { status: 'skipped' };
    }

    await clearBrowserSession(browser, wlog);
    const page = await newPage(browser);
    let cbServer;
    try {
        // 1) Google 登录
        await page.goto('https://accounts.google.com/signin', {
            waitUntil: 'domcontentloaded', timeout: 30000,
        }).catch(e => wlog.warn(`  signin nav: ${e.message}`));
        await sleep(1000);
        await googleLogin(page, member, wlog);
        timer.step('googleLogin');

        // 2) 本地 OAuth
        const port = getNextCbPort(workerId);
        cbServer = await startCbServer(port, wlog);
        const authUrl = buildAuthUrl(cbServer.port);
        wlog.info(`  local OAuth on port ${cbServer.port}`);
        const code = await obtainAuthCode({
            page, authUrl, member, cbServer, wlog,
        });
        timer.step('obtainAuthCode');

        const tokens = await exchangeCode(code, cbServer.port);
        timer.step('exchangeCode');
        wlog.success(`  refresh_token acquired (${tokens.refresh_token.slice(0, 10)}...)`);

        // 3) project_id
        let projectId = await getProjectId(tokens.access_token, wlog);
        timer.step('getProjectId');
        wlog.info(`  project_id = ${projectId || '(empty)'}`);

        // 4) 探测
        let probe = await probeAntigravity(tokens.access_token, projectId);
        timer.step('probe #1');
        wlog.info(`  probe #1: http=${probe.status} ok=${probe.ok} hasValidationUrl=${!!probe.validationUrl}`);

        // 5) 若需验证
        if (!probe.ok && probe.validationUrl && !opts.skipValidation) {
            wlog.warn(`  validation_url detected → driving validation flow`);
            wlog.info(`  ${probe.validationUrl.slice(0, 120)}...`);
            // 故意不清 session：保留 googleLogin 刚建立的 accounts.google.com
            // cookie，让 validationUrl 能直接 follow continue= 进入验证页，
            // 避免二次登录（-1 次密码 / -1 次 TOTP，降低 Google 风控挑战）。
            const vpage = await newPage(browser);
            try {
                const ok = await completeValidationFlow(vpage, probe.validationUrl, member, wlog);
                timer.step('completeValidationFlow');
                if (!ok) {
                    await takeScreenshot(vpage, `validation_stuck_${member.email.replace(/[^a-z0-9]/gi, '_')}`, wlog);
                    throw new Error('validation_flow_stuck');
                }
            } finally {
                await vpage.close().catch(() => { });
            }

            // 验证完再取一次 project_id（可能此时才生成）
            if (!projectId) {
                projectId = await getProjectId(tokens.access_token, wlog);
                wlog.info(`  project_id (after validate) = ${projectId || '(still empty)'}`);
            }

            probe = await probeAntigravity(tokens.access_token, projectId);
            timer.step('probe #2');
            wlog.info(`  probe #2: http=${probe.status} ok=${probe.ok}`);
        }

        // 6) 落盘
        const cred = {
            name,
            email: tokens.email || member.email,
            host_email: host.email,
            member_email: member.email,
            refresh_token: tokens.refresh_token,
            access_token: tokens.access_token,
            token_type: tokens.token_type || 'Bearer',
            scope: tokens.scope,
            expires_in: tokens.expires_in,
            expires_at: Date.now() + (tokens.expires_in || 3600) * 1000,
            project_id: projectId || '',
            verified_at: probe.ok ? new Date().toISOString() : null,
            probe_status: probe.status,
            probe_error: probe.ok ? null : (probe.errorBody || '').slice(0, 500),
            updated_at: new Date().toISOString(),
        };
        const up = await upsertCredential(cred);
        timer.step('upsertCredential');
        wlog.success(`  credential ${up.updated ? 'updated' : 'saved'} (total=${up.total})  verified=${probe.ok}`);

        return {
            status: probe.ok ? 'ok' : 'saved_unverified',
            name,
            verified: probe.ok,
        };
    } finally {
        await page.close().catch(() => { });
        if (cbServer) try { cbServer.server.close(); } catch (_) { }
        await clearBrowserSession(browser, wlog).catch(() => { });
    }
}

// ============ main — DB-backed ============
const membersDb = require('./db/members');
const hostsDb   = require('./db/hosts');
const eventsDb  = require('./db/events');

let _workers3 = [];
function cleanupWorkers3(workers) {
    const keep = (process.env.KEEP_BROWSER_OPEN || '').toLowerCase() === 'true';
    for (const w of workers) {
        if (keep) { try { w.browser.disconnect(); } catch (_) { } }
        else { try { w.browser.close(); } catch (_) { } try { w.proc.kill(); } catch (_) { } }
    }
}

async function runStage3({ runId, concurrency = 1 } = {}) {
    const chromePath = findChrome();
    if (!chromePath) throw new Error('Chrome not found');

    const work = await membersDb.listMembersForStage(3);
    log(`Stage3: ${work.length} pending oauth`);
    if (!work.length) return { ok: 0, ng: 0 };

    const workers = _workers3 = [];
    for (let w = 0; w < Math.min(concurrency, work.length); w++) {
        const chrome = await launchRealChrome(chromePath, w);
        workers.push({ id: w, ...chrome });
        if (w < concurrency - 1) await sleep(rand(2000, 3000));
    }

    let idx = 0;
    const stats = { ok: 0, ng: 0 };

    async function workerFn(worker) {
        const wlog = createWorkerLogger(worker.id);
        while (true) {
            const i = idx++;
            if (i >= work.length) break;
            const m = work[i];

            // Fetch host record for processMember (needs host.email)
            const hostRow = await hostsDb.getHostById(m.host_id);
            if (!hostRow) {
                wlog.error(`Stage3 [${m.email}]: host_id=${m.host_id} not found in DB, skipping`);
                stats.ng++;
                continue;
            }

            // Normalise DB row to the shape processMember / googleLogin expect
            const memberAccount = {
                idx: m.id,
                email: m.email,
                pass: m.password,
                recovery: m.recovery_email || '',
                totp_secret: m.totp_secret || undefined,
            };
            const hostAccount = {
                idx: hostRow.id,
                email: hostRow.email,
                pass: hostRow.password,
                recovery: hostRow.recovery_email || '',
                totp_secret: hostRow.totp_secret || undefined,
            };

            await eventsDb.logEvent({ memberId: m.id, hostId: m.host_id, runId, stage: 'stage3', eventType: 'start' });
            try {
                const result = await processMember({
                    member: memberAccount,
                    host: hostAccount,
                    browser: worker.browser,
                    workerId: worker.id,
                    opts: CLI_OPTS,
                });

                // processMember upserts the credential internally; retrieve it for DB persistence
                const credName = result.name || require('./3_sub2api').accountName(hostRow.email, m.email);
                const cred = findCredentialByName(credName);
                const token = cred && cred.refresh_token;
                if (!token) throw new Error('no refresh_token found after processMember');

                const { refresh_token: _rt, ...tokenMeta } = cred;
                await membersDb.transitionToDone(m.id, token, tokenMeta);
                await eventsDb.logEvent({ memberId: m.id, hostId: m.host_id, runId, stage: 'stage3', eventType: 'success' });
                stats.ok++;
            } catch (e) {
                wlog.error(`Stage3 [${m.email}]: ${e.message}`);
                await membersDb.transitionToFailed(m.id, { newStatus: 'oauth_failed', error: e.message, releaseHost: false });
                await eventsDb.logEvent({ memberId: m.id, hostId: m.host_id, runId, stage: 'stage3', eventType: 'fail', message: e.message });
                stats.ng++;
                if (/Protocol error|Session closed|Target closed/i.test(e.message || '')) {
                    try { await restartChrome(chromePath, worker); } catch (_) { }
                }
            }
            await sleep(rand(1000, 2000));
        }
    }

    await Promise.all(workers.map(w => workerFn(w)));
    cleanupWorkers3(workers);
    log(`Stage3 done: OK=${stats.ok} FAIL=${stats.ng}`, 'SUCCESS');
    return stats;
}

module.exports = {
    runStage3,
    buildAuthUrl,
    exchangeCode,
    startCbServer,
    getProjectId,
    probeAntigravity,
    upsertCredential,
    findCredentialByName,
    CLIENT_ID,
    CLIENT_SECRET,
    SCOPES,
    ANTIGRAVITY_BASE,
    ANTIGRAVITY_UA,
    PROBE_MODEL,
    CRED_FILE,
};

if (require.main === module) {
    process.on('SIGINT',  () => { cleanupWorkers3(_workers3); process.exit(130); });
    process.on('SIGTERM', () => { cleanupWorkers3(_workers3); process.exit(143); });

    runStage3({ runId: null, concurrency: CLI_OPTS.concurrency })
        .then(() => process.exit(0))
        .catch(e => { log(`Fatal: ${e.message}`, 'ERROR'); process.exit(1); });
}
