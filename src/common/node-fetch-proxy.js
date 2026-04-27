'use strict';

const { execFileSync } = require('child_process');

const LOCAL_PROXY_PORTS = [7890, 7897, 10809, 10808, 8080, 8118, 1080, 1087];

function normalizeProxyUrl(proxy) {
    if (!proxy) return null;
    const value = String(proxy).trim();
    if (!value) return null;
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return value;
    return `http://${value}`;
}

function parseWindowsProxyServer(proxyServer) {
    if (!proxyServer) return null;
    const value = String(proxyServer).trim();
    if (!value) return null;
    const parts = value.split(';').map(part => part.trim()).filter(Boolean);
    const keyed = new Map();
    for (const part of parts) {
        const idx = part.indexOf('=');
        if (idx > 0) keyed.set(part.slice(0, idx).toLowerCase(), part.slice(idx + 1));
    }
    if (keyed.size > 0) {
        return normalizeProxyUrl(keyed.get('https') || keyed.get('http') || keyed.values().next().value);
    }
    return normalizeProxyUrl(value);
}

function mergeNoProxy(existing) {
    const required = ['localhost', '127.0.0.1', '::1'];
    const entries = String(existing || '')
        .split(',')
        .map(item => item.trim())
        .filter(Boolean);
    for (const item of required) {
        if (!entries.some(entry => entry.toLowerCase() === item.toLowerCase())) entries.push(item);
    }
    return entries.join(',');
}

function getEnvProxy(env = process.env) {
    return normalizeProxyUrl(env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy);
}

function getLocalListeningProxy({ platform = process.platform, execFile = execFileSync, ports = LOCAL_PROXY_PORTS } = {}) {
    if (platform !== 'win32') return null;
    let output;
    try {
        output = execFile('netstat.exe', ['-ano', '-p', 'tcp'], { encoding: 'utf8' });
    } catch (_) {
        return null;
    }
    const lines = String(output).split(/\r?\n/);
    for (const port of ports) {
        const portPattern = new RegExp(`(?:127\\.0\\.0\\.1|0\\.0\\.0\\.0|\\[?::1\\]?|\\[?::\\]?):${port}\\s+.*LISTENING`, 'i');
        if (lines.some(line => portPattern.test(line))) return `http://127.0.0.1:${port}`;
    }
    return null;
}

function getWindowsUserProxy({ platform = process.platform, execFile = execFileSync } = {}) {
    if (platform !== 'win32') return null;
    let output;
    try {
        output = execFile('reg.exe', [
            'query',
            'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings',
            '/v',
            'ProxyEnable',
        ], { encoding: 'utf8' });
    } catch (_) {
        return null;
    }
    if (!/ProxyEnable\s+REG_DWORD\s+0x1/i.test(output)) return null;
    try {
        output = execFile('reg.exe', [
            'query',
            'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings',
            '/v',
            'ProxyServer',
        ], { encoding: 'utf8' });
    } catch (_) {
        return null;
    }
    const match = output.match(/ProxyServer\s+REG_SZ\s+(.+)$/im);
    return match ? parseWindowsProxyServer(match[1]) : null;
}

function setupNodeFetchProxy({ env = process.env, platform = process.platform, execFile = execFileSync, log = console.log } = {}) {
    let proxyUrl = getEnvProxy(env);
    let source = 'env';
    if (!proxyUrl) {
        proxyUrl = getWindowsUserProxy({ platform, execFile });
        source = 'windows';
        if (proxyUrl) {
            env.HTTPS_PROXY = proxyUrl;
            env.HTTP_PROXY = proxyUrl;
        }
    }
    if (!proxyUrl) {
        proxyUrl = getLocalListeningProxy({ platform, execFile });
        source = 'local';
        if (proxyUrl) {
            env.HTTPS_PROXY = proxyUrl;
            env.HTTP_PROXY = proxyUrl;
        }
    }
    if (!proxyUrl) return { enabled: false };

    env.NO_PROXY = mergeNoProxy(env.NO_PROXY || env.no_proxy);
    env.no_proxy = env.NO_PROXY;

    const { setGlobalDispatcher, EnvHttpProxyAgent } = require('undici');
    setGlobalDispatcher(new EnvHttpProxyAgent());
    if (log) log(`[proxy] Node fetch via ${source} proxy ${proxyUrl} (NO_PROXY=${env.NO_PROXY})`);
    return { enabled: true, proxyUrl, source, noProxy: env.NO_PROXY };
}

module.exports = {
    normalizeProxyUrl,
    parseWindowsProxyServer,
    mergeNoProxy,
    getEnvProxy,
    getLocalListeningProxy,
    getWindowsUserProxy,
    setupNodeFetchProxy,
};
