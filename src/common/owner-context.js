/**
 * Implicit owner context propagated through async boundaries.
 *
 * The orchestrator wraps its main() in `runWithOwner(WORKER_ID, ...)` so that
 * every downstream DB call inside stage 1 / 2 / 3 / reconcile can pull the
 * current install's owner_worker_id without having to thread it through ~15
 * function signatures and helper layers.
 *
 * DB modules call `currentOwnerId()` as a fallback when the explicit
 * `{ ownerId }` argument is omitted. Production code paths therefore work
 * three ways, in priority order:
 *   1. Explicit `{ ownerId: 'xyz' }` (routes that have app.workerId pass this)
 *   2. ALS-bound owner (orchestrator child process; set once at startup)
 *   3. Nothing → query is unfiltered (legacy behavior, used by tests)
 */
const { AsyncLocalStorage } = require('async_hooks');

const als = new AsyncLocalStorage();

function runWithOwner(ownerId, fn) {
    // Empty/null is allowed — same as not setting a context at all (legacy).
    return als.run({ ownerId: ownerId || null }, fn);
}

function currentOwnerId() {
    const store = als.getStore();
    return (store && store.ownerId) || null;
}

module.exports = { runWithOwner, currentOwnerId };
