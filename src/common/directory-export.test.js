const assert = require('node:assert/strict');
const { test } = require('node:test');
const { readyBatches } = require('./directory-export');
const { loginAction, skipReason } = require('./login-state');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { atomicJson, createWriteQueue } = require('./directory-export');

test('串行写入队列在单次失败后不会污染后续 worker 的保存操作', async () => {
    const enqueue = createWriteQueue();
    const events = [];
    const first = enqueue(async () => {
        events.push('first');
        throw new Error('disk full');
    });
    const second = enqueue(async () => {
        events.push('second');
        return 'ok';
    });
    await assert.rejects(first, /disk full/);
    assert.equal(await second, 'ok');
    assert.deepEqual(events, ['first', 'second']);
});

test('进度快照遇到短暂文件占用会重试，替换前保留原快照', async t => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gemini-progress-'));
    const file = path.join(dir, 'status.json');
    await fs.writeFile(file, '{"success":29}');
    const rename = fs.rename;
    let attempts = 0;
    t.mock.method(fs, 'rename', async (...args) => {
        attempts++;
        if (attempts <= 2) {
            assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), { success: 29 });
            throw Object.assign(new Error('temporarily busy'), { code: 'EPERM' });
        }
        return rename(...args);
    });
    try {
        await atomicJson(file, { success: 33 });
        assert.equal(attempts, 3);
        assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), { success: 33 });
    } finally {
        t.mock.restoreAll();
        await fs.unlink(file);
        await fs.rmdir(dir);
    }
});

test('非临时写入错误立即报错并保留旧进度及恢复文件', async t => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gemini-progress-'));
    const file = path.join(dir, 'status.json');
    await fs.writeFile(file, '{"success":29}');
    const failure = Object.assign(new Error('invalid rename'), { code: 'EINVAL' });
    const mocked = t.mock.method(fs, 'rename', async () => { throw failure; });
    try {
        await assert.rejects(atomicJson(file, { success: 33 }), error => error === failure);
        assert.equal(mocked.mock.callCount(), 1);
        assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), { success: 29 });
        assert.deepEqual(JSON.parse(await fs.readFile(`${file}.tmp`, 'utf8')), { success: 33 });
    } finally {
        t.mock.restoreAll();
        await fs.unlink(file);
        await fs.unlink(`${file}.tmp`);
        await fs.rmdir(dir);
    }
});

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

test('自定义30个成功账号发布，77个账号最后发布17个尾批', () => {
    const rows = Array.from({ length: 77 }, (_, i) => ({ index: i + 1, status: 'success' }));
    assert.deepEqual(readyBatches(rows, false, 30).map(batch => batch.length), [30, 30]);
    assert.deepEqual(readyBatches(rows, true, 30).map(batch => batch.length), [30, 30, 17]);
    rows[29].status = 'running';
    assert.deepEqual(readyBatches(rows, false, 30), []);
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
