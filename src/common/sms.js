/**
 * hero-sms.com API 封装 — 兼容 SMS-Activate 协议
 *
 * 流程：getNumber → 等待验证码 → getCode → complete/cancel
 */

const http = require('http');
const https = require('https');
const { log } = require('./logger');

const API_BASE = process.env.HERO_SMS_API_URL || 'https://api.hero-sms.com/stubs/handler_api.php';
const API_KEY = process.env.HERO_SMS_API_KEY || '';

// ============ HTTP 请求 ============
async function apiRequest(params) {
    const url = new URL(API_BASE);
    url.searchParams.set('api_key', API_KEY);
    for (const [k, v] of Object.entries(params)) {
        url.searchParams.set(k, v);
    }

    return new Promise((resolve, reject) => {
        const mod = url.protocol === 'https:' ? https : http;
        mod.get(url.toString(), (res) => {
            let data = '';
            res.on('data', chunk => (data += chunk));
            res.on('end', () => resolve(data.trim()));
        }).on('error', reject);
    });
}

// ============ 获取余额 ============
async function getBalance() {
    const result = await apiRequest({ action: 'getBalance' });
    // 返回格式: ACCESS_BALANCE:123.45
    if (result.startsWith('ACCESS_BALANCE:')) {
        return parseFloat(result.split(':')[1]);
    }
    throw new Error(`getBalance failed: ${result}`);
}

// ============ 获取可用国家列表及价格 ============
async function getTopCountriesByService(service = 'go') {
    const result = await apiRequest({
        action: 'getTopCountriesByService',
        service,
    });
    try {
        return JSON.parse(result);
    } catch (_) {
        // 如果不支持这个 API，返回 null
        return null;
    }
}

// ============ 获取号码 ============
/**
 * 获取一个临时手机号
 * @param {string} service - 服务代码 (go = Google)
 * @param {number|string} country - 国家代码 (0 = 自动选择最便宜的)
 * @returns {{ id: string, phone: string }}
 */
async function getNumber(service = 'go', country = 0) {
    const result = await apiRequest({
        action: 'getNumber',
        service,
        country: String(country),
    });
    // 返回格式: ACCESS_NUMBER:ID:PHONE_NUMBER
    if (result.startsWith('ACCESS_NUMBER:')) {
        const parts = result.split(':');
        return { id: parts[1], phone: parts[2] };
    }
    // 错误情况
    if (result === 'NO_NUMBERS') throw new Error('No numbers available for this service/country');
    if (result === 'NO_BALANCE') throw new Error('Insufficient balance on hero-sms account');
    if (result === 'BAD_KEY') throw new Error('Invalid hero-sms API key');
    throw new Error(`getNumber failed: ${result}`);
}

// ============ 获取状态/验证码 ============
/**
 * 获取激活状态
 * @param {string} id - 激活 ID
 * @returns {{ status: string, code?: string }}
 */
async function getStatus(id) {
    const result = await apiRequest({
        action: 'getStatus',
        id,
    });
    // STATUS_WAIT_CODE - 等待验证码
    // STATUS_WAIT_RETRY:lastCode - 等待重新发送
    // STATUS_WAIT_RESEND - 等待重发
    // STATUS_CANCEL - 已取消
    // STATUS_OK:CODE - 收到验证码
    if (result === 'STATUS_WAIT_CODE' || result === 'STATUS_WAIT_RESEND') {
        return { status: 'waiting' };
    }
    if (result.startsWith('STATUS_OK:')) {
        return { status: 'ok', code: result.split(':')[1] };
    }
    if (result.startsWith('STATUS_WAIT_RETRY:')) {
        return { status: 'retry', code: result.split(':')[1] };
    }
    if (result === 'STATUS_CANCEL') {
        return { status: 'cancelled' };
    }
    return { status: 'unknown', raw: result };
}

// ============ 设置状态 ============
/**
 * 设置激活状态
 * @param {string} id - 激活 ID
 * @param {number} status - 状态码: 1=通知已准备, 3=请求重发, 6=完成, 8=取消
 */
async function setStatus(id, status) {
    const result = await apiRequest({
        action: 'setStatus',
        id,
        status: String(status),
    });
    return result;
}

// ============ 高级接口：获取号码并等待验证码 ============
/**
 * 获取手机号 → 等待验证码（轮询）
 * @param {Object} options
 * @param {string} options.service - 服务代码
 * @param {number} options.country - 国家代码 (0 = 自动)
 * @param {number} options.timeout - 超时秒数 (默认 120)
 * @param {number} options.pollInterval - 轮询间隔秒数 (默认 5)
 * @param {Function} options.onNumber - 获取到号码后的回调 (phone) => {}
 * @param {Object} options.wlog - worker logger
 * @returns {{ phone: string, code: string, activationId: string }}
 */
async function getNumberAndWaitCode(options = {}) {
    const {
        service = 'go',
        country = 0,
        timeout = 120,
        pollInterval = 5,
        onNumber,
        wlog,
    } = options;

    const logger = wlog || { info: log, warn: (...a) => log(a.join(' '), 'WARN'), error: (...a) => log(a.join(' '), 'ERROR'), debug: () => {} };

    // 1. 获取号码
    logger.info(`  [SMS] Getting phone number (service=${service}, country=${country})...`);
    const { id, phone } = await getNumber(service, country);
    logger.info(`  [SMS] Got number: +${phone} (activation ID: ${id})`);

    // 回调：让调用方把号码填入页面
    if (onNumber) {
        await onNumber(phone);
    }

    // 2. 通知已准备接收
    await setStatus(id, 1);

    // 3. 轮询等待验证码
    const startTime = Date.now();
    while ((Date.now() - startTime) / 1000 < timeout) {
        await new Promise(r => setTimeout(r, pollInterval * 1000));

        const elapsed = Math.round((Date.now() - startTime) / 1000);
        const result = await getStatus(id);

        if (result.status === 'ok') {
            logger.info(`  [SMS] Received code: ${result.code} (${elapsed}s)`);
            // 完成激活
            await setStatus(id, 6);
            return { phone, code: result.code, activationId: id };
        }

        if (result.status === 'cancelled') {
            throw new Error('SMS activation was cancelled');
        }

        logger.debug(`  [SMS] Waiting for code... (${elapsed}s)`);
    }

    // 超时，取消激活
    logger.warn(`  [SMS] Timeout waiting for code after ${timeout}s, cancelling...`);
    await setStatus(id, 8).catch(() => {});
    throw new Error(`SMS code not received within ${timeout}s`);
}

module.exports = {
    getBalance,
    getTopCountriesByService,
    getNumber,
    getStatus,
    setStatus,
    getNumberAndWaitCode,
};
