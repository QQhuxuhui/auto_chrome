'use strict';

const path = require('path');
const { McpError, CODES } = require('../errors');

const COMMON_PATH = path.resolve(__dirname, '..', '..', '..', 'src', 'common');
const { exchangeCode } = require(path.join(COMMON_PATH, 'oauth'));

function registerOauthTools({ logger, config }) {
    const tools = {};

    tools['oauth.exchange_code'] = {
        schema: {
            type: 'object',
            required: ['code', 'redirectUri'],
            properties: {
                code: { type: 'string' },
                clientId: { type: 'string', description: 'Falls back to env CLIENT_ID when omitted' },
                clientSecret: { type: 'string', description: 'Falls back to env CLIENT_SECRET when omitted' },
                redirectUri: { type: 'string' },
            },
        },
        async handler({ code, clientId, clientSecret, redirectUri }) {
            const effClientId = clientId || config.clientId;
            const effClientSecret = clientSecret || config.clientSecret;
            if (!effClientId || !effClientSecret) {
                throw new McpError(
                    CODES.PRECONDITION_FAILED,
                    'clientId/clientSecret missing (pass as args or set CLIENT_ID/CLIENT_SECRET env)'
                );
            }
            try {
                const tokens = await exchangeCode({
                    code,
                    clientId: effClientId,
                    clientSecret: effClientSecret,
                    redirectUri,
                });
                return {
                    accessToken: tokens.access_token,
                    refreshToken: tokens.refresh_token,
                    expiresIn: tokens.expires_in,
                    scope: tokens.scope,
                    idToken: tokens.id_token,
                    tokenType: tokens.token_type || 'Bearer',
                };
            } catch (e) {
                throw new McpError(CODES.OAUTH_TOKEN_EXCHANGE_FAILED, e.message, { cause: e });
            }
        },
    };

    return tools;
}

module.exports = { registerOauthTools };
