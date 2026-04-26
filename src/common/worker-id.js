/**
 * Per-install worker identity.
 *
 * Multiple users share the cloud DB; each install needs a stable identifier
 * so that pipeline_runs rows can be partitioned per machine. Without this,
 * one user's "running" row blocks another user's startup, and cross-machine
 * pid checks would lie about liveness (pid 12345 alive on machine A means
 * nothing on machine B).
 *
 * The id is a UUID written once to ~/.auto_chrome/worker_id.json and read
 * thereafter. The label defaults to os.hostname() so the UI can show a
 * human-friendly name without leaking the UUID.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

function configDir() {
    // ~/.auto_chrome on POSIX, %USERPROFILE%/.auto_chrome on Windows. Stays
    // out of the repo so reinstalling the app preserves identity.
    return path.join(os.homedir(), '.auto_chrome');
}

function configPath() {
    return path.join(configDir(), 'worker_id.json');
}

let _cached = null;

function loadOrCreateWorkerIdentity() {
    if (_cached) return _cached;

    const dir = configDir();
    const file = configPath();

    // Best-effort read. Corrupt file → regenerate; we never want a parse
    // failure to take down the server, identity loss is recoverable.
    try {
        if (fs.existsSync(file)) {
            const raw = fs.readFileSync(file, 'utf8');
            const obj = JSON.parse(raw);
            if (obj && typeof obj.workerId === 'string' && obj.workerId.length >= 8) {
                _cached = {
                    workerId: obj.workerId,
                    workerLabel: typeof obj.workerLabel === 'string' && obj.workerLabel
                        ? obj.workerLabel
                        : os.hostname() || 'unknown-host',
                };
                return _cached;
            }
        }
    } catch (_) { /* fall through to regen */ }

    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }

    const fresh = {
        workerId: crypto.randomUUID(),
        workerLabel: os.hostname() || 'unknown-host',
    };
    fs.writeFileSync(file, JSON.stringify(fresh, null, 2));
    _cached = fresh;
    return _cached;
}

function getWorkerId() {
    return loadOrCreateWorkerIdentity().workerId;
}

function getWorkerLabel() {
    return loadOrCreateWorkerIdentity().workerLabel;
}

module.exports = {
    loadOrCreateWorkerIdentity,
    getWorkerId,
    getWorkerLabel,
    configPath,
};
