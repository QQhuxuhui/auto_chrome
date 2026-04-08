/**
 * TOTP (Time-based One-Time Password) 生成器
 *
 * 基于 RFC 6238 标准，使用 Node.js 内置 crypto 模块实现
 * 与 Google Authenticator / 2faa.live 生成的验证码一致
 */

const crypto = require('crypto');

/**
 * Base32 解码（RFC 4648）
 * Google Authenticator 的 secret key 使用 base32 编码
 */
function base32Decode(encoded) {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    // 清理输入：去除空格、连字符，转大写，去除填充
    encoded = encoded.replace(/[\s-]/g, '').toUpperCase().replace(/=+$/, '');

    let bits = '';
    for (const ch of encoded) {
        const val = alphabet.indexOf(ch);
        if (val === -1) throw new Error(`Invalid base32 character: ${ch}`);
        bits += val.toString(2).padStart(5, '0');
    }

    const bytes = [];
    for (let i = 0; i + 8 <= bits.length; i += 8) {
        bytes.push(parseInt(bits.substring(i, i + 8), 2));
    }
    return Buffer.from(bytes);
}

/**
 * 生成 HOTP 值（RFC 4226）
 * @param {Buffer} secret - 解码后的密钥
 * @param {BigInt|number} counter - 计数器
 * @returns {string} 6 位验证码
 */
function generateHOTP(secret, counter) {
    // 将 counter 转为 8 字节大端序 buffer
    const counterBuf = Buffer.alloc(8);
    const c = BigInt(counter);
    counterBuf.writeBigUInt64BE(c);

    // HMAC-SHA1
    const hmac = crypto.createHmac('sha1', secret);
    hmac.update(counterBuf);
    const digest = hmac.digest();

    // Dynamic truncation
    const offset = digest[digest.length - 1] & 0x0f;
    const code = (
        ((digest[offset] & 0x7f) << 24) |
        ((digest[offset + 1] & 0xff) << 16) |
        ((digest[offset + 2] & 0xff) << 8) |
        (digest[offset + 3] & 0xff)
    ) % 1000000;

    return code.toString().padStart(6, '0');
}

/**
 * 生成 TOTP 验证码
 * @param {string} secretBase32 - Base32 编码的密钥（即 "fa码"）
 * @param {number} [period=30] - 时间步长（秒），默认 30
 * @returns {string} 6 位验证码
 */
function generateTOTP(secretBase32, period = 30) {
    const secret = base32Decode(secretBase32);
    const counter = Math.floor(Date.now() / 1000 / period);
    return generateHOTP(secret, counter);
}

/**
 * 获取当前 TOTP 验证码及剩余有效秒数
 * @param {string} secretBase32 - Base32 编码的密钥
 * @returns {{ code: string, remainingSeconds: number }}
 */
function getTOTPWithTTL(secretBase32) {
    const period = 30;
    const now = Math.floor(Date.now() / 1000);
    const code = generateTOTP(secretBase32, period);
    const remainingSeconds = period - (now % period);
    return { code, remainingSeconds };
}

module.exports = { generateTOTP, getTOTPWithTTL };
