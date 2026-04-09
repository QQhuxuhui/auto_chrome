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
        const data = await this._request('POST', '/api/v1/admin/antigravity/oauth/auth-url', { proxy_id: proxyId });
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
     */
    async findAccountByName(name) {
        const qs = new URLSearchParams({ search: name, page: '1', page_size: '50' }).toString();
        const data = await this._request('GET', `/api/v1/admin/accounts?${qs}`, undefined);
        const list = Array.isArray(data?.items) ? data.items
            : Array.isArray(data?.list) ? data.list
            : Array.isArray(data) ? data
            : [];
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
     * Runs the test endpoint. Consumes the SSE stream and returns true if no
     * explicit error event was seen, false otherwise. Non-fatal by design.
     */
    async testAccount(id) {
        const url = `${this.baseUrl}/api/v1/admin/accounts/${encodeURIComponent(id)}/test`;
        let res;
        try {
            res = await fetch(url, {
                method: 'POST',
                headers: { 'x-api-key': this.apiKey, 'content-type': 'application/json' },
                body: JSON.stringify({}),
            });
        } catch (e) {
            return false;
        }
        if (!res.ok || !res.body) return false;
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = '';
        let sawError = false;
        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                buf += decoder.decode(value, { stream: true });
                // Scan each SSE event (separated by blank line)
                let idx;
                while ((idx = buf.indexOf('\n\n')) >= 0) {
                    const evt = buf.slice(0, idx);
                    buf = buf.slice(idx + 2);
                    if (/event:\s*error/i.test(evt) || /"type"\s*:\s*"error"/i.test(evt)) {
                        sawError = true;
                    }
                }
            }
        } catch (_) {
            return false;
        }
        return !sawError;
    }
}

module.exports = {
    accountName,
    parseSub2apiConfig,
    shouldForceReauth,
    Sub2apiClient,
    Sub2apiError,
};
