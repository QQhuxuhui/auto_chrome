# Gemini 登录

在本机 Chrome 中打开 Gemini，完成 Google 登录后自动核对页面上的账号邮箱。每个邮箱使用独立的 Chrome 配置目录，再次运行时可以继续使用该账号的会话。

需要 Node.js 18 或更高版本和桌面版 Google Chrome。在仓库根目录运行以下命令。

```sh
npm ci
npm start -- --email name@example.com
```

运行 `npm start` 或在 Windows 双击 `run.bat`，也可以按提示输入邮箱。使用非默认安装位置的 Chrome 时，将 `CHROME_PATH` 设为浏览器可执行文件的路径。

出现 Google 登录页后，在浏览器里输入密码并完成验证。需要切换验证方式时，点“试试其他方式”，再选“从 Google 身份验证器应用获取验证码”。返回 Gemini 并核对邮箱后，终端会提示成功。关闭浏览器即可退出。

Windows 的会话保存在 `%LOCALAPPDATA%\auto_chrome\gemini`，其他平台默认使用 `~/.local/share/auto_chrome/gemini`。运行 `npm test` 可用本机 Chrome 和模拟页面验证登录流程。
