/**
 * 账号解析、分组逻辑
 */

const fs = require('fs');
const path = require('path');
const { log } = require('./logger');

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

const failedMutex = new AsyncMutex();

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
    return failedMutex.runExclusive(() => {
        const fail = loadFailedUnsafe();
        fail.push({ ...record, time: new Date().toISOString() });
        saveFailedUnsafe(fail);
        return fail.length;
    });
}

// ============ 账号解析 ============
function parseAccounts(input) {
    let raw;
    if (typeof input === 'string' && input.includes('\n') === false && input.length < 500 && fs.existsSync(input)) {
        // Treat as a file path
        raw = fs.readFileSync(input, 'utf-8');
    } else if (typeof input === 'string') {
        // Treat as raw content
        raw = input;
    } else {
        throw new Error('parseAccounts: input must be a file path or raw string');
    }
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

        // TAB 分隔格式：email\tpass\trecovery\ttotp_secret（后两列可选）
        if (trimmed.includes('\t')) {
            const cols = trimmed.split(/\t+/).map(s => s.trim());
            const email = cols[0] || '';
            const pass = cols[1] || '';
            const recovery = cols[2] || '';
            const totpRaw = cols[3] || '';
            if (!email || !pass) {
                log(`  Line ${i + 1}: empty email or password, skipping`, 'WARN');
                return null;
            }
            if (!email.includes('@')) {
                log(`  Line ${i + 1}: invalid email "${email}", skipping`, 'WARN');
                return null;
            }
            const account = { idx: i + 1, email, pass, recovery };
            if (totpRaw) {
                const m = totpRaw.match(/^[A-Za-z2-7]+/);
                if (m && m[0].length >= 16) account.totp_secret = m[0];
            }
            return account;
        }

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

        let pass, recovery, totp_secret;
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
            // 支持格式: pass:recovery:totp_secret 或 pass:recovery 或 pass
            // totp_secret 是纯 base32 字符串（A-Z2-7），不含 @ 也不含空格
            const parts = rest.split(':');
            if (parts.length >= 3) {
                // email:pass:recovery:fa_secret 格式
                pass = parts[0].trim();
                recovery = parts[1].trim();
                totp_secret = parts.slice(2).join(':').trim();
                // fa_secret 后面可能跟 | 或其他后缀，只保留 base32 前缀
                const m = totp_secret.match(/^[A-Za-z2-7]+/);
                totp_secret = m ? m[0] : '';
            } else if (parts.length === 2) {
                const afterLast = parts[1].trim();
                const beforeLast = parts[0].trim();
                if (afterLast === '' || afterLast.includes('@')) {
                    pass = beforeLast;
                    recovery = afterLast;
                } else {
                    // 没有 @ 符号 — 可能是 pass:fa_secret（无 recovery）
                    // 判断：如果看起来像 base32（只含 A-Z 和 2-7，长度>=16），当作 fa_secret
                    if (/^[A-Za-z2-7]{16,}$/.test(afterLast)) {
                        pass = beforeLast;
                        recovery = '';
                        totp_secret = afterLast;
                    } else {
                        pass = rest.trim();
                        recovery = '';
                    }
                }
            } else {
                pass = rest.trim();
                recovery = '';
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

        const account = { idx: i + 1, email, pass, recovery: recovery || '' };
        if (totp_secret) account.totp_secret = totp_secret;
        return account;
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

module.exports = {
    AsyncMutex,
    parseAccounts,
    buildGroups,
    addFailedRecord,
    FAILED_FILE,
};
