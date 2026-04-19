/**
 * 基于文件标记的暂停机制。用于登录流程中遇到需要人工介入的场景
 * （CAPTCHA、Confirm you're not a robot 等）。
 *
 * 原理：在 logs/paused/ 下创建一个 flag 文件；程序每 2s 轮询一次；
 * flag 消失 → 恢复执行；出现 .abort 同名文件 → 放弃。
 *
 * 好处：适合 forked child process 场景（stdin 不可用）。用户用任意方式
 * 删 flag 都能解锁（终端、文件管理器、UI 将来的按钮）。
 */
const fs = require('fs');
const path = require('path');

const PAUSE_DIR = path.resolve(__dirname, '..', '..', 'logs', 'paused');

function ensureDir() {
    try { fs.mkdirSync(PAUSE_DIR, { recursive: true }); } catch (_) { }
}

/**
 * 等待人工介入。
 *
 * @param {string} label      简短标签，用在 flag 文件名里（如 `captcha_foo@x.com`）
 * @param {object} wlog       worker logger
 * @param {object} opts
 * @param {number} opts.timeoutMs  默认 30 分钟
 * @returns {{ resumed: boolean, aborted?: boolean, timeout?: boolean }}
 */
async function waitForHumanIntervention(label, wlog, opts = {}) {
    ensureDir();
    const safeLabel = String(label).replace(/[^a-zA-Z0-9_.@-]/g, '_').substring(0, 80);
    const flagPath = path.join(PAUSE_DIR, `${safeLabel}_${Date.now()}.flag`);
    const abortPath = flagPath + '.abort';
    fs.writeFileSync(flagPath, `${new Date().toISOString()}\nlabel=${label}\npid=${process.pid}\n`, 'utf-8');

    const banner = [
        '',
        '═══════════════════════════════════════════════════════════════════',
        `  🛑 需要人工介入：${label}`,
        '',
        '  请在浏览器窗口完成对应操作（验证码、"I\'m not a robot" 等）。',
        '  完成后删除此 flag 文件以继续：',
        '',
        `    rm "${flagPath}"`,
        '',
        '  如需放弃：',
        `    touch "${abortPath}"`,
        '',
        `  超时：${Math.round((opts.timeoutMs || 30 * 60 * 1000) / 60000)} 分钟后自动继续（视为超时放弃）`,
        '═══════════════════════════════════════════════════════════════════',
        ''
    ].join('\n');

    // 同时写 logger（含 pino 结构化）+ stderr（人眼直读）
    if (wlog && wlog.warn) wlog.warn(banner);
    process.stderr.write(banner);

    const timeoutMs = opts.timeoutMs || 30 * 60 * 1000;
    const pollInterval = 2000;
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
        await new Promise(r => setTimeout(r, pollInterval));
        if (!fs.existsSync(flagPath)) {
            if (wlog && wlog.info) wlog.info(`[pause:${label}] flag removed, resuming`);
            return { resumed: true };
        }
        if (fs.existsSync(abortPath)) {
            try { fs.unlinkSync(flagPath); } catch (_) { }
            try { fs.unlinkSync(abortPath); } catch (_) { }
            if (wlog && wlog.warn) wlog.warn(`[pause:${label}] abort flag detected`);
            return { resumed: false, aborted: true };
        }
    }

    try { fs.unlinkSync(flagPath); } catch (_) { }
    if (wlog && wlog.warn) wlog.warn(`[pause:${label}] timed out after ${timeoutMs}ms`);
    return { resumed: false, timeout: true };
}

/**
 * 检测当前页是否有「Confirm you're not a robot」/ reCAPTCHA 等人类验证拦截。
 * 只做 DOM/URL 检查，返回 true 表示需要人工介入。
 */
async function detectCaptchaChallenge(page) {
    try {
        const url = page.url() || '';
        // Google 已知的验证拦截 URL 片段
        if (/\/challenge\/(ipp|rp|recaptcha)/i.test(url)) return true;

        const byText = await page.evaluate(() => {
            const t = (document.body && document.body.innerText) || '';
            if (!t) return false;
            const re = /confirm you['\u2019]?re not a robot|i['\u2019]?m not a robot|not a robot|prove you are human|verify you are human|请证明您不是机器人|不是机器人|请确认您是真人/i;
            if (re.test(t)) return true;
            // 有 reCAPTCHA iframe
            const rcFrame = document.querySelector('iframe[src*="recaptcha"], iframe[title*="reCAPTCHA" i]');
            if (rcFrame) return true;
            return false;
        }).catch(() => false);

        return byText;
    } catch (_) {
        return false;
    }
}

module.exports = { waitForHumanIntervention, detectCaptchaChallenge, PAUSE_DIR };
