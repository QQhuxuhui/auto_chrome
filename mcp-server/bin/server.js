#!/usr/bin/env node
'use strict';

const { startServer } = require('../src/server');
startServer().catch(e => {
    process.stderr.write(`[fatal] ${e.stack || e.message}\n`);
    process.exit(1);
});
