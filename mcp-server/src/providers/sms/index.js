'use strict';

const _providers = new Map();

function registerProvider(provider) {
    if (!provider.name) throw new Error('provider.name required');
    _providers.set(provider.name, provider);
}

function getProvider(name, config) {
    if (_providers.has(name)) return _providers.get(name);
    // Lazy-load built-ins
    if (name === 'hero-sms') {
        const hero = require('./hero-sms');
        registerProvider(hero.create(config));
        return _providers.get(name);
    }
    throw new Error(`unknown SMS provider: ${name}`);
}

module.exports = { registerProvider, getProvider };
