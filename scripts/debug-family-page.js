#!/usr/bin/env node
/**
 * Family 页 DOM 侦察脚本。
 *
 * 用途：通过 stealth Chrome 登录指定 host，抓取 Google Family 页面的 DOM
 * 结构（列表页 + 点进一个成员的详情页），dump 到 logs/debug-family/，
 * 帮助 debug removeFamilyMember。
 *
 * 用法：
 *   node scripts/debug-family-page.js <host-id-or-email>
 *
 * 例：
 *   node scripts/debug-family-page.js huxuhui123@gmail.com
 *   node scripts/debug-family-page.js 241
 *
 * 输出文件（logs/debug-family/）：
 *   - 01-list-screenshot.png          列表页截图
 *   - 01-list-fullpage.html           列表页完整 HTML
 *   - 01-list-rows.json               解析出的成员行摘要（位置/文本/HTML 片段）
 *   - 02-clicked-row-info.json        我们点击的是哪一行
 *   - 03-detail-screenshot.png        详情页截图
 *   - 03-detail-fullpage.html         详情页完整 HTML
 *   - 03-detail-buttons.json          详情页所有 button/link 的文本+aria-label
 *   - 03-detail-url.txt               详情页 URL
 */

const path = require('path');
const fs = require('fs');

// src/node_modules 到 require 搜索路径（让本脚本能 require 项目里的包）
module.paths.unshift(path.join(__dirname, '..', 'src', 'node_modules'));

require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });
const { log, createWorkerLogger } = require('../src/common/logger');
const {
    findChrome, launchRealChrome, newPage, sleep, clearBrowserSession,
} = require('../src/common/chrome');
const { googleLogin } = require('../src/common/google-login');
const hostsDb = require('../src/db/hosts');
const db = require('../src/db');

const FAMILY_URL = 'https://myaccount.google.com/family/details?utm_source=g1web&utm_medium=default';
const OUT_DIR = path.resolve(__dirname, '..', 'logs', 'debug-family');

async function resolveHost(arg) {
    // 先按邮箱查
    const list = await hostsDb.listHosts({ pageSize: 10000 });
    const byEmail = list.find(h => h.email.toLowerCase() === String(arg).toLowerCase());
    if (byEmail) return byEmail;
    // 再按 id
    if (/^\d+$/.test(arg)) {
        const byId = await hostsDb.getHostById(parseInt(arg, 10));
        if (byId) return byId;
    }
    throw new Error(`host not found: ${arg}`);
}

async function dumpFile(name, content) {
    const target = path.join(OUT_DIR, name);
    if (Buffer.isBuffer(content)) {
        fs.writeFileSync(target, content);
    } else if (typeof content === 'object') {
        fs.writeFileSync(target, JSON.stringify(content, null, 2), 'utf-8');
    } else {
        fs.writeFileSync(target, String(content), 'utf-8');
    }
    console.log(`  wrote ${target} (${fs.statSync(target).size} bytes)`);
}

async function main() {
    const arg = process.argv[2];
    if (!arg) {
        console.error('Usage: node scripts/debug-family-page.js <host-id-or-email>');
        process.exit(2);
    }

    fs.mkdirSync(OUT_DIR, { recursive: true });
    console.log(`Output dir: ${OUT_DIR}`);

    const host = await resolveHost(arg);
    console.log(`Host: ${host.email} (id=${host.id})`);

    const chromePath = findChrome();
    if (!chromePath) throw new Error('Chrome not found');

    const chrome = await launchRealChrome(chromePath, 0);
    const wlog = createWorkerLogger(0);

    try {
        await clearBrowserSession(chrome.browser, wlog);
        const page = await newPage(chrome.browser);

        // 登录
        console.log('Logging in...');
        await page.goto('https://accounts.google.com/signin', { waitUntil: 'networkidle2', timeout: 30000 }).catch(() => { });
        await googleLogin(page, {
            email: host.email, pass: host.password,
            recovery: host.recovery_email || '',
            totp_secret: host.totp_secret || undefined,
        }, wlog);
        await sleep(2000);

        // 进 family 列表
        console.log('Navigating to family page...');
        await page.goto(FAMILY_URL, { waitUntil: 'networkidle2', timeout: 30000 }).catch(() => { });
        await sleep(3000);

        // ========== 1. Dump 列表页 ==========
        console.log('Dumping list page...');
        const listShot = await page.screenshot({ fullPage: true });
        await dumpFile('01-list-screenshot.png', listShot);
        const listHtml = await page.content();
        await dumpFile('01-list-fullpage.html', listHtml);

        // 尝试用多种策略定位"成员行"，输出调试信息
        const rows = await page.evaluate(() => {
            // 找所有含 @ 符号（email）的文本节点及所有"卡片状"元素
            const results = [];
            const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
            let node;
            const seen = new Set();
            while ((node = walker.nextNode())) {
                const t = String(node.nodeValue || '').trim();
                if (!t || t.length > 200) continue;
                // 向上找"卡片行":宽>200 & 高 30-200
                let el = node.parentElement;
                while (el && el !== document.body) {
                    const r = el.getBoundingClientRect();
                    if (r.width > 200 && r.height >= 30 && r.height <= 200) {
                        if (!seen.has(el)) {
                            seen.add(el);
                            results.push({
                                text: (el.textContent || '').trim().substring(0, 200),
                                tag: el.tagName,
                                className: el.className || '',
                                role: el.getAttribute('role') || '',
                                aria: el.getAttribute('aria-label') || '',
                                href: el.getAttribute('href') || '',
                                width: Math.round(r.width),
                                height: Math.round(r.height),
                                top: Math.round(r.top),
                                outerHtmlHead: (el.outerHTML || '').substring(0, 500),
                            });
                        }
                        break;
                    }
                    el = el.parentElement;
                }
            }
            return results;
        });
        await dumpFile('01-list-rows.json', rows);

        // ========== 2. 找 <a href="family/member/..."> 跳过 host 自己，点第一个 member ==========
        console.log('Searching for a member anchor to click (skip host)...');
        const pickResult = await page.evaluate(() => {
            const anchors = Array.from(document.querySelectorAll('a[href*="family/member"]'));
            // 每个 anchor 文本里第一个 div 一般是姓名 + "Member"/"Family manager"
            const rows = anchors.map(a => {
                const r = a.getBoundingClientRect();
                const text = (a.textContent || '').trim();
                return {
                    el: a, text, href: a.getAttribute('href'),
                    isManager: /family manager|家庭管理员/i.test(text),
                    visible: r.width > 50 && r.height > 30,
                    top: r.top, width: r.width, height: r.height,
                };
            });
            const visibleMembers = rows.filter(r => r.visible && !r.isManager);
            if (!visibleMembers.length) return { ok: false, reason: 'no_non_manager_anchor', totalAnchors: anchors.length };
            visibleMembers.sort((a, b) => a.top - b.top);
            const chosen = visibleMembers[0];
            chosen.el.setAttribute('data-debug-click-target', '1');
            chosen.el.scrollIntoView({ block: 'center' });
            return {
                ok: true, text: chosen.text, href: chosen.href,
                width: chosen.width, height: chosen.height, top: chosen.top,
                totalAnchors: anchors.length, nonManagerCount: visibleMembers.length,
            };
        }).catch(e => ({ ok: false, error: e.message }));

        await dumpFile('02-clicked-row-info.json', pickResult);
        console.log(`  picked: ${JSON.stringify(pickResult)}`);
        if (!pickResult.ok) {
            console.log('  NO name-only row found; detail page dump skipped.');
            return;
        }

        // CDP click
        const handle = await page.$('[data-debug-click-target]').catch(() => null);
        if (!handle) {
            console.log('  Mark element lost before click.');
            return;
        }
        await handle.click({ delay: 40 });
        await handle.dispose().catch(() => { });
        await sleep(4000);

        // ========== 3. Dump 详情页 ==========
        console.log('Dumping detail page...');
        const detailShot = await page.screenshot({ fullPage: true });
        await dumpFile('03-detail-screenshot.png', detailShot);
        const detailHtml = await page.content();
        await dumpFile('03-detail-fullpage.html', detailHtml);
        await dumpFile('03-detail-url.txt', page.url());

        // 列出详情页所有可点元素（button / a / role=button）
        const buttons = await page.evaluate(() => {
            const els = document.querySelectorAll('button, a, [role="button"], [role="menuitem"]');
            const out = [];
            for (const el of els) {
                const r = el.getBoundingClientRect();
                if (r.width < 10 || r.height < 10) continue;
                const s = window.getComputedStyle(el);
                if (s.display === 'none' || s.visibility === 'hidden') continue;
                out.push({
                    tag: el.tagName,
                    text: (el.textContent || '').trim().substring(0, 120),
                    aria: el.getAttribute('aria-label') || '',
                    role: el.getAttribute('role') || '',
                    href: el.getAttribute('href') || '',
                    className: (el.className || '').substring(0, 120),
                    width: Math.round(r.width), height: Math.round(r.height),
                    top: Math.round(r.top), left: Math.round(r.left),
                });
            }
            return out;
        });
        await dumpFile('03-detail-buttons.json', buttons);

        console.log('Done. Share logs/debug-family/ back to Claude.');
    } finally {
        await sleep(1000);
        try { chrome.browser.close(); } catch (_) { }
        try { chrome.proc.kill(); } catch (_) { }
        await db.close();
    }
}

main().catch(e => {
    console.error('fatal:', e.message);
    if (e.stack) console.error(e.stack);
    process.exit(1);
});
