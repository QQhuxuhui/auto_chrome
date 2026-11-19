const fs = require('node:fs/promises');
const path = require('node:path');
const { homedir } = require('node:os');
const { createHash } = require('node:crypto');
const { parseArgs } = require('node:util');
const { launchChrome } = require('./common/chrome');
const { loginAccount } = require('./common/account-login');
const { exportCookies } = require('./common/cookie-export');

async function main() {
    const { values } = parseArgs({ options: {
        file: { type: 'string' }, output: { type: 'string' },
        concurrency: { type: 'string', default: '2' }, resume: { type: 'boolean' },
    } });
    if (!values.file || !values.output) throw new Error('用法：node src/export_accounts.js --file 账号文件 --output 输出TXT [--resume]');
    const rows = (await fs.readFile(values.file, 'utf8')).split(/\r?\n/).filter(row => row.trim());
    const accounts = rows.map((row, index) => {
        const [email, password, , secret] = row.split('----');
        if (!email || !password || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) throw new Error(`第 ${index + 1} 行格式无效`);
        return { email: email.trim().toLowerCase(), password, secret: secret?.trim(), index };
    });
    if (new Set(accounts.map(account => account.email)).size !== accounts.length) throw new Error('账号文件含重复邮箱');
    const concurrency = Number(values.concurrency);
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 4) throw new Error('并发数须为 1 至 4');
    const root = path.resolve(__dirname, '..');
    const output = path.resolve(values.output);
    const cookieDir = path.join(root, 'cookies');
    const statusPath = `${output}.status.json`;
    const profileRoot = process.env.LOCALAPPDATA || path.join(homedir(), '.local', 'share');
    const results = accounts.map(account => ({ index: account.index + 1, email: account.email, status: 'pending' }));
    const cookies = new Array(accounts.length);
    if (values.resume) {
        const previous = JSON.parse(await fs.readFile(statusPath, 'utf8'));
        for (const account of accounts) {
            const old = previous.find(item => item.index === account.index + 1 && item.email === account.email && item.status === 'success');
            if (old) {
                cookies[account.index] = await fs.readFile(old.filePath, 'utf8');
                if (!cookies[account.index] || /[\r\n]/.test(cookies[account.index])) throw new Error('已有 Cookie 文件格式无效');
                results[account.index] = old;
            }
        }
    } else {
        try { await fs.access(output); throw new Error('输出文件已存在，请换文件名或使用 --resume'); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    await fs.mkdir(path.dirname(output), { recursive: true });
    let writes = Promise.resolve();
    function save() {
        writes = writes.then(async () => {
            const successful = cookies.filter(Boolean);
            if (successful.length) {
                await fs.writeFile(`${output}.tmp`, successful.join('\r\n') + '\r\n', { mode: 0o600 });
                await fs.rename(`${output}.tmp`, output);
            }
            let line = 0;
            const snapshot = results.map(result => ({ ...result, outputLine: result.status === 'success' ? ++line : null }));
            await fs.writeFile(statusPath, JSON.stringify(snapshot, null, 2), { mode: 0o600 });
        });
        return writes;
    }
    await save();
    let cursor = 0;
    async function worker() {
        while (cursor < accounts.length) {
            const account = accounts[cursor++];
            if (cookies[account.index]) continue;
            const result = results[account.index];
            let browser, page;
            const started = Date.now();
            result.startedAt = new Date(started).toISOString();
            result.timings = {};
            result.steps = [];
            const log = text => console.log(`[${account.index + 1}/${accounts.length}] ${text}`);
            try {
                result.status = 'running';
                await save();
                log('启动独立环境');
                const accountDir = createHash('sha256').update(account.email).digest('hex');
                let phaseStarted = Date.now();
                browser = await launchChrome(path.join(profileRoot, 'auto_chrome', 'gemini', accountDir), { portableCookies: true });
                page = (await browser.pages()).find(tab => tab.url() === 'about:blank') || await browser.newPage();
                result.timings.launchMs = Date.now() - phaseStarted;
                phaseStarted = Date.now();
                await loginAccount(page, account, log, undefined, result.steps);
                result.timings.loginMs = Date.now() - phaseStarted;
                phaseStarted = Date.now();
                await page.bringToFront();
                const exported = await exportCookies(page, account.email, cookieDir);
                result.timings.exportMs = Date.now() - phaseStarted;
                cookies[account.index] = exported.cookieText;
                Object.assign(result, { status: 'success', filePath: exported.filePath,
                    cookieMetadataPath: exported.metadataPath, conflictingCookieNames: exported.conflictingNames });
                log('Cookie 已导出');
            } catch (error) {
                result.status = 'failed';
                result.error = error.message.replace(/https?:\/\/\S+/g, '[URL]');
                if (page && !page.isClosed()) result.pagePath = new URL(page.url()).pathname;
                log(`失败：${result.error}`);
            } finally {
                if (browser?.connected) await browser.close().catch(() => {});
                result.timings.totalMs = Date.now() - started;
                result.completedAt = new Date().toISOString();
                await save();
            }
        }
    }
    await Promise.all(Array.from({ length: concurrency }, worker));
    console.log(`完成：成功 ${results.filter(r => r.status === 'success').length}/${accounts.length}`);
    if (results.some(r => r.status !== 'success')) process.exitCode = 1;
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
