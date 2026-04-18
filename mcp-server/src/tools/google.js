'use strict';

const path = require('path');
const { McpError, CODES } = require('../errors');

const COMMON_PATH = path.resolve(__dirname, '..', '..', '..', 'src', 'common');
const { googleLogin } = require(path.join(COMMON_PATH, 'google-login'));

// Fix 5: broaden pattern to match v3/signin/rejected, signin/v2/rejected, signin/rejected/...
const REJECTED_URL_PATTERN = /\/signin\/[^?]*rejected/;

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
        // Returns: { status: 'ok'|'rejected'|'timeout'|'stuck'|'sms_needed', finalUrl, stateHistory, screenshot? }
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
                // Fix 1: fall back to common/sms when providers/sms module not yet present
                if (smsBehavior === 'auto') {
                    try {
                        const { getProvider } = require('../providers/sms');
                        smsProvider = getProvider(config.smsProvider, config);
                    } catch (e) {
                        // providers/sms module doesn't exist yet — fall back to common/sms directly
                        // (same module google-login.js lazy-loads by default).
                        if (e.code === 'MODULE_NOT_FOUND') {
                            smsProvider = require(path.join(COMMON_PATH, 'sms'));
                        } else {
                            throw new McpError(CODES.SMS_PROVIDER_ERROR, `SMS provider '${config.smsProvider}' unavailable: ${e.message}`);
                        }
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

                // Fix 4: remove dead `rejected` boolean — only emit event
                const rejectWatcher = setInterval(() => {
                    try {
                        const url = page.url();
                        if (REJECTED_URL_PATTERN.test(url)) {
                            page.emit('__mcp_rejected');
                        }
                    } catch (_) {}
                }, 750);

                try {
                    await page.goto(startUrl, { waitUntil: 'domcontentloaded', timeout: 30000 })
                        .catch(e => wlog.warn(`signin nav: ${e.message}`));

                    // Fix 3: clearTimeout + swallow losing promise to avoid leaks
                    let timeoutId;
                    const timeoutPromise = new Promise((_, rej) => {
                        timeoutId = setTimeout(() => rej(new McpError(CODES.TIMEOUT, `login timed out after ${timeoutMs}ms`)), timeoutMs);
                    });
                    const loginPromise = googleLogin(page, effectiveAccount, wlog, { smsProvider });
                    // Attach noop catcher so losing promise doesn't become unhandled rejection
                    loginPromise.catch(() => {});

                    const rejectPromise = new Promise((_, rej) => {
                        // Fix: no escaped apostrophe — write it directly
                        page.once('__mcp_rejected', () => rej(new McpError(CODES.GOOGLE_LOGIN_REJECTED,
                            "Google rejected signin: \"Couldn't sign you in\"")));
                    });

                    try {
                        await Promise.race([loginPromise, rejectPromise, timeoutPromise]);
                    } catch (e) {
                        // Fix 2: map "SMS skipped" to status sms_needed per spec §5.6
                        if (/SMS skipped/.test(e.message || '')) {
                            const screenshot = await captureBase64Screenshot(page).catch(() => null);
                            return { status: 'sms_needed', finalUrl: page.url(), stateHistory: [], screenshot };
                        }
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
                    } finally {
                        clearTimeout(timeoutId);
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
