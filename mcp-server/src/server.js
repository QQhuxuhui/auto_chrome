'use strict';

const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { CallToolRequestSchema, ListToolsRequestSchema } = require('@modelcontextprotocol/sdk/types.js');

const { loadConfig, validateConfig } = require('./config');
const { createLogger } = require('./logger');
const { SessionRegistry } = require('./sessions');
const { McpError, CODES } = require('./errors');
const { registerChromeTools } = require('./tools/chrome');
const { registerGoogleTools } = require('./tools/google');
const { registerOauthTools } = require('./tools/oauth');

// Configure Node fetch to honor HTTPS_PROXY (matches 3_local_oauth.js pattern)
{
    const cfg = loadConfig();
    if (cfg.httpsProxy) {
        const { setGlobalDispatcher, ProxyAgent } = require('undici');
        setGlobalDispatcher(new ProxyAgent(cfg.httpsProxy));
    }
}

async function startServer() {
    const config = loadConfig();
    const logger = createLogger(config.logLevel);

    // Optional cross-field validation (e.g., hero-sms requires key)
    try { validateConfig(config); }
    catch (e) { logger.warn(`config validation: ${e.message} (continuing, tools may fail at call time)`); }

    const registry = new SessionRegistry({ maxSessions: config.maxSessions });

    const tools = {
        ...registerChromeTools({ registry, logger, config }),
        ...registerGoogleTools({ registry, logger, config }),
        ...registerOauthTools({ logger, config }),
    };

    const server = new Server(
        { name: 'stealth-chrome-mcp', version: '0.1.0' },
        { capabilities: { tools: {} } },
    );

    server.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: Object.entries(tools).map(([name, t]) => ({
            name,
            description: t.description || '',
            inputSchema: t.schema,
        })),
    }));

    server.setRequestHandler(CallToolRequestSchema, async (req) => {
        const tool = tools[req.params.name];
        if (!tool) throw new Error(`Unknown tool: ${req.params.name}`);
        try {
            const result = await tool.handler(req.params.arguments || {});
            return { content: [{ type: 'text', text: JSON.stringify(result) }] };
        } catch (e) {
            const code = e instanceof McpError ? e.code : 'INTERNAL_ERROR';
            logger.warn(`tool ${req.params.name} failed: ${code}: ${e.message}`);
            throw new Error(`${code}: ${e.message}`);
        }
    });

    const shutdown = async () => {
        logger.info('shutting down, closing sessions...');
        await registry.closeAll({
            cleanup: async (s) => {
                try { await s.browser.close(); } catch (_) {}
                try { s.proc && s.proc.kill(); } catch (_) {}
            },
        });
        process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
    process.on('uncaughtException', (e) => {
        logger.error('uncaughtException:', e.stack || e.message);
        shutdown();
    });

    const transport = new StdioServerTransport();
    await server.connect(transport);
    logger.info(`stealth-chrome-mcp ready (maxSessions=${config.maxSessions})`);
}

module.exports = { startServer };
