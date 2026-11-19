const assert = require('node:assert/strict');
const { test } = require('node:test');
const { readyBatches } = require('./directory-export');
const { loginAction, skipReason } = require('./login-state');

test('每50个成功账号发布一个不可变批次，未完成账号不能被越过', () => {
    const rows = Array.from({ length: 120 }, (_, i) => ({ index: i + 1, status: 'success' }));
    rows[20].status = 'skipped'; rows[55].status = 'running';
    assert.deepEqual(readyBatches(rows, false).map(batch => batch.length), [50]);
    const first = readyBatches(rows, false)[0].map(row => row.index);
    rows[55].status = 'failed';
    assert.deepEqual(readyBatches(rows, false).map(batch => batch.length), [50, 50]);
    assert.deepEqual(readyBatches(rows, true).map(batch => batch.length), [50, 50, 18]);
    assert.deepEqual(readyBatches(rows, true)[0].map(row => row.index), first);
});

test('常规2FA不算风控，直接验证码页不切换方式，可选信息只点跳过', () => {
    const base = { pathname: '/v3/signin/challenge/totp', buttons: ['试试其他方式'], text: '为了保护您的账号安全，Google 希望确认是您本人在尝试登录', totp: true };
    assert.equal(skipReason(base), null);
    assert.equal(skipReason({ ...base, origin: 'https://myaccount.google.com', pathname: '/restrictions/account/most-services' }), 'Google账号服务受限');
    assert.equal(skipReason({ ...base, origin: 'https://myaccount.google.com', pathname: '/verification/selfie/precollection' }), '要求自拍视频验证');
    assert.equal(loginAction(base), '验证器验证码');
    assert.equal(loginAction({ pathname: '/v3/signin/accountchooser', chooser: true, buttons: [] }), '选择目标账号');
    assert.equal(skipReason({ ...base, captcha: true }), '人机验证');
    assert.equal(skipReason({ ...base, text: '检测到异常活动' }), '风控或尝试次数限制');
    assert.equal(skipReason({ ...base, origin: 'https://gemini.google.com', pathname: '/app', text: '历史对话：怎么处理人机验证、异常活动和账号已停用' }), null);
    assert.equal(loginAction({ pathname: '/speedbump/phone', phone: true, buttons: ['以后再说'] }), '跳过补充信息');
    assert.equal(skipReason({ pathname: '/speedbump/phone', phone: true, buttons: [], text: '添加电话号码' }), '补充信息无法跳过');
});
