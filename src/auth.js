/**
 * Antigravity 批量授权 v12 — 稳定极速版
 *
 * v12 改进（基于 v11）：
 * 1. 【稳定】修复 Chrome 每个账号后崩溃 — 用 CDP 清理会话替代 context.close()
 * 2. 【稳定】修复 Email deadloop — 密码输入框检测优先于 email
 * 3. 【稳定】Chrome 启动后 warm-up 验证，避免 'Failed to open a new tab'
 * 4. 【稳定】添加 Chrome 防崩溃启动参数（disable-gpu/sandbox/extensions）
 * 5. 【提速】缩短所有固定等待时间约 50%
 * 6. 【稳定】处理 "Make sure you downloaded" 安全确认页面
 * 7. 保留 v11 的所有功能
 */

require('dotenv').config();
const puppeteer = require('puppeteer-core');
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');

// ============ 配置 ============
const CLIENT_ID = process.env.CLIENT_ID || '1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com';
const CLIENT_SECRET = process.env.CLIENT_SECRET || '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';
const SCOPES = 'openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/userinfo.profile https://www.googleapis.com/auth/cloud-platform';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const CONCURRENCY = parseInt(process.env.CONCURRENCY, 10) || 3;
const BASE_DEBUG_PORT = parseInt(process.env.DEBUG_PORT, 10) || 9234;
const OUTPUT = path.resolve(__dirname, 'credentials.json');
const FAILED = path.resolve(__dirname, 'failed.json');
const ENABLE_API_FAILED = path.resolve(__dirname, 'enableAPI_failed.json');
const MAX_RETRIES = 2; // 单账号最大重试次数

// ============ 每个 Worker 预分配独立端口段 ============
// Worker 0: 18900-18949, Worker 1: 18950-18999, Worker 2: 19000-19049 ...
const CB_PORT_BASE = 18900;
const PORT_RANGE_PER_WORKER = 50;
const workerPortCounters = {}; // workerId -> 下一个可用端口

function getNextCbPort(workerId) {
    const base = CB_PORT_BASE + workerId * PORT_RANGE_PER_WORKER;
    if (!(workerId in workerPortCounters)) {
        workerPortCounters[workerId] = base;
    }
    const port = workerPortCounters[workerId];
    workerPortCounters[workerId] = port + 1;
    // 如果超出范围，回绕
    if (workerPortCounters[workerId] >= base + PORT_RANGE_PER_WORKER) {
        workerPortCounters[workerId] = base;
    }
    return port;
}

// ============ CLI 参数解析（提前解析以便控制日志级别）============
const cliArgs = process.argv.slice(2);
let VERBOSE = cliArgs.includes('--verbose') || cliArgs.includes('-v');
let SCREENSHOT_ALL = cliArgs.includes('--screenshot-all');

// ============ 分级日志系统 ============
const LOG_COLORS = {
    RESET: '\x1b[0m',
    BOLD: '\x1b[1m',
    DIM: '\x1b[2m',
    RED: '\x1b[31m',
    GREEN: '\x1b[32m',
    YELLOW: '\x1b[33m',
    BLUE: '\x1b[34m',
    MAGENTA: '\x1b[35m',
    CYAN: '\x1b[36m',
    WHITE: '\x1b[37m',
    BG_RED: '\x1b[41m',
    BG_GREEN: '\x1b[42m',
    BG_YELLOW: '\x1b[43m',
};

// Worker 颜色表（循环使用）
const WORKER_COLORS = [
    LOG_COLORS.CYAN,
    LOG_COLORS.MAGENTA,
    LOG_COLORS.YELLOW,
    LOG_COLORS.GREEN,
    LOG_COLORS.BLUE,
    LOG_COLORS.WHITE,
];

function getTimestamp() {
    return new Date().toISOString().replace('T', ' ').replace('Z', '');
}

function log(msg, level = 'INFO') {
    const ts = getTimestamp();
    let prefix = '';
    let color = LOG_COLORS.RESET;

    switch (level) {
        case 'DEBUG':
            if (!VERBOSE) return;
            color = LOG_COLORS.DIM;
            prefix = 'DBG';
            break;
        case 'INFO':
            color = LOG_COLORS.RESET;
            prefix = 'INF';
            break;
        case 'WARN':
            color = LOG_COLORS.YELLOW;
            prefix = 'WRN';
            break;
        case 'ERROR':
            color = LOG_COLORS.RED;
            prefix = 'ERR';
            break;
        case 'SUCCESS':
            color = LOG_COLORS.GREEN;
            prefix = ' OK';
            break;
    }
    console.log(`${color}[${ts}][${prefix}] ${msg}${LOG_COLORS.RESET}`);
}

/**
 * Worker 专用日志器——自动添加 [W{id}] 前缀和颜色
 */
function createWorkerLogger(workerId) {
    const wColor = WORKER_COLORS[workerId % WORKER_COLORS.length];
    const tag = `[W${workerId}]`;

    return {
        debug: (msg) => log(`${wColor}${tag}${LOG_COLORS.RESET} ${LOG_COLORS.DIM}${msg}`, 'DEBUG'),
        info: (msg) => log(`${wColor}${tag}${LOG_COLORS.RESET} ${msg}`, 'INFO'),
        warn: (msg) => log(`${wColor}${tag}${LOG_COLORS.RESET} ${LOG_COLORS.YELLOW}${msg}`, 'WARN'),
        error: (msg, err) => {
            log(`${wColor}${tag}${LOG_COLORS.RESET} ${LOG_COLORS.RED}${msg}`, 'ERROR');
            if (err && err.stack && VERBOSE) {
                console.log(`${LOG_COLORS.DIM}${err.stack}${LOG_COLORS.RESET}`);
            }
        },
        success: (msg) => log(`${wColor}${tag}${LOG_COLORS.RESET} ${LOG_COLORS.GREEN}${msg}`, 'SUCCESS'),
    };
}

// ============ 计时器 ============
class StepTimer {
    constructor(wlog) {
        this.wlog = wlog;
        this.start = Date.now();
        this.lastStep = Date.now();
    }
    step(label) {
        const now = Date.now();
        const elapsed = now - this.lastStep;
        const total = now - this.start;
        this.wlog.debug(`>> ${label}: ${elapsed}ms (total ${total}ms)`);
        this.lastStep = now;
    }
    total() {
        return Date.now() - this.start;
    }
}

// ============ 进度追踪器 ============
const workerStatus = {}; // workerId -> { state, account, startTime }
let globalStats = { ok: 0, ng: 0, total: 0, retries: 0 };

function updateWorkerStatus(workerId, state, account = '') {
    workerStatus[workerId] = { state, account, time: Date.now() };
}

function printProgressSummary() {
    const now = Date.now();
    log('');
    log(`${'='.repeat(70)}`, 'INFO');
    log(`  Progress | OK: ${LOG_COLORS.GREEN}${globalStats.ok}${LOG_COLORS.RESET} | FAIL: ${LOG_COLORS.RED}${globalStats.ng}${LOG_COLORS.RESET} | Retry: ${globalStats.retries} | Remaining: ${globalStats.total - globalStats.ok - globalStats.ng}`, 'INFO');
    for (const [wid, status] of Object.entries(workerStatus)) {
        const elapsed = Math.round((now - status.time) / 1000);
        const wColor = WORKER_COLORS[parseInt(wid) % WORKER_COLORS.length];
        log(`  ${wColor}[W${wid}]${LOG_COLORS.RESET} ${status.state} | ${status.account} | ${elapsed}s ago`, 'INFO');
    }
    log(`${'='.repeat(70)}`, 'INFO');
    log('');
}

// ============ AsyncMutex ============
class AsyncMutex {
    constructor() {
        this._queue = [];
        this._locked = false;
    }

    acquire() {
        return new Promise((resolve) => {
            if (!this._locked) {
                this._locked = true;
                resolve();
            } else {
                this._queue.push(resolve);
            }
        });
    }

    release() {
        if (this._queue.length > 0) {
            const next = this._queue.shift();
            next();
        } else {
            this._locked = false;
        }
    }

    async runExclusive(fn) {
        await this.acquire();
        try {
            return await fn();
        } finally {
            this.release();
        }
    }
}

const fileMutex = new AsyncMutex();

// ============ fetch 兼容层（支持 HTTP 代理） ============
function _getProxyAgent(url) {
    const proxy = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.https_proxy || process.env.http_proxy;
    if (!proxy) return undefined;
    try {
        const parsedUrl = new URL(url);
        if (parsedUrl.protocol === 'https:') {
            const { HttpsProxyAgent } = require('https-proxy-agent');
            return new HttpsProxyAgent(proxy);
        } else {
            const { HttpProxyAgent } = require('http-proxy-agent');
            return new HttpProxyAgent(proxy);
        }
    } catch (_) { return undefined; }
}

async function httpFetch(url, options = {}) {
    const agent = _getProxyAgent(url);
    if (typeof globalThis.fetch === 'function') {
        const fetchOpts = { ...options };
        if (agent) fetchOpts.dispatcher = undefined; // fetch 不支持 agent，走下面的 http 方式
        if (!agent) return globalThis.fetch(url, options);
    }
    return new Promise((resolve, reject) => {
        const parsedUrl = new URL(url);
        const mod = parsedUrl.protocol === 'https:' ? https : http;
        const reqOptions = {
            hostname: parsedUrl.hostname,
            port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
            path: parsedUrl.pathname + parsedUrl.search,
            method: options.method || 'GET',
            headers: options.headers || {},
        };
        if (agent) reqOptions.agent = agent;
        const req = mod.request(reqOptions, (res) => {
            let data = '';
            res.on('data', chunk => (data += chunk));
            res.on('end', () => {
                resolve({
                    ok: res.statusCode >= 200 && res.statusCode < 300,
                    status: res.statusCode,
                    json: () => Promise.resolve(JSON.parse(data)),
                    text: () => Promise.resolve(data),
                });
            });
        });
        req.on('error', reject);
        if (options.body) req.write(options.body);
        req.end();
    });
}

// ============ 基础工具 ============
const sleep = ms => new Promise(r => setTimeout(r, ms));
const rand = (a, b) => Math.floor(Math.random() * (b - a) + a);
const pick = arr => arr[rand(0, arr.length)];

// ============ 极速输入（直接粘贴，不模拟真人） ============

/**
 * 直接点击元素（不做鼠标曲线移动）
 */
async function fastClick(page, element) {
    try {
        await element.click();
    } catch (_) { }
}

/**
 * 极速输入：先清空，再通过 page.evaluate 直接设置 value 并触发事件
 * 比剪贴板粘贴更可靠，跨平台无依赖
 */
async function fastType(page, selector, text, wlog) {
    try {
        // 方法1：直接通过 JS 设置值（最快）
        const success = await page.evaluate((sel, txt) => {
            const el = document.querySelector(sel);
            if (!el) return false;
            // 聚焦
            el.focus();
            // 使用 React/Angular 兼容的方式设置值
            const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
                window.HTMLInputElement.prototype, 'value'
            ).set;
            nativeInputValueSetter.call(el, txt);
            // 触发所有必要的事件
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
            el.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true }));
            el.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true }));
            return true;
        }, selector, text);

        if (!success) {
            // 方法2：fallback 到 puppeteer 的 type（快速，无延迟）
            const el = await page.$(selector);
            if (!el) throw new Error(`Input not found: ${selector}`);
            await el.click();
            await sleep(100);
            // 全选删除
            const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
            await page.keyboard.down(mod);
            await page.keyboard.press('KeyA');
            await page.keyboard.up(mod);
            await page.keyboard.press('Backspace');
            await sleep(50);
            // 快速打字（无延迟）
            await el.type(text, { delay: 0 });
        }
    } catch (e) {
        if (wlog) wlog.debug(`fastType error (${e.message}), trying keyboard fallback`);
        // 方法3：最后的 fallback
        try {
            const el = await page.$(selector);
            if (el) {
                await el.click();
                await el.type(text, { delay: 0 });
            }
        } catch (e2) {
            if (wlog) wlog.warn(`All input methods failed for ${selector}: ${e2.message}`);
        }
    }
}

// ============ Chrome ============
function findChrome() {
    const paths = [
        (process.env['LOCALAPPDATA'] || '') + '\\Google\\Chrome\\Application\\chrome.exe',
        (process.env['PROGRAMFILES'] || '') + '\\Google\\Chrome\\Application\\chrome.exe',
        (process.env['PROGRAMFILES(X86)'] || '') + '\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        '/usr/bin/google-chrome',
        '/usr/bin/google-chrome-stable',
        '/usr/bin/chromium-browser',
        '/usr/bin/chromium',
    ];
    for (const p of paths) {
        try { if (p && fs.existsSync(p)) return p; } catch (_) { }
    }
    try {
        const cmd = process.platform === 'win32'
            ? 'where chrome'
            : 'which google-chrome || which chromium-browser || which chromium';
        return execSync(cmd, { encoding: 'utf-8' }).trim().split('\n')[0].trim();
    } catch (_) { }
    return null;
}

async function launchRealChrome(chromePath, workerId = 0) {
    const wlog = createWorkerLogger(workerId);
    const debugPort = BASE_DEBUG_PORT + workerId;
    const CHROME_DATA = path.resolve(__dirname, `chrome_data_temp_auth_${workerId}`);
    if (!fs.existsSync(CHROME_DATA)) fs.mkdirSync(CHROME_DATA, { recursive: true });

    wlog.debug(`Launch Chrome: debugPort=${debugPort}, dataDir=${CHROME_DATA}`);

    const proc = spawn(chromePath, [
        `--remote-debugging-port=${debugPort}`,
        `--user-data-dir=${CHROME_DATA}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-sync',
        '--disable-features=InProductHelp',
        '--window-size=1280,800',
        // v12: 稳定性参数
        '--disable-gpu',
        '--disable-dev-shm-usage',
        '--disable-background-networking',
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
        '--disable-hang-monitor',
        '--disable-popup-blocking',
        '--disable-prompt-on-repost',
        '--disable-extensions',
        '--disable-component-update',
        '--disable-domain-reliability',
        '--no-sandbox',
        '--metrics-recording-only',
    ], { detached: false, stdio: 'ignore' });

    proc.on('error', e => { wlog.error(`Chrome process error: ${e.message}`, e); });
    proc.on('exit', (code, signal) => {
        wlog.warn(`Chrome process exit: code=${code}, signal=${signal}`);
    });

    let wsUrl = null;
    for (let i = 0; i < 30; i++) {
        try {
            const r = await httpFetch(`http://localhost:${debugPort}/json/version`);
            const data = await r.json();
            wsUrl = data.webSocketDebuggerUrl;
            wlog.debug(`Chrome DevTools WebSocket: ${wsUrl}`);
            break;
        } catch (_) {
            if (i % 5 === 4) wlog.debug(`Waiting for Chrome... (${i + 1}/30)`);
            await sleep(1000);
        }
    }
    if (!wsUrl) {
        proc.kill();
        throw new Error(`[W${workerId}] Chrome launch timeout (30s)`);
    }

    const browser = await puppeteer.connect({
        browserWSEndpoint: wsUrl,
        defaultViewport: null,
        protocolTimeout: 180000,
    });

    // v12: warm-up — 验证 Chrome 可以正常创建页面
    try {
        const testPage = await browser.newPage();
        await testPage.close();
        wlog.debug('Chrome warm-up OK');
    } catch (e) {
        wlog.warn(`Chrome warm-up failed: ${e.message}, waiting...`);
        await sleep(2000);
    }

    wlog.info(`Chrome started (port ${debugPort}, PID ${proc.pid})`);
    return { browser, proc, dataDir: CHROME_DATA, debugPort };
}

async function restartChrome(chromePath, worker) {
    const wlog = createWorkerLogger(worker.id);
    wlog.warn('Chrome seems crashed, restarting...');
    try { worker.browser.disconnect(); } catch (_) { }
    try { worker.proc.kill(); } catch (_) { }
    await sleep(3000); // v12: 稍微多等以确保端口释放
    const fresh = await launchRealChrome(chromePath, worker.id);
    worker.browser = fresh.browser;
    worker.proc = fresh.proc;
    worker.debugPort = fresh.debugPort;
    wlog.success('Chrome restarted');
}

async function isChromeAlive(worker) {
    try {
        const r = await httpFetch(`http://localhost:${worker.debugPort}/json/version`);
        return r.ok;
    } catch (_) {
        return false;
    }
}

// ============ 账号解析 ============
//
// 逐行智能检测分隔符，支持混合格式文件：
//   email----password----recovery@xx.com
//   email----password----
//   email----password
//   email:password:recovery@xx.com
//   email:password:
//   email:password
//   email：password（全角冒号，自动转换）
//   email:password----recovery@xx.com（混合分隔符）
//
// 核心逻辑：
//   1. email 不含 : 也不含 ----，所以行内最先出现的分隔符就是 email 与 rest 的分界
//   2. rest 部分先找 ----、再找 : 来分离 password 和 recovery
//   3. recovery 必须为空或含 @（像邮箱），否则认为整段都是密码
//
function parseAccounts(f) {
    if (!fs.existsSync(f)) throw new Error(`Account file not found: ${f}`);
    let raw = fs.readFileSync(f, 'utf-8');

    // 去除 UTF-8 BOM
    if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);

    const lines = raw.split(/\r?\n/).filter(l => {
        const trimmed = l.trim();
        return trimmed && !trimmed.startsWith('#');
    });
    if (lines.length === 0) return [];

    // 统一全角冒号 ： (U+FF1A) → 半角冒号 : (U+003A)
    const normalizedLines = lines.map(l => l.replace(/\uff1a/g, ':'));

    log(`Account file: ${normalizedLines.length} lines to parse`);

    return normalizedLines.map((line, i) => {
        const trimmed = line.trim();
        if (!trimmed) return null;

        // ===== Step 1: 分离 email =====
        // email 绝不含 : 或 ----，所以谁先出现谁就是 email 的分隔符
        const colonPos = trimmed.indexOf(':');
        const dashPos = trimmed.indexOf('----');

        let email, rest;

        if (colonPos >= 0 && (dashPos < 0 || colonPos < dashPos)) {
            // : 先出现（或没有 ----）
            email = trimmed.substring(0, colonPos).trim();
            rest = trimmed.substring(colonPos + 1);          // 冒号后面的所有内容
        } else if (dashPos >= 0) {
            // ---- 先出现（或没有 :）
            email = trimmed.substring(0, dashPos).trim();
            rest = trimmed.substring(dashPos + 4);            // ---- 后面的所有内容
        } else {
            log(`  Line ${i + 1}: no delimiter found, skipping: "${trimmed.substring(0, 50)}"`, 'WARN');
            return null;
        }

        // ===== Step 2: 从 rest 分离 password 和 recovery =====
        let pass, recovery;

        // 优先检测 rest 中的 ---- 分隔符
        const restDashPos = rest.indexOf('----');
        if (restDashPos >= 0) {
            const before = rest.substring(0, restDashPos).trim();
            const after = rest.substring(restDashPos + 4).trim();
            if (after === '' || after.includes('@')) {
                // ---- 后面为空或是邮箱 → 成功分离 password / recovery
                pass = before;
                recovery = after;
            }
            // 否则 ---- 后面不像 recovery（如密码含 ----），fall through 到冒号检测
        }

        // 如果 ---- 没能成功分离，用冒号检测
        if (pass === undefined) {
            const lastColon = rest.lastIndexOf(':');
            if (lastColon < 0) {
                // 没有更多分隔符: rest 整体就是 password
                pass = rest.trim();
                recovery = '';
            } else {
                const afterLast = rest.substring(lastColon + 1).trim();
                const beforeLast = rest.substring(0, lastColon).trim();
                if (afterLast === '' || afterLast.includes('@')) {
                    // 最后一段为空或是邮箱 → recovery
                    pass = beforeLast;
                    recovery = afterLast;
                } else {
                    // 最后一段既不为空也不是邮箱 → 整个 rest 都是密码
                    pass = rest.trim();
                    recovery = '';
                }
            }
        }

        // ===== Step 3: 校验 =====
        if (!email || !pass) {
            log(`  Line ${i + 1}: empty email or password, skipping: "${trimmed.substring(0, 50)}"`, 'WARN');
            return null;
        }
        if (!email.includes('@')) {
            log(`  Line ${i + 1}: invalid email "${email}", skipping`, 'WARN');
            return null;
        }

        return { idx: i + 1, email, pass, recovery: recovery || '' };
    }).filter(Boolean);
}

// ============ 凭证文件管理 ============

function _loadCredentialsUnsafe() {
    if (!fs.existsSync(OUTPUT)) {
        fs.writeFileSync(OUTPUT, '[]', 'utf-8');
        return [];
    }
    try {
        const raw = fs.readFileSync(OUTPUT, 'utf-8').trim();
        const arr = JSON.parse(raw);
        if (!Array.isArray(arr)) {
            fs.writeFileSync(OUTPUT, '[]', 'utf-8');
            return [];
        }
        return arr;
    } catch (e) {
        log(`Credentials file parse error (${e.message}), resetting`, 'WARN');
        const backupPath = OUTPUT + '.bak.' + Date.now();
        fs.copyFileSync(OUTPUT, backupPath);
        fs.writeFileSync(OUTPUT, '[]', 'utf-8');
        return [];
    }
}

function _saveCredentialsUnsafe(creds) {
    fs.writeFileSync(OUTPUT, JSON.stringify(creds, null, 2), 'utf-8');
}

function _loadFailedUnsafe() {
    if (!fs.existsSync(FAILED)) return [];
    try {
        const arr = JSON.parse(fs.readFileSync(FAILED, 'utf-8').trim());
        return Array.isArray(arr) ? arr : [];
    } catch (_) { return []; }
}

function _saveFailedUnsafe(fail) {
    fs.writeFileSync(FAILED, JSON.stringify(fail, null, 2), 'utf-8');
}

function _loadEnableApiFailedUnsafe() {
    if (!fs.existsSync(ENABLE_API_FAILED)) return [];
    try {
        const arr = JSON.parse(fs.readFileSync(ENABLE_API_FAILED, 'utf-8').trim());
        return Array.isArray(arr) ? arr : [];
    } catch (_) { return []; }
}

function _saveEnableApiFailedUnsafe(data) {
    fs.writeFileSync(ENABLE_API_FAILED, JSON.stringify(data, null, 2), 'utf-8');
}

async function addEnableApiFailedRecord(record) {
    return fileMutex.runExclusive(() => {
        const list = _loadEnableApiFailedUnsafe();
        list.push(record);
        _saveEnableApiFailedUnsafe(list);
        return list.length;
    });
}

async function addCredential(cred) {
    return fileMutex.runExclusive(() => {
        const creds = _loadCredentialsUnsafe();
        if (creds.some(c => c.email === cred.email)) {
            log(`Dedup skip: ${cred.email} already exists`, 'DEBUG');
            return creds.length;
        }
        creds.push(cred);
        _saveCredentialsUnsafe(creds);
        return creds.length;
    });
}

async function addFailedRecord(record) {
    return fileMutex.runExclusive(() => {
        const fail = _loadFailedUnsafe();
        fail.push(record);
        _saveFailedUnsafe(fail);
        return fail.length;
    });
}

async function isEmailInCredentials(email) {
    return fileMutex.runExclusive(() => {
        const creds = _loadCredentialsUnsafe();
        return creds.some(c => c.email === email);
    });
}

// ============ OAuth ============
function buildAuthUrl(port) {
    return `https://accounts.google.com/o/oauth2/v2/auth?${new URLSearchParams({
        client_id: CLIENT_ID,
        redirect_uri: `http://localhost:${port}/callback`,
        response_type: 'code',
        scope: SCOPES,
        access_type: 'offline',
        prompt: 'consent',
    })}`;
}

async function exchangeCode(code, port) {
    const r = await httpFetch(TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            code,
            client_id: CLIENT_ID,
            client_secret: CLIENT_SECRET,
            redirect_uri: `http://localhost:${port}/callback`,
            grant_type: 'authorization_code',
        }).toString(),
    });
    const d = await r.json();
    if (d.error) throw new Error(`Token Exchange failed: ${d.error}: ${d.error_description || 'no description'}`);
    return d;
}

// ============ 自动开启 API 服务 ============

async function getProjectId(accessToken, wlog) {
    const headers = {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'User-Agent': 'geminicli-oauth/1.0',
    };
    const loadCodeAssistBody = JSON.stringify({
        metadata: { ideType: 'ANTIGRAVITY', platform: 'PLATFORM_UNSPECIFIED', pluginType: 'GEMINI' },
    });

    // Method 1: loadCodeAssist
    let tierId = 'LEGACY';
    try {
        wlog.debug('[1/4] loadCodeAssist...');
        const resp = await httpFetch('https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist',
            { method: 'POST', headers, body: loadCodeAssistBody });
        const respText = await resp.text();
        wlog.debug(`[1/4] HTTP ${resp.status}, resp: ${respText.substring(0, 300)}`);
        if (resp.ok || resp.status === 200) {
            const data = JSON.parse(respText);
            if (data.allowedTiers && Array.isArray(data.allowedTiers)) {
                const defaultTier = data.allowedTiers.find(t => t.isDefault);
                if (defaultTier && defaultTier.id) {
                    tierId = defaultTier.id;
                    wlog.debug(`[1/4] Detected default tier: ${tierId}`);
                }
            }
            if (data.currentTier && data.cloudaicompanionProject) {
                wlog.success(`Project ID (loadCodeAssist): ${data.cloudaicompanionProject}`);
                return data.cloudaicompanionProject;
            }
            wlog.debug('[1/4] User not activated (no currentTier), need onboard');
        }
    } catch (e) { wlog.debug(`[1/4] Error: ${e.message}`); }

    // Method 2: onboardUser
    try {
        wlog.debug(`[2/4] onboardUser (tier=${tierId})...`);
        const onboardBody = JSON.stringify({
            tierId: tierId,
            metadata: { ideType: 'ANTIGRAVITY', platform: 'PLATFORM_UNSPECIFIED', pluginType: 'GEMINI' },
        });
        for (let attempt = 1; attempt <= 6; attempt++) {
            const resp = await httpFetch('https://cloudcode-pa.googleapis.com/v1internal:onboardUser',
                { method: 'POST', headers, body: onboardBody });
            const respText = await resp.text();
            wlog.debug(`[2/4] Poll ${attempt}/6, HTTP ${resp.status}`);
            if (resp.ok || resp.status === 200) {
                const data = JSON.parse(respText);
                if (data.done) {
                    const respData = data.response || {};
                    const projObj = respData.cloudaicompanionProject;
                    let pid = null;
                    if (typeof projObj === 'object' && projObj) pid = projObj.id;
                    else if (typeof projObj === 'string') pid = projObj;
                    if (pid) { wlog.success(`Project ID (onboardUser): ${pid}`); return pid; }
                    break;
                }
            } else { break; }
            await sleep(3000);
        }
    } catch (e) { wlog.debug(`[2/4] Error: ${e.message}`); }

    // Method 3: loadCodeAssist again
    try {
        wlog.debug('[3/4] loadCodeAssist retry...');
        await sleep(2000);
        const resp = await httpFetch('https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist',
            { method: 'POST', headers, body: loadCodeAssistBody });
        const respText = await resp.text();
        if (resp.ok || resp.status === 200) {
            const data = JSON.parse(respText);
            if (data.cloudaicompanionProject) {
                wlog.success(`Project ID (retry): ${data.cloudaicompanionProject}`);
                return data.cloudaicompanionProject;
            }
        }
    } catch (e) { wlog.debug(`[3/4] Error: ${e.message}`); }

    // Method 4: Resource Manager API
    try {
        wlog.debug('[4/4] Resource Manager API...');
        const projResp = await httpFetch('https://cloudresourcemanager.googleapis.com/v1/projects', {
            headers: { 'Authorization': `Bearer ${accessToken}`, 'User-Agent': 'geminicli-oauth/1.0' },
        });
        const respText = await projResp.text();
        if (projResp.ok || projResp.status === 200) {
            const data = JSON.parse(respText);
            const active = (data.projects || []).filter(p => p.lifecycleState === 'ACTIVE');
            if (active.length > 0) {
                const pid = active[0].projectId;
                wlog.success(`Project ID (ResourceManager): ${pid}`);
                return pid;
            }
        }
    } catch (e) { wlog.debug(`[4/4] Error: ${e.message}`); }

    return null;
}

async function enableRequiredApis(accessToken, projectId, wlog) {
    const headers = {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'User-Agent': 'geminicli-oauth/1.0',
    };
    try {
        wlog.debug('Verifying user activation...');
        const resp = await httpFetch('https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist', {
            method: 'POST', headers,
            body: JSON.stringify({ metadata: { ideType: 'ANTIGRAVITY', platform: 'PLATFORM_UNSPECIFIED', pluginType: 'GEMINI' } }),
        });
        if (resp.ok) {
            const data = await resp.json();
            if (data.currentTier && data.cloudaicompanionProject) {
                const tierName = typeof data.currentTier === 'object'
                    ? (data.currentTier.id || data.currentTier.name || JSON.stringify(data.currentTier))
                    : data.currentTier;
                wlog.success(`User activated (tier=${tierName}), project=${data.cloudaicompanionProject}`);
                wlog.success('Gemini Cloud Assist API + Gemini for Google Cloud API ready');
                return true;
            }
        }
    } catch (e) { wlog.warn(`Verification error: ${e.message}`); }
    return false;
}

function startCbServer(startPort, wlog) {
    return new Promise((resolve, reject) => {
        let done;
        const codePromise = new Promise(r => { done = r; });
        let attempts = 0;

        function tryListen(port) {
            if (port > startPort + PORT_RANGE_PER_WORKER) {
                reject(new Error(`No available port in ${startPort}~${port}`));
                return;
            }
            attempts++;
            const server = http.createServer((req, res) => {
                try {
                    const u = new URL(req.url, `http://localhost:${port}`);
                    if (u.pathname === '/callback') {
                        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
                        const code = u.searchParams.get('code');
                        const error = u.searchParams.get('error');
                        res.end(code
                            ? '<h1>OK. You can close this tab.</h1>'
                            : `<h1>FAIL: ${error || 'unknown'}</h1>`);
                        done(code ? { code } : { error: error || 'unknown' });
                    } else {
                        res.writeHead(404);
                        res.end('Not Found');
                    }
                } catch (_) {
                    try { res.writeHead(500); res.end('Error'); } catch (_2) { }
                }
            });
            server.on('error', (e) => {
                if (e.code === 'EADDRINUSE') {
                    if (wlog) wlog.debug(`Port ${port} in use, trying ${port + 1}`);
                    tryListen(port + 1);
                } else {
                    reject(e);
                }
            });
            server.listen(port, () => {
                if (attempts > 1 && wlog) wlog.debug(`Callback server bound to port ${port} (${attempts} attempts)`);
                resolve({ server, port, codePromise });
            });
        }
        tryListen(startPort);
    });
}

// ============ 页面状态检测 ============

async function detectPageState(page, wlog) {
    const pageUrl = page.url();

    try {
        const u = new URL(pageUrl);
        if (u.hostname === 'localhost' && u.pathname === '/callback') return { state: 'callback', url: pageUrl };
    } catch (_) { }

    if (pageUrl.startsWith('chrome://')) return { state: 'chrome_internal', url: pageUrl };
    if (pageUrl === 'about:blank') return { state: 'blank', url: pageUrl };

    const pageInfo = await page.evaluate(() => {
        function isVisible(el) {
            if (!el) return false;
            const r = el.getBoundingClientRect();
            const s = window.getComputedStyle(el);
            return r.width > 0 && r.height > 0
                && s.display !== 'none'
                && s.visibility !== 'hidden'
                && s.opacity !== '0';
        }
        const text = document.body ? document.body.innerText : '';
        const emailInputs = Array.from(document.querySelectorAll('input[type="email"]'));
        const hasVisibleEmail = emailInputs.some(isVisible);
        const pwInputs = Array.from(document.querySelectorAll('input[type="password"]'));
        const hasVisiblePassword = pwInputs.some(isVisible);
        return {
            text: text.substring(0, 3000),
            title: document.title || '',
            hasEmailInput: hasVisibleEmail,
            hasPasswordInput: hasVisiblePassword,
            url: location.href,
            inputCount: document.querySelectorAll('input').length,
            buttonCount: document.querySelectorAll('button, [role="button"]').length,
            formCount: document.querySelectorAll('form').length,
        };
    }).catch(() => ({
        text: '', title: '', hasEmailInput: false, hasPasswordInput: false,
        url: pageUrl, inputCount: 0, buttonCount: 0, formCount: 0,
    }));

    const t = pageInfo.text.toLowerCase();
    const u = pageInfo.url.toLowerCase();

    const debugSummary = {
        url: pageInfo.url.substring(0, 120),
        title: pageInfo.title.substring(0, 60),
        textPreview: pageInfo.text.replace(/\n/g, ' ').substring(0, 150),
        inputs: pageInfo.inputCount,
        buttons: pageInfo.buttonCount,
        forms: pageInfo.formCount,
        hasEmail: pageInfo.hasEmailInput,
        hasPassword: pageInfo.hasPasswordInput,
    };

    let state = 'unknown';
    // v12.1: 检测"验证身份"页面（不可重试），必须在其他检测之前
    if (t.includes('verificer, at det er dig') || t.includes('验证身份')) {
        state = 'identity_verify';
    }
    // v12: 密码检测优先于 email！
    // Google 密码页面仍保留隐藏的 email input，导致 email 条件误匹配
    // 只要有可见的 password input，就一定是密码页面
    else if (pageInfo.hasPasswordInput) {
        state = 'password';
    } else if (pageInfo.hasEmailInput &&
        (u.includes('identifier') || u.includes('signin'))) {
        state = 'email';
    } else if (u.includes('speedbump') ||
        t.includes('\u6b22\u8fce\u4f7f\u7528\u60a8\u7684\u65b0\u8d26\u53f7') ||
        t.includes('welcome to your new account')) {
        state = 'speedbump';
    } else if (t.includes('\u767b\u5f55 chrome') || t.includes('sign in to chrome') ||
        t.includes('\u767b\u5f55chrome') ||
        (t.includes('\u8eab\u4efd\u7ee7\u7eed') && t.includes('chrome'))) {
        state = 'chrome_sync';
    } else if (t.includes('\u53d7\u5230\u7ba1\u7406') || t.includes('will be managed') ||
        t.includes('\u8d44\u6599\u5c06\u53d7\u5230\u7ba1\u7406') || t.includes('managed')) {
        state = 'managed_profile';
    } else if (t.includes('\u670d\u52a1\u6761\u6b3e') || t.includes('terms of service') ||
        t.includes('\u6761\u6b3e\u548c\u9690\u79c1')) {
        state = 'tos';
    } else if (u.includes('challenge') && !pageInfo.hasPasswordInput) {
        state = 'challenge';
    } else if (t.includes('\u9009\u62e9\u5e10\u53f7') || t.includes('choose an account') ||
        t.includes('choose account')) {
        state = 'choose_account';
    } else if ((t.includes("verify it's you") || t.includes('\u9a8c\u8bc1\u60a8\u7684\u8eab\u4efd') ||
        t.includes('get a verification code')) &&
        (t.includes('phone') || t.includes('\u7535\u8bdd\u53f7\u7801'))) {
        state = 'phone_verification';
    } else if (u.includes('consent') || u.includes('approval') ||
        t.includes('wants to access') || t.includes('\u8bf7\u6c42\u4ee5\u4e0b\u6743\u9650') ||
        t.includes('\u60f3\u8981\u8bbf\u95ee') || t.includes('google antigravity') ||
        t.includes("hasn't verified") || t.includes('\u672a\u7ecf\u9a8c\u8bc1') ||
        t.includes('risky') || t.includes('this app') ||
        // v12: 处理 "Make sure you downloaded" 安全页面
        t.includes('make sure') || t.includes('\u786e\u4fdd\u60a8\u5df2\u4ece') ||
        t.includes('downloaded this app') ||
        (t.includes('sign in') && (u.includes('oauth') || u.includes('consent') || u.includes('approval')))) {
        state = 'oauth_consent';
    } else if (t.includes("couldn't sign you in") || t.includes('wrong password') ||
        t.includes('\u5bc6\u7801\u9519\u8bef') ||
        t.includes('account has been disabled') || t.includes('\u5e10\u53f7\u5df2\u505c\u7528') ||
        t.includes("couldn't find your google account") || t.includes('\u627e\u4e0d\u5230')) {
        state = 'error';
    } else if (t.includes('sign in') && !pageInfo.hasEmailInput && !pageInfo.hasPasswordInput) {
        state = 'confirm_signin';
    }
    return { state, ...debugSummary };
}

// ============ 按钮点击 ============

async function clickButton(page, keywords) {
    const selectors = [
        'button', 'a', 'input[type="submit"]', 'input[type="button"]',
        'div[role="button"]', 'span[role="button"]', 'div[role="link"]',
        'span[jsname]', 'label[role="checkbox"]',
        'material-button', 'mwc-button', 'gm-raised-button',
        '[data-id]', '[jscontroller]', '[jsaction]',
    ];
    const elements = await page.$$(selectors.join(', '));
    const matches = [];
    for (const el of elements) {
        try {
            const info = await page.evaluate(node => {
                const r = node.getBoundingClientRect();
                const s = window.getComputedStyle(node);
                const visible = r.width > 0 && r.height > 0
                    && s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0';
                const tag = node.tagName.toLowerCase();
                const text = (node.textContent || '').trim().toLowerCase();
                let directText = '';
                for (const child of node.childNodes) {
                    if (child.nodeType === Node.TEXT_NODE) directText += child.textContent;
                }
                directText = directText.trim().toLowerCase();
                return { text, directText, visible, tag, area: r.width * r.height };
            }, el);
            if (!info.visible) continue;
            const containerTags = ['form', 'section', 'main', 'body', 'html', 'article', 'nav', 'header', 'footer'];
            if (containerTags.includes(info.tag)) continue;
            if (keywords.some(k => info.text.includes(k))) {
                matches.push({ el, info });
            }
        } catch (_) { }
    }
    if (matches.length === 0) return false;
    matches.sort((a, b) => {
        const aDirectMatch = keywords.some(k => a.info.directText.includes(k)) ? 1 : 0;
        const bDirectMatch = keywords.some(k => b.info.directText.includes(k)) ? 1 : 0;
        if (aDirectMatch !== bDirectMatch) return bDirectMatch - aDirectMatch;
        return a.info.text.length - b.info.text.length;
    });
    const best = matches[0];
    await fastClick(page, best.el);
    return `<${best.info.tag}>: "${best.info.text.substring(0, 40)}"`;
}

async function clickButtonByEval(page, keywords) {
    return page.evaluate((kws) => {
        function isVisible(el) {
            const r = el.getBoundingClientRect();
            const s = window.getComputedStyle(el);
            return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0';
        }
        const all = document.querySelectorAll(
            'button, a, input[type="submit"], div[role="button"], span[role="button"], ' +
            'span[jsname], material-button, mwc-button, [data-id], [jscontroller], ' +
            'div[jscontroller], div[jsaction], span[jsaction]'
        );
        const matches = [];
        for (const el of all) {
            const txt = (el.textContent || '').trim().toLowerCase();
            if (isVisible(el) && kws.some(k => txt.includes(k))) {
                const tag = el.tagName.toLowerCase();
                if (['form', 'section', 'main', 'body', 'html'].includes(tag)) continue;
                matches.push({ el, txt, len: txt.length });
            }
        }
        if (matches.length === 0) return null;
        matches.sort((a, b) => a.len - b.len);
        matches[0].el.click();
        return matches[0].txt.substring(0, 40);
    }, keywords).catch(() => null);
}

async function clickAnyElementByText(page, keywords) {
    return page.evaluate((kws) => {
        function isVisible(el) {
            if (!el || !el.getBoundingClientRect) return false;
            const r = el.getBoundingClientRect();
            if (r.width <= 0 || r.height <= 0) return false;
            const s = window.getComputedStyle(el);
            return s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0';
        }
        const CONTAINER_TAGS = new Set([
            'html', 'body', 'main', 'section', 'article', 'nav',
            'header', 'footer', 'form', 'fieldset', 'table',
            'thead', 'tbody', 'tr', 'ul', 'ol', 'dl',
        ]);
        function isInteractive(el) {
            const role = (el.getAttribute('role') || '').toLowerCase();
            return ['button', 'link', 'menuitem', 'tab', 'checkbox', 'radio', 'switch'].includes(role);
        }
        const all = document.querySelectorAll('*');
        const candidates = [];
        for (const el of all) {
            if (!isVisible(el)) continue;
            const tag = el.tagName.toLowerCase();
            if (CONTAINER_TAGS.has(tag) && !isInteractive(el)) continue;
            let directText = '';
            for (const child of el.childNodes) {
                if (child.nodeType === Node.TEXT_NODE) directText += child.textContent;
            }
            directText = directText.trim().toLowerCase();
            const fullText = (el.innerText || el.textContent || '').trim().toLowerCase();
            if (!fullText) continue;
            const directMatch = kws.some(k => directText.includes(k));
            const fullMatch = kws.some(k => fullText.includes(k));
            if (!directMatch && !fullMatch) continue;
            const r = el.getBoundingClientRect();
            const area = r.width * r.height;
            let score = 0;
            if (directMatch) score += 100;
            if (fullMatch && !directMatch) score += 10;
            const interactiveTags = new Set(['button', 'a', 'input', 'label', 'span']);
            if (interactiveTags.has(tag)) score += 80;
            if (isInteractive(el)) score += 80;
            if (el.hasAttribute('jscontroller') || el.hasAttribute('jsaction')) score += 40;
            if (el.hasAttribute('data-id') || el.hasAttribute('data-action')) score += 30;
            const childElementCount = el.children ? el.children.length : 0;
            if (childElementCount === 0) score += 60;
            else if (childElementCount <= 2) score += 30;
            if (area >= 200 && area <= 30000) score += 50;
            else if (area > 30000 && area <= 80000) score += 10;
            else if (area > 80000) score -= 50;
            const density = fullText.length > 0 ? directText.length / fullText.length : 0;
            score += Math.round(density * 40);
            if (fullText.length <= 20) score += 30;
            else if (fullText.length <= 50) score += 10;
            else score -= 20;
            try {
                const cursor = window.getComputedStyle(el).cursor;
                if (cursor === 'pointer') score += 40;
            } catch (_) { }
            candidates.push({
                el, score, area, tag,
                text: fullText.substring(0, 80),
                directText: directText.substring(0, 80),
            });
        }
        if (candidates.length === 0) return null;
        candidates.sort((a, b) => b.score - a.score);
        const best = candidates[0];
        best.el.click();
        return `<${best.tag}> score=${best.score}: "${best.text.substring(0, 60)}"`;
    }, keywords).catch(() => null);
}

async function listVisibleElements(page) {
    return page.evaluate(() => {
        const tags = 'button, a, div[role="button"], span[role="button"], input[type="submit"], ' +
            'input[type="button"], material-button, [jscontroller], [data-id]';
        const els = document.querySelectorAll(tags);
        const result = [];
        for (const el of els) {
            const r = el.getBoundingClientRect();
            if (r.width > 0 && r.height > 0) {
                const s = window.getComputedStyle(el);
                if (s.display !== 'none' && s.visibility !== 'hidden') {
                    result.push(`<${el.tagName.toLowerCase()} class="${(el.className || '').toString().substring(0, 30)}">: "${(el.textContent || '').trim().substring(0, 60)}"`);
                }
            }
        }
        return result;
    }).catch(() => []);
}

// ============ 截图辅助 ============
async function takeScreenshot(page, label, wlog) {
    try {
        const safeName = label.replace(/[^a-zA-Z0-9_-]/g, '_');
        const ssPath = path.resolve(__dirname, `debug_${safeName}_${Date.now()}.png`);
        await page.screenshot({ path: ssPath, fullPage: true });
        wlog.debug(`Screenshot saved: ${ssPath}`);
        return ssPath;
    } catch (e) {
        wlog.debug(`Screenshot failed: ${e.message}`);
        return null;
    }
}

// ============ 多策略按钮点击封装 ============
async function tryClickStrategies(page, keywords, wlog, label = '') {
    let result = await clickButton(page, keywords);
    if (result) {
        wlog.debug(`  [${label}] Strategy 1 click: ${result}`);
        return true;
    }

    result = await clickButtonByEval(page, keywords);
    if (result) {
        wlog.debug(`  [${label}] Strategy 2 click: "${result}"`);
        return true;
    }

    result = await clickAnyElementByText(page, keywords);
    if (result) {
        wlog.debug(`  [${label}] Strategy 3 click: "${result}"`);
        return true;
    }

    const jsResult = await page.evaluate((kws) => {
        const all = document.querySelectorAll('[onclick], [jsaction], [data-action]');
        for (const el of all) {
            const r = el.getBoundingClientRect();
            if (r.width <= 0 || r.height <= 0) continue;
            const txt = (el.textContent || '').trim().toLowerCase();
            if (kws.some(k => txt.includes(k))) {
                el.click();
                return txt.substring(0, 40);
            }
        }
        return null;
    }, keywords).catch(() => null);
    if (jsResult) {
        wlog.debug(`  [${label}] Strategy 4 click: "${jsResult}"`);
        return true;
    }

    wlog.debug(`  [${label}] All click strategies missed`);
    return false;
}

// ============ CDP 会话清理（替代 context.close，避免 Chrome 崩溃）============
async function clearBrowserSession(browser, wlog) {
    try {
        const pages = await browser.pages();
        // 关闭所有非空白页
        for (const p of pages) {
            const url = p.url();
            if (url !== 'about:blank' && !url.startsWith('chrome://')) {
                await p.close().catch(() => { });
            }
        }
        // 通过 CDP 清理所有 cookies 和存储
        const remainPages = await browser.pages();
        const page = remainPages[0] || await browser.newPage();
        const cdp = await page.createCDPSession();
        await cdp.send('Network.clearBrowserCookies').catch(() => { });
        await cdp.send('Network.clearBrowserCache').catch(() => { });
        // 清理 Google 登录相关的存储
        for (const origin of [
            'https://accounts.google.com',
            'https://myaccount.google.com',
            'https://console.cloud.google.com',
            'https://cloudcode-pa.googleapis.com',
        ]) {
            await cdp.send('Storage.clearDataForOrigin', {
                origin,
                storageTypes: 'all',
            }).catch(() => { });
        }
        await cdp.detach().catch(() => { });
        wlog.debug('Session cleared via CDP');
    } catch (e) {
        wlog.warn(`Session clear failed: ${e.message}`);
    }
}

// ============ 状态机驱动的授权流程 ============
async function auth(account, browser, workerId) {
    const wlog = createWorkerLogger(workerId);
    const timer = new StepTimer(wlog);

    wlog.info(`>> Start ${account.email} (#${account.idx})`);
    updateWorkerStatus(workerId, 'Login', account.email);

    // v12: 使用 default context，不再创建 incognito context
    // incognito context.close() 会导致 Chrome 进程退出
    const context = browser.defaultBrowserContext();
    const useDefaultContext = true;

    // 关闭 Chrome 启动时自动创建的空白页面，避免每个账号出现两个窗口
    try {
        const existingPages = await browser.pages();
        for (const ep of existingPages) {
            const epUrl = ep.url();
            if (epUrl === 'about:blank' || epUrl === '' || epUrl.startsWith('chrome://newtab') || epUrl.startsWith('chrome://new-tab-page')) {
                await ep.close().catch(() => { });
                wlog.debug(`Closed pre-existing blank page: ${epUrl}`);
            }
        }
    } catch (e) {
        wlog.debug(`Failed to close blank pages: ${e.message}`);
    }
    const page = await context.newPage();
    const vpWidth = rand(1200, 1400);
    const vpHeight = rand(700, 900);
    await page.setViewport({ width: vpWidth, height: vpHeight }).catch(() => { });

    const cbPortStart = getNextCbPort(workerId);
    wlog.debug(`Callback port: ${cbPortStart}`);
    const { server, port, codePromise } = await startCbServer(cbPortStart, wlog);
    wlog.debug(`Callback server: http://localhost:${port}/callback`);

    timer.step('Setup');

    let authCode = null;
    codePromise.then(r => { authCode = r; }).catch(() => { });

    try {
        await sleep(100); // v12: 缩短

        const authUrl = buildAuthUrl(port);
        wlog.debug(`OAuth URL: ${authUrl.substring(0, 100)}...`);

        await page.goto(authUrl, { waitUntil: 'networkidle2', timeout: 30000 })
            .catch(e => {
                wlog.warn(`Page load timeout (${e.message}), continuing...`);
            });

        timer.step('Page load');

        const stateHistory = [];
        let lastScreenshotState = '';

        for (let step = 0; step < 30; step++) {
            if (authCode) {
                if (authCode.error) throw new Error(`OAuth error: ${authCode.error}`);
                timer.step('Auth code received');
                break;
            }

            const stateInfo = await detectPageState(page, wlog);
            const state = stateInfo.state;

            wlog.info(`  [Step ${String(step + 1).padStart(2, '0')}] State: ${LOG_COLORS.BOLD}${state}${LOG_COLORS.RESET}`);
            wlog.debug(`    URL: ${stateInfo.url}`);
            wlog.debug(`    Title: ${stateInfo.title}`);
            wlog.debug(`    Preview: ${(stateInfo.textPreview || '').substring(0, 120)}`);

            stateHistory.push(state);
            updateWorkerStatus(workerId, `Step${step + 1}:${state}`, account.email);

            if (SCREENSHOT_ALL && state !== lastScreenshotState) {
                await takeScreenshot(page, `W${workerId}_${account.email}_step${step}_${state}`, wlog);
                lastScreenshotState = state;
            }

            // Deadloop detection
            if (stateHistory.length >= 8) {
                const last8 = stateHistory.slice(-8);
                if (new Set(last8).size === 1) {
                    await takeScreenshot(page, `W${workerId}_deadloop_${account.email}_${state}`, wlog);
                    throw new Error(`8 identical states (${state}), deadloop detected`);
                }
            }
            if (stateHistory.length >= 5) {
                const last5 = stateHistory.slice(-5);
                if (new Set(last5).size === 1 && state === 'unknown') {
                    await takeScreenshot(page, `W${workerId}_unknown5x_${account.email}`, wlog);
                    const fullText = await page.evaluate(() => document.body ? document.body.innerText : '').catch(() => '');
                    wlog.error('5x unknown state, page text:');
                    wlog.error(fullText.substring(0, 500));
                    throw new Error('5x unknown state, giving up');
                }
            }

            switch (state) {
                case 'callback':
                    wlog.debug('Callback page reached, waiting for code...');
                    await sleep(1000);
                    break;

                case 'email': {
                    wlog.debug(`Pasting email: ${account.email}`);
                    await fastType(page, 'input[type="email"]', account.email, wlog);
                    await sleep(100); // v12: 缩短
                    await Promise.all([
                        page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(() => { }),
                        page.keyboard.press('Enter'),
                    ]);
                    timer.step('Email input');
                    await sleep(300); // v12: 缩短 (800→300)
                    break;
                }

                case 'password': {
                    wlog.debug('Pasting password');
                    await fastType(page, 'input[type="password"]', account.pass, wlog);
                    await sleep(100); // v12: 缩短
                    await Promise.all([
                        page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(() => { }),
                        page.keyboard.press('Enter'),
                    ]);
                    timer.step('Password input');
                    await sleep(500); // v12: 缩短 (1000→500)
                    break;
                }

                case 'speedbump': {
                    wlog.info('  Handling Workspace welcome page...');
                    const speedbumpKws = [
                        'i understand', 'understood', 'got it',
                        'accept', 'ok', 'continue', 'next',
                        'i agree', 'agree',
                        '\u6211\u4e86\u89e3', '\u6211\u77e5\u9053\u4e86', '\u77e5\u9053\u4e86', '\u4e86\u89e3', '\u660e\u767d',
                        '\u63a5\u53d7', '\u786e\u5b9a', '\u597d',
                        '\u7ee7\u7eed', '\u4e0b\u4e00\u6b65',
                        '\u6211\u540c\u610f', '\u540c\u610f',
                    ];

                    const submitClicked = await page.evaluate(() => {
                        const submits = document.querySelectorAll('input[type="submit"], button[type="submit"]');
                        for (const s of submits) {
                            const r = s.getBoundingClientRect();
                            if (r.width > 0 && r.height > 0) { s.click(); return 'submit:' + (s.value || s.textContent || '').substring(0, 30); }
                        }
                        const forms = document.querySelectorAll('form');
                        for (const f of forms) {
                            if (f.querySelector('input[type="submit"], button[type="submit"]')) { f.submit(); return 'form.submit'; }
                        }
                        return null;
                    }).catch(() => null);

                    if (submitClicked) {
                        wlog.debug(`  Form submit: "${submitClicked}"`);
                    } else {
                        const clicked = await tryClickStrategies(page, speedbumpKws, wlog, 'speedbump');
                        if (!clicked) {
                            wlog.warn('  Speedbump stuck, trying Tab+Enter');
                            await takeScreenshot(page, `W${workerId}_speedbump_stuck_${account.email}`, wlog);
                            for (let t = 0; t < 8; t++) { await page.keyboard.press('Tab'); await sleep(50); }
                            await page.keyboard.press('Enter');
                        }
                    }
                    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 8000 }).catch(() => { });
                    timer.step('Speedbump');
                    await sleep(200); // v12: 缩短 (500→200)
                    break;
                }

                case 'chrome_sync': {
                    wlog.info('  Handling Chrome sync prompt...');
                    const syncKws = ['continue as', 'continue', 'without signing', 'no thanks', 'skip',
                        '\u8eab\u4efd\u7ee7\u7eed', '\u7ee7\u7eed', '\u4e0d\u767b\u5f55', '\u53d6\u6d88', '\u8df3\u8fc7'];
                    let clicked = await tryClickStrategies(page, syncKws, wlog, 'chrome_sync');
                    if (!clicked) await page.keyboard.press('Enter');
                    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 5000 }).catch(() => { });
                    timer.step('Chrome sync');
                    await sleep(500);
                    break;
                }

                case 'managed_profile': {
                    wlog.info('  Handling managed profile page...');
                    const mgdKws = ['continue', 'accept', 'ok', 'i understand',
                        '\u7ee7\u7eed', '\u63a5\u53d7', '\u786e\u5b9a', '\u6211\u4e86\u89e3'];
                    let clicked = await tryClickStrategies(page, mgdKws, wlog, 'managed');
                    if (!clicked) await page.keyboard.press('Enter');
                    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 5000 }).catch(() => { });
                    timer.step('Managed profile');
                    await sleep(500);
                    break;
                }

                case 'confirm_signin': {
                    wlog.info('  Handling sign-in confirm...');
                    const siKws = ['sign in', 'signin', 'confirm', 'continue',
                        '\u767b\u5f55', '\u786e\u8ba4', '\u7ee7\u7eed'];
                    let clicked = await tryClickStrategies(page, siKws, wlog, 'confirm_signin');
                    if (!clicked) await page.keyboard.press('Enter');
                    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 5000 }).catch(() => { });
                    timer.step('Sign-in confirm');
                    await sleep(500);
                    break;
                }

                case 'tos': {
                    wlog.info('  Handling ToS page...');
                    const tosKws = ['agree', 'accept', 'i agree', 'ok', 'continue',
                        '\u540c\u610f', '\u63a5\u53d7', '\u6211\u540c\u610f', '\u786e\u5b9a', '\u7ee7\u7eed'];
                    let clicked = await tryClickStrategies(page, tosKws, wlog, 'tos');
                    if (!clicked) await page.keyboard.press('Enter');
                    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 5000 }).catch(() => { });
                    timer.step('ToS');
                    await sleep(500);
                    break;
                }

                case 'phone_verification': {
                    wlog.warn('  Phone verification required!');
                    await takeScreenshot(page, `W${workerId}_phone_verify_${account.email}`, wlog);
                    const phoneKws = ['try another', 'skip', 'another way',
                        '\u5176\u4ed6\u65b9\u5f0f', '\u8df3\u8fc7', '\u6362\u4e00\u79cd\u65b9\u5f0f'];
                    await tryClickStrategies(page, phoneKws, wlog, 'phone_verify');
                    await sleep(1000);
                    break;
                }

                case 'challenge': {
                    wlog.info('  Handling security challenge...');
                    await takeScreenshot(page, `W${workerId}_challenge_${account.email}`, wlog);
                    if (account.recovery) {
                        wlog.debug(`  Trying recovery: ${account.recovery.substring(0, 5)}...`);
                        const inputs = await page.$$('input[type="email"], input[type="text"]');
                        let filled = false;
                        for (const inp of inputs) {
                            const isVis = await page.evaluate(el => {
                                const rect = el.getBoundingClientRect();
                                const s = window.getComputedStyle(el);
                                return rect.width > 0 && rect.height > 0
                                    && s.display !== 'none' && s.visibility !== 'hidden';
                            }, inp).catch(() => false);
                            if (!isVis) continue;
                            const v = await page.evaluate(el => el.value, inp).catch(() => '');
                            if (!v) {
                                await fastClick(page, inp);
                                await sleep(100);
                                await inp.type(account.recovery, { delay: 0 });
                                await sleep(200);
                                await page.keyboard.press('Enter');
                                filled = true;
                                break;
                            }
                        }
                        if (!filled) {
                            await tryClickStrategies(page, ['try another', 'next', '\u5176\u4ed6\u65b9\u5f0f', '\u4e0b\u4e00\u6b65'], wlog, 'challenge');
                        }
                    } else {
                        wlog.warn('  No recovery info available');
                        await tryClickStrategies(page, ['try another', 'skip', '\u5176\u4ed6\u65b9\u5f0f'], wlog, 'challenge');
                    }
                    timer.step('Challenge');
                    await sleep(1000);
                    break;
                }

                case 'choose_account': {
                    wlog.info('  Handling account chooser...');
                    const chooseKws = ['use another', 'other account', 'add another',
                        '\u4f7f\u7528\u5176\u4ed6', '\u5176\u4ed6\u5e10\u53f7', '\u6dfb\u52a0\u5176\u4ed6'];
                    let clicked = await tryClickStrategies(page, chooseKws, wlog, 'choose_account');
                    if (clicked) {
                        await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 5000 }).catch(() => { });
                    } else {
                        // Fallback if click missed
                        await page.keyboard.press('Tab');
                        await sleep(50);
                        await page.keyboard.press('Enter');
                    }
                    timer.step('Account chooser');
                    await sleep(500);
                    break;
                }

                case 'oauth_consent': {
                    wlog.info('  Handling OAuth consent...');
                    await sleep(100); // v12: 缩短 (300→100)

                    const checkboxes = await page.$$('label[role="checkbox"], input[type="checkbox"]');
                    let cbCount = 0;
                    for (const cb of checkboxes) {
                        try {
                            const isChecked = await page.evaluate(el => {
                                return el.getAttribute('aria-checked') === 'true' || el.checked === true;
                            }, cb);
                            if (!isChecked) {
                                const vis = await page.evaluate(el => {
                                    const r = el.getBoundingClientRect();
                                    return r.width > 0 && r.height > 0;
                                }, cb);
                                if (vis) {
                                    await fastClick(page, cb);
                                    cbCount++;
                                    await sleep(200);
                                }
                            }
                        } catch (_) { }
                    }
                    if (cbCount > 0) wlog.debug(`  Checked ${cbCount} scope checkboxes`);

                    let advClicked = await clickButton(page, ['advanced', '\u9ad8\u7ea7', '\u663e\u793a\u9ad8\u7ea7', 'details']);
                    if (advClicked) {
                        wlog.debug('  Clicked Advanced');
                        await sleep(500);
                        let goToClicked = await clickButton(page, ['go to', 'unsafe', 'proceed',
                            '\u524d\u5f80', '\u4e0d\u5b89\u5168', '\u7ee7\u7eed\u524d\u5f80']);
                        if (goToClicked) {
                            wlog.debug(`  Clicked Go to unsafe`);
                            timer.step('OAuth consent (unsafe)');
                            await sleep(500);
                            break;
                        }
                    }

                    const consentKws = [
                        'continue', 'allow', 'accept', 'grant', 'sign in',
                        '\u7ee7\u7eed', '\u5141\u8bb8', '\u540c\u610f', '\u6388\u6743', '\u767b\u5f55',
                        'cho ph\u00e9p', 'ti\u1ebfp t\u1ee5c',
                        'advanced', '\u9ad8\u7ea7', 'unsafe', '\u4e0d\u5b89\u5168', 'go to', '\u524d\u5f80',
                    ];
                    let clicked = await tryClickStrategies(page, consentKws, wlog, 'oauth_consent');
                    if (clicked) {
                        await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 8000 }).catch(() => { });
                    } else {
                        await takeScreenshot(page, `W${workerId}_consent_stuck_${account.email}_step${step}`, wlog);
                        const visibleEls = await listVisibleElements(page);
                        wlog.warn(`  OAuth consent stuck, visible elements: ${visibleEls.length}`);
                        for (let t = 0; t < 5; t++) { await page.keyboard.press('Tab'); await sleep(50); }
                        await page.keyboard.press('Enter');
                    }
                    timer.step('OAuth consent');
                    await sleep(500);
                    break;
                }
                case 'identity_verify': {
                    wlog.warn('  Identity verification required (non-retryable)!');
                    await takeScreenshot(page, `W${workerId}_identity_verify_${account.email}`, wlog);
                    throw new Error('identity_verification_required');
                }
                case 'error': {
                    const errText = await page.evaluate(() => {
                        return document.body
                            ? document.body.innerText.substring(0, 500).replace(/\n/g, ' ')
                            : 'unknown error';
                    }).catch(() => 'could not read error page');
                    await takeScreenshot(page, `W${workerId}_login_error_${account.email}`, wlog);
                    wlog.error(`  Login error: ${errText.substring(0, 200)}`);
                    throw new Error(`Login blocked: ${errText.substring(0, 200)}`);
                }

                case 'chrome_internal':
                case 'blank':
                    wlog.debug('  Chrome internal/blank page, waiting...');
                    await sleep(1000);
                    break;

                case 'unknown': {
                    wlog.warn('  Unknown page state');
                    await takeScreenshot(page, `W${workerId}_unknown_${account.email}_step${step}`, wlog);

                    const pageText = await page.evaluate(() =>
                        document.body ? document.body.innerText.substring(0, 500) : ''
                    ).catch(() => '');
                    wlog.debug(`  Page text: ${pageText.replace(/\n/g, ' ').substring(0, 200)}`);

                    const unknownKws = [
                        'continue', 'next', 'ok', 'accept', 'agree', 'allow', 'confirm', 'sign in',
                        '\u7ee7\u7eed', '\u4e0b\u4e00\u6b65', '\u786e\u5b9a', '\u63a5\u53d7', '\u540c\u610f', '\u5141\u8bb8', '\u786e\u8ba4', '\u767b\u5f55',
                        '\u6211\u4e86\u89e3', '\u6211\u77e5\u9053\u4e86', '\u4e86\u89e3', 'i understand', 'got it',
                    ];
                    let clicked = await tryClickStrategies(page, unknownKws, wlog, 'unknown');
                    if (!clicked) {
                        const visibleEls = await listVisibleElements(page);
                        wlog.debug(`  Visible elements (${visibleEls.length}):`);
                        visibleEls.slice(0, 15).forEach(t => wlog.debug(`    ${t}`));
                        for (let t = 0; t < 3; t++) { await page.keyboard.press('Tab'); await sleep(50); }
                        await page.keyboard.press('Enter');
                    }
                    timer.step('Unknown');
                    await sleep(1000);
                    break;
                }
            }
        }

        if (!authCode) {
            wlog.info('  Waiting for final callback (15s timeout)...');
            const r = await Promise.race([
                codePromise,
                sleep(15000).then(() => ({ error: 'timeout_final' })),
            ]);
            authCode = r;
        }

        if (!authCode || authCode.error) {
            await takeScreenshot(page, `W${workerId}_final_fail_${account.email}`, wlog);
            throw new Error(`Auth failed: ${authCode ? authCode.error : 'flow timeout'}`);
        }

        timer.step('Got auth code');

        wlog.info('  Getting Refresh Token...');
        const tok = await exchangeCode(authCode.code, port);
        if (!tok.refresh_token) {
            throw new Error('Auth succeeded but no refresh_token returned');
        }
        timer.step('Token exchange');

        // Auto-enable API (retry up to 3 times)
        let apiEnabled = false;
        for (let apiAttempt = 1; apiAttempt <= 3; apiAttempt++) {
            try {
                wlog.info(`  Enabling Gemini API (attempt ${apiAttempt}/3)...`);
                const projectId = await getProjectId(tok.access_token, wlog);
                if (projectId) {
                    const apiOk = await enableRequiredApis(tok.access_token, projectId, wlog);
                    if (apiOk) {
                        wlog.success('API services ready');
                        apiEnabled = true;
                        break;
                    } else {
                        wlog.warn(`API enable returned false (attempt ${apiAttempt}/3)`);
                    }
                } else {
                    wlog.warn(`Could not get project ID (attempt ${apiAttempt}/3)`);
                }
            } catch (apiErr) {
                wlog.warn(`API enable error (attempt ${apiAttempt}/3): ${apiErr.message}`);
            }
            if (apiAttempt < 3) {
                await sleep(3000);
            }
        }

        if (!apiEnabled) {
            // API 没开成功，抛出特殊错误，附带 refresh_token 以便记录
            const err = new Error('ENABLE_API_FAILED');
            err.refresh_token = tok.refresh_token;
            throw err;
        }
        timer.step('API enable');

        const totalMs = timer.total();
        wlog.success(`Done: ${account.email} (${(totalMs / 1000).toFixed(1)}s)`);
        return { email: account.email, refresh_token: tok.refresh_token };

    } finally {
        server.close();
        // v12: 不再 context.close()（会导致 Chrome 崩溃），改用 CDP 清理会话
        await page.close().catch(() => { });
        await clearBrowserSession(browser, wlog);
    }
}

// ============ main ============
async function main() {
    const args = process.argv.slice(2);

    // Default: look for accounts file next to run.bat (parent dir)
    let accountsFile = path.resolve(__dirname, '..', 'accounts.txt');
    let start = 0, end = Infinity, testN = null;
    let concurrency = CONCURRENCY;

    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--accounts' || args[i] === '-a') { accountsFile = args[++i]; }
        else if (args[i] === '--test' || args[i] === '-t') { testN = parseInt(args[++i], 10); }
        else if (args[i] === '--start' || args[i] === '-s') { start = parseInt(args[++i], 10) - 1; }
        else if (args[i] === '--end' || args[i] === '-e') { end = parseInt(args[++i], 10); }
        else if (args[i] === '--concurrency' || args[i] === '-c') {
            const c = parseInt(args[++i], 10);
            if (c > 0) concurrency = c;
        }
    }

    // Fallback account file search
    if (!fs.existsSync(accountsFile)) {
        const fallbacks = [
            path.resolve(__dirname, '..', 'accounts.txt'),
            path.resolve(__dirname, 'accounts.txt'),
            path.resolve(process.cwd(), 'accounts.txt'),
        ];
        let found = false;
        for (const fb of fallbacks) {
            if (fs.existsSync(fb)) {
                accountsFile = fb;
                found = true;
                break;
            }
        }
        if (!found) {
            console.error(`Error: Account file not found.`);
            console.error(`Searched: ${accountsFile}`);
            console.error(`Please create accounts.txt next to run.bat`);
            console.error(`Format: email@gmail.com:password (one per line)`);
            process.exit(1);
        }
    }

    const chromePath = findChrome();
    if (!chromePath) { console.error('Chrome not found'); process.exit(1); }

    log('');
    log(`${'='.repeat(60)}`);
    log(`  Antigravity Batch Auth v12 — 稳定极速版`);
    log(`${'='.repeat(60)}`);
    log(`  Chrome:       ${chromePath}`);
    log(`  Accounts:     ${accountsFile}`);
    log(`  Concurrency:  ${concurrency}`);
    log(`  Log level:    ${VERBOSE ? 'VERBOSE (DEBUG+)' : 'INFO (use --verbose for details)'}`);
    log(`  Screenshots:  ${SCREENSHOT_ALL ? 'ALL' : 'Errors only (use --screenshot-all)'}`);
    log(`  Max retries:  ${MAX_RETRIES}`);
    log(`  Port range:   ${CB_PORT_BASE}-${CB_PORT_BASE + concurrency * PORT_RANGE_PER_WORKER - 1}`);
    log(`${'='.repeat(60)}`);
    log('');

    // Init credentials file
    const initialCreds = _loadCredentialsUnsafe();
    const existingEmails = new Set(initialCreds.map(c => c.email));
    log(`Credentials file: ${initialCreds.length} existing records`);

    // Parse accounts
    const all = parseAccounts(accountsFile);
    let accs = all.slice(start, end);
    if (testN) accs = accs.slice(0, testN);

    const beforeFilter = accs.length;
    accs = accs.filter(a => {
        if (existingEmails.has(a.email)) {
            log(`  Skip (exists): ${a.email}`, 'DEBUG');
            return false;
        }
        return true;
    });

    log('');
    log(`  Total accounts:    ${all.length}`);
    log(`  Already done:      ${beforeFilter - accs.length}`);
    log(`  To process:        ${accs.length}`);
    log(`  Workers:           ${concurrency}`);
    log('');

    globalStats.total = accs.length;

    if (!accs.length) {
        log('No new accounts to process. Exiting.');
        return;
    }

    // Launch Chrome instances
    log(`Launching ${concurrency} Chrome instances...`);
    const workers = [];
    for (let w = 0; w < concurrency; w++) {
        try {
            const chrome = await launchRealChrome(chromePath, w);
            workers.push({ id: w, ...chrome });
            if (w < concurrency - 1) await sleep(rand(2000, 3000));
        } catch (e) {
            log(`Worker${w} launch failed: ${e.message}`, 'ERROR');
        }
    }

    if (workers.length === 0) {
        console.error('All Chrome instances failed to start');
        process.exit(1);
    }

    log(`${workers.length} workers ready`, 'SUCCESS');
    log('');

    let accountIdx = 0;

    const progressInterval = setInterval(() => {
        if (globalStats.ok + globalStats.ng < globalStats.total) {
            printProgressSummary();
        }
    }, 60000);

    function cleanup() {
        clearInterval(progressInterval);
        for (const w of workers) {
            try { w.browser.close(); } catch (_) { }
            try { w.proc.kill(); } catch (_) { }
        }
    }

    process.on('SIGINT', () => {
        log('\nInterrupted (Ctrl+C). Saving progress...', 'WARN');
        cleanup();
        printProgressSummary();
        process.exit();
    });

    async function workerFn(worker) {
        const wlog = createWorkerLogger(worker.id);

        while (true) {
            const idx = accountIdx++;
            if (idx >= accs.length) {
                updateWorkerStatus(worker.id, 'Done');
                wlog.info('All assigned accounts processed');
                break;
            }

            const acc = accs[idx];
            updateWorkerStatus(worker.id, 'Preparing', acc.email);

            const alreadyExists = await isEmailInCredentials(acc.email);
            if (alreadyExists) {
                wlog.info(`Skip (already exists): ${acc.email}`);
                continue;
            }

            let success = false;
            let lastError = null;

            for (let attempt = 1; attempt <= MAX_RETRIES + 1; attempt++) {
                try {
                    const alive = await isChromeAlive(worker);
                    if (!alive) {
                        wlog.warn('Chrome unreachable, restarting...');
                        await restartChrome(chromePath, worker);
                    }

                    if (attempt > 1) {
                        wlog.info(`Retry ${acc.email} (${attempt}/${MAX_RETRIES + 1})`);
                        globalStats.retries++;
                        await sleep(rand(2000, 5000)); // v12: 缩短重试间隔 (5-10s→2-5s)
                    }

                    const result = await auth(acc, worker.browser, worker.id);

                    const totalCreds = await addCredential(result);
                    globalStats.ok++;
                    wlog.success(`>> Saved (total: ${totalCreds}, ok: ${globalStats.ok}/${globalStats.total})`);
                    success = true;
                    break;

                } catch (e) {
                    lastError = e;
                    wlog.error(`Failed [${acc.email}] (${attempt}/${MAX_RETRIES + 1}): ${e.message}`, e);

                    // ENABLE_API_FAILED: don't save credentials, log to enableAPI_failed
                    if (e.message === 'ENABLE_API_FAILED') {
                        globalStats.apiFailCount = (globalStats.apiFailCount || 0) + 1;
                        await addEnableApiFailedRecord({
                            email: acc.email,
                            refresh_token: e.refresh_token,
                            reason: 'API enable failed after 3 retries',
                            time: new Date().toISOString(),
                            workerId: worker.id,
                        });
                        wlog.warn(`>> enableAPI_failed logged, skipping retries`);
                        break; // no retry for this type of error
                    }

                    if (attempt <= MAX_RETRIES) {
                        const msg = e.message.toLowerCase();
                        const noRetry = msg.includes('wrong password')
                            || msg.includes('disabled')
                            || msg.includes("couldn't find")
                            || msg.includes('phone_verification')
                            || msg.includes('identity_verification_required');
                        if (noRetry) {
                            wlog.warn(`  Non-retryable error, skipping`);
                            break;
                        }
                    }
                }
            }

            if (!success) {
                globalStats.ng++;
                await addFailedRecord({
                    email: acc.email,
                    error: lastError ? lastError.message : 'unknown',
                    time: new Date().toISOString(),
                    workerId: worker.id,
                });
            }

            const d = rand(500, 1500); // v12: 缩短冷却 (1-3s→0.5-1.5s)
            wlog.debug(`Cooldown ${Math.round(d / 1000)}s...`);
            updateWorkerStatus(worker.id, `Cooldown ${Math.round(d / 1000)}s`, acc.email);
            await sleep(d);
        }
    }

    const STAGGER_DELAY = rand(1000, 2000);
    log(`Processing ${accs.length} accounts (${workers.length} workers, stagger ${Math.round(STAGGER_DELAY / 1000)}s)...`);
    log('');

    const workerPromises = workers.map((w, i) => {
        const delay = i * STAGGER_DELAY;
        if (i > 0) log(`  Worker${w.id} starts in ${Math.round(delay / 1000)}s`);
        return sleep(delay).then(() => {
            const wlog = createWorkerLogger(w.id);
            wlog.info('Starting');
            return workerFn(w);
        });
    });

    await Promise.all(workerPromises);

    cleanup();

    log('');
    log(`${'='.repeat(60)}`);
    log(`  Complete`, 'SUCCESS');
    log(`${'='.repeat(60)}`);
    log(`  ${LOG_COLORS.GREEN}OK: ${globalStats.ok}${LOG_COLORS.RESET}`);
    log(`  ${LOG_COLORS.RED}FAIL: ${globalStats.ng}${LOG_COLORS.RESET}`);
    if (globalStats.apiFailCount) {
        log(`  ${LOG_COLORS.YELLOW}API Enable Failed: ${globalStats.apiFailCount}${LOG_COLORS.RESET}`);
    }
    log(`  Retries: ${globalStats.retries}`);
    log(`  Credentials: ${OUTPUT} (${_loadCredentialsUnsafe().length} total)`);
    log(`  Failed log:  ${FAILED}`);
    if (globalStats.apiFailCount) {
        log(`  API Failed:  ${ENABLE_API_FAILED} (${_loadEnableApiFailedUnsafe().length} total)`);
    }
    log(`${'='.repeat(60)}`);
    log('');
}

main().catch(e => {
    log(`Fatal: ${e.message}`, 'ERROR');
    if (e.stack) console.error(e.stack);
    process.exit(1);
});
