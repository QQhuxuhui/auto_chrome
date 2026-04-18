'use strict';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

function createLogger(level = 'info', { prefix = '' } = {}) {
    const threshold = LEVELS[level] || LEVELS.info;
    function write(lvl, args) {
        if (LEVELS[lvl] < threshold) return;
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
        child: (childPrefix) => createLogger(level, { prefix: `${prefix} ${childPrefix}`.trim() }),
    };
}

module.exports = { createLogger };
