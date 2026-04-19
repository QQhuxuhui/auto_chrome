'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildAuthUrl } = require('./oauth');

test('buildAuthUrl composes correct query params', () => {
    const url = buildAuthUrl({
        clientId: 'c1.apps.googleusercontent.com',
        scopes: ['https://www.googleapis.com/auth/cloud-platform'],
        port: 18900,
    });
    const u = new URL(url);
    assert.equal(u.host, 'accounts.google.com');
    assert.equal(u.searchParams.get('client_id'), 'c1.apps.googleusercontent.com');
    assert.equal(u.searchParams.get('redirect_uri'), 'http://localhost:18900/callback');
    assert.equal(u.searchParams.get('prompt'), 'consent');
    assert.equal(u.searchParams.get('access_type'), 'offline');
    assert.equal(u.searchParams.get('response_type'), 'code');
    assert.equal(u.searchParams.get('scope'), 'https://www.googleapis.com/auth/cloud-platform');
});

test('buildAuthUrl respects custom redirectUri when provided', () => {
    const url = buildAuthUrl({
        clientId: 'c',
        scopes: ['s'],
        port: 9999,
        redirectUri: 'http://example.com/cb',
    });
    const u = new URL(url);
    assert.equal(u.searchParams.get('redirect_uri'), 'http://example.com/cb');
});
