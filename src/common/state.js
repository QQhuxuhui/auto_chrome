/**
 * 状态管理：state.json 读写、failed.json 读写、账号解析、分组逻辑
 */

const fs = require('fs');
const path = require('path');
const { log } = require('./logger');

const STATE_FILE = path.resolve(__dirname, '..', '..', 'state.json');
const FAILED_FILE = path.resolve(__dirname, '..', '..', 'failed.json');

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

const stateMutex = new AsyncMutex();

// ============ 账号解析 ============
function parseAccounts(f) {
    if (!fs.existsSync(f)) throw new Error(`Account file not found: ${f}`);
    let raw = fs.readFileSync(f, 'utf-8');
    if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);

    const lines = raw.split(/\r?\n/).filter(l => {
        const trimmed = l.trim();
        return trimmed && !trimmed.startsWith('#');
    });
    if (lines.length === 0) return [];

    const normalizedLines = lines.map(l => l.replace(/\uff1a/g, ':'));

    return normalizedLines.map((line, i) => {
        const trimmed = line.trim();
        if (!trimmed) return null;

        const colonPos = trimmed.indexOf(':');
        const dashPos = trimmed.indexOf('----');

        let email, rest;

        if (colonPos >= 0 && (dashPos < 0 || colonPos < dashPos)) {
            email = trimmed.substring(0, colonPos).trim();
            rest = trimmed.substring(colonPos + 1);
        } else if (dashPos >= 0) {
            email = trimmed.substring(0, dashPos).trim();
            rest = trimmed.substring(dashPos + 4);
        } else {
            log(`  Line ${i + 1}: no delimiter found, skipping: "${trimmed.substring(0, 50)}"`, 'WARN');
            return null;
        }

        let pass, recovery;
        const restDashPos = rest.indexOf('----');
        if (restDashPos >= 0) {
            const before = rest.substring(0, restDashPos).trim();
            const after = rest.substring(restDashPos + 4).trim();
            if (after === '' || after.includes('@')) {
                pass = before;
                recovery = after;
            }
        }

        if (pass === undefined) {
            const lastColon = rest.lastIndexOf(':');
            if (lastColon < 0) {
                pass = rest.trim();
                recovery = '';
            } else {
                const afterLast = rest.substring(lastColon + 1).trim();
                const beforeLast = rest.substring(0, lastColon).trim();
                if (afterLast === '' || afterLast.includes('@')) {
                    pass = beforeLast;
                    recovery = afterLast;
                } else {
                    pass = rest.trim();
                    recovery = '';
                }
            }
        }

        if (!email || !pass) {
            log(`  Line ${i + 1}: empty email or password, skipping`, 'WARN');
            return null;
        }
        if (!email.includes('@')) {
            log(`  Line ${i + 1}: invalid email "${email}", skipping`, 'WARN');
            return null;
        }

        return { idx: i + 1, email, pass, recovery: recovery || '' };
    }).filter(Boolean);
}

// ============ 分组逻辑 ============
function buildGroups(hosts, members) {
    const groups = [];
    for (let i = 0; i < hosts.length; i++) {
        const start = i * 5;
        const end = Math.min(start + 5, members.length);
        const memberSlice = members.slice(start, end);
        if (memberSlice.length === 0) break;
        groups.push({
            groupId: i + 1,
            host: hosts[i],
            members: memberSlice,
        });
    }
    return groups;
}

// ============ state.json 操作 ============
function loadStateUnsafe() {
    if (!fs.existsSync(STATE_FILE)) return [];
    try {
        const raw = fs.readFileSync(STATE_FILE, 'utf-8').trim();
        const arr = JSON.parse(raw);
        return Array.isArray(arr) ? arr : [];
    } catch (_) {
        return [];
    }
}

function saveStateUnsafe(state) {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf-8');
}

async function loadState() {
    return stateMutex.runExclusive(() => loadStateUnsafe());
}

async function saveState(state) {
    return stateMutex.runExclusive(() => saveStateUnsafe(state));
}

async function updateState(updater) {
    return stateMutex.runExclusive(() => {
        const state = loadStateUnsafe();
        const result = updater(state);
        saveStateUnsafe(state);
        return result;
    });
}

/**
 * 初始化 state.json：按分组创建初始状态（跳过已存在的组）
 */
async function initState(groups) {
    return stateMutex.runExclusive(() => {
        const existing = loadStateUnsafe();
        const existingIds = new Set(existing.map(g => g.groupId));

        for (const g of groups) {
            if (existingIds.has(g.groupId)) continue;
            existing.push({
                groupId: g.groupId,
                host: g.host.email,
                members: g.members.map(m => m.email),
                stage1_invited: false,
                stage2_accepted: g.members.map(() => false),
            });
        }

        saveStateUnsafe(existing);
        return existing;
    });
}

// ============ failed.json 操作 ============
function loadFailedUnsafe() {
    if (!fs.existsSync(FAILED_FILE)) return [];
    try {
        const arr = JSON.parse(fs.readFileSync(FAILED_FILE, 'utf-8').trim());
        return Array.isArray(arr) ? arr : [];
    } catch (_) { return []; }
}

function saveFailedUnsafe(data) {
    fs.writeFileSync(FAILED_FILE, JSON.stringify(data, null, 2), 'utf-8');
}

async function addFailedRecord(record) {
    return stateMutex.runExclusive(() => {
        const fail = loadFailedUnsafe();
        fail.push({
            ...record,
            time: new Date().toISOString(),
        });
        saveFailedUnsafe(fail);
        return fail.length;
    });
}

module.exports = {
    AsyncMutex,
    parseAccounts,
    buildGroups,
    loadState,
    saveState,
    updateState,
    initState,
    addFailedRecord,
    STATE_FILE,
    FAILED_FILE,
};
