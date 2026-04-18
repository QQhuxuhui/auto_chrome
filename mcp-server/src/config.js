'use strict';

function parseIntOr(value, fallback, { name } = {}) {
    if (value === undefined || value === null || value === '') return fallback;
    if (!/^-?\d+$/.test(String(value).trim())) {
        throw new Error(`Invalid integer for ${name || 'env var'}: ${JSON.stringify(value)}`);
    }
    const n = Number(value);
    if (n < 1) throw new Error(`${name || 'value'} must be >= 1, got ${n}`);
    return n;
}

function parseBool(value, fallback) {
    if (value === undefined || value === null || value === '') return fallback;
    const v = String(value).trim().toLowerCase();
    if (['true', '1', 'yes', 'on'].includes(v)) return true;
    if (['false', '0', 'no', 'off'].includes(v)) return false;
    throw new Error(`Invalid boolean value: ${JSON.stringify(value)}`);
}

function loadConfig(env = process.env) {
    return {
        chromePath: env.CHROME_PATH || null,
        httpsProxy: env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy || null,
        clientId: env.CLIENT_ID || null,
        clientSecret: env.CLIENT_SECRET || null,
        smsProvider: env.SMS_PROVIDER || 'hero-sms',
        heroSmsApiKey: env.HERO_SMS_API_KEY || null,
        maxSessions: parseIntOr(env.MAX_SESSIONS, 5, { name: 'MAX_SESSIONS' }),
        chromeDataRoot: env.CHROME_DATA_ROOT || '/tmp/stealth-chrome-mcp',
        keepBrowserOpen: parseBool(env.KEEP_BROWSER_OPEN, false),
        logLevel: env.LOG_LEVEL || 'info',
        logFile: env.LOG_FILE || null,
        basePort: parseIntOr(env.BASE_PORT, 9234, { name: 'BASE_PORT' }),
    };
}

function validateConfig(cfg) {
    if (cfg.smsProvider === 'hero-sms' && !cfg.heroSmsApiKey) {
        throw new Error('HERO_SMS_API_KEY env is required when SMS_PROVIDER=hero-sms');
    }
}

module.exports = { loadConfig, validateConfig };
