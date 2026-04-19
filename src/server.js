/**
 * Fastify server — local account management UI + API.
 * Bind to 127.0.0.1 only (no auth).
 */
require('dotenv').config({ path: require('path').resolve(__dirname, '..', '.env') });
const path = require('path');
const Fastify = require('fastify');

const PORT = parseInt(process.env.SERVER_PORT, 10) || 3000;
const HOST = process.env.SERVER_HOST || '127.0.0.1';

async function build() {
    const app = Fastify({
        logger: { level: 'info' },
        disableRequestLogging: false,
    });

    await app.register(require('@fastify/static'), {
        root: path.resolve(__dirname, '..', 'public'),
        prefix: '/public/',
    });

    await app.register(require('./routes/hosts'));
    await app.register(require('./routes/members'));
    await app.register(require('./routes/status'));
    await app.register(require('./routes/pipeline'));
    await app.register(require('./routes/migrate'));
    await app.register(require('./routes/ops'));
    await app.register(require('./routes/antigravity'));

    app.get('/', async (_req, reply) => reply.sendFile('index.html'));
    app.get('/accounts', async (_req, reply) => reply.sendFile('accounts.html'));
    app.get('/runs', async (_req, reply) => reply.sendFile('runs.html'));

    app.get('/api/ping', async () => ({ ok: true, ts: new Date().toISOString() }));

    // Routes will be registered in subsequent tasks.

    app.setErrorHandler((err, _req, reply) => {
        app.log.error(err);
        const code = err.statusCode && err.statusCode >= 400 ? err.statusCode : 500;
        reply.code(code).send({ error: err.message });
    });

    return app;
}

async function start() {
    const app = await build();
    try {
        await app.listen({ port: PORT, host: HOST });

        // Antigravity 定时 sync (set SYNC_INTERVAL_MS=0 to disable)
        const SYNC_MS = parseInt(process.env.SYNC_INTERVAL_MS, 10);
        if (SYNC_MS === 0) {
            app.log.info('Antigravity scheduled sync disabled (SYNC_INTERVAL_MS=0)');
        } else {
            const ms = Number.isFinite(SYNC_MS) && SYNC_MS > 0 ? SYNC_MS : 5 * 60 * 1000;
            const sync = require('./sync/antigravity-sync');
            setInterval(() => {
                sync.syncFromRemote()
                    .then(r => app.log.info({ event: 'antigravity-sync', ...r }, `antigravity sync: matched=${r.matched} orphans=${r.orphans.length}`))
                    .catch(e => app.log.warn({ err: e.message }, 'antigravity scheduled sync failed'));
            }, ms).unref();
            app.log.info(`Antigravity scheduled sync every ${ms}ms`);
        }

        app.log.info(`HTTP ready on http://${HOST}:${PORT}`);
    } catch (e) {
        app.log.error(e);
        process.exit(1);
    }
}

if (require.main === module) start();

module.exports = { build };
