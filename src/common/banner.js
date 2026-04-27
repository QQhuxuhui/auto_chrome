const { spawn } = require('node:child_process');

function buildOpenBrowserCommand(platform, url) {
    if (platform === 'win32') return { cmd: 'cmd', args: ['/c', 'start', '""', url] };
    if (platform === 'darwin') return { cmd: 'open', args: [url] };
    return { cmd: 'xdg-open', args: [url] };
}

function openDefaultBrowser(url) {
    const { cmd, args } = buildOpenBrowserCommand(process.platform, url);
    try {
        const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
        child.unref();
    } catch (_) { /* don't let browser-launch failures kill the server */ }
}

function buildBannerLines({ version, dataDir, listenUrl }) {
    return [
        '============================================',
        `  auto_chrome v${version}`,
        '============================================',
        '',
        `  data dir : ${dataDir}`,
        `  listen   : ${listenUrl}`,
        '',
        '  正在打开浏览器...',
        '',
        '  关闭此窗口或按 Ctrl+C 退出服务',
        '============================================',
    ];
}

function printBanner(opts) {
    for (const line of buildBannerLines(opts)) console.log(line);
}

async function waitForKeypress() {
    return new Promise((resolve) => {
        if (process.stdin.setRawMode) process.stdin.setRawMode(true);
        process.stdin.resume();
        process.stdin.once('data', () => {
            if (process.stdin.setRawMode) process.stdin.setRawMode(false);
            process.stdin.pause();
            resolve();
        });
    });
}

module.exports = {
    buildOpenBrowserCommand,
    buildBannerLines,
    openDefaultBrowser,
    printBanner,
    waitForKeypress,
};
