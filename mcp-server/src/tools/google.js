'use strict';

const path = require('path');
const { McpError, CODES } = require('../errors');

const COMMON_PATH = path.resolve(__dirname, '..', '..', '..', 'src', 'common');
const { googleLogin } = require(path.join(COMMON_PATH, 'google-login'));

const REJECTED_URL_PATTERN = /\/v3\/signin\/rejected/;

function registerGoogleTools({ registry, logger, config }) {
    const tools = {};

    tools['google.login'] = {
        schema: {
            type: 'object',
            required: ['sessionId', 'account'],
            properties: {
                sessionId: { type: 'string' },
                account: {
                    type: 'object',
                    required: ['email', 'password'],
                    properties: {
                        email: { type: 'string' },
                        password: { type: 'string' },
                        totp_secret: { type: 'string' },
                        fa_secret: { type: 'string' },
                        recovery_email: { type: 'string' },
                    },
                },
                smsBehavior: { type: 'string', enum: ['auto', 'skip', 'manual'], default: 'auto' },
                timeoutMs: { type: 'integer', default: 180000 },
                startUrl: { type: 'string', default: 'https://accounts.google.com/signin' },
            },
        },
        async handler({ sessionId, account, smsBehavior = 'auto', timeoutMs = 180000, startUrl = 'https://accounts.google.com/signin' }) {
            return registry.withLock(sessionId, async () => {
                const s = registry.get(sessionId);
                const wlog = logger.child(`[${sessionId}]`);

                // Normalize: fa_secret is alias for totp_secret
                const effectiveAccount = {
                    ...account,
                    totp_secret: account.totp_secret || account.fa_secret,
                };

                // Determine smsProvider based on smsBehavior
                let smsProvider = null;
                if (smsBehavior === 'auto') {
                    try {
                        const { getProvider } = require('../providers/sms');
                        smsProvider = getProvider(config.smsProvider, config);
                    } catch (e) {
                        throw new McpError(CODES.SMS_PROVIDER_ERROR, `SMS provider '${config.smsProvider}' unavailable: ${e.message}`);
                    }
                } else if (smsBehavior === 'skip') {
                    smsProvider = {
                        getPhone: async () => { throw new Error('SMS skipped by smsBehavior=skip'); },
                        getCode: async () => { throw new Error('SMS skipped'); },
                        cancelSms: async () => {},
                        getNumberAndWaitCode: async () => { throw new Error('SMS skipped by smsBehavior=skip'); },
                    };
                } else if (smsBehavior === 'manual') {
                    smsProvider = null;  // googleLogin falls through to manual-wait mode
                }

                const page = await s.browser.newPage();

                // Rejected-page watcher: polls URL, short-circuits if rejected landing detected
                let rejected = false;
                const rejectWatcher = setInterval(() => {
                    try {
                        const url = page.url();
                        if (REJECTED_URL_PATTERN.test(url)) {
                            rejected = true;
                            page.emit('__mcp_rejected');
                        }
                    } catch (_) {}
                }, 750);

                try {
                    await page.goto(startUrl, { waitUntil: 'domcontentloaded', timeout: 30000 })
                        .catch(e => wlog.warn(`signin nav: ${e.message}`));

                    const loginPromise = googleLogin(page, effectiveAccount, wlog, { smsProvider });
                    const rejectPromise = new Promise((_, rej) => {
                        page.once('__mcp_rejected', () => rej(new McpError(CODES.GOOGLE_LOGIN_REJECTED,
                            'Google rejected signin: "Couldn\'t sign you in"')));
                    });
                    const timeoutPromise = new Promise((_, rej) => setTimeout(
                        () => rej(new McpError(CODES.TIMEOUT, `login timed out after ${timeoutMs}ms`)),
                        timeoutMs));

                    try {
                        await Promise.race([loginPromise, rejectPromise, timeoutPromise]);
                    } catch (e) {
                        if (e instanceof McpError) {
                            const screenshot = await captureBase64Screenshot(page).catch(() => null);
                            return {
                                status: e.code === CODES.GOOGLE_LOGIN_REJECTED ? 'rejected' : 'timeout',
                                finalUrl: page.url(),
                                stateHistory: [],
                                screenshot,
                            };
                        }
                        if (/deadloop|stuck/i.test(e.message || '')) {
                            const screenshot = await captureBase64Screenshot(page).catch(() => null);
                            return { status: 'stuck', finalUrl: page.url(), stateHistory: [], screenshot };
                        }
                        throw e;
                    }

                    return { status: 'ok', finalUrl: page.url(), stateHistory: [] };
                } finally {
                    clearInterval(rejectWatcher);
                    await page.close().catch(() => {});
                }
            });
        },
    };

    return tools;
}

async function captureBase64Screenshot(page) {
    const buf = await page.screenshot({ type: 'png' });
    return buf.toString('base64');
}

module.exports = { registerGoogleTools };
