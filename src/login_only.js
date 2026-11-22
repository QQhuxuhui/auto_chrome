const { createHash } = require('node:crypto');
const { homedir } = require('node:os');
const path = require('node:path');
const { createInterface } = require('node:readline/promises');
const { parseArgs } = require('node:util');
const { launchChrome } = require('./common/chrome');
const { loginToGemini } = require('./common/gemini-session');
const { exportCookies } = require('./common/cookie-export');

async function main() {
    const { values } = parseArgs({ options: {
        email: { type: 'string' },
        'keep-open': { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h' },
    } });
    if (values.help) {
        console.log('用法：npm start -- --email name@example.com [--keep-open]\n也可以运行 npm start，按提示输入邮箱。');
        return;
    }
    let email = values.email;
    if (email === undefined) {
        if (!process.stdin.isTTY) throw new Error('请通过 --email 指定要登录的邮箱');
        const prompt = createInterface({ input: process.stdin, output: process.stdout });
        try {
            email = await prompt.question('请输入要登录 Gemini 的 Google 邮箱：');
        } finally {
            prompt.close();
        }
    }
    email = email.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('请输入有效的邮箱');

    const accountDir = createHash('sha256').update(email).digest('hex');
    const profileRoot = process.env.LOCALAPPDATA || path.join(homedir(), '.local', 'share');
    const browser = await launchChrome(path.join(profileRoot, 'auto_chrome', 'gemini', accountDir), { portableCookies: true });
    try {
        const page = (await browser.pages())[0] || await browser.newPage();
        console.log('请在 Chrome 窗口完成 Google 登录。要使用身份验证器，可在验证页选择“试试其他方式”。');
        const signedInTab = await loginToGemini(browser, page, email);
        await signedInTab.bringToFront();
        const { filePath } = await exportCookies(signedInTab, email, path.resolve(__dirname, '..', 'cookies'), {
            freezeBeforeSnapshot: !values['keep-open'],
        });
        console.log(`Cookie 已保存：${filePath}`);
        if (values['keep-open']) {
            console.log('已在 Gemini 核对目标邮箱。注意：继续在此窗口浏览可能滚动刷新会话 Cookie，建议服务端使用时重新导出。关闭 Chrome 即可退出。');
            if (browser.connected) await new Promise(resolve => browser.once('disconnected', resolve));
        } else {
            console.log('已在 Gemini 核对目标邮箱，已冻结并关闭浏览器以固定导出的 Cookie（如需保留窗口请加 --keep-open）。');
        }
    } finally {
        if (browser.connected) await browser.close();
    }
}

main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
});
