/**
 * Google 登录状态机 — 供所有阶段脚本复用
 *
 * 处理：email 输入 → 密码输入 → 各种中间页面（speedbump, chrome_sync, tos, challenge 等）
 * 登录完成后返回 page 供调用方继续操作
 */

const { LOG_COLORS } = require('./logger');
const {
    sleep, fastType, detectPageState, tryClickStrategies,
    takeScreenshot, listVisibleElements, fastClick,
} = require('./chrome');

const MAX_LOGIN_STEPS = 25;

/**
 * 在 page 上完成 Google 登录流程
 * @param {Page} page - Puppeteer 页面（已导航到 Google 登录页或 OAuth 页）
 * @param {Object} account - { email, pass, recovery }
 * @param {Object} wlog - worker logger
 * @returns {Promise<void>} - 登录完成后返回（page 保持在登录后的目标页面）
 */
async function googleLogin(page, account, wlog) {
    const stateHistory = [];

    for (let step = 0; step < MAX_LOGIN_STEPS; step++) {
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
                await Promise.all([
                    page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(() => { }),
                    page.keyboard.press('Enter'),
                ]);
                await sleep(300);
                break;
            }

            case 'password': {
                // 如果连续多次回到 password 状态，说明密码错误，立即失败
                const pwCount = stateHistory.filter(s => s === 'password').length;
                if (pwCount >= 3) {
                    await takeScreenshot(page, `login_wrong_password_${account.email}`, wlog);
                    throw new Error('Wrong password: login returned to password page multiple times');
                }

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

                wlog.debug('Entering password');
                await fastType(page, 'input[type="password"]', account.pass, wlog);
                await sleep(100);
                await Promise.all([
                    page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(() => { }),
                    page.keyboard.press('Enter'),
                ]);
                await sleep(500);
                break;
            }

            case 'speedbump': {
                wlog.info('  Handling speedbump...');
                const kws = [
                    'i understand', 'understood', 'got it', 'accept', 'ok', 'continue', 'next',
                    'i agree', 'agree', '我了解', '我知道了', '知道了', '了解', '明白',
                    '接受', '确定', '好', '继续', '下一步', '我同意', '同意',
                ];
                const submitClicked = await page.evaluate(() => {
                    const submits = document.querySelectorAll('input[type="submit"], button[type="submit"]');
                    for (const s of submits) {
                        const r = s.getBoundingClientRect();
                        if (r.width > 0 && r.height > 0) { s.click(); return true; }
                    }
                    return false;
                }).catch(() => false);

                if (!submitClicked) {
                    const clicked = await tryClickStrategies(page, kws, wlog, 'speedbump');
                    if (!clicked) {
                        for (let t = 0; t < 8; t++) { await page.keyboard.press('Tab'); await sleep(50); }
                        await page.keyboard.press('Enter');
                    }
                }
                await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 8000 }).catch(() => { });
                await sleep(200);
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
                const kws = ['sign in', 'signin', 'confirm', 'continue', '登录', '确认', '继续'];
                const clicked = await tryClickStrategies(page, kws, wlog, 'confirm_signin');
                if (!clicked) await page.keyboard.press('Enter');
                await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 5000 }).catch(() => { });
                await sleep(500);
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

            case 'phone_verification': {
                wlog.info('  ============================================');
                wlog.info('  Phone verification required!');
                wlog.info('  Please complete it manually in the Chrome window.');
                wlog.info('  Waiting (checking every 5s, timeout 5min)...');
                wlog.info('  ============================================');
                await takeScreenshot(page, `phone_verify_${account.email}`, wlog);

                const phoneStart = Date.now();
                const PHONE_TIMEOUT = 5 * 60 * 1000;
                let phoneResolved = false;

                while (Date.now() - phoneStart < PHONE_TIMEOUT) {
                    await sleep(5000);
                    const newState = await detectPageState(page, wlog);
                    if (newState.state !== 'phone_verification' && newState.state !== 'challenge') {
                        wlog.success('  Phone verification completed!');
                        phoneResolved = true;
                        break;
                    }
                }

                if (!phoneResolved) {
                    throw new Error('phone_verification_timeout');
                }
                break;
            }

            case 'identity_verify': {
                wlog.warn('  Identity verification required!');
                await takeScreenshot(page, `identity_verify_${account.email}`, wlog);
                throw new Error('identity_verification_required');
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
                    !currentUrl.startsWith('chrome://')) {
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
                await takeScreenshot(page, `login_unknown_${account.email}_step${step}`, wlog);
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
                await sleep(1000);
                break;
            }
        }
    }

    throw new Error('Login flow exceeded max steps');
}

module.exports = { googleLogin };
