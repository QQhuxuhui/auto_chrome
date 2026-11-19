const { spawn } = require('node:child_process');
const { createServer } = require('node:net');
const { setTimeout: sleep } = require('node:timers/promises');
const puppeteer = require('puppeteer-core');

async function launchChrome(userDataDir, { portableCookies = false } = {}) {
    // 已绑定的旧会话无法靠重启转换。导出使用独立目录重新登录，避免复用旧绑定。
    const profileDirectory = portableCookies ? `${userDataDir}-portable-v2` : userDataDir;
    const disabledFeatures = ['DiceWebSigninInterception', 'SigninInterceptBubble'];
    // Chrome 可通过网页登录或 OAuthMultilogin 创建设备绑定会话，需覆盖两条路径。
    if (portableCookies) disabledFeatures.push(
        'EnableBoundSessionCredentials',
        'DeviceBoundSessions',
        'EnableChromeRefreshTokenBinding',
        'EnableOAuthMultiloginCookiesBinding',
        'EnableOAuthMultiloginStandardCookiesBinding',
        'EnableOAuthMultiloginCookiesBindingServerExperiment',
    );
    // Chrome 的普通启动方式；保留每个邮箱独立的持久配置。
    const server = createServer();
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    const port = server.address().port;
    await new Promise(resolve => server.close(resolve));
    const proc = spawn(process.env.CHROME_PATH || puppeteer.executablePath('chrome'), [
        `--user-data-dir=${profileDirectory}`,
        '--remote-debugging-address=127.0.0.1',
        `--remote-debugging-port=${port}`,
        '--no-first-run', '--no-default-browser-check',
        // 不将网站登录转成新的 Chrome 配置，避免打断邮箱独立环境。
        '--disable-sync',
        `--disable-features=${disabledFeatures.join(',')}`,
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
        'about:blank',
    ], { stdio: 'ignore' });
    let launchError;
    proc.once('error', error => { launchError = error; });
    for (let attempt = 0; attempt < 120; attempt++) {
        if (launchError) throw launchError;
        if (proc.exitCode !== null) throw new Error('Chrome 已退出；请关闭此邮箱的旧窗口后重试');
        try {
            return await puppeteer.connect({ browserURL: `http://127.0.0.1:${port}`, defaultViewport: null });
        } catch {
            await sleep(250);
        }
    }
    proc.kill();
    throw new Error('连接 Chrome 超时');
}

module.exports = { launchChrome };
