/**
 * Google 登录状态机 — 供所有阶段脚本复用
 *
 * 处理：email 输入 → 密码输入 → 各种中间页面（speedbump, chrome_sync, tos, challenge 等）
 * 登录完成后返回 page 供调用方继续操作
 */

const { LOG_COLORS } = require('./logger');
const {
    sleep, fastType, detectPageState, tryClickStrategies,
    takeScreenshot, listVisibleElements, fastClick, forceEnglishUI,
} = require('./chrome');
const { generateTOTP, getTOTPWithTTL } = require('./totp');

const MAX_LOGIN_STEPS = 25;

/**
 * 在 page 上完成 Google 登录流程
 * @param {Page} page - Puppeteer 页面（已导航到 Google 登录页或 OAuth 页）
 * @param {Object} account - { email, pass, recovery }
 * @param {Object} wlog - worker logger
 * @returns {Promise<void>} - 登录完成后返回（page 保持在登录后的目标页面）
 */
async function googleLogin(page, account, wlog, opts = {}) {
    const smsProvider = opts.smsProvider || require('./sms');
    const stateHistory = [];

    for (let step = 0; step < MAX_LOGIN_STEPS; step++) {
        // URL 优先判断登录成功：到达任何已认证目的页即立即返回，
        // 避免页面内 "Sign in" 文本触发 confirm_signin 误判死循环。
        // 必须同时满足：
        //   1. 在一个已认证域（mail/myaccount/one/drive/calendar/photos）
        //   2. 路径不包含任何"验证/挑战/登录"段（signin/challenge/verification/identity/...）
        const curUrl = page.url();
        const authDomainRe = /^https:\/\/(mail\.google\.com\/mail\/|myaccount\.google\.com\/|one\.google\.com\/|drive\.google\.com\/drive\/|calendar\.google\.com\/calendar\/|photos\.google\.com\/)/;
        const challengePathRe = /\/(signin|challenge|verification|identity|selectaccount|identifier|interstitial|pwd)(\/|\?|$)/i;
        if (authDomainRe.test(curUrl) && !challengePathRe.test(curUrl)) {
            wlog.info(`  Login complete (reached authenticated URL: ${curUrl.substring(0, 100)})`);
            return;
        }

        // 账号语言非英文时，Google 会忽略 Accept-Language 头渲染本地化 UI，
        // 导致下方按钮文本关键词（verify/next/continue 等）全部匹配不上。
        // 每轮先尝试切成英文，已是英文或找不到切换器时 no-op。
        await forceEnglishUI(page, wlog);

        const stateInfo = await detectPageState(page, wlog);
        const state = stateInfo.state;

        wlog.info(`  [Login Step ${String(step + 1).padStart(2, '0')}] State: ${LOG_COLORS.BOLD}${state}${LOG_COLORS.RESET}`);
        wlog.debug(`    URL: ${stateInfo.url}`);

        stateHistory.push(state);

        // 死循环检测
        if (stateHistory.length >= 8) {
            const last8 = stateHistory.slice(-8);
            if (new Set(last8).size === 1) {
                await takeScreenshot(page, `login_deadloop_${account.email}_${state}`, wlog);
                throw new Error(`Login deadloop: 8x ${state}`);
            }
        }
        if (stateHistory.length >= 5) {
            const last5 = stateHistory.slice(-5);
            if (new Set(last5).size === 1 && state === 'unknown') {
                await takeScreenshot(page, `login_unknown5x_${account.email}`, wlog);
                throw new Error('Login stuck: 5x unknown state');
            }
        }

        switch (state) {
            case 'email': {
                wlog.debug(`Entering email: ${account.email}`);
                await fastType(page, 'input[type="email"]', account.email, wlog);
                await sleep(100);
                // 显式 focus 后再按 Enter，避免 React 重渲染后焦点落到 body 上导致表单不提交
                await page.focus('input[type="email"]').catch(() => { });
                await page.keyboard.press('Enter');
                // Google 登录是 SPA，按 Enter 未必触发 navigation；等"可见"密码框注入。
                // 隐藏的占位密码框会在过场期就出现，必须等可见才算就绪，否则下轮会对隐藏框 fastType。
                await page.waitForFunction(() => {
                    const inputs = Array.from(document.querySelectorAll('input[type="password"]'));
                    return inputs.some(el => {
                        const r = el.getBoundingClientRect();
                        const s = window.getComputedStyle(el);
                        return r.width > 0 && r.height > 0
                            && s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0'
                            && el.getAttribute('aria-hidden') !== 'true';
                    });
                }, { timeout: 8000 }).catch(() => { });
                await sleep(100);
                break;
            }

            case 'password': {
                // 诊断日志：URL / 可见密码框数量 / 累计进入次数，定位"密码框反复刷新"
                const pwDiag = await page.evaluate(() => {
                    const all = Array.from(document.querySelectorAll('input[type="password"]'));
                    const visible = all.filter(el => {
                        const r = el.getBoundingClientRect();
                        const s = window.getComputedStyle(el);
                        return r.width > 0 && r.height > 0
                            && s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0'
                            && el.getAttribute('aria-hidden') !== 'true';
                    });
                    return {
                        url: location.href,
                        path: location.pathname,
                        total: all.length,
                        visible: visible.length,
                        currentValueLen: visible[0] ? (visible[0].value || '').length : -1,
                    };
                }).catch(() => null);
                const pwSeen = stateHistory.filter(s => s === 'password').length;
                wlog.info(`  [pwd-diag] enter#${pwSeen} path=${pwDiag && pwDiag.path} pwInputs total=${pwDiag && pwDiag.total} visible=${pwDiag && pwDiag.visible} valueLen=${pwDiag && pwDiag.currentValueLen}`);

                // 检查页面上是否已有密码错误提示
                const hasError = await page.evaluate(() => {
                    const text = (document.body ? document.body.innerText : '').toLowerCase();
                    return text.includes('wrong password') ||
                        text.includes('密码错误') ||
                        text.includes('incorrect password') ||
                        text.includes("couldn't sign you in") ||
                        text.includes('无法让您登录');
                }).catch(() => false);

                if (hasError) {
                    await takeScreenshot(page, `login_wrong_password_${account.email}`, wlog);
                    throw new Error('Wrong password: error message detected on page');
                }

                // 如果已经输入过密码（上一个状态也是 password），说明密码可能错误
                const pwCount = stateHistory.filter(s => s === 'password').length;
                if (pwCount >= 4) {
                    await takeScreenshot(page, `login_wrong_password_${account.email}`, wlog);
                    throw new Error('Wrong password: login returned to password page multiple times');
                }

                wlog.debug('Entering password');
                await fastType(page, 'input[type="password"]', account.pass, wlog);
                await sleep(100);
                // 显式 focus 后再按 Enter，避免 React 重渲染后焦点落到 body 上导致表单不提交
                await page.focus('input[type="password"]:not([aria-hidden="true"])').catch(() => { });
                await page.keyboard.press('Enter');
                // 密码提交后可能是 SPA 过渡（URL 客户端切换）或真实 navigation，
                // 统一判"已离开密码页"：密码输入框消失或 URL 不在 /pwd 路径。
                await page.waitForFunction(
                    () => !document.querySelector('input[type="password"]:not([aria-hidden="true"])')
                        || !/\/pwd(\/|\?|$)/i.test(location.pathname),
                    { timeout: 8000 }
                ).catch(() => { });
                await sleep(500);
                break;
            }

            case 'speedbump': {
                wlog.info('  Handling speedbump...');
                const speedbumpCount = stateHistory.filter(s => s === 'speedbump').length;

                const kws = [
                    'i understand', 'understood', 'got it', 'accept', 'ok', 'continue', 'next',
                    'i agree', 'agree', '我了解', '我知道了', '知道了', '了解', '明白',
                    '接受', '确定', '好', '继续', '下一步', '我同意', '同意',
                ];

                // 策略 1: 提交按钮
                const submitClicked = await page.evaluate(() => {
                    const submits = document.querySelectorAll('input[type="submit"], button[type="submit"]');
                    for (const s of submits) {
                        const r = s.getBoundingClientRect();
                        if (r.width > 0 && r.height > 0) { s.click(); return true; }
                    }
                    return false;
                }).catch(() => false);

                if (!submitClicked) {
                    // 策略 2: Shadow DOM 深度搜索（类似 skippable_prompt）
                    const shadowClicked = await page.evaluate((kws2) => {
                        function findInShadow(root) {
                            const els = root.querySelectorAll('button, a, span, div[role="button"], input[type="submit"], [jscontroller]');
                            for (const el of els) {
                                const txt = (el.textContent || '').trim().toLowerCase();
                                const r = el.getBoundingClientRect();
                                if (r.width > 0 && r.height > 0 && kws2.some(k => txt === k || txt.includes(k))) {
                                    el.click();
                                    return txt;
                                }
                            }
                            const allEls = root.querySelectorAll('*');
                            for (const el of allEls) {
                                if (el.shadowRoot) {
                                    const result = findInShadow(el.shadowRoot);
                                    if (result) return result;
                                }
                            }
                            return null;
                        }
                        return findInShadow(document);
                    }, kws).catch(() => null);

                    if (shadowClicked) {
                        wlog.debug(`  Shadow DOM click: "${shadowClicked}"`);
                    } else {
                        // 策略 3: tryClickStrategies
                        const clicked = await tryClickStrategies(page, kws, wlog, 'speedbump');
                        if (!clicked) {
                            // 策略 4: 激进键盘导航（重试次数越多 Tab 次数越多）
                            const tabCount = 3 + speedbumpCount * 2;
                            wlog.debug(`  Keyboard fallback: ${tabCount} Tabs + Enter`);
                            for (let t = 0; t < tabCount; t++) {
                                await page.keyboard.press('Tab');
                                await sleep(80);
                            }
                            await page.keyboard.press('Enter');
                        }
                    }
                }

                await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 8000 }).catch(() => { });
                await sleep(1000);
                break;
            }

            case 'profile_info': {
                // 登记信息页面 — 填写手机号，其他字段通常已预填
                wlog.info('  Profile info page detected, filling phone number...');

                const phoneNumber = '+8613004588605';

                // 查找手机号输入框（尝试多种选择器）
                const phoneFilled = await page.evaluate((phone) => {
                    const selectors = [
                        'input[type="tel"]',
                        'input[name*="phone" i]',
                        'input[name*="Phone" i]',
                        'input[autocomplete*="tel"]',
                        'input[aria-label*="phone" i]',
                        'input[aria-label*="电话" i]',
                        'input[aria-label*="手机" i]',
                    ];
                    for (const sel of selectors) {
                        const inputs = document.querySelectorAll(sel);
                        for (const inp of inputs) {
                            const r = inp.getBoundingClientRect();
                            if (r.width > 0 && r.height > 0) {
                                inp.focus();
                                inp.click();
                                // 清空再填写
                                inp.value = '';
                                inp.dispatchEvent(new Event('input', { bubbles: true }));
                                return { found: true, sel };
                            }
                        }
                    }
                    return { found: false };
                }, phoneNumber).catch(() => ({ found: false }));

                if (phoneFilled.found) {
                    wlog.debug(`  Found phone input via: ${phoneFilled.sel}`);
                    // 用键盘输入最可靠
                    const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
                    await page.keyboard.down(mod);
                    await page.keyboard.press('KeyA');
                    await page.keyboard.up(mod);
                    await page.keyboard.press('Backspace');
                    await sleep(200);
                    await page.keyboard.type(phoneNumber, { delay: 30 });
                } else {
                    wlog.debug('  Phone input not found by selector, trying keyboard navigation...');
                    // 直接用 fastType 兜底
                    await fastType(page, 'input[type="tel"]', phoneNumber, wlog);
                }

                await sleep(1000);
                await takeScreenshot(page, `profile_info_filled_${account.email}`, wlog);

                // 点击 Next/Continue/提交（使用更多按钮文本）
                const nextClicked = await tryClickStrategies(page,
                    ['next', 'continue', 'submit', 'save', '下一步', '继续', '提交', '保存', '完成', 'done'],
                    wlog, 'profile_next');
                if (!nextClicked) {
                    // 尝试 Tab + Enter
                    for (let t = 0; t < 5; t++) { await page.keyboard.press('Tab'); await sleep(50); }
                    await page.keyboard.press('Enter');
                }
                await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(() => { });
                await sleep(3000);
                wlog.success('  Profile info submitted');
                break;
            }

            case 'skippable_prompt':
            case 'profile_address': {
                // 可跳过的中间页面（添加手机号、住址等）— 直接跳过
                wlog.info(`  Skippable page detected (${state}), skipping...`);

                const clicked = await tryClickStrategies(page,
                    ['skip', 'not now', 'later', 'no thanks', 'cancel', '跳过', '以后再说', '暂时不', '稍后', '不用了', '取消'],
                    wlog, 'skip_prompt');
                if (!clicked) {
                    await tryClickStrategies(page,
                        ['next', 'continue', 'done', '下一步', '继续', '完成'],
                        wlog, 'skip_next');
                }
                await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 10000 }).catch(() => { });
                await sleep(2000);
                wlog.success('  Page skipped');
                break;
            }

            case 'chrome_sync': {
                wlog.info('  Handling Chrome sync prompt...');
                const kws = ['continue as', 'continue', 'without signing', 'no thanks', 'skip',
                    '身份继续', '继续', '不登录', '取消', '跳过'];
                const clicked = await tryClickStrategies(page, kws, wlog, 'chrome_sync');
                if (!clicked) await page.keyboard.press('Enter');
                await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 5000 }).catch(() => { });
                await sleep(500);
                break;
            }

            case 'managed_profile': {
                wlog.info('  Handling managed profile...');
                const kws = ['continue', 'accept', 'ok', 'i understand', '继续', '接受', '确定', '我了解'];
                const clicked = await tryClickStrategies(page, kws, wlog, 'managed');
                if (!clicked) await page.keyboard.press('Enter');
                await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 5000 }).catch(() => { });
                await sleep(500);
                break;
            }

            case 'tos': {
                wlog.info('  Handling ToS...');
                const kws = ['agree', 'accept', 'i agree', 'ok', 'continue', '同意', '接受', '我同意', '确定', '继续'];
                const clicked = await tryClickStrategies(page, kws, wlog, 'tos');
                if (!clicked) await page.keyboard.press('Enter');
                await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 5000 }).catch(() => { });
                await sleep(500);
                break;
            }

            case 'confirm_signin': {
                wlog.info('  Handling sign-in confirm...');
                // Dump visible buttons on the first pass to diagnose the page
                if (step <= 6) {
                    try {
                        const info = await page.evaluate(() => {
                            function isVisible(el) {
                                const r = el.getBoundingClientRect();
                                const s = window.getComputedStyle(el);
                                return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden';
                            }
                            const out = [];
                            for (const el of document.querySelectorAll('button, a, [role="button"], input[type="submit"]')) {
                                if (!isVisible(el)) continue;
                                const t = (el.textContent || '').trim().substring(0, 60);
                                const a = (el.getAttribute('aria-label') || '').substring(0, 60);
                                if (!t && !a) continue;
                                out.push(`[${el.tagName}] "${t}" aria="${a}"`);
                            }
                            return { url: location.href, title: document.title.substring(0, 100), buttons: out.slice(0, 15) };
                        });
                        wlog.info(`  [confirm_signin DUMP] url=${info.url}`);
                        wlog.info(`  [confirm_signin DUMP] title=${info.title}`);
                        for (const b of info.buttons) wlog.info(`  [confirm_signin DUMP]   ${b}`);
                    } catch (_) { }
                }
                // Strict click: match only by explicit keywords on text/aria (avoid fuzzy false positives)
                const kws = ['continue', 'sign in', 'yes', 'allow', 'accept', 'confirm',
                    '继续', '登录', '是', '允许', '确认'];
                const clicked = await page.evaluate((keywords) => {
                    function isVisible(el) {
                        const r = el.getBoundingClientRect();
                        const s = window.getComputedStyle(el);
                        return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden';
                    }
                    const lc = keywords.map(k => k.toLowerCase());
                    const cands = [];
                    const sel = 'button, a, [role="button"], input[type="submit"], input[type="button"]';
                    for (const el of document.querySelectorAll(sel)) {
                        if (!isVisible(el)) continue;
                        if (el.disabled || el.getAttribute('aria-disabled') === 'true') continue;
                        const text = (el.textContent || '').trim().toLowerCase();
                        const aria = (el.getAttribute('aria-label') || '').toLowerCase();
                        const hay = (text + ' ' + aria).trim();
                        if (!hay) continue;
                        for (const k of lc) {
                            if (hay.includes(k)) { cands.push({ el, hay, kwLen: k.length }); break; }
                        }
                    }
                    if (!cands.length) return null;
                    cands.sort((a, b) => (b.kwLen - a.kwLen) || (a.hay.length - b.hay.length));
                    cands[0].el.click();
                    return (cands[0].el.textContent || cands[0].el.getAttribute('aria-label') || '').trim().substring(0, 60);
                }, kws).catch(() => null);
                if (clicked) wlog.info(`  confirm_signin clicked: "${clicked}"`);
                else {
                    wlog.debug('  No confirm button found, pressing Enter as fallback');
                    await page.keyboard.press('Enter');
                }
                await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 8000 }).catch(() => { });
                await sleep(1500);
                break;
            }

            case 'choose_account': {
                wlog.info('  Handling account chooser...');
                const kws = ['use another', 'other account', 'add another', '使用其他', '其他帐号', '添加其他'];
                const clicked = await tryClickStrategies(page, kws, wlog, 'choose_account');
                if (clicked) {
                    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 5000 }).catch(() => { });
                } else {
                    await page.keyboard.press('Tab');
                    await sleep(50);
                    await page.keyboard.press('Enter');
                }
                await sleep(500);
                break;
            }

            case 'challenge': {
                wlog.info('  ============================================');
                wlog.info('  Security challenge detected!');
                wlog.info('  Please complete the verification manually in the Chrome window.');
                wlog.info('  Waiting for you to finish (checking every 5s, timeout 5min)...');
                wlog.info('  ============================================');
                await takeScreenshot(page, `challenge_${account.email}`, wlog);

                // 等待人工介入完成验证（最多5分钟）
                const challengeStart = Date.now();
                const CHALLENGE_TIMEOUT = 5 * 60 * 1000;
                let challengeResolved = false;

                while (Date.now() - challengeStart < CHALLENGE_TIMEOUT) {
                    await sleep(5000);
                    const currentUrl = page.url();
                    const newState = await detectPageState(page, wlog);

                    // 如果离开了 challenge 页面，说明人工验证完成
                    if (newState.state !== 'challenge' &&
                        !currentUrl.includes('challenge') &&
                        !currentUrl.includes('rejected')) {
                        wlog.success('  Manual verification completed!');
                        challengeResolved = true;
                        break;
                    }

                    // 如果到达 rejected 页面，也视为人工可能正在处理
                    if (currentUrl.includes('rejected')) {
                        const elapsed = Math.round((Date.now() - challengeStart) / 1000);
                        wlog.info(`  Still on rejected page... (${elapsed}s elapsed)`);
                    }
                }

                if (!challengeResolved) {
                    throw new Error('challenge_timeout: manual verification not completed within 5 minutes');
                }
                break;
            }

            case 'verify_recovery_email': {
                // 优先级 1：备用邮箱验证 — 自动填写
                if (!account.recovery) {
                    wlog.warn('  Recovery email verification required but no recovery email configured!');
                    wlog.warn(`  Add recovery email to members.txt: ${account.email}:password:recovery@email.com`);
                    await takeScreenshot(page, `verify_no_recovery_${account.email}`, wlog);
                    throw new Error('recovery_email_required_but_not_configured');
                }

                wlog.info(`  Entering recovery email: ${account.recovery}`);

                // 先尝试点击输入框聚焦
                const inputFocused = await page.evaluate(() => {
                    function findInputInShadow(root) {
                        const selectors = [
                            'input[name="knowledgePreregisteredEmailResponse"]',
                            'input[type="email"]',
                            'input[type="text"]',
                            'input:not([type="hidden"]):not([type="password"]):not([type="submit"])',
                        ];
                        for (const sel of selectors) {
                            const inputs = root.querySelectorAll(sel);
                            for (const inp of inputs) {
                                const r = inp.getBoundingClientRect();
                                if (r.width > 0 && r.height > 0) {
                                    inp.focus();
                                    inp.click();
                                    // 清空现有内容
                                    inp.value = '';
                                    inp.dispatchEvent(new Event('input', { bubbles: true }));
                                    return true;
                                }
                            }
                        }
                        const allEls = root.querySelectorAll('*');
                        for (const el of allEls) {
                            if (el.shadowRoot) {
                                const result = findInputInShadow(el.shadowRoot);
                                if (result) return result;
                            }
                        }
                        return false;
                    }
                    return findInputInShadow(document);
                }).catch(() => false);

                if (inputFocused) {
                    // 用键盘 Ctrl+A 清空再输入，最可靠
                    const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
                    await page.keyboard.down(mod);
                    await page.keyboard.press('KeyA');
                    await page.keyboard.up(mod);
                    await page.keyboard.press('Backspace');
                    await sleep(200);
                    await page.keyboard.type(account.recovery, { delay: 30 });
                } else {
                    // 尝试用 fastType 兜底
                    await fastType(page, 'input[type="email"], input[type="text"]', account.recovery, wlog);
                }

                await sleep(500);
                // 先尝试点击 "Next" / "下一步" 按钮
                const nextClicked = await tryClickStrategies(page,
                    ['next', 'continue', '下一步', '继续', '下一个', 'verify', '验证'],
                    wlog, 'recovery_next');
                if (!nextClicked) {
                    await page.keyboard.press('Enter');
                }
                await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(() => { });
                await sleep(3000);

                // 检查是否有错误提示（备用邮箱错误）
                const recoveryError = await page.evaluate(() => {
                    const text = (document.body ? document.body.innerText : '').toLowerCase();
                    return text.includes('wrong') || text.includes('incorrect') ||
                        text.includes('try again') || text.includes('错误') ||
                        text.includes('不正确') || text.includes('重试');
                }).catch(() => false);

                if (recoveryError) {
                    await takeScreenshot(page, `verify_recovery_wrong_${account.email}`, wlog);
                    throw new Error('Wrong recovery email');
                }

                wlog.success('  Recovery email submitted');
                break;
            }

            case 'verify_authenticator': {
                if (account.totp_secret) {
                    // 自动生成并填入 TOTP 验证码
                    const { code, remainingSeconds } = getTOTPWithTTL(account.totp_secret);
                    wlog.info('  ============================================');
                    wlog.info('  Auto-generating TOTP code from fa_secret');
                    wlog.info(`  Account: ${account.email}`);
                    wlog.info(`  Code: ${code} (valid for ${remainingSeconds}s)`);
                    wlog.info('  ============================================');

                    // 如果剩余时间太短，等待下一个周期
                    if (remainingSeconds < 5) {
                        wlog.info(`  Code expiring soon, waiting ${remainingSeconds + 1}s for new code...`);
                        await sleep((remainingSeconds + 1) * 1000);
                        const fresh = getTOTPWithTTL(account.totp_secret);
                        wlog.info(`  New code: ${fresh.code} (valid for ${fresh.remainingSeconds}s)`);
                        var totpCode = fresh.code;
                    } else {
                        var totpCode = code;
                    }

                    // 定位 TOTP 输入框的精确 selector（按优先级），再用 fastType 一次性写入
                    const totpSelector = await page.evaluate(() => {
                        const sels = ['#totpPin', '#idvPin',
                            'input[name*="totpPin" i]', 'input[name*="pin" i]', 'input[name*="code" i]',
                            'input[aria-label*="code" i]', 'input[aria-label*="验证码" i]',
                            'input[type="tel"]', 'input[type="number"]', 'input[type="text"]'];
                        const isVisible = (e) => {
                            const r = e.getBoundingClientRect();
                            const s = window.getComputedStyle(e);
                            return r.width > 0 && r.height > 0
                                && s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0'
                                && e.getAttribute('aria-hidden') !== 'true' && !e.disabled;
                        };
                        for (const sel of sels) {
                            if (Array.from(document.querySelectorAll(sel)).some(isVisible)) return sel;
                        }
                        return null;
                    });

                    if (!totpSelector) {
                        // 页面可能还在渲染输入框，等一下再让外层循环重新判一次状态
                        wlog.warn('  TOTP input not found, waiting 1.5s before retry');
                        await sleep(1500);
                        break;
                    }
                    await fastType(page, totpSelector, totpCode, wlog);
                    await sleep(150);
                    // 显式 focus 后 Enter，避免按钮匹配落空 + 焦点丢失
                    await page.focus(totpSelector).catch(() => { });
                    await page.keyboard.press('Enter');
                    // 不等 networkidle2（太慢），改为等"离开 totp 输入页"或验证码框消失
                    await page.waitForFunction(() => {
                        if (!/\/challenge\/(totp|ipp)(\/|\?|$)/i.test(location.pathname)) return true;
                        const inp = document.querySelector('#totpPin, input[name*="totpPin" i], input[name*="pin" i]');
                        return !inp || inp.disabled;
                    }, { timeout: 8000 }).catch(() => { });
                    await sleep(500);

                    // 检查是否通过
                    const postState = await detectPageState(page, wlog);
                    if (postState.state === 'verify_authenticator') {
                        wlog.warn('  TOTP code may have been rejected, will retry on next loop...');
                    } else {
                        wlog.success('  TOTP verification completed automatically!');
                    }
                } else {
                    // 无 fa_secret — 回退到手动模式
                    wlog.info('  ============================================');
                    wlog.info('  Google Authenticator code required!');
                    wlog.info(`  Account: ${account.email}`);
                    wlog.info('  No totp_secret configured — manual input required.');
                    wlog.info('  Please enter the 6-digit code in the Chrome window.');
                    wlog.info('  Waiting (checking every 5s, timeout 5min)...');
                    wlog.info('  ============================================');
                    await takeScreenshot(page, `verify_authenticator_${account.email}`, wlog);

                    const authStart = Date.now();
                    const AUTH_TIMEOUT = 5 * 60 * 1000;
                    let authResolved = false;

                    while (Date.now() - authStart < AUTH_TIMEOUT) {
                        await sleep(5000);
                        const newState = await detectPageState(page, wlog);
                        if (newState.state !== 'verify_authenticator' &&
                            newState.state !== 'identity_verify' &&
                            newState.state !== 'challenge') {
                            wlog.success('  Authenticator verification completed!');
                            authResolved = true;
                            break;
                        }
                    }

                    if (!authResolved) {
                        throw new Error('authenticator_verification_timeout');
                    }
                }
                break;
            }

            case 'verify_phone':
            case 'phone_verification': {
                // 手机短信验证 — 使用 hero-sms API 自动获取验证码
                wlog.info('  ============================================');
                wlog.info('  Phone/SMS verification required!');
                wlog.info(`  Account: ${account.email}`);
                wlog.info('  ============================================');
                await takeScreenshot(page, `verify_phone_${account.email}`, wlog);

                const smsApiKey = process.env.HERO_SMS_API_KEY;
                if (!smsApiKey) {
                    // 没有配置 API Key，退回手动模式
                    wlog.warn('  HERO_SMS_API_KEY not configured, waiting for manual input...');
                    wlog.info('  Please complete SMS verification manually in the Chrome window.');
                    wlog.info('  Waiting (checking every 5s, timeout 5min)...');

                    const phoneStartManual = Date.now();
                    let phoneResolvedManual = false;
                    while (Date.now() - phoneStartManual < 5 * 60 * 1000) {
                        await sleep(5000);
                        const ns = await detectPageState(page, wlog);
                        if (ns.state !== 'verify_phone' && ns.state !== 'phone_verification' &&
                            ns.state !== 'identity_verify' && ns.state !== 'challenge') {
                            wlog.success('  Phone verification completed!');
                            phoneResolvedManual = true;
                            break;
                        }
                    }
                    if (!phoneResolvedManual) throw new Error('phone_verification_timeout');
                    break;
                }

                // 有 API Key，自动获取号码和验证码（支持换号重试）
                const SMS_MAX_RETRIES = parseInt(process.env.HERO_SMS_MAX_RETRIES || '3', 10);
                let smsSuccess = false;

                for (let smsAttempt = 1; smsAttempt <= SMS_MAX_RETRIES; smsAttempt++) {
                    let phoneSubmitted = false;
                    try {
                        wlog.info(`  [SMS] Attempt ${smsAttempt}/${SMS_MAX_RETRIES}`);
                        const smsResult = await smsProvider.getNumberAndWaitCode({
                            service: process.env.HERO_SMS_SERVICE || 'go',
                            country: parseInt(process.env.HERO_SMS_COUNTRY || '0', 10),
                            timeout: parseInt(process.env.HERO_SMS_TIMEOUT || '120', 10),
                            pollInterval: parseInt(process.env.HERO_SMS_POLL_INTERVAL || '5', 10),
                            wlog,
                            onNumber: async (phone) => {
                                const phoneFormatted = phone.startsWith('+') ? phone : `+${phone}`;
                                wlog.info(`  [SMS] Filling phone number: ${phoneFormatted}`);

                                // 查找手机号输入框
                                const found = await page.evaluate(() => {
                                    const sels = ['input[type="tel"]', 'input[name*="phone" i]',
                                        'input[autocomplete*="tel"]', 'input[aria-label*="phone" i]',
                                        'input[aria-label*="\u7535\u8bdd" i]'];
                                    for (const sel of sels) {
                                        for (const inp of document.querySelectorAll(sel)) {
                                            const r = inp.getBoundingClientRect();
                                            if (r.width > 0 && r.height > 0) {
                                                inp.focus(); inp.click(); inp.value = '';
                                                inp.dispatchEvent(new Event('input', { bubbles: true }));
                                                return true;
                                            }
                                        }
                                    }
                                    return false;
                                }).catch(() => false);

                                if (found) {
                                    const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
                                    await page.keyboard.down(mod);
                                    await page.keyboard.press('KeyA');
                                    await page.keyboard.up(mod);
                                    await page.keyboard.press('Backspace');
                                    await sleep(200);
                                    await page.keyboard.type(phoneFormatted, { delay: 30 });
                                } else {
                                    await fastType(page, 'input[type="tel"]', phoneFormatted, wlog);
                                }

                                await sleep(500);
                                const sendClicked = await tryClickStrategies(page,
                                    ['send', 'next', 'get code', 'send code', '\u53d1\u9001', '\u4e0b\u4e00\u6b65', '\u83b7\u53d6\u9a8c\u8bc1\u7801'],
                                    wlog, 'phone_send');
                                if (!sendClicked) await page.keyboard.press('Enter');
                                await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(() => {});
                                await sleep(3000);
                                phoneSubmitted = true;
                                wlog.info('  [SMS] Phone number submitted, waiting for code...');
                            },
                        });

                        // 收到验证码，填入页面
                        wlog.info(`  [SMS] Entering verification code: ${smsResult.code}`);
                        const codeFound = await page.evaluate(() => {
                            const sels = ['input[type="tel"]', 'input[type="number"]', 'input[type="text"]',
                                'input[name*="code" i]', 'input[name*="pin" i]',
                                'input[aria-label*="code" i]', 'input[aria-label*="\u9a8c\u8bc1\u7801" i]'];
                            for (const sel of sels) {
                                for (const inp of document.querySelectorAll(sel)) {
                                    const r = inp.getBoundingClientRect();
                                    if (r.width > 0 && r.height > 0) {
                                        inp.focus(); inp.click(); inp.value = '';
                                        inp.dispatchEvent(new Event('input', { bubbles: true }));
                                        return true;
                                    }
                                }
                            }
                            return false;
                        }).catch(() => false);

                        if (codeFound) {
                            const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
                            await page.keyboard.down(mod);
                            await page.keyboard.press('KeyA');
                            await page.keyboard.up(mod);
                            await page.keyboard.press('Backspace');
                            await sleep(200);
                            await page.keyboard.type(smsResult.code, { delay: 30 });
                        } else {
                            await fastType(page, 'input[type="tel"], input[type="text"]', smsResult.code, wlog);
                        }

                        await sleep(500);
                        const verifyClicked = await tryClickStrategies(page,
                            ['verify', 'next', 'continue', 'confirm', '\u9a8c\u8bc1', '\u4e0b\u4e00\u6b65', '\u7ee7\u7eed', '\u786e\u8ba4'],
                            wlog, 'phone_verify');
                        if (!verifyClicked) await page.keyboard.press('Enter');
                        await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(() => {});
                        await sleep(3000);
                        wlog.success('  [SMS] Phone verification code submitted!');
                        smsSuccess = true;
                        break;

                    } catch (smsErr) {
                        wlog.error(`  [SMS] Attempt ${smsAttempt} failed: ${smsErr.message}`);
                        if (smsAttempt < SMS_MAX_RETRIES) {
                            wlog.info(`  [SMS] Retrying with new number...`);
                            // 号码还没填进页面（SMS 接口本身就失败了）→ 页面没动，直接重试，不要 goBack
                            if (!phoneSubmitted) {
                                await sleep(1500);
                                continue;
                            }
                            // 已经提交过手机号，页面跳到验证码页/卡住 → 才需要回退
                            await page.goBack({ waitUntil: 'networkidle2', timeout: 10000 }).catch(() => {});
                            await sleep(2000);
                            const retryState = await detectPageState(page, wlog);
                            if (retryState.state !== 'verify_phone' && retryState.state !== 'phone_verification') {
                                wlog.warn(`  [SMS] Could not return to phone input (state: ${retryState.state})`);
                                if (retryState.state === 'identity_verify') {
                                    const reClicked = await tryClickStrategies(page,
                                        ['verifying your phone', 'verify your phone', 'phone number',
                                            '验证您的电话', '电话号码', '手机号码', '短信', 'sms', 'text message',
                                            'get a verification code'],
                                        wlog, 'retry_select_phone');
                                    if (reClicked) {
                                        await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 8000 }).catch(() => {});
                                        await sleep(3000);
                                    }
                                }
                            }
                        }
                    }
                }

                if (!smsSuccess) {
                    wlog.warn('  [SMS] All auto attempts exhausted, falling back to manual mode...');
                    await takeScreenshot(page, `sms_all_failed_${account.email}`, wlog);

                    const phoneStartFb = Date.now();
                    let phoneResolvedFb = false;
                    while (Date.now() - phoneStartFb < 5 * 60 * 1000) {
                        await sleep(5000);
                        const ns = await detectPageState(page, wlog);
                        if (ns.state !== 'verify_phone' && ns.state !== 'phone_verification' &&
                            ns.state !== 'identity_verify' && ns.state !== 'challenge') {
                            wlog.success('  Phone verification completed!');
                            phoneResolvedFb = true;
                            break;
                        }
                    }
                    if (!phoneResolvedFb) throw new Error('phone_verification_timeout');
                }
                break;
            }

            case 'identity_verify': {
                // 通用身份验证 — 按优先级选择验证方式
                wlog.info('  Identity verification required, checking available methods...');
                await takeScreenshot(page, `identity_verify_${account.email}`, wlog);

                // 检测是否反复进入 identity_verify（说明选择后没生效）
                const identityCount = stateHistory.filter(s => s === 'identity_verify').length;
                if (identityCount >= 4) {
                    wlog.warn('  identity_verify repeated too many times, falling back to manual mode');
                    wlog.info('  ============================================');
                    wlog.info(`  Account: ${account.email}`);
                    wlog.info('  Please complete verification manually in the Chrome window.');
                    wlog.info('  Waiting (checking every 5s, timeout 5min)...');
                    wlog.info('  ============================================');

                    const verifyStart = Date.now();
                    let verifyResolved = false;
                    while (Date.now() - verifyStart < 5 * 60 * 1000) {
                        await sleep(5000);
                        const newState = await detectPageState(page, wlog);
                        if (newState.state !== 'identity_verify' && newState.state !== 'challenge') {
                            wlog.success('  Identity verification completed!');
                            verifyResolved = true;
                            break;
                        }
                    }
                    if (!verifyResolved) throw new Error('identity_verification_timeout');
                    break;
                }

                // 按优先级尝试选择验证方式：备用邮箱 > 验证码 > 手机短信
                const methodPriority = [
                    {
                        name: 'recovery_email',
                        keywords: ['确认您的辅助邮箱', '辅助邮箱', 'recovery email', 'confirm your recovery email'],
                        condition: () => !!account.recovery,
                    },
                    {
                        name: 'authenticator',
                        keywords: ['authenticator', 'google 验证', '验证码应用', '两步验证'],
                        condition: () => true,
                    },
                    {
                        name: 'phone',
                        keywords: ['verifying your phone', 'verify your phone', 'phone number',
                            '验证您的电话', '电话号码', '手机号码', '短信', 'sms', 'text message',
                            'get a verification code'],
                        condition: () => true,
                    },
                ];

                let methodSelected = false;
                for (const method of methodPriority) {
                    if (method.condition()) {
                        const clicked = await tryClickStrategies(page, method.keywords, wlog, `select_${method.name}`);
                        if (clicked) {
                            wlog.info(`  Selected ${method.name} verification method`);
                            // Google 可能用 AJAX 更新页面而非整页导航，两种都等
                            await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 8000 }).catch(() => { });
                            await sleep(3000);
                            // 检查页面是否已变化
                            const afterState = await detectPageState(page, wlog);
                            if (afterState.state === 'identity_verify') {
                                // 页面没变，可能需要点击 Next/Continue
                                wlog.debug('  Page still on identity_verify after click, trying Next...');
                                const nextClicked = await tryClickStrategies(page,
                                    ['next', 'continue', '下一步', '继续', 'try another way', '尝试其他方式'],
                                    wlog, 'identity_next');
                                if (nextClicked) {
                                    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 8000 }).catch(() => { });
                                    await sleep(2000);
                                }
                            }
                            methodSelected = true;
                            break;
                        }
                    }
                }

                if (!methodSelected) {
                    // 没有找到可自动选择的方式，等待人工处理
                    wlog.warn('  Could not find preferred verification method');
                    wlog.info('  ============================================');
                    wlog.info(`  Account: ${account.email}`);
                    wlog.info('  Please complete verification manually in the Chrome window.');
                    wlog.info('  Waiting (checking every 5s, timeout 5min)...');
                    wlog.info('  ============================================');

                    const verifyStart = Date.now();
                    const VERIFY_TIMEOUT = 5 * 60 * 1000;
                    let verifyResolved = false;

                    while (Date.now() - verifyStart < VERIFY_TIMEOUT) {
                        await sleep(5000);
                        const newState = await detectPageState(page, wlog);
                        if (newState.state !== 'identity_verify' &&
                            newState.state !== 'challenge') {
                            wlog.success('  Identity verification completed!');
                            verifyResolved = true;
                            break;
                        }
                    }

                    if (!verifyResolved) {
                        throw new Error('identity_verification_timeout');
                    }
                }
                break;
            }

            case 'error': {
                const errText = await page.evaluate(() => {
                    return document.body
                        ? document.body.innerText.substring(0, 500).replace(/\n/g, ' ')
                        : 'unknown error';
                }).catch(() => 'could not read error page');
                await takeScreenshot(page, `login_error_${account.email}`, wlog);
                throw new Error(`Login blocked: ${errText.substring(0, 200)}`);
            }

            case 'oauth_consent': {
                // 登录完成后到达 OAuth 同意页面——这不是 google-login 要处理的
                // 返回给调用方处理
                wlog.info('  Login complete (reached OAuth consent)');
                return;
            }

            case 'callback':
                wlog.info('  Login complete (reached callback)');
                return;

            case 'chrome_internal':
            case 'blank':
                wlog.debug('  Chrome internal/blank page, waiting...');
                await sleep(1000);
                break;

            case 'unknown': {
                // 检查是否已经到达目标页面（非 Google 登录页）
                const currentUrl = page.url();
                if (!currentUrl.includes('accounts.google.com') &&
                    !currentUrl.includes('about:blank') &&
                    !currentUrl.startsWith('chrome://') &&
                    !currentUrl.includes('workspace.google.com') &&
                    !currentUrl.includes('google.com/gmail') &&
                    !currentUrl.includes('accounts.youtube.com')) {
                    wlog.info(`  Login appears complete (URL: ${currentUrl.substring(0, 80)})`);
                    return;
                }

                // 检查是否到达 rejected 页面——也需要等待人工介入
                if (currentUrl.includes('rejected')) {
                    wlog.info('  ============================================');
                    wlog.info('  Login rejected by Google!');
                    wlog.info('  Please resolve manually in the Chrome window.');
                    wlog.info('  (e.g., try logging in again or verify identity)');
                    wlog.info('  Waiting for you to finish (checking every 5s, timeout 5min)...');
                    wlog.info('  ============================================');
                    await takeScreenshot(page, `rejected_${account.email}`, wlog);

                    const rejStart = Date.now();
                    const REJ_TIMEOUT = 5 * 60 * 1000;
                    let rejResolved = false;

                    while (Date.now() - rejStart < REJ_TIMEOUT) {
                        await sleep(5000);
                        const rejUrl = page.url();
                        if (!rejUrl.includes('rejected') &&
                            !rejUrl.includes('challenge') &&
                            !rejUrl.includes('signin')) {
                            wlog.success('  Manual intervention completed!');
                            rejResolved = true;
                            break;
                        }
                        // 也检测是否登录成功到了其他页面
                        if (!rejUrl.includes('accounts.google.com')) {
                            wlog.success('  Login completed after manual intervention!');
                            rejResolved = true;
                            break;
                        }
                    }

                    if (!rejResolved) {
                        throw new Error('rejected_timeout: manual intervention not completed within 5 minutes');
                    }
                    break;
                }

                wlog.warn('  Unknown page state');
                await takeScreenshot(page, `login_unknown_${account.email}_step${step}`, wlog).catch(() => {});

                // 非英文页面可能因为按钮匹配不上而卡在 unknown，再尝试一次强制切换英文
                const switched = await forceEnglishUI(page, wlog);
                if (switched) {
                    // 切换后页面已重载，回到循环顶部重新检测
                    break;
                }

                // 页面可能还在加载，先等一下再操作
                await sleep(2000);

                try {
                    const unknownKws = [
                        'continue', 'next', 'ok', 'accept', 'agree', 'allow', 'confirm', 'sign in',
                        '继续', '下一步', '确定', '接受', '同意', '允许', '确认', '登录',
                        '我了解', '我知道了', '了解', 'i understand', 'got it',
                    ];
                    const clicked = await tryClickStrategies(page, unknownKws, wlog, 'unknown');
                    if (!clicked) {
                        for (let t = 0; t < 3; t++) { await page.keyboard.press('Tab'); await sleep(50); }
                        await page.keyboard.press('Enter');
                    }
                } catch (unknownErr) {
                    wlog.debug(`  Unknown state handler error: ${unknownErr.message}`);
                }
                await sleep(1000);
                break;
            }
        }
    }

    throw new Error('Login flow exceeded max steps');
}

module.exports = { googleLogin };
