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

Chrome 以普通进程启动，脚本通过本机调试连接读取页面。每个邮箱对应独立的配置目录；相同邮箱再次运行会复用会话。邮箱核对成功后，当前 Gemini URL 适用的 Cookie 保存至 `cookies/<邮箱>.cookie.txt`，不会打印 Cookie 原文。

批量导出使用 `邮箱----密码----辅助邮箱----验证器密钥----其他字段` 格式的账号文件：

```sh
node src/export_accounts.js --file accounts.txt --output "C:/Users/你的用户名/Downloads/gemini-cookies.txt" --concurrency 2
```

合并 TXT 每行一个账号的 Cookie，按输入文件顺序排列。只有在 Gemini 核对邮箱成功的账号才会写入；进度和失败原因保存在同名 `.status.json` 文件中，可用 `--resume` 继续尚未成功的账号。批量流程支持密码和验证器验证码；其他挑战会记录为失败，不会将游客 Cookie 当作成功结果。

2026-11-18 的速度优化以 `d2ae03ef94024eaf90c99341decdc37175567e52` 为回退基线，该基线已实际完成 49 个账号导出。优化版依据页面状态变化推进，避免跳转时重复点击旧控件，并记录每个账号的 `timings`（启动、登录、导出、总耗时，单位毫秒）和 `steps`（阶段及相对登录开始时间）。密码和验证码的重试仍保留 25 秒间隔，验证方式按钮未推进时按 5/10/25 秒间隔重试。默认并发及账号独立配置目录不变。

计划于 2026-11-19 手动试用；目前仅完成本地模拟页面测试，尚未验证真实 Google 页面的提速效果。测试获取最新 Cookie 时应指定一个新的输出文件名，不使用 `--resume`，因为续跑会复用已保存的成功结果。已有账号的有效登录会话会被继续使用，因此这类测试不能代表新账号首次登录速度。如果优化版出现回归，使用 `git revert <本次优化提交哈希>` 撤销优化提交；保留账号环境和此前的 Cookie 文件。
