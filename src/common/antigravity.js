/**
 * Antigravity-Manager HTTP 客户端。
 * 无状态，只做网络调用。上层业务逻辑在 src/sync/antigravity-sync.js。
 */

const BASE = process.env.ANTIGRAVITY_URL || 'http://104.194.91.23:8045';
const API_KEY = process.env.ANTIGRAVITY_API_KEY;
const TIMEOUT_MS = parseInt(process.env.ANTIGRAVITY_TIMEOUT_MS, 10) || 10000;

class AntigravityError extends Error {
    constructor(message, status, body) {
        super(message);
        this.name = 'AntigravityError';
        this.status = status;
        this.body = body;
    }
}

async function request(path, { method = 'GET', body } = {}) {
    if (!API_KEY) throw new AntigravityError('ANTIGRAVITY_API_KEY missing in env', 0, null);
    const url = `${BASE}${path}`;
    const headers = { Authorization: `Bearer ${API_KEY}` };
    const init = { method, headers };
    if (body !== undefined) {
        headers['Content-Type'] = 'application/json';
        init.body = JSON.stringify(body);
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    init.signal = controller.signal;
    let res;
    try {
        res = await fetch(url, init);
    } catch (e) {
        clearTimeout(timer);
        throw new AntigravityError(`network: ${e.message}`, 0, null);
    }
    clearTimeout(timer);

    const ct = res.headers.get && res.headers.get('content-type');
    let parsed = null;
    if (ct && String(ct).includes('application/json')) {
        try { parsed = await res.json(); } catch (_) { parsed = null; }
    }
    if (!res.ok) {
        const msg = (parsed && (parsed.error || parsed.message)) || `HTTP ${res.status}`;
        throw new AntigravityError(msg, res.status, parsed);
    }
    return parsed;
}

async function listAccounts() {
    return request('/api/accounts');
}

async function pushAccount({ refreshToken }) {
    return request('/api/accounts', { method: 'POST', body: { refreshToken } });
}

async function deleteAccount(id) {
    return request(`/api/accounts/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

module.exports = { listAccounts, pushAccount, deleteAccount, AntigravityError };
