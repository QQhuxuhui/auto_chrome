const path = require('node:path');
const fs = require('node:fs');

function resolveExeDir({ isPkg, execPath, srcCommonDir }) {
    if (!isPkg) return path.resolve(srcCommonDir, '..', '..');

    // On Windows, use win32 path handling; on other platforms, use posix
    // (In production, when packaged as .exe, this code runs on Windows)
    const pathModule = execPath.includes('\\') ? path.win32 : path.posix;
    return pathModule.dirname(execPath);
}

function pickEnvPath(candidates, existsFn = fs.existsSync) {
    for (const c of candidates) if (existsFn(c)) return c;
    return null;
}

function ensureDir(p) {
    if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
    return p;
}

const isPkg = !!process.pkg;
const exeDir = resolveExeDir({
    isPkg,
    execPath: process.execPath,
    srcCommonDir: __dirname,
});

let dataDir;
try {
    dataDir = ensureDir(path.join(exeDir, 'data'));
} catch (e) {
    if (isPkg && e.code === 'EACCES') {
        e.userMessage = `无法在 ${exeDir} 创建 data 目录（权限不足）。\n请把 auto_chrome.exe 移到桌面或自己可写的文件夹再运行。`;
    }
    throw e;
}

const chromeProfilesDir = ensureDir(path.join(dataDir, 'chrome-profiles'));
const debugDir = ensureDir(path.join(dataDir, 'debug'));

function loadEnv() {
    const dotenv = require('dotenv');
    const candidates = [
        path.join(exeDir, '.env'),
        path.resolve(__dirname, '..', '..', '.env'),
    ];
    const envPath = pickEnvPath(candidates);
    if (envPath) dotenv.config({ path: envPath });
    return envPath;
}

let version = '0.0.0';
try {
    version = require(path.resolve(__dirname, '..', '..', 'package.json')).version || version;
} catch (e) {
    // Root package.json doesn't exist until Phase 3 — that's expected.
    // Anything else (e.g. malformed JSON) should surface, not silently fall back.
    if (e && e.code !== 'MODULE_NOT_FOUND') throw e;
}

module.exports = {
    isPkg,
    exeDir,
    dataDir,
    chromeProfilesDir,
    debugDir,
    credentialsFile: path.join(dataDir, 'credentials.json'),
    failedFile: path.join(dataDir, 'failed.json'),
    enableApiFailedFile: path.join(dataDir, 'enableAPI_failed.json'),
    loadEnv,
    version,
    resolveExeDir,
    pickEnvPath,
};
