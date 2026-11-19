// 在页面内执行；不读取输入框的值，避免把密码或验证码带入诊断记录。
function readLoginState(previous) {
    const visible = el => {
        const style = getComputedStyle(el);
        return el.getClientRects().length > 0 && style.visibility !== 'hidden'
            && style.opacity !== '0' && !el.closest('[aria-hidden="true"]');
    };
    const ready = selector => [...document.querySelectorAll(selector)]
        .some(el => visible(el) && !el.disabled && !el.readOnly);
    const captchaVisible = el => {
        const rect = el.getBoundingClientRect();
        return visible(el) && rect.width >= 20 && rect.height >= 20
            && rect.bottom > 0 && rect.right > 0 && rect.top < innerHeight && rect.left < innerWidth;
    };
    const state = {
        origin: location.origin,
        pathname: location.pathname,
        text: document.body?.innerText || '',
        email: ready('#identifierId:not([type="hidden"])'),
        password: ready('input[name="Passwd"]'),
        totp: ready('#totpPin'),
        chooser: ready('[data-identifier],[data-email]'),
        captcha: [...document.querySelectorAll('input[name="ca"], input[name*="captcha" i], iframe[src*="recaptcha"], iframe[src*="hcaptcha"]')].some(captchaVisible),
        phone: ready('input[type="tel"]:not(#totpPin):not([name="Pin"]):not(#securityKeyOtpInputId)'),
        busy: [...document.querySelectorAll('[role="progressbar"], [aria-busy="true"]')].some(visible),
        buttons: [...document.querySelectorAll('button,[role="link"],[role="button"]')]
            .filter(el => visible(el) && !el.disabled && el.getAttribute('aria-disabled') !== 'true')
            .map(el => el.innerText.trim()),
    };
    return previous === JSON.stringify(state) ? false : state;
}

function loginAction(state) {
    if (state.busy) return null;
    const has = re => state.buttons.some(text => re.test(text));
    const route = state.pathname;
    if (/\/accountchooser\/?$/.test(route)) return state.chooser ? '选择目标账号' : null;
    // 验证器输入框已出现时直接提交，不再切换验证方式。
    if (state.totp && /\/challenge\//.test(route)) return '验证器验证码';
    if (/\/identifier\/?$/.test(route)) return state.email ? '邮箱' : null;
    if (/\/challenge\/pwd\/?$/.test(route)) return state.password ? '密码' : null;
    if (/\/challenge\/(totp|ipp)\/?$/.test(route)) return state.totp ? '验证器验证码' : null;
    if (/\/challenge\/selection\/?$/.test(route)) {
        return has(/身份验证器|Authenticator/i) ? '选择身份验证器' : null;
    }
    if (route.includes('/speedbump/passkeyenrollment')) {
        return has(/^(以后再说|Not now|Skip)$/i) ? '跳过通行密钥' : null;
    }
    if (/\/(speedbump|interstitial|signin\/chip)/.test(route)
        && has(/^(跳过|以后再说|暂不|不用了|Skip|Not now|Maybe later|No thanks)$/i)) return '跳过补充信息';
    // 路径已跳转而旧表单还在时，等待新的验证控件，不重复操作旧页面。
    if (state.email || state.password || state.totp) return null;
    if (/\/challenge\//.test(route) && has(/^(试试其他方式|Try another way)$/i)) return '其他验证方式';
    return null;
}

function skipReason(state) {
    const text = state.text || '';
    if (state.origin === 'https://myaccount.google.com') {
        if (/^\/restrictions\/account\//.test(state.pathname)) return 'Google账号服务受限';
        if (/^\/verification\/selfie\//.test(state.pathname)) return '要求自拍视频验证';
    }
    // Gemini正文和历史标题可能包含这些词，不能将聊天内容误判为登录风控。
    const authenticationPage = !state.origin || ['https://accounts.google.com', 'https://gds.google.com', 'https://myaccount.google.com', 'https://www.google.com'].includes(state.origin);
    if (state.captcha || /\/(sorry|captcha|recaptcha)(\/|$)/i.test(state.pathname)
        || (authenticationPage && /证明您不是机器人|证明你不是机器人|验证您不是机器人|prove you.re not a robot|verify you are human|人机验证/i.test(text))) return '人机验证';
    if (authenticationPage && /此浏览器或应用可能不安全|browser or app may not be secure/i.test(text)) return '浏览器安全限制';
    if (authenticationPage && /异常活动|异常流量|可疑活动|可疑登录|unusual activity|unusual traffic|suspicious activity|suspicious sign.in|too many (?:failed )?attempts|尝试次数过多|尝试次数太多|无法验证此账号归您所有|couldn.t verify this account belongs to you/i.test(text)) return '风控或尝试次数限制';
    if (authenticationPage && /账号已停用|账号已被停用|account has been disabled/i.test(text)) return '账号停用';
    const optionalPage = /\/(speedbump|interstitial|signin\/chip)/.test(state.pathname);
    const canSkip = state.buttons?.some(value => /^(跳过|以后再说|暂不|不用了|Skip|Not now|Maybe later|No thanks)$/i.test(value));
    if (optionalPage && !state.busy && !canSkip && (state.phone
        || /添加.*(?:手机号|电话号码|地址)|add.*(?:phone number|address)|enter your (?:phone number|address)/i.test(text))) return '补充信息无法跳过';
    return null;
}

function retryDelay(action, attempts) {
    // 通行密钥提示提交后可能仍显示可点按钮，后台登录完成前重复点击会使流程失效。
    // 等待期间仍通过页面状态变化立即推进，无需固定睡满间隔。
    if (action === '跳过通行密钥') return 60000;
    // 密码/验证码提交保留保守间隔；其他按钮未推进时更早检查并重试。
    if (['邮箱', '密码', '验证器验证码'].includes(action)) return 25000;
    return attempts <= 1 ? 5000 : attempts === 2 ? 10000 : 25000;
}

module.exports = { readLoginState, loginAction, retryDelay, skipReason };
