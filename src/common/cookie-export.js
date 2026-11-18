const fs = require('node:fs/promises');
const path = require('node:path');
const { geminiAccountState } = require('./gemini-session');

async function exportCookies(tab, email, outputDir) {
    const pageUrl = tab.url();
    if (new URL(pageUrl).origin !== 'https://gemini.google.com'
        || await tab.evaluate(geminiAccountState, email) !== 'signed-in') {
        throw new Error('尚未在 Gemini 核对目标邮箱，拒绝导出');
    }
    const client = await tab.createCDPSession();
    try {
        const { cookies } = await client.send('Network.getCookies', { urls: [pageUrl] });
        if (!cookies.length) throw new Error('没有读到 Cookie');
        const cookieText = cookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; ');
        if (/[\r\n]/.test(cookieText)) throw new Error('Cookie 包含换行符');
        await fs.mkdir(outputDir, { recursive: true });
        const filePath = path.join(outputDir, `${email.replace(/[^a-zA-Z0-9@._+-]/g, '_')}.cookie.txt`);
        await fs.writeFile(filePath, cookieText, { encoding: 'utf8', mode: 0o600 });
        return { cookieText, filePath };
    } finally {
        await client.detach();
    }
}
module.exports = { exportCookies };
