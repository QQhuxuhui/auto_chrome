// 在页面内执行；不读取输入框的值，避免把密码或验证码带入诊断记录。
function readLoginState(previous) {
    const visible = el => {
        const style = getComputedStyle(el);
        return el.getClientRects().length > 0 && style.visibility !== 'hidden'
            && style.opacity !== '0' && !el.closest('[aria-hidden="true"]');
    };
    const ready = selector => [...document.querySelectorAll(selector)]
        .some(el => visible(el) && !el.disabled && !el.readOnly);
    const state = {
        origin: location.origin,
        pathname: location.pathname,
        text: document.body?.innerText || '',
        email: ready('#identifierId:not([type="hidden"])'),
        password: ready('input[name="Passwd"]'),
        totp: ready('#totpPin'),
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
    if (/\/identifier\/?$/.test(route)) return state.email ? '邮箱' : null;
    if (/\/challenge\/pwd\/?$/.test(route)) return state.password ? '密码' : null;
    if (/\/challenge\/(totp|ipp)\/?$/.test(route)) return state.totp ? '验证器验证码' : null;
    if (/\/challenge\/selection\/?$/.test(route)) {
        return has(/身份验证器|Authenticator/i) ? '选择身份验证器' : null;
    }
    if (route.includes('/speedbump/passkeyenrollment')) {
        return has(/^(以后再说|Not now|Skip)$/i) ? '跳过通行密钥' : null;
    }
    // 路径已跳转而旧表单还在时，等待新的验证控件，不重复操作旧页面。
    if (state.email || state.password || state.totp) return null;
    if (/\/challenge\//.test(route) && has(/^(试试其他方式|Try another way)$/i)) return '其他验证方式';
    return null;
}

function retryDelay(action, attempts) {
    // 密码/验证码提交保留保守间隔；按钮未推进时更早检查并重试。
    if (['邮箱', '密码', '验证器验证码'].includes(action)) return 25000;
    return attempts <= 1 ? 5000 : attempts === 2 ? 10000 : 25000;
}

module.exports = { readLoginState, loginAction, retryDelay };
