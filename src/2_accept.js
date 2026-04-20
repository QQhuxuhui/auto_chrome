/**
 * 2_accept.js — historical entrypoint.
 *
 * The implementation now lives in src/stages/accept/. This file is a shim
 * preserving require('./2_accept') compatibility for orchestrator.js and
 * any callers that haven't been updated.
 */
module.exports = require('./stages/accept');

// CLI entry — delegate to stages/accept when run directly. Note: unlike
// 1_invite / 3_local_oauth, this shim does not install SIGINT/SIGTERM
// cleanup — when invoked via orchestrator (primary path) the parent
// forwards signals to the child; direct CLI invocation is dev-only.
if (require.main === module) {
    const { runStage2 } = require('./stages/accept');
    let cli_concurrency = parseInt(process.env.CONCURRENCY, 10) || 1;
    const argv_ = process.argv.slice(2);
    for (let i = 0; i < argv_.length; i++) {
        if ((argv_[i] === '--concurrency' || argv_[i] === '-c') && argv_[i + 1]) {
            cli_concurrency = parseInt(argv_[i + 1], 10) || cli_concurrency;
        }
    }
    runStage2({ runId: null, concurrency: cli_concurrency })
        .then(() => process.exit(0))
        .catch((e) => { console.error(e.stack || e.message); process.exit(1); });
}
