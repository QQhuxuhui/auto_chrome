/**
 * Process liveness check used by the run reaper.
 *
 * `process.kill(pid, 0)` is the POSIX way to "send signal 0" — it doesn't
 * actually deliver anything, just probes. ESRCH = no such process; EPERM =
 * process exists but signaling it is forbidden (different uid). We treat
 * EPERM as alive to avoid wrongly reaping a foreign-owned orchestrator that
 * a sysadmin started.
 *
 * Linux pid recycling is a known caveat: if the OS already reused this pid
 * for an unrelated process, this returns true. Acceptable risk — at worst
 * the zombie row stays for one more reap cycle, which the user can clear
 * via the cancel button (which now also runs this check).
 */
function isPidAlive(pid) {
    if (!pid || !Number.isFinite(Number(pid))) return false;
    try {
        process.kill(Number(pid), 0);
        return true;
    } catch (e) {
        if (e && e.code === 'EPERM') return true;
        return false;
    }
}

module.exports = { isPidAlive };
