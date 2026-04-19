'use strict';

const http = require('http');

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const PORT_RANGE_PER_WORKER = 50;

function buildAuthUrl({ clientId, scopes, port, redirectUri }) {
    const uri = redirectUri || `http://localhost:${port}/callback`;
    return `${AUTH_URL}?${new URLSearchParams({
        client_id: clientId,
        redirect_uri: uri,
        response_type: 'code',
        scope: Array.isArray(scopes) ? scopes.join(' ') : scopes,
        access_type: 'offline',
        prompt: 'consent',
    }).toString()}`;
}

async function exchangeCode({ code, clientId, clientSecret, redirectUri }) {
    const resp = await fetch(TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            code,
            client_id: clientId,
            client_secret: clientSecret,
            redirect_uri: redirectUri,
            grant_type: 'authorization_code',
        }).toString(),
    });
    const text = await resp.text();
    let data;
    try { data = JSON.parse(text); }
    catch (_) { throw new Error(`Token exchange: non-JSON response (${resp.status}): ${text.slice(0, 200)}`); }
    if (data.error) throw new Error(`Token exchange failed: ${data.error}: ${data.error_description || ''}`);
    if (!data.refresh_token) throw new Error('Token exchange succeeded but no refresh_token (prompt=consent required?)');
    return data;
}

function startCbServer(startPort, wlog) {
    return new Promise((resolve, reject) => {
        let done;
        const codePromise = new Promise(r => { done = r; });
        function tryListen(port) {
            if (port > startPort + PORT_RANGE_PER_WORKER) {
                reject(new Error(`no available port in range ${startPort}~${port}`));
                return;
            }
            const server = http.createServer((req, res) => {
                try {
                    const u = new URL(req.url, `http://localhost:${port}`);
                    if (u.pathname === '/callback') {
                        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
                        const code = u.searchParams.get('code');
                        const err = u.searchParams.get('error');
                        res.end(code ? '<h1>OK. You can close this tab.</h1>' : `<h1>FAIL: ${err || 'unknown'}</h1>`);
                        done(code ? { code } : { error: err || 'unknown' });
                    } else {
                        res.writeHead(404);
                        res.end('Not Found');
                    }
                } catch (_) {
                    try { res.writeHead(500); res.end('err'); } catch (_2) {}
                }
            });
            server.on('error', (e) => {
                if (e.code === 'EADDRINUSE') {
                    if (wlog && wlog.debug) wlog.debug(`  port ${port} in use, trying ${port + 1}`);
                    tryListen(port + 1);
                } else {
                    reject(e);
                }
            });
            server.listen(port, () => resolve({ server, port, codePromise }));
        }
        tryListen(startPort);
    });
}

module.exports = { buildAuthUrl, exchangeCode, startCbServer, AUTH_URL, TOKEN_URL, PORT_RANGE_PER_WORKER };
