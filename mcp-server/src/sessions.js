'use strict';

const { randomUUID } = require('crypto');
const { McpError, CODES } = require('./errors');

class Mutex {
    constructor() { this._tail = Promise.resolve(); }
    acquire() {
        let release;
        const gate = new Promise(res => { release = res; });
        const prev = this._tail;
        this._tail = prev.then(() => gate);
        return prev.then(() => release);
    }
}

class SessionRegistry {
    constructor({ maxSessions = 5 } = {}) {
        this._sessions = new Map();
        this._mutexes = new Map();
        this.maxSessions = maxSessions;
    }

    create({ workerId, browser, proc, dataDir, debugPort, tags = {} }) {
        if (this._sessions.size >= this.maxSessions) {
            throw new McpError(CODES.CONCURRENCY_LIMIT_EXCEEDED,
                `active sessions (${this._sessions.size}) >= max (${this.maxSessions})`);
        }
        const sessionId = `sess_${randomUUID().slice(0, 12)}`;
        const session = { sessionId, workerId, browser, proc, dataDir, debugPort, tags, createdAt: Date.now() };
        this._sessions.set(sessionId, session);
        this._mutexes.set(sessionId, new Mutex());
        return sessionId;
    }

    get(sessionId) {
        const s = this._sessions.get(sessionId);
        if (!s) throw new McpError(CODES.SESSION_NOT_FOUND, `no such session: ${sessionId}`);
        return s;
    }

    close(sessionId) {
        this._sessions.delete(sessionId);
        this._mutexes.delete(sessionId);
    }

    list() {
        return Array.from(this._sessions.values()).map(s => ({
            sessionId: s.sessionId, tags: s.tags, createdAt: s.createdAt, debugPort: s.debugPort,
        }));
    }

    async withLock(sessionId, fn) {
        this.get(sessionId);
        const mutex = this._mutexes.get(sessionId);
        const release = await mutex.acquire();
        try { return await fn(); }
        finally { release(); }
    }

    async closeAll({ cleanup } = {}) {
        const ids = Array.from(this._sessions.keys());
        await Promise.all(ids.map(async (id) => {
            const s = this._sessions.get(id);
            if (cleanup && s) { try { await cleanup(s); } catch (_) {} }
            this.close(id);
        }));
    }
}

module.exports = { SessionRegistry, Mutex };
