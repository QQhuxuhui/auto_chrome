#!/usr/bin/env node
/**
 * 构建脚本：生成 dist/bundled.js（HTML 内嵌），供 pkg 打包成 exe
 * 用法: node tools/build.js
 */
const fs = require('fs');
const path = require('path');

const TOOLS_DIR = __dirname;
const DIST_DIR = path.join(TOOLS_DIR, 'dist');
const HTML = fs.readFileSync(path.join(TOOLS_DIR, 'totp.html'), 'utf8');
const SERVE = fs.readFileSync(path.join(TOOLS_DIR, 'serve.js'), 'utf8');

// 把 HTML 安全编码成 base64（避免反引号/${}/反斜杠转义问题）
const htmlB64 = Buffer.from(HTML, 'utf8').toString('base64');

// 生成 bundled.js：
//  - 把原 serve.js 的「读文件」逻辑替换为直接使用内嵌字符串
const bundled = SERVE
    .replace(
        /const HTML_PATH = .*?;/,
        `const HTML_CONTENT = Buffer.from('${htmlB64}', 'base64').toString('utf8');`
    )
    .replace(
        /\/\/ BUILD:HTML_BLOCK_START[\s\S]*?\/\/ BUILD:HTML_BLOCK_END/,
        `res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });\n        res.end(HTML_CONTENT);`
    );

if (!fs.existsSync(DIST_DIR)) fs.mkdirSync(DIST_DIR);
fs.writeFileSync(path.join(DIST_DIR, 'bundled.js'), bundled);
console.log('[build] dist/bundled.js 生成完毕 (' + bundled.length + ' bytes)');
console.log('[build] 下一步: npx @yao-pkg/pkg tools/dist/bundled.js -t node18-win-x64 -o tools/auto-chrome-tools.exe');
