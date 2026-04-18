'use strict';

const path = require('path');
const fs = require('fs');
const { randomUUID } = require('crypto');
const { McpError, CODES } = require('../errors');

// Reach into common/ for proven Chrome launching
const COMMON_PATH = path.resolve(__dirname, '..', '..', '..', 'src', 'common');
const { launchRealChrome, findChrome, clearBrowserSession } = require(path.join(COMMON_PATH, 'chrome'));

function registerChromeTools({ registry, logger, config }) {
    const chromePath = config.chromePath || findChrome();
    if (!chromePath) throw new Error('Chrome not found; set CHROME_PATH');

    const tools = {};

    tools['chrome.launch'] = {
        schema: {
            type: 'object',
            properties: {
                dataDir: { type: 'string' },
                extraArgs: { type: 'array', items: { type: 'string' } },
                lang: { type: 'string', default: 'en-US' },
                viewport: { type: 'string', default: '1280,800' },
                proxy: { type: 'string' },
                tags: { type: 'object', additionalProperties: { type: 'string' } },
            },
        },
        async handler({ dataDir, extraArgs = [], lang, viewport, proxy, tags = {} } = {}) {
            if (proxy) extraArgs = [`--proxy-server=${proxy}`, ...extraArgs];
            const workerId = registry.list().length;
            const resolvedDataDir = dataDir
                || path.join(config.chromeDataRoot, `sess-${randomUUID().slice(0, 8)}`);
            fs.mkdirSync(resolvedDataDir, { recursive: true });

            let launched;
            try {
                launched = await launchRealChrome(chromePath, workerId, {
                    dataDir: resolvedDataDir, extraArgs, lang, viewport,
                    debugPort: config.basePort + workerId,
                });
            } catch (e) {
                throw new McpError(CODES.CHROME_LAUNCH_FAILED, `Chrome launch failed: ${e.message}`, { cause: e });
            }

            const sessionId = registry.create({
                workerId,
                browser: launched.browser,
                proc: launched.proc,
                dataDir: resolvedDataDir,
                debugPort: launched.debugPort,
                tags,
            });
            logger.info(`chrome.launch ok sessionId=${sessionId} port=${launched.debugPort}`);
            return { sessionId, debugPort: launched.debugPort, dataDir: resolvedDataDir };
        },
    };

    tools['chrome.close'] = {
        schema: { type: 'object', required: ['sessionId'], properties: { sessionId: { type: 'string' } } },
        async handler({ sessionId }) {
            const s = registry.get(sessionId);
            try { await s.browser.close(); } catch (_) {}
            try { s.proc.kill(); } catch (_) {}
            try { fs.rmSync(s.dataDir, { recursive: true, force: true }); } catch (_) {}
            registry.close(sessionId);
            logger.info(`chrome.close ok sessionId=${sessionId}`);
            return { ok: true };
        },
    };

    tools['chrome.list'] = {
        schema: { type: 'object', properties: {} },
        async handler() { return { sessions: registry.list() }; },
    };

    return tools;
}

module.exports = { registerChromeTools };
