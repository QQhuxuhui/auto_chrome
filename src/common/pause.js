/**
 * 登录流程中遇到 CAPTCHA / "Confirm you're not a robot" 等无法自动解的人类验证时，
 * 暂停程序并**持续轮询页面**，等用户在浏览器窗口自己解完。
 * 拦截一消失（URL 变了 / DOM 变了）就自动继续，不需要任何额外操作。
 */

/**
 * 检测当前页是否有「Confirm you're not a robot」/ reCAPTCHA 等人类验证拦截。
 * 只做 DOM/URL 检查，返回 true 表示需要人工介入。
 */
async function detectCaptchaChallenge(page) {
    try {
        const url = page.url() || '';
        // 只匹配 **明确是 reCAPTCHA 的** URL 路径。
        // 注意：/challenge/ipp 是手机身份验证、/challenge/rp 是 recovery phone —— 都不是 captcha
        // 由 google-login.js 的 verify_phone/challenge 分支处理。
        if (/\/challenge\/recaptcha/i.test(url)) return true;

        const byText = await page.evaluate(() => {
            const t = (document.body && document.body.innerText) || '';
            if (!t) return false;
            // 收窄到「机器人/robot」专用短语。避免 "verify you are human"（某些手机验证页
            // 和设备验证页可能出现类似"verify"关键词，会误判）。
            const re = /confirm you['\u2019]?re not a robot|i['\u2019]?m not a robot|prove you['\u2019]?re not a robot|请证明您不是机器人|确认您不是机器人|请确认您是真人/i;
            if (re.test(t)) return true;
            // reCAPTCHA iframe 是强信号
            const rcFrame = document.querySelector(
                'iframe[src*="google.com/recaptcha"], iframe[title*="reCAPTCHA" i], iframe[title*="recaptcha" i]'
            );
            if (rcFrame) return true;
            return false;
        }).catch(() => false);

        return byText;
    } catch (_) {
        return false;
    }
}

/**
 * 检测到 CAPTCHA 后，持续轮询页面，等用户手动解完（页面离开 challenge 状态）。
 *
 * @param {Page}   page         puppeteer Page
 * @param {string} label        日志用的短标签（例如 email）
 * @param {object} wlog         worker logger
 * @param {object} opts
 * @param {number} opts.timeoutMs            默认 30 分钟
 * @param {number} opts.clearConfirmMs       连续 N ms 都没检测到拦截才算真的解完（避免
 *                                           过渡态抖动），默认 3000ms
 * @returns {{ resumed: boolean, timeout?: boolean, elapsedMs: number }}
 */
async function waitForCaptchaResolved(page, label, wlog, opts = {}) {
    const timeoutMs = opts.timeoutMs || 30 * 60 * 1000;
    const pollInterval = opts.pollMs || 2000;
    const clearConfirmMs = opts.clearConfirmMs || 3000;
    const start = Date.now();
    const deadline = start + timeoutMs;

    const banner = [
        '',
        '═══════════════════════════════════════════════════════════════════',
        `  🛑 检测到人类验证拦截：${label}`,
        '',
        '  请在 Chrome 窗口完成验证（勾选 "I\'m not a robot" / 图片验证码等）。',
        '  程序会自动检测拦截消失后继续，不用手动干预。',
        '',
        `  每 ${pollInterval / 1000}s 轮询一次；${Math.round(timeoutMs / 60000)} 分钟超时`,
        '═══════════════════════════════════════════════════════════════════',
        ''
    ].join('\n');
    if (wlog && wlog.warn) wlog.warn(banner);
    process.stderr.write(banner);

    let clearStart = null;  // 连续 N ms "没拦截" 才算真的解完
    let lastState = true;   // 默认认为还在拦截

    while (Date.now() < deadline) {
        await new Promise(r => setTimeout(r, pollInterval));
        let stillBlocked;
        try {
            stillBlocked = await detectCaptchaChallenge(page);
        } catch (_) {
            stillBlocked = true;  // 页面异常算仍在
        }

        if (stillBlocked) {
            clearStart = null;
            if (lastState === false && wlog && wlog.info) {
                wlog.info(`[captcha:${label}] still present`);
            }
            lastState = true;
            continue;
        }

        // 没检测到拦截 —— 需连续 clearConfirmMs 都清白才放行
        if (clearStart === null) {
            clearStart = Date.now();
            if (wlog && wlog.info) wlog.info(`[captcha:${label}] seems cleared, confirming for ${clearConfirmMs}ms...`);
        } else if (Date.now() - clearStart >= clearConfirmMs) {
            const elapsedMs = Date.now() - start;
            if (wlog && wlog.info) wlog.info(`[captcha:${label}] resolved; elapsed ${(elapsedMs / 1000).toFixed(1)}s`);
            return { resumed: true, elapsedMs };
        }
        lastState = false;
    }

    const elapsedMs = Date.now() - start;
    if (wlog && wlog.warn) wlog.warn(`[captcha:${label}] timed out after ${(elapsedMs / 1000).toFixed(1)}s`);
    return { resumed: false, timeout: true, elapsedMs };
}

module.exports = { detectCaptchaChallenge, waitForCaptchaResolved };
