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

Cookie 导出入口使用邮箱目录的 `-portable-v2` 独立配置。该进程关闭旧式和标准设备绑定，以及 Chrome 登录后的 OAuthMultilogin Cookie 绑定，使新登录会话适用于 WEBAPI 的 `RotateCookies` 续期。此配置中的 Google 会话失去设备绑定保护，导出的 Cookie 应作为登录凭据妥善保存。第一次使用需要重新登录，因为旧设备绑定会话不能通过修改启动参数转换。需要重新生成已有导出时使用新的输出文件或批次前缀，`--resume` 会继续复用已成功的旧导出。本机一般浏览器设置不受该进程参数影响。

Chrome 以普通进程启动，脚本通过本机调试连接读取页面。每个邮箱对应独立的配置目录；相同邮箱再次运行会复用会话。邮箱核对成功后，多地址 Cookie 字段并集保存至 `cookies/<邮箱>.cookie.txt`，不会打印 Cookie 原文。

并集范围为当前 Gemini 页面、Gemini batchexecute/StreamGenerate、accounts.google.com 的 RotateCookies/RotateBoundCookies/RotateBoundGaps、play.google.com/log、www.google.com/。只读取此账号环境中这些 URL 适用的 Cookie，不会访问这些地址来人为生成缺失字段。TXT 每个名称仅保留一个值；同名不同值优先当前 Gemini URL，再按上述地址顺序取值。配套 `<邮箱>.cookies.json` 保存各地址的完整 Cookie 对象（包含值、域、路径、到期等 CDP 元数据）和冲突名称。JSON 同样属于私密凭据文件，不应提交版本库。

并集 TXT 是兼容性导出文件，不等同于任意一条请求的实际 Cookie 请求头；按目标站点发送时应依据 JSON 中的作用域选择 Cookie。JSON 保留全部同名变体，不能将 TXT 简化后的唯一值视为适用于所有域。并集不能替代 Chrome 绑定会话的挑战响应，也不保证解决保活。已有批次不会自动更新，`--resume` 会复用此前成功结果；需要新格式时另用新输出或批次前缀。

批量导出使用 `邮箱----密码----辅助邮箱----验证器密钥----其他字段` 格式的账号文件：

```sh
node src/export_accounts.js --file accounts.txt --output "C:/Users/你的用户名/Downloads/gemini-cookies.txt" --concurrency 2
```

合并 TXT 每行一个账号的 Cookie，按输入文件顺序排列。只有在 Gemini 核对邮箱成功的账号才会写入；进度和失败原因保存在同名 `.status.json` 文件中，可用 `--resume` 继续尚未成功的账号。批量流程支持密码和验证器验证码；其他挑战会记录为失败，不会将游客 Cookie 当作成功结果。

2026-11-18 的速度优化以 `d2ae03ef94024eaf90c99341decdc37175567e52` 为回退基线，该基线已实际完成 49 个账号导出。优化版依据页面状态变化推进，避免跳转时重复点击旧控件，并记录每个账号的 `timings`（启动、登录、导出、总耗时，单位毫秒）和 `steps`（阶段及相对登录开始时间）。密码和验证码的重试仍保留 25 秒间隔，验证方式按钮未推进时按 5/10/25 秒间隔重试。默认并发及账号独立配置目录不变。

计划于 2026-11-19 手动试用；目前仅完成本地模拟页面测试，尚未验证真实 Google 页面的提速效果。测试获取最新 Cookie 时应指定一个新的输出文件名，不使用 `--resume`，因为续跑会复用已保存的成功结果。已有账号的有效登录会话会被继续使用，因此这类测试不能代表新账号首次登录速度。如果优化版出现回归，使用 `git revert <本次优化提交哈希>` 撤销优化提交；保留账号环境和此前的 Cookie 文件。

目录批量导出：`node src/export_directory.js --input 账号目录 --output Cookie目录 --prefix gemini-20261119 --concurrency 4`。扫描目录内 TXT，按文件名和行号排序并按邮箱去重；同邮箱凭据冲突单独记录跳过。每 50 个成功账号发布一个 `前缀-001.txt` 文件，完整批次保持不变，全部处理完再发布不足 50 个的尾批。只有成功核对 Gemini 邮箱的账号才进入批次。

本次规则：人机验证和风控直接跳过；直接显示验证器输入框时填写验证码；Google 可选补充设置和 Gemini 的“不使用内容应用”选项跳过；强制补充资料无法跳过时记录原因。正常的两步验证不视为风控，隐藏的验证控件和聊天正文中的相关字样也不作为风控依据。

`输出目录/_records/前缀/status.json` 保存总进度、来源文件、成功/失败/跳过原因、重复项、批次行号与邮箱映射、SHA256 和耗时；`success.json`、`unsuccessful.json` 分别保存跑通和没跑通记录。恢复时使用相同参数加 `--resume`，已结束的成功/失败/跳过项不会重跑。建立 `_records/前缀/pause.flag` 可让当前账号结束后停止领取新账号，移除该文件后可继续恢复。输入文件发生变化时拒绝复用进度。
