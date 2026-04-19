'use strict';

const path = require('path');
const COMMON_PATH = path.resolve(__dirname, '..', '..', '..', '..', 'src', 'common');
const heroSms = require(path.join(COMMON_PATH, 'sms'));

/**
 * Create a hero-sms SmsProvider that adapts common/sms.js to the MCP
 * provider interface ({getPhone, waitCode, cancel}).
 *
 * common/sms.js only exposes getNumberAndWaitCode (combined call), so we
 * use the fallback strategy: getPhone kicks off the combined call and stashes
 * the promise; waitCode resolves it; cancel drops it.
 *
 * getNumberAndWaitCode is also exposed as a pass-through for google-login.js
 * which calls smsProvider.getNumberAndWaitCode({service, country}) directly.
 */
function create(config) {
    if (!config.heroSmsApiKey) {
        throw new Error('HERO_SMS_API_KEY env required for hero-sms provider');
    }
    // common/sms.js reads HERO_SMS_API_KEY from env internally — no extra wiring needed.

    const pending = new Map();

    return {
        name: 'hero-sms',

        // Pass-through for google-login.js which calls getNumberAndWaitCode directly
        getNumberAndWaitCode: heroSms.getNumberAndWaitCode.bind(heroSms),

        async getPhone({ service, country }) {
            // Kick off the combined call; stash promise for waitCode to await.
            const id = `hero_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
            const p = heroSms.getNumberAndWaitCode({ service, country });
            pending.set(id, p);
            // We don't have the number synchronously — return activationId only.
            // Callers needing the number up-front should use getNumberAndWaitCode.
            return { number: null, activationId: id };
        },

        async waitCode({ activationId, timeoutMs = 120000 }) {
            const p = pending.get(activationId);
            if (!p) throw new Error(`unknown activationId: ${activationId}`);
            const race = Promise.race([
                p,
                new Promise((_, rej) => setTimeout(
                    () => rej(new Error(`SMS_TIMEOUT after ${timeoutMs}ms`)), timeoutMs,
                )),
            ]);
            try {
                const res = await race;
                pending.delete(activationId);
                return { code: res.code || res };
            } catch (e) {
                pending.delete(activationId);
                throw e;
            }
        },

        async cancel({ activationId }) {
            pending.delete(activationId);
            // Combined API has no direct cancel — best effort; actual hero-sms
            // rental may still burn the slot until it expires.
        },
    };
}

module.exports = { create };
