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

                // Normalize field names. common/google-login.js uses:
                //   account.pass         — password (NOT `password`)
                //   account.totp_secret  — base32 secret (also accepts fa_secret alias)
                // MCP schema exposes `password` for caller ergonomics; map it here.
                const effectiveAccount = {
                    ...account,
                    pass: account.pass || account.password,
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
                    // Let the signin page settle before googleLogin's state machine starts
                    // probing. Matches auto_chrome/src/3_local_oauth.js processMember timing.
                    await new Promise(res => setTimeout(res, 1000));

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
                        if (/wrong password|incorrect password|密码错误|无法让您登录/i.test(e.message || '')) {
                            const screenshot = await captureBase64Screenshot(page).catch(() => null);
                            return {
                                status: 'rejected',
                                reason: 'wrong_password',
                                finalUrl: page.url(),
                                stateHistory: [],
                                screenshot,
                                error: e.message,
                            };
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

    tools['google.oauth_get_code'] = {
        schema: {
            type: 'object',
            required: ['sessionId', 'scopes'],
            properties: {
                sessionId: { type: 'string' },
                clientId: { type: 'string', description: 'Falls back to env CLIENT_ID' },
                scopes: { type: 'array', items: { type: 'string' } },
                callbackPortStart: { type: 'integer', default: 18900 },
                handleConsent: { type: 'boolean', default: true, description: 'Auto-click consent + handle TOTP re-challenge' },
                account: {
                    type: 'object',
                    description: 'handleConsent=true needs account for TOTP secret and email matching',
                    properties: {
                        email: { type: 'string' },
                        totp_secret: { type: 'string' },
                        fa_secret: { type: 'string' },
                    },
                },
                timeoutMs: { type: 'integer', default: 120000 },
            },
        },
        async handler({ sessionId, clientId, scopes, callbackPortStart = 18900, handleConsent = true, account, timeoutMs = 120000 }) {
            const { buildAuthUrl, startCbServer } = require(path.join(COMMON_PATH, 'oauth'));
            // Consent helpers live in 3_sub2api.js
            const sub2apiPath = path.resolve(COMMON_PATH, '..', '3_sub2api');
            const { clickOAuthConsentTarget, handleTotpChallenge } = require(sub2apiPath);

            return registry.withLock(sessionId, async () => {
                const s = registry.get(sessionId);
                const wlog = logger.child(`[${sessionId}]`);
                const effClientId = clientId || config.clientId;
                if (!effClientId) {
                    throw new McpError(CODES.PRECONDITION_FAILED, 'clientId missing (pass arg or set env CLIENT_ID)');
                }
                // Normalize account (fa_secret → totp_secret)
                const effAccount = account
                    ? { ...account, totp_secret: account.totp_secret || account.fa_secret }
                    : null;

                const cbServer = await startCbServer(callbackPortStart, wlog);
                const redirectUri = `http://localhost:${cbServer.port}/callback`;

                try {
                    const authUrl = buildAuthUrl({ clientId: effClientId, scopes, port: cbServer.port });
                    const page = await s.browser.newPage();
                    try {
                        // Fire navigation; don't await — consent driven from the poller below
                        page.goto(authUrl, { waitUntil: 'domcontentloaded', timeout: 60000 })
                            .catch(e => wlog.debug(`authUrl goto: ${e.message}`));

                        // Consent poller
                        let keepPolling = true;
                        const poller = (async () => {
                            // Initial delay so the page has time to render consent UI
                            await new Promise(res => setTimeout(res, 2500));
                            let ticks = 0;
                            while (keepPolling && handleConsent) {
                                ticks++;
                                try {
                                    if (effAccount) {
                                        const totpHandled = await handleTotpChallenge(page, effAccount, wlog);
                                        if (totpHandled) { await new Promise(res => setTimeout(res, 4000)); continue; }
                                    }
                                    const hit = effAccount
                                        ? await clickOAuthConsentTarget(page, effAccount.email)
                                        : null;
                                    if (hit) {
                                        wlog.debug(`[consent] click (#${ticks}): ${hit}`);
                                        await new Promise(res => setTimeout(res, 2500));
                                        continue;
                                    }
                                } catch (_) { /* keep polling */ }
                                await new Promise(res => setTimeout(res, 1500));
                            }
                        })();
                        poller.catch(() => {});

                        // Race callback capture against timeout
                        let timeoutId;
                        const timeoutP = new Promise((_, rej) => {
                            timeoutId = setTimeout(
                                () => rej(new McpError(CODES.OAUTH_CODE_NOT_RECEIVED, `no callback within ${timeoutMs}ms`)),
                                timeoutMs,
                            );
                        });

                        let result;
                        try {
                            result = await Promise.race([cbServer.codePromise, timeoutP]);
                        } finally {
                            clearTimeout(timeoutId);
                            keepPolling = false;
                        }

                        if (result.error) {
                            throw new McpError(CODES.OAUTH_CODE_NOT_RECEIVED, `oauth denied: ${result.error}`);
                        }
                        if (!result.code) {
                            throw new McpError(CODES.OAUTH_CODE_NOT_RECEIVED, 'callback received but no code field');
                        }
                        return { code: result.code, redirectUri };
                    } finally {
                        await page.close().catch(() => {});
                    }
                } finally {
                    try { cbServer.server.close(); } catch (_) {}
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
