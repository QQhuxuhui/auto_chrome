# Gemini 账号导出、WEBAPI 导入与保活操作手册

整理日期：2026-11-20（Asia/Hong_Kong）。用户明确要求保存本次流程，下次相同操作直接沿用，不再让用户重新讲解。

## 1. 用户约定与任务边界

- 用户给出新账号目录并说“相同逻辑，继续导入”，即按本手册执行：检查名单、导出、每 50 个成功账号导入、服务器验收、持续保活观察、有限重试、最终报告。
- **按成功账号数每 50 个导入一次**，不是每检查 50 个账号导入；首轮完成后，不足 50 个的尾批也必须导入。重试恢复出的账号另行发布补充批次。
- 保留已有账号的启用/停用状态；新增账号先停用，登录和 TS 验收通过后再启用。
- 凭据错误、Google 人机验证等不应阻止继续处理其他账号。用户此前已明确“暂无更新凭据，继续现有名单”，不要反复问同一个问题。
- 用户已授权本流程的服务器账号导入与保活测试，也要求修复稳定后提交导出器修改。不要把这扩大成其他服务器部署、全局浏览器配置修改或无关模型变更；Git 提交与推送是不同动作。
- 允许清理已确认闲置的旧自动化浏览器配置，保留账号名单、导出 Cookie、日志、验收证据以及当前任务仍需使用的配置。
- 全程不在回复、日志摘要、提交内容中输出密码、TOTP 密钥、refresh token、完整 Cookie、后台密钥或代理凭据。报告只呈现数量、原因及必要的身份摘要。

## 2. 固定入口与已验证实现

| 用途 | 本机位置 |
| --- | --- |
| Gemini 导出器工作树 | `E:\python_code\auto_log\auto_chrome-gemini`，分支 `gemini` |
| 原始项目与账号目录 | `E:\python_code\auto_log\auto_chrome\accounts` |
| Cookie 输出目录 | `E:\python_code\auto_log\auto_chrome\cookie` |
| WEBAPI 源码 | `E:\python_code\sparkcode\gemini-web2api-go` |
| 最近一次完整批次执行器和证据 | `E:\python_code\auto_log\auto_chrome-gemini\data\portable-batch-20261119-2` |
| 前一批次、本地/服务器样本保活脚本 | `E:\python_code\auto_log\auto_chrome-gemini\data\portable-soak-20261119` |
| 已清空的旧配置目录 | `C:\Users\gjy62\AppData\Local\auto_chrome\gemini` |

核心代码：`src/export_directory.js`、`src/common/directory-export.js`、`chrome.js`、`account-login.js`、`login-state.js`、`gemini-session.js`、`cookie-export.js`。

批次辅助脚本均位于上述 `data/portable-batch-20261119-2`：

| 文件 | 作用及注意点 |
| --- | --- |
| `run_batch.py` | 主导出并发 4、监听导入、首轮后临时失败重试并发 2 |
| `import_batches.py` | 按 SHA256、行数、账号映射校验不可变批次，经 SSH 导入并拉取验收报告 |
| `import_remote.py` | 服务器备份、事务更新/新增、调用实际登录和轮换接口、读库验收 |
| `observe_server.py` | 只读观察本批次账号，记录 TS 摘要变化和成功时间，不触发额外轮换 |
| `status.py` | 汇总当前导出、导入、服务器观察进度 |
| `finalize.py` | 合并首轮和重试结果，最终核对服务器身份、TS、成功时间与错误 |
| `clean_old_profiles.ps1` | 固定根目录、路径校验、占用检查、跳过重解析点的旧配置清理示例 |

**这些是已经跑通的批次脚本，不是完全参数化的通用命令。** 新任务先复制到新的私有任务目录，再核对并替换 `SOURCE`、`PREFIX`、`DEFAULT_PREFIX`、`PREFIXES`、观察器中的前缀列表、`PROFILES`、报告目录及服务器报告根路径。不要直接运行旧 `run_batch.py` 或旧 `finalize.py`；不要覆盖旧报告。旧停止标志也不能带入新观察任务。

服务器连接目标从现有 `import_batches.py` 的 `HOST` 核对，使用现有 SSH 密钥。2026-11-19/20 实测容器为 `gemini-web2api`，后台接口为服务器本机 `http://127.0.0.1:8083`；运行辅助模块 `/opt/gemini-web2api/private/release-control-76836a6.py` 提供 `admin()`、`volume()`、`OPENER`。数据库是 `Path(ops.volume()) / 'gemini.db'`。这些是当次环境事实，后续先确认服务和表结构没有改变，不把历史部署状态当作实时状态。

## 3. 每次执行步骤

### 3.1 检查名单和运行环境

1. 检查 Git 分支、修改、现有导出/导入进程，避免重复启动同一批次；保留用户已有修改。
2. 用当前 `readAccounts` 解析指定目录中的 TXT：按 `----` 分隔，字段顺序为邮箱、密码、第三字段、TOTP 密钥。当前登录不消费后续 refresh token。**不要根据文件名猜账号数量。**
3. 记录实际行数、唯一账号数、重复、凭据冲突、格式错误与输入指纹。同邮箱不同密码/密钥视为冲突，不任意选一个。
4. 选一个未使用的批次前缀，检查磁盘空间；大量独立配置优先放在 E 盘，通过 `--profile-root` 指定。
5. 新名单和完整重新导出使用新前缀；若要求全新登录环境，也使用新的独立 profile-root。仅更换输出前缀不会自动更换浏览器会话。

导出命令示意（替换占位符后运行；这里只启动导出，导入监听和观察器须由执行器另行启动）：

```powershell
node src/export_directory.js --input "<新账号目录>" --output "E:\python_code\auto_log\auto_chrome\cookie" --prefix "<唯一批次前缀>" --concurrency 4 --profile-root "E:\python_code\auto_log\auto_chrome-gemini\data\browser-profiles\<批次>"
```

`--resume` 仅用于恢复同一输入指纹、同一批次、同一 profile-root：会复用成功 Cookie，并把中断的 running 状态改回 pending；**不会重试已经 failed/skipped 的账号，也不能当成重新导出所有账号**。任务运行时不要改原始名单文件。

### 3.2 导出与批次发布

- 每个邮箱使用独立的 SHA256 配置目录，导出启动器追加 `-portable-v2`。
- 在 Gemini 可见账号控件中确认完整目标邮箱后才能导出。不能仅凭页面打开、出现聊天框或邮箱部分相同就记为成功。
- 输出每账号单行 `name=value; name=value` 的 Cookie TXT，同时保存包含域、路径、同名冲突等信息的 JSON。
- Cookie 来自当前 Gemini 地址以及相关 Google 登录、轮换与请求地址的并集；TXT 同名冲突优先当前 Gemini 地址，完整变体留在 JSON。不要擅自裁成两三个字段。
- 并集 TXT 的语法与手动复制的 Cookie 请求头一致，但不等于任意一条浏览器请求实际发送的 Cookie 集合；分析某个端点时按 JSON 中的域和路径核对，不能把同名 Cookie 的唯一值视作适用于所有域。
- 本流程用 `SAPISID` 与 `__Secure-1PSID` 确认会话身份，用 `__Secure-1PSIDTS` 验证轮换；这不是声称“只有这三个 Cookie 就足够”。
- 批次按已处理的输入顺序发布，发布后不可变。保存 SHA256、每行邮箱映射和行数；累计满 50 即交给导入器，不等整份名单结束。

### 3.3 服务器导入与即时验收

1. 核对部署实际支持的管理接口。当次服务器 PATCH 只用于状态修改，不能据此假定支持 Cookie 替换。
2. 沿用已经验证的远端导入逻辑：每批文件锁、独立报告目录和 SQLite `before.db` 备份；按标准化邮箱匹配 label，匹配到多个账号则停止该导入并排查。
3. 等待已有轮换 lease 释放，在事务内更新 Cookie。会话身份相同则保留服务器可能更新的 TS；身份变化才替换 Cookie 并清除旧轮换状态。原有账号的启停状态不变。
4. 新账号先以 disabled 插入。通过服务器自身 `/admin/api/cookies/{id}/check` 和 `/rotate` 验证，并读回数据库，确认身份匹配、TS 非空且不同于导出值、`last_success` 不早于本次导入，才启用新增账号。
5. 不能把 HTTP 200、`complete=true`、进程退出码 0 或“Cookie 非空”当作全体验收通过。逐批确认 `summary.verified == summary.total == batch.count`。
6. 遇到暂时 429 等问题保留退避；当次导入器完整等待 610 秒后重验，最多再验两轮。重验次数用尽也可能返回 0，必须另查未验收账号并如实记录，不能报告为全部成功。
7. 登录、TS、身份等验收数据保存在本地 `server-import/batch-N.json` 和服务器私有批次报告中。补充批次有独立前缀，不能重复导入已发布行。

### 3.4 持续保活、重试与收尾

- 初次手动 rotate 成功不算后续自动保活。启动本批次专用只读观察器，记录 TS 的 SHA256 与 `last_success`；只有 TS 改变且成功时间推进才计为新一轮。
- 新增启用账号继续观察至少两轮自动续期；保留停用的旧账号不为了观察而启用。当次服务器间隔约 10 分钟，实际以运行配置和记录为准。
- 修改导出/登录流程后，先做有意义的回归测试和少量真实多轮验收，再扩大批量。本地曾验证 3 账号 × 4 轮、30 分钟；服务器仍须独立验证，不能拿本地结果替代。
- 首轮后仅对连接超时、导航/渲染失败、临时 Google 服务错误等做一次独立重试，并发 2，保留原邮箱与文件行号映射。
- 不自动重试明确密码失效、账号不存在、错误/缺失验证器、验证码挑战、自拍要求、服务限制或身份不匹配。泛化的“停留在邮箱”或“等待超时”先看诊断页面，不能一概当网络故障。
- 需要改代码时，放置本批次 `_records/<prefix>/pause.flag`，让正在登录的会话收尾，再修改、测试、移除标志、恢复；不要和运行中的状态写入抢写 `status.json`。
- 执行器遇到导入异常或近期 8 个完成账号中至少 3 个 `/unknownerror` 会暂停，先看具体原因再恢复。
- 合并首轮、重试结果时按邮箱去重，不能将两次尝试算成两个账号。最终再核对服务器 label、会话身份摘要、TS、导入后成功时间、最新错误和启停状态。
- 保存 `final-summary.json`、`final-account-results.json`、`unsuccessful-accounts.json`、`final-server-audit.json`、`server-continuous-report.json`。
- 检查导出/导入进程退出、本任务 Chrome 全部关闭；用本任务的 `stop-server-observation.flag` 结束只读观察器，**不停止服务器自动保活**。持续跟进到验收完成再给最终结果。

## 4. 已排查的问题与修复

| 提交 | 已验证结论/行为 |
| --- | --- |
| `4a698e4` | 通过全新独立会话并在导出 Chrome 进程禁用设备绑定相关功能，恢复可在浏览器外轮换的会话；已绑定的旧配置不能仅靠重启转换。 |
| `2fba300` | 跳过通行密钥后，按钮仍可见不代表提交未生效；过早重复点击会触发 unknownerror。重试间隔改为 60 秒，页面变化仍立即推进。 |
| `e7a828f` | Gemini 新侧栏、本地化账号标签、双向文本标记需要识别；仍严格确认完整邮箱，不把其他账号导出。 |
| `dd9ad21` | 新增 `--profile-root`，让批量配置放到空间充足的磁盘；恢复时必须保持同一路径。 |
| `c10184e` | Google 中文“找不到此账号”属于账号不可用，立即结束，不重复提交邮箱，也不加入临时故障重试。 |

`chrome.js` 当前禁用项为 `EnableBoundSessionCredentials`、`DeviceBoundSessions`、`EnableChromeRefreshTokenBinding`、`EnableOAuthMultiloginCookiesBinding`、`EnableOAuthMultiloginStandardCookiesBinding`、`EnableOAuthMultiloginCookiesBindingServerExperiment`；仅作用于独立导出浏览器，不更改用户全局 Chrome。

Cookie 字符串外形相同不代表会话可移植；同一账号重新登录后值也可能不同。比较时区分同一会话/不同登录时刻，关键结论来自实际 TS 轮换，不要求跨会话所有 Cookie 字节一致。曾看到的 `--log-net-log` 提示条本身不足以证明保活根因，不应凭提示条下结论。

2026-11-20 最新完整测试：`npm test` 21 项通过。上述修复已本地提交，不能据此声称已推送远端。

## 5. 旧配置清理

只清理已确认属于本项目、无进程使用、无需当前恢复/重试的旧配置。删除前固定并解析绝对根目录，校验每个目标仍在根内，检查 Chrome 的 `--user-data-dir`，跳过重解析点及其子树。使用 PowerShell `Remove-Item -LiteralPath ... -Recurse`，不跨 shell 拼接删除命令。

不要删除用户日常 Chrome 配置；不要通过网页退出账号或撤销会话来“清理文件”；不要删输入、Cookie TXT/JSON、批次状态、验收证据和服务器备份。当前配置保留到任务不再需要使用为止，不能看到目录名字相似就删。

本次旧 C 盘配置 1,483 个全部删除，约释放 53.96 GiB；当前批次 E 盘配置保留。清理后旧批次 318 个启用账号均再次自动续期，最新错误 0，38 个停用账号仍停用。证据：新任务目录中的 `old-profile-cleanup.json`、`previous-imports-after-cleanup.json`。

## 6. 已完成批次的事实基线（不可当作实时状态）

| 名单 | 输入/去重 | 最终成功导入 | 服务器结果 |
| --- | --- | --- | --- |
| `accounts\20261119` | 767 行、716 唯一、51 重复 | 356，新增 23、更新 333 | 318 启用、保留 38 停用；全部初次 TS 验收通过 |
| `accounts\20261119-2` | 979 行、979 唯一 | 71，全部新增，50＋21 两批 | 71 启用，全部至少两轮后续自动 TS 续期，最新错误 0，最终读库通过 |

第二批重试 7 个，未增加成功；最终 191 failed、717 skipped。908 个未通过原因：人机验证 456、登录限制 259、密码已更改 106、账号不可用 52、验证器页面未通过 32、未提供验证器方式 2、邮箱不匹配 1。不能把这些全部称作导出器错误。

第一批的 `accounts_200 (1).txt` 最终成功 4 个，不能沿用早期抽样“暂时没有成功”的结论。数据以各批次 `final-summary.json` 为准。

## 7. 下次的默认交付

用户只需提供新名单目录。先读本手册并核对当前代码、服务及脚本参数，执行完整流程，最后汇报输入/去重数量、成功导入数量、每批数量、新增/更新/启停情况、实际自动 TS 轮数、失败原因、提交与测试结果、清理数量及报告路径。不以“任务已启动”代替最终完成，不要求用户再重复批次规则。
