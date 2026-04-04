/**
 * 分级日志系统 — 从 auth.js 抽取
 */

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

const WORKER_COLORS = [
    LOG_COLORS.CYAN,
    LOG_COLORS.MAGENTA,
    LOG_COLORS.YELLOW,
    LOG_COLORS.GREEN,
    LOG_COLORS.BLUE,
    LOG_COLORS.WHITE,
];

let VERBOSE = false;

function setVerbose(v) { VERBOSE = v; }
function isVerbose() { return VERBOSE; }

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

module.exports = {
    LOG_COLORS,
    WORKER_COLORS,
    log,
    createWorkerLogger,
    StepTimer,
    setVerbose,
    isVerbose,
};
