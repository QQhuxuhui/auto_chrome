const fs = require('node:fs/promises');
const path = require('node:path');
const { homedir } = require('node:os');
const { parseArgs } = require('node:util');
const { launchChrome } = require('./common/chrome');
const { loginAccount } = require('./common/account-login');
const { exportCookies } = require('./common/cookie-export');
const { readAccounts, readyBatches, atomicJson, digest } = require('./common/directory-export');

async function main() {
    const { values } = parseArgs({ options: {
        input: { type: 'string' }, output: { type: 'string' }, prefix: { type: 'string' },
        concurrency: { type: 'string', default: '3' }, limit: { type: 'string' }, resume: { type: 'boolean' },
        'profile-root': { type: 'string' },
    } });
    if (!values.input || !values.output || !/^[a-zA-Z0-9_-]+$/.test(values.prefix || '')) throw new Error('请指定 --input 账号目录 --output 输出目录 --prefix 批次前缀');
    const concurrency = Number(values.concurrency), limit = values.limit ? Number(values.limit) : Infinity;
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 4) throw new Error('并发数须为 1 至 4');
    if (limit !== Infinity && (!Number.isInteger(limit) || limit < 1)) throw new Error('limit 必须为正整数');
    const input = await readAccounts(path.resolve(values.input));
    const out = path.resolve(values.output), records = path.join(out, '_records', values.prefix);
    const profileRoot = values['profile-root'] ? path.resolve(values['profile-root'])
        : path.join(process.env.LOCALAPPDATA || path.join(homedir(), '.local', 'share'), 'auto_chrome', 'gemini');
    const statusPath = path.join(records, 'status.json');
    await fs.mkdir(records, { recursive: true });
    let state;
    if (values.resume) {
        state = JSON.parse(await fs.readFile(statusPath, 'utf8'));
        if (state.fingerprint !== input.fingerprint) throw new Error('输入文件已改变，不能复用此批次进度');
        for (const result of state.results) if (result.status === 'running') result.status = 'pending';
    } else {
        try { await fs.access(statusPath); throw new Error('批次已存在，请用 --resume'); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        state = { fingerprint: input.fingerprint, inputRows: input.inputRows, uniqueAccounts: input.accounts.length,
            duplicates: input.duplicates, invalid: input.invalid, startedAt: new Date().toISOString(), batches: [],
            results: input.accounts.map(account => ({ index: account.index, email: account.email, source: account.source,
                status: account.conflict ? 'skipped' : 'pending', ...(account.conflict ? { reason: '重复账号凭据不一致，未尝试登录' } : {}) })) };
    }
    const cookieTexts = new Map();
    for (const result of state.results.filter(result => result.status === 'success')) {
        const text = await fs.readFile(result.cookiePath, 'utf8');
        if (!text || /[\r\n]/.test(text)) throw new Error('已保存的 Cookie 格式无效');
        cookieTexts.set(result.index, text);
    }
    let writes = Promise.resolve();
    function save() {
        writes = writes.then(async () => {
            const complete = state.results.every(result => !['pending', 'running'].includes(result.status));
            const batches = readyBatches(state.results, complete);
            for (let i = 0; i < batches.length; i++) {
                const rows = batches[i];
                const name = `${values.prefix}-${String(i + 1).padStart(3, '0')}.txt`;
                const file = path.join(out, name);
                const text = rows.map(row => cookieTexts.get(row.index)).join('\r\n') + '\r\n';
                const sha256 = digest(text);
                if (state.batches[i]) {
                    if (state.batches[i].sha256 !== sha256) throw new Error('已发布批次内容发生变化');
                    continue;
                }
                // 崩溃发生在发布文件之后、写入状态之前时，只接纳内容完全一致的文件。
                let alreadyPublished = false;
                try {
                    if (digest(await fs.readFile(file, 'utf8')) !== sha256) throw new Error(`同名批次内容不匹配：${name}`);
                    alreadyPublished = true;
                } catch (error) { if (error.code !== 'ENOENT') throw error; }
                if (!alreadyPublished) {
                    await fs.writeFile(`${file}.tmp`, text, { mode: 0o600 });
                    await fs.rename(`${file}.tmp`, file);
                }
                state.batches.push({ number: i + 1, file, count: rows.length, sha256, createdAt: new Date().toISOString(),
                    accounts: rows.map(row => ({ index: row.index, email: row.email })) });
                console.log(`BATCH_READY ${JSON.stringify({ number: i + 1, file, count: rows.length, sha256 })}`);
            }
            state.updatedAt = new Date().toISOString();
            state.complete = complete;
            state.summary = Object.fromEntries(['pending', 'running', 'success', 'failed', 'skipped'].map(key => [key, state.results.filter(row => row.status === key).length]));
            await atomicJson(statusPath, state);
            await atomicJson(path.join(records, 'success.json'), state.results.filter(row => row.status === 'success'));
            await atomicJson(path.join(records, 'unsuccessful.json'), state.results.filter(row => ['failed', 'skipped'].includes(row.status)));
        });
        return writes;
    }
    await save();
    const queue = state.results.filter(result => result.status === 'pending').slice(0, limit);
    let cursor = 0;
    async function worker() {
        while (cursor < queue.length) {
            // 放置 pause.flag 可在当前账号结束后暂停取新账号，进度可继续恢复。
            if (await fs.access(path.join(records, 'pause.flag')).then(() => true, () => false)) return;
            const result = queue[cursor++], account = input.accounts[result.index - 1];
            const started = Date.now();
            let browser, page;
            result.status = 'running'; result.steps = []; result.startedAt = new Date().toISOString(); result.timings = {};
            const log = message => console.log(`[${result.index}/${input.accounts.length}] ${message}`);
            await save();
            try {
                log('启动独立环境');
                browser = await launchChrome(path.join(profileRoot, digest(account.email)), { portableCookies: true });
                page = (await browser.pages()).find(tab => tab.url() === 'about:blank') || await browser.newPage();
                result.timings.launchMs = Date.now() - started;
                const loginStart = Date.now();
                await loginAccount(page, account, log, 240000, result.steps);
                result.timings.loginMs = Date.now() - loginStart;
                await page.bringToFront();
                const exported = await exportCookies(page, account.email, path.join(records, 'accounts'));
                cookieTexts.set(result.index, exported.cookieText);
                result.cookiePath = exported.filePath;
                result.cookieMetadataPath = exported.metadataPath;
                result.conflictingCookieNames = exported.conflictingNames;
                result.status = 'success';
                log('成功，Cookie 已保存');
            } catch (error) {
                result.status = error.code === 'ACCOUNT_SKIPPED' ? 'skipped' : 'failed';
                result.reason = error.message.replace(/https?:\/\/\S+/g, '[URL]');
                for (const secret of [account.password, account.secret]) result.reason = result.reason.split(secret).join('[隐藏]');
                if (page && !page.isClosed()) {
                    try {
                        const url = new URL(page.url()); result.pagePath = url.pathname; result.pageOrigin = url.origin;
                        const diagnostic = await page.evaluate(() => ({ text: location.origin === 'https://gemini.google.com' ? '[Gemini身份确认未完成]' : document.body?.innerText.slice(0,6000) || '',
                            inputs: [...document.querySelectorAll('input')].filter(el=>el.getClientRects().length).map(el=>({name:el.name,type:el.type,id:el.id})) }));
                        for (const secret of [account.password, account.secret]) diagnostic.text = diagnostic.text.split(secret).join('[隐藏]');
                        await atomicJson(path.join(records, `failure-${result.index}.json`), { index: result.index, reason: result.reason, origin: url.origin, path: url.pathname, ...diagnostic });
                    } catch { /* 页面已关闭 */ }
                }
                log(`${result.status === 'skipped' ? '跳过' : '未跑通'}：${result.reason}`);
            } finally {
                if (browser?.connected) await browser.close().catch(() => {});
                result.completedAt = new Date().toISOString(); result.timings.totalMs = Date.now() - started;
                await save();
                console.log(`PROGRESS ${JSON.stringify(state.summary)}`);
            }
        }
    }
    await Promise.all(Array.from({ length: concurrency }, worker));
    await save();
    console.log(`FINISHED ${JSON.stringify({ complete: state.complete, ...state.summary, batches: state.batches.length })}`);
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
