'use strict';

const { McpError, CODES } = require('../errors');
const { getProvider } = require('../providers/sms');

function registerSmsTools({ logger, config }) {
    function resolveProvider(override) {
        try { return getProvider(override || config.smsProvider, config); }
        catch (e) { throw new McpError(CODES.SMS_PROVIDER_ERROR, e.message, { cause: e }); }
    }
    const tools = {};

    tools['sms.get_phone'] = {
        schema: {
            type: 'object', required: ['service', 'country'],
            properties: {
                service: { type: 'string' },
                country: { type: 'string' },
                provider: { type: 'string', description: 'Override default provider' },
            },
        },
        async handler({ service, country, provider }) {
            const p = resolveProvider(provider);
            try { return await p.getPhone({ service, country }); }
            catch (e) {
                if (/balance/i.test(e.message)) throw new McpError(CODES.SMS_BALANCE_INSUFFICIENT, e.message);
                throw new McpError(CODES.SMS_PROVIDER_ERROR, e.message, { cause: e });
            }
        },
    };

    tools['sms.wait_code'] = {
        schema: {
            type: 'object', required: ['activationId'],
            properties: {
                activationId: { type: 'string' },
                timeoutMs: { type: 'integer', default: 120000 },
                provider: { type: 'string' },
            },
        },
        async handler({ activationId, timeoutMs = 120000, provider }) {
            const p = resolveProvider(provider);
            try { return await p.waitCode({ activationId, timeoutMs }); }
            catch (e) {
                if (/timeout/i.test(e.message)) throw new McpError(CODES.SMS_TIMEOUT, e.message);
                throw new McpError(CODES.SMS_PROVIDER_ERROR, e.message, { cause: e });
            }
        },
    };

    tools['sms.cancel'] = {
        schema: {
            type: 'object', required: ['activationId'],
            properties: { activationId: { type: 'string' }, provider: { type: 'string' } },
        },
        async handler({ activationId, provider }) {
            const p = resolveProvider(provider);
            await p.cancel({ activationId });
            return { ok: true };
        },
    };

    return tools;
}

module.exports = { registerSmsTools };
