'use strict';

function parseIntOr(value, fallback) {
    const n = parseInt(value, 10);
    return Number.isFinite(n) && n >= 1 ? n : fallback;
}

function loadConfig(env = process.env) {
    return {
        chromePath: env.CHROME_PATH || null,
        httpsProxy: env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy || null,
        clientId: env.CLIENT_ID || null,
        clientSecret: env.CLIENT_SECRET || null,
        smsProvider: env.SMS_PROVIDER || 'hero-sms',
        heroSmsApiKey: env.HERO_SMS_API_KEY || null,
        maxSessions: parseIntOr(env.MAX_SESSIONS, 5),
        chromeDataRoot: env.CHROME_DATA_ROOT || '/tmp/stealth-chrome-mcp',
        keepBrowserOpen: (env.KEEP_BROWSER_OPEN || '').toLowerCase() === 'true',
        logLevel: env.LOG_LEVEL || 'info',
        logFile: env.LOG_FILE || null,
        basePort: parseIntOr(env.BASE_PORT, 9234),
    };
}

module.exports = { loadConfig };
