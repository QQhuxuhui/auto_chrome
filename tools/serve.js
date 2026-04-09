#!/usr/bin/env node
/**
 * 极小本地服务器：
 *   1. 提供 tools/totp.html 静态页面
 *   2. 代理 /api/sms?... → https://hero-sms.com/stubs/handler_api.php?...
 *      （避开浏览器 CORS 限制）
 *
 * 用法：
 *   node tools/serve.js            # 默认端口 8787
 *   PORT=9000 node tools/serve.js  # 自定义端口
 *
 * 然后浏览器打开 http://localhost:8787/
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const PORT = parseInt(process.env.PORT || '8787', 10);
const HERO_SMS_BASE = 'https://hero-sms.com/stubs/handler_api.php';
const HTML_PATH = path.join(__dirname, 'totp.html');

const server = http.createServer(async (req, res) => {
    const reqUrl = new URL(req.url, `http://localhost:${PORT}`);

    // ---- 静态页面 ----
    if (reqUrl.pathname === '/' || reqUrl.pathname === '/totp.html') {
        // BUILD:HTML_BLOCK_START
        fs.readFile(HTML_PATH, (err, data) => {
            if (err) {
                res.writeHead(500); res.end('无法读取 totp.html: ' + err.message);
                return;
            }
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(data);
        });
        // BUILD:HTML_BLOCK_END
        return;
    }

    // ---- SMS 代理 ----
    if (reqUrl.pathname === '/api/sms') {
        const upstream = new URL(HERO_SMS_BASE);
        reqUrl.searchParams.forEach((v, k) => upstream.searchParams.set(k, v));

        https.get(upstream.toString(), (upRes) => {
            let body = '';
            upRes.on('data', chunk => (body += chunk));
            upRes.on('end', () => {
                res.writeHead(upRes.statusCode || 200, {
                    'Content-Type': 'text/plain; charset=utf-8',
                    'Access-Control-Allow-Origin': '*',
                });
                res.end(body);
            });
        }).on('error', (err) => {
            res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end('上游错误: ' + err.message);
        });
        return;
    }

    res.writeHead(404); res.end('Not Found');
});

server.listen(PORT, () => {
    console.log(`\n  Tools server running:`);
    console.log(`    http://localhost:${PORT}/\n`);
    console.log(`  按 Ctrl+C 停止`);
});
