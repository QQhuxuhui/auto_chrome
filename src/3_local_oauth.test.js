const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const {
    buildAuthUrl,
    startCbServer,
    upsertCredential,
    findCredentialByName,
    probeAntigravity,
    CLIENT_ID,
    SCOPES,
    CRED_FILE,
} = require('./3_local_oauth');

// ============ buildAuthUrl ============

test('buildAuthUrl: contains all required OAuth params', () => {
    const url = buildAuthUrl(19000);
    assert.ok(url.includes(`client_id=${encodeURIComponent(CLIENT_ID)}`), 'client_id');
    assert.ok(url.includes('redirect_uri=http%3A%2F%2Flocalhost%3A19000%2Fcallback'), 'redirect_uri');
    assert.ok(url.includes('response_type=code'), 'response_type');
    assert.ok(url.includes('access_type=offline'), 'access_type');
    assert.ok(url.includes('prompt=consent'), 'prompt');
});

test('buildAuthUrl: includes antigravity scopes (cclog + experimentsandconfigs)', () => {
    const url = decodeURIComponent(buildAuthUrl(19000));
    assert.ok(url.includes('auth/cclog'), 'cclog scope');
    assert.ok(url.includes('auth/experimentsandconfigs'), 'experimentsandconfigs scope');
    assert.ok(url.includes('auth/cloud-platform'), 'cloud-platform scope');
});

test('buildAuthUrl: different ports produce different redirect_uri', () => {
    const a = buildAuthUrl(19000);
    const b = buildAuthUrl(19001);
    assert.notStrictEqual(a, b);
    assert.ok(a.includes('19000'));
    assert.ok(b.includes('19001'));
});

// ============ getNextCbPort (via module internals — test port wrap indirectly) ============
// Port wrap logic is tested by requiring the module and checking behavior is correct.
// Since getNextCbPort isn't exported, we verify the contract through startCbServer.

test('startCbServer: binds and receives callback code', async () => {
    const cb = await startCbServer(19800);
    try {
        assert.ok(cb.port >= 19800);
        assert.ok(cb.server.listening);
        // Simulate Google redirect
        const resp = await fetch(`http://localhost:${cb.port}/callback?code=test_abc_123`);
        assert.strictEqual(resp.status, 200);
        const result = await cb.codePromise;
        assert.strictEqual(result.code, 'test_abc_123');
    } finally {
        cb.server.close();
    }
});

test('startCbServer: captures error param', async () => {
    const cb = await startCbServer(19810);
    try {
        await fetch(`http://localhost:${cb.port}/callback?error=access_denied`);
        const result = await cb.codePromise;
        assert.strictEqual(result.error, 'access_denied');
    } finally {
        cb.server.close();
    }
});

test('startCbServer: retries next port when first is occupied', async () => {
    // Occupy a port
    const blocker = http.createServer();
    await new Promise((res, rej) => {
        blocker.listen(19820, res);
        blocker.on('error', rej);
    });
    try {
        const cb = await startCbServer(19820);
        try {
            assert.ok(cb.port > 19820, `expected port > 19820, got ${cb.port}`);
            assert.ok(cb.server.listening);
        } finally {
            cb.server.close();
        }
    } finally {
        blocker.close();
    }
});

// ============ upsertCredential + findCredentialByName ============

// Use a temp file for isolation
function withTempCredFile(fn) {
    return async () => {
        const tmp = path.join(os.tmpdir(), `cred_test_${Date.now()}_${Math.random().toString(36).slice(2)}.json`);
        // Monkey-patch CRED_FILE for the module — we need to reach into the module's internals.
        // Since CRED_FILE is a const string, we patch the underlying functions via a fresh require approach.
        // Instead, write directly and test upsertCredential's file I/O by temporarily pointing env var.
        const origEnv = process.env.CRED_FILE;
        process.env.CRED_FILE = tmp;
        try {
            // Re-require module to pick up new CRED_FILE
            delete require.cache[require.resolve('./3_local_oauth')];
            const mod = require('./3_local_oauth');
            await fn(mod, tmp);
        } finally {
            process.env.CRED_FILE = origEnv || '';
            delete require.cache[require.resolve('./3_local_oauth')];
            try { fs.unlinkSync(tmp); } catch (_) { }
        }
    };
}

test('upsertCredential: inserts new credential', withTempCredFile(async (mod, tmp) => {
    const cred = { name: 'ultra_host_member1', email: 'member1@test.com', refresh_token: 'rt1' };
    const r = await mod.upsertCredential(cred);
    assert.strictEqual(r.total, 1);
    assert.strictEqual(r.updated, false);
    const stored = JSON.parse(fs.readFileSync(tmp, 'utf-8'));
    assert.strictEqual(stored.length, 1);
    assert.strictEqual(stored[0].name, 'ultra_host_member1');
}));

test('upsertCredential: updates existing by name', withTempCredFile(async (mod, tmp) => {
    await mod.upsertCredential({ name: 'ultra_h_m', email: 'a@b', refresh_token: 'old' });
    const r = await mod.upsertCredential({ name: 'ultra_h_m', email: 'a@b', refresh_token: 'new' });
    assert.strictEqual(r.total, 1);
    assert.strictEqual(r.updated, true);
    const stored = JSON.parse(fs.readFileSync(tmp, 'utf-8'));
    assert.strictEqual(stored[0].refresh_token, 'new');
}));

test('upsertCredential: multiple distinct names', withTempCredFile(async (mod, tmp) => {
    await mod.upsertCredential({ name: 'a', email: 'a@x', refresh_token: '1' });
    await mod.upsertCredential({ name: 'b', email: 'b@x', refresh_token: '2' });
    const r = await mod.upsertCredential({ name: 'c', email: 'c@x', refresh_token: '3' });
    assert.strictEqual(r.total, 3);
    assert.strictEqual(r.updated, false);
}));

test('findCredentialByName: returns null for missing', withTempCredFile(async (mod) => {
    const found = mod.findCredentialByName('nonexistent');
    assert.strictEqual(found, null);
}));

test('findCredentialByName: returns match after insert', withTempCredFile(async (mod) => {
    await mod.upsertCredential({ name: 'ultra_h_m', email: 'x@y', refresh_token: 'rt' });
    const found = mod.findCredentialByName('ultra_h_m');
    assert.strictEqual(found.email, 'x@y');
}));

// ============ probeAntigravity (with mock server) ============

function startMockAntigravity(handler) {
    return new Promise((resolve) => {
        const server = http.createServer(handler);
        server.listen(0, () => {
            resolve({ server, port: server.address().port });
        });
    });
}

test('probeAntigravity: returns ok on 200', async () => {
    const mock = await startMockAntigravity((req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.end('data: {"candidates":[{"content":{"parts":[{"text":"hi"}]}}]}\n\n');
    });
    try {
        // Override base URL via env — need re-require
        const origBase = process.env.ANTIGRAVITY_BASE_URL;
        process.env.ANTIGRAVITY_BASE_URL = `http://localhost:${mock.port}`;
        delete require.cache[require.resolve('./3_local_oauth')];
        const mod = require('./3_local_oauth');
        const result = await mod.probeAntigravity('fake_token', 'proj123');
        assert.strictEqual(result.ok, true);
        assert.strictEqual(result.validationUrl, null);
        process.env.ANTIGRAVITY_BASE_URL = origBase || '';
        delete require.cache[require.resolve('./3_local_oauth')];
    } finally {
        mock.server.close();
    }
});

test('probeAntigravity: extracts validationUrl from 403', async () => {
    const validationUrl = 'https://accounts.google.com/signin/continue?sarp=1&continue=https://developers.google.com/gemini-code-assist/auth/auth_success_gemini';
    const body403 = JSON.stringify({
        error: {
            code: 403,
            message: 'Verify your account to continue.',
            status: 'PERMISSION_DENIED',
            details: [{
                '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
                reason: 'VALIDATION_REQUIRED',
                domain: 'cloudcode-pa.googleapis.com',
                metadata: { validation_url: validationUrl },
            }],
        },
    });
    const mock = await startMockAntigravity((req, res) => {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(body403);
    });
    try {
        const origBase = process.env.ANTIGRAVITY_BASE_URL;
        process.env.ANTIGRAVITY_BASE_URL = `http://localhost:${mock.port}`;
        delete require.cache[require.resolve('./3_local_oauth')];
        const mod = require('./3_local_oauth');
        const result = await mod.probeAntigravity('fake_token', 'proj123');
        assert.strictEqual(result.ok, false);
        assert.strictEqual(result.status, 403);
        assert.strictEqual(result.validationUrl, validationUrl);
        process.env.ANTIGRAVITY_BASE_URL = origBase || '';
        delete require.cache[require.resolve('./3_local_oauth')];
    } finally {
        mock.server.close();
    }
});

test('probeAntigravity: returns null validationUrl on non-validation 403', async () => {
    const body = JSON.stringify({ error: { code: 403, message: 'Quota exceeded', status: 'RESOURCE_EXHAUSTED' } });
    const mock = await startMockAntigravity((req, res) => {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(body);
    });
    try {
        const origBase = process.env.ANTIGRAVITY_BASE_URL;
        process.env.ANTIGRAVITY_BASE_URL = `http://localhost:${mock.port}`;
        delete require.cache[require.resolve('./3_local_oauth')];
        const mod = require('./3_local_oauth');
        const result = await mod.probeAntigravity('fake_token', 'proj123');
        assert.strictEqual(result.ok, false);
        assert.strictEqual(result.validationUrl, null);
        process.env.ANTIGRAVITY_BASE_URL = origBase || '';
        delete require.cache[require.resolve('./3_local_oauth')];
    } finally {
        mock.server.close();
    }
});
