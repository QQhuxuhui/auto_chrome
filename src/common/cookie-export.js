const fs = require('node:fs/promises');
const path = require('node:path');
const { geminiAccountState } = require('./gemini-session');

// 固定相关站点范围，不读取整个浏览器的所有网站。
function exportUrls(pageUrl) {
    return [...new Set([pageUrl,
        'https://gemini.google.com/_/BardChatUi/data/batchexecute',
        'https://gemini.google.com/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate',
        'https://accounts.google.com/RotateCookies',
        'https://accounts.google.com/RotateBoundCookies',
        'https://accounts.google.com/RotateBoundGaps',
        'https://play.google.com/log',
        'https://www.google.com/',
    ])];
}

async function exportCookies(tab, email, outputDir) {
    const pageUrl = tab.url();
    if (new URL(pageUrl).origin !== 'https://gemini.google.com'
        || await tab.evaluate(geminiAccountState, email) !== 'signed-in') {
        throw new Error('尚未在 Gemini 核对目标邮箱，拒绝导出');
    }
    const client = await tab.createCDPSession();
    try {
        const scopes = [];
        for (const url of exportUrls(pageUrl)) {
            const { cookies } = await client.send('Network.getCookies', { urls: [url] });
            scopes.push({ url, cookies });
        }
        if (!scopes[0].cookies.length) throw new Error('没有读到 Gemini Cookie');
        const selected = new Map(), conflicts = new Set();
        for (const scope of scopes) {
            for (const cookie of scope.cookies) {
                const prior = selected.get(cookie.name);
                if (!prior) selected.set(cookie.name, cookie);
                else if (prior.value !== cookie.value) conflicts.add(cookie.name);
            }
        }
        // TXT无法表示同名、不同域/路径的多个值。优先当前Gemini URL，完整变体保存在JSON。
        const cookieText = [...selected.values()].map(cookie => `${cookie.name}=${cookie.value}`).join('; ');
        if (/[\r\n]/.test(cookieText)) throw new Error('Cookie 包含换行符');
        await fs.mkdir(outputDir, { recursive: true });
        const filePath = path.join(outputDir, `${email.replace(/[^a-zA-Z0-9@._+-]/g, '_')}.cookie.txt`);
        const metadataPath = filePath.replace(/\.cookie\.txt$/, '.cookies.json');
        await fs.writeFile(metadataPath, JSON.stringify({
            schemaVersion: 1, exportedAt: new Date().toISOString(),
            format: 'multi-url-cookie-union',
            collisionPolicy: 'first URL wins; current Gemini URL first; all variants retained in scopes',
            conflictingNames: [...conflicts], scopes,
        }, null, 2), { encoding: 'utf8', mode: 0o600 });
        await fs.writeFile(filePath, cookieText, { encoding: 'utf8', mode: 0o600 });
        return { cookieText, filePath, metadataPath, conflictingNames: [...conflicts] };
    } finally {
        await client.detach();
    }
}
module.exports = { exportCookies };
