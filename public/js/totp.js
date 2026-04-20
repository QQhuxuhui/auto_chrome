// Browser-side TOTP (RFC 4226 + RFC 6238, HMAC-SHA1).
// Parity with src/common/totp.js so codes match Google Authenticator / 2faa.live.
// Uses Web Crypto (available in all modern browsers); no external deps.
(function (global) {
    function base32Decode(encoded) {
        const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
        const cleaned = String(encoded || '').replace(/[\s-]/g, '').toUpperCase().replace(/=+$/, '');
        let bits = '';
        for (const ch of cleaned) {
            const val = alphabet.indexOf(ch);
            if (val === -1) throw new Error('Invalid base32 character: ' + ch);
            bits += val.toString(2).padStart(5, '0');
        }
        const bytes = [];
        for (let i = 0; i + 8 <= bits.length; i += 8) {
            bytes.push(parseInt(bits.substring(i, i + 8), 2));
        }
        return new Uint8Array(bytes);
    }

    async function generateTOTP(secretBase32, period) {
        const p = period || 30;
        const secret = base32Decode(secretBase32);
        const counter = BigInt(Math.floor(Date.now() / 1000 / p));
        const counterBuf = new Uint8Array(8);
        new DataView(counterBuf.buffer).setBigUint64(0, counter, false);
        const key = await crypto.subtle.importKey(
            'raw', secret, { name: 'HMAC', hash: 'SHA-1' }, false, ['sign'],
        );
        const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, counterBuf));
        const offset = sig[sig.length - 1] & 0x0f;
        const code = (
            ((sig[offset] & 0x7f) << 24) |
            ((sig[offset + 1] & 0xff) << 16) |
            ((sig[offset + 2] & 0xff) << 8) |
            (sig[offset + 3] & 0xff)
        ) % 1000000;
        return String(code).padStart(6, '0');
    }

    async function getTOTPWithTTL(secretBase32) {
        const period = 30;
        const now = Math.floor(Date.now() / 1000);
        const code = await generateTOTP(secretBase32, period);
        const remainingSeconds = period - (now % period);
        return { code, remainingSeconds };
    }

    const api = { generateTOTP, getTOTPWithTTL, base32Decode };
    global.TOTP = api;
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    }
}(typeof window !== 'undefined' ? window : globalThis));
