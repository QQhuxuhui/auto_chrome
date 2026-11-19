const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');

const digest = value => createHash('sha256').update(value).digest('hex');
async function readAccounts(directory) {
    const files = (await fs.readdir(directory)).filter(name => /\.txt$/i.test(name)).sort();
    const accounts = [], duplicates = [], invalid = [], hashes = [];
    const byEmail = new Map();
    let inputRows = 0;
    for (const file of files) {
        const raw = await fs.readFile(path.join(directory, file), 'utf8');
        hashes.push([file, digest(raw)]);
        for (const [line, row] of raw.split(/\r?\n/).entries()) {
            if (!row.trim()) continue;
            inputRows++;
            const [rawEmail, password, , secret] = row.split('----');
            const email = rawEmail?.trim().toLowerCase();
            const source = { file, line: line + 1 };
            if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email || '') || !password || !/^[a-z2-7]{16,}$/i.test(secret?.trim() || '')) {
                invalid.push({ ...source, reason: '账号格式或验证器密钥无效' });
                continue;
            }
            const existing = byEmail.get(email);
            if (existing) {
                const conflict = existing.password !== password || existing.secret.toUpperCase() !== secret.trim().toUpperCase();
                duplicates.push({ email, ...source, firstSource: existing.source, conflict });
                if (conflict) existing.conflict = true;
                continue;
            }
            const account = { index: accounts.length + 1, email, password, secret: secret.trim(), source };
            byEmail.set(email, account);
            accounts.push(account);
        }
    }
    return { accounts, duplicates, invalid, inputRows, fingerprint: digest(JSON.stringify(hashes)) };
}

// 只发布已处理前缀中的成功账号，确保完整批次一经发布就不再变动。
function readyBatches(results, complete, batchSize = 50) {
    const ready = [];
    for (const result of results) {
        if (['pending', 'running'].includes(result.status)) break;
        if (result.status === 'success') ready.push(result);
    }
    const batches = [];
    for (let offset = 0; offset < ready.length; offset += batchSize) {
        const rows = ready.slice(offset, offset + batchSize);
        if (rows.length < batchSize && !complete) break;
        batches.push(rows);
    }
    return batches;
}

async function atomicJson(file, value) {
    await fs.writeFile(`${file}.tmp`, JSON.stringify(value, null, 2), { mode: 0o600 });
    await fs.rename(`${file}.tmp`, file);
}

module.exports = { readAccounts, readyBatches, atomicJson, digest };
