// Shared UI helpers. Loaded by all pages.
window.App = (function () {
    async function api(method, url, body) {
        const opts = { method, headers: {} };
        if (body !== undefined) {
            opts.headers['Content-Type'] = 'application/json';
            opts.body = JSON.stringify(body);
        }
        const r = await fetch(url, opts);
        if (r.status === 204) return null;
        const ct = r.headers.get('content-type') || '';
        const data = ct.includes('application/json') ? await r.json() : await r.text();
        if (!r.ok) {
            const msg = (data && data.error) || `HTTP ${r.status}`;
            throw new Error(msg);
        }
        return data;
    }
    function timeago(iso) {
        if (!iso) return '';
        const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
        if (s < 60) return `${s}s ago`;
        if (s < 3600) return `${Math.floor(s / 60)}m ago`;
        if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
        return `${Math.floor(s / 86400)}d ago`;
    }
    function shortToken(t) {
        if (!t) return '—';
        return t.length > 10 ? t.slice(0, 8) + '…' : t;
    }
    async function copyText(s) {
        try { await navigator.clipboard.writeText(s); return true; }
        catch (_) { return false; }
    }
    return { api, timeago, shortToken, copyText };
})();
