'use strict';

const path = require('path');
const { McpError, CODES } = require('../errors');
const COMMON_PATH = path.resolve(__dirname, '..', '..', '..', 'src', 'common');
const totpMod = require(path.join(COMMON_PATH, 'totp'));

function registerTotpTools({ logger }) {
    return {
        'totp.generate': {
            schema: {
                type: 'object', required: ['secret'],
                properties: {
                    secret: { type: 'string' },
                    timestamp: { type: 'integer', description: '(test use) ms epoch; defaults to now' },
                },
            },
            async handler({ secret, timestamp }) {
                try {
                    // Prefer getTOTPWithTTL if available (returns both code + remaining seconds)
                    if (typeof totpMod.getTOTPWithTTL === 'function') {
                        const { code, remainingSeconds } = totpMod.getTOTPWithTTL(secret, timestamp);
                        return { code, validForS: remainingSeconds };
                    }
                    // Fallback: use generateTOTP and compute remaining seconds manually
                    const code = totpMod.generateTOTP(secret, timestamp);
                    const now = timestamp || Date.now();
                    const validForS = 30 - Math.floor(now / 1000) % 30;
                    return { code, validForS };
                } catch (e) {
                    throw new McpError(CODES.TOTP_INVALID_SECRET, e.message, { cause: e });
                }
            },
        },
    };
}

module.exports = { registerTotpTools };
