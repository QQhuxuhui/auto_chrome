'use strict';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

function createLogger(level = 'info', { prefix = '' } = {}) {
    const threshold = LEVELS[level] || LEVELS.info;
    function write(lvl, args) {
        // `success` is an info-level annotation (matches common/logger.js createWorkerLogger),
        // threshold-gated as info.
        const effLvl = lvl === 'success' ? 'info' : lvl;
        if (LEVELS[effLvl] < threshold) return;
        const ts = new Date().toISOString();
        const tag = `[${ts}][${lvl.toUpperCase()}]${prefix ? ' ' + prefix : ''}`;
        const msg = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ');
        process.stderr.write(`${tag} ${msg}\n`);
    }
    return {
        debug: (...a) => write('debug', a),
        info: (...a) => write('info', a),
        warn: (...a) => write('warn', a),
        error: (...a) => write('error', a),
        // common/google-login.js calls wlog.success(...) — match common/logger.js interface.
        success: (...a) => write('success', a),
        child: (childPrefix) => createLogger(level, { prefix: `${prefix} ${childPrefix}`.trim() }),
    };
}

module.exports = { createLogger };
