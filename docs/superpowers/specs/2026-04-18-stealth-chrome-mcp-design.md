# stealth-chrome-mcp 工程设计

**目的**：把 `common/*.js` 里的"原子能力"封成一个 MCP server，供 Claude Code / Hermes 等 agent 调用；业务流程（stage 1/2/3）改写成 skill 使用这些 tool。

---

## 1. 设计目标与非目标

### 目标
- 稳定的**原子能力**契约：Chrome 启动、Google 登录、OAuth 码交换、SMS / TOTP。
- 单进程 MCP server 可并发管理 N 个 Chrome session（对齐现在 `-c 3`）。
- SMS provider 可替换（当前 hero-sms，后续可能 5sim / sms-activate / 手动）。
- Chrome 启动参数与 `auto_chrome` 现行一致（保留反检测效果）。

### 非目标
- 不承担业务逻辑（邀请、接受、OAuth probe、Antigravity validation 等留给 skill）。
- 不内置账号解析、不读 `hosts.txt` / `members.txt`（这些是业务）。
- 不做跨进程 / 跨机器的 session 漂移（session 生命周期 = server 进程生命周期）。

---

## 2. 代码布局

```
auto_chrome/
├── mcp-server/                      # 新增
│   ├── package.json                 # deps: @modelcontextprotocol/sdk, puppeteer-core, undici
│   ├── bin/server.js                # stdio 入口，npm link 后 `stealth-chrome-mcp`
│   ├── src/
│   │   ├── server.js                # MCP server setup + tool 注册
│   │   ├── sessions.js              # SessionRegistry
│   │   ├── config.js                # 读 env / CLI args
│   │   ├── tools/
│   │   │   ├── chrome.js
│   │   │   ├── google.js
│   │   │   ├── oauth.js
│   │   │   ├── sms.js
│   │   │   └── totp.js
│   │   └── providers/sms/
│   │       ├── index.js             # registry + interface
│   │       └── hero-sms.js          # 现有实现
│   └── README.md
├── src/                             # 现状不动
└── common/                          # 现状不动，mcp-server 通过 require 相对路径复用

/usr/src/workspace/github/QQhuxuhui/my-skills/   # Skill 放独立 repo
├── google-login-playbook/SKILL.md
├── oauth-token-harvest/SKILL.md
├── google-invite/SKILL.md
├── google-accept/SKILL.md
├── google-oauth-validate/SKILL.md
└── gpt-plus/SKILL.md
```

**复用策略**：`mcp-server/` 里**不复制代码**，直接 `require('../../common/chrome')` 等，避免双份维护。common 自身需要做一点小重构（见 §12）。

---

## 3. Server 与传输

- **Transport**：stdio（Claude Code / Hermes / Cursor 都支持；最简最稳）。
- **SDK**：`@modelcontextprotocol/sdk` Node 版。
- **分发**：**仅本地路径**，不发 npm（见 §15 决策 11）。Claude Code / 本地 Hermes 在配置里写绝对路径 `node /usr/src/workspace/github/QQhuxuhui/auto_chrome/mcp-server/bin/server.js`。
- **无 HTTP/SSE**：MVP 不做。多客户端场景后续再考虑。
- **puppeteer-core 版本**：锁定 `^24.2.1`，与 `auto_chrome/src/package.json` 一致，避免 drift。

---

## 4. Session 模型

### 结构
```
type Session = {
  id: string                 // 'sess_01HW...' (ULID)
  workerId: number           // 启动时分配，用于数据目录隔离
  debugPort: number          // 9234 + workerId
  browser: puppeteer.Browser // puppeteer 连接句柄
  proc: ChildProcess         // Chrome 子进程
  dataDir: string
  createdAt: number
  tags: Record<string, string>  // 调用方自定义标签（如 email），便于日志
}
```

### 生命周期
- `chrome.launch` / `chrome.connect` → 创建 session，返回 `session_id`。
- 所有其他 tool 通过 `session_id` 引用。
- `chrome.close(session_id)` → 关 Chrome、删 dataDir（`--isolated` 语义）。
- Server 退出（SIGTERM）→ 自动清理所有 session。
- 空闲检测：可选，默认不做；调用方负责显式 close。

### Registry API（内部）
```js
registry.create({ workerId, browser, proc, ... }) -> sessionId
registry.get(sessionId)       // throws SESSION_NOT_FOUND
registry.close(sessionId)     // 幂等
registry.list()
registry.closeAll()           // server 退出时调用
```

---

## 5. Tool 清单（JSON Schema 草案）

### 5.1 `chrome.launch`
启动一个新 Chrome 实例（与 `launchRealChrome` 行为一致）。

```json
{
  "name": "chrome.launch",
  "inputSchema": {
    "type": "object",
    "properties": {
      "dataDir": { "type": "string", "description": "可选。不传则用 isolated 临时目录" },
      "extraArgs": { "type": "array", "items": { "type": "string" } },
      "lang": { "type": "string", "default": "en-US" },
      "viewport": { "type": "string", "default": "1280x800" },
      "proxy": { "type": "string", "description": "--proxy-server=..." },
      "tags": { "type": "object", "additionalProperties": { "type": "string" } }
    }
  },
  "outputSchema": {
    "type": "object",
    "required": ["sessionId", "debugPort", "dataDir"],
    "properties": {
      "sessionId": { "type": "string" },
      "debugPort": { "type": "integer" },
      "dataDir": { "type": "string" }
    }
  }
}
```

### 5.2 `chrome.connect`
连接到已运行 Chrome（`browserURL` 或 `wsEndpoint`）。用于接外部手动启动的浏览器。

```json
{
  "name": "chrome.connect",
  "inputSchema": {
    "type": "object",
    "oneOf": [
      { "required": ["browserURL"] },
      { "required": ["wsEndpoint"] }
    ],
    "properties": {
      "browserURL": { "type": "string", "description": "http://127.0.0.1:9222" },
      "wsEndpoint": { "type": "string" },
      "tags": { "type": "object" }
    }
  }
}
```

### 5.3 `chrome.close` / `chrome.list`
```json
{ "name": "chrome.close", "inputSchema": { "required": ["sessionId"] } }
{ "name": "chrome.list", "inputSchema": {} }  // 返回 [{sessionId, tags, createdAt}]
```

> `chrome.list` 为**附加 tool**（对话未明确讨论）。用途：debug / 观察当前 session 状态。不是核心能力，可按需保留或砍掉。

### 5.4 `chrome.clear_google_cookies`
对齐现有 `clearBrowserSession`；只清 Google 域。

```json
{ "name": "chrome.clear_google_cookies", "inputSchema": { "required": ["sessionId"] } }
```

### 5.5 `chrome.evaluate`（逃生口）
```json
{
  "name": "chrome.evaluate",
  "inputSchema": {
    "required": ["sessionId", "script"],
    "properties": {
      "sessionId": { "type": "string" },
      "script": { "type": "string", "description": "IIFE or expression" },
      "args": { "type": "array" }
    }
  }
}
```

### 5.6 `google.login` ⭐ 核心
封装 `googleLogin` 整个状态机。SMS 和 TOTP 依赖通过 server 级配置的 provider 解决。

```json
{
  "name": "google.login",
  "inputSchema": {
    "type": "object",
    "required": ["sessionId", "account"],
    "properties": {
      "sessionId": { "type": "string" },
      "account": {
        "type": "object",
        "required": ["email", "password"],
        "properties": {
          "email": { "type": "string" },
          "password": { "type": "string" },
          "totp_secret": { "type": "string", "description": "base32, 用于 2FA" },
          "fa_secret": { "type": "string", "description": "兼容字段，同 totp_secret" },
          "recovery_email": { "type": "string" }
        }
      },
      "smsBehavior": {
        "type": "string",
        "enum": ["auto", "skip", "manual"],
        "default": "auto",
        "description": "auto=用 server 配置的 sms provider；skip=遇到短信就失败；manual=打开浏览器等人工完成"
      },
      "timeoutMs": { "type": "integer", "default": 180000 },
      "startUrl": { "type": "string", "default": "https://accounts.google.com/signin" }
    }
  },
  "outputSchema": {
    "type": "object",
    "required": ["status"],
    "properties": {
      "status": { "enum": ["ok", "stuck", "rejected", "sms_needed", "timeout"] },
      "finalUrl": { "type": "string" },
      "stateHistory": { "type": "array", "items": { "type": "string" } },
      "screenshot": { "type": "string", "description": "base64 PNG on failure (可选)" }
    }
  }
}
```

**实现要点**：登录状态机每个 tick 主动检测当前页面是否为 "Couldn't sign you in / This browser or app may not be secure"（URL path `/v3/signin/rejected` 或页面含 `heading: Couldn't sign you in`），命中立即短路返回 `status=rejected`，不要走完超时。这是目前 MCP-launched Chrome 在 Google 反自动化下最常见的失败模式。

### 5.7 `google.oauth_get_code`
跑 Google OAuth 授权流程，起本地回调 server 捕获 `code`。前置：session 已登录。

```json
{
  "name": "google.oauth_get_code",
  "inputSchema": {
    "required": ["sessionId", "scopes"],
    "properties": {
      "sessionId": { "type": "string" },
      "clientId": { "type": "string", "description": "缺省读 env CLIENT_ID（§15 决策 9）" },
      "scopes": { "type": "array", "items": { "type": "string" } },
      "callbackPortStart": { "type": "integer", "default": 18900 },
      "handleConsent": { "type": "boolean", "default": true, "description": "自动处理账号选择+consent+TOTP 二次挑战" },
      "account": {
        "description": "handleConsent=true 时用于定位账号 + TOTP 二次挑战",
        "type": "object"
      },
      "timeoutMs": { "type": "integer", "default": 120000 }
    }
  },
  "outputSchema": {
    "required": ["code", "redirectUri"],
    "properties": {
      "code": { "type": "string" },
      "redirectUri": { "type": "string" }
    }
  }
}
```

### 5.8 `oauth.exchange_code`
无状态 HTTP 调用（`oauth2.googleapis.com/token`）。

```json
{
  "name": "oauth.exchange_code",
  "inputSchema": {
    "required": ["code", "redirectUri"],
    "properties": {
      "code": { "type": "string" },
      "clientId": { "type": "string", "description": "缺省读 env CLIENT_ID（§15 决策 9）" },
      "clientSecret": { "type": "string", "description": "缺省读 env CLIENT_SECRET（§15 决策 9）" },
      "redirectUri": { "type": "string" }
    }
  },
  "outputSchema": {
    "required": ["accessToken", "refreshToken", "expiresIn"],
    "properties": {
      "accessToken": { "type": "string" },
      "refreshToken": { "type": "string" },
      "expiresIn": { "type": "integer" },
      "scope": { "type": "string" },
      "idToken": { "type": "string" }
    }
  }
}
```

### 5.9 `sms.*`
```json
{ "name": "sms.get_phone", "inputSchema": { "required": ["service", "country"], "properties": {
    "service": { "type": "string", "example": "go" },
    "country": { "type": "string", "example": "6" },
    "provider": { "type": "string", "description": "覆盖默认 provider" }
}}}

{ "name": "sms.wait_code", "inputSchema": { "required": ["activationId"], "properties": {
    "activationId": { "type": "string" },
    "timeoutMs": { "type": "integer", "default": 120000 }
}}}

{ "name": "sms.cancel", "inputSchema": { "required": ["activationId"] } }
```

### 5.10 `totp.generate`
```json
{
  "name": "totp.generate",
  "inputSchema": { "required": ["secret"], "properties": {
    "secret": { "type": "string" },
    "timestamp": { "type": "integer", "description": "测试用，默认 now" }
  }},
  "outputSchema": { "required": ["code", "validForS"] }
}
```

---

## 6. 错误语义

**原则**：所有 tool 失败时抛 MCP error 而不是返回 `{ok:false}`；错误附 `code` 字段便于 agent 分支。

```
CHROME_LAUNCH_FAILED
CHROME_PROTOCOL_ERROR           // Target closed / Session closed
SESSION_NOT_FOUND
GOOGLE_LOGIN_REJECTED           // "Couldn't sign you in"
GOOGLE_LOGIN_STUCK              // 状态机 deadloop
GOOGLE_CHALLENGE_UNSUPPORTED    // 出现未处理的挑战（如 passkey）
OAUTH_CODE_NOT_RECEIVED
OAUTH_TOKEN_EXCHANGE_FAILED
SMS_BALANCE_INSUFFICIENT
SMS_TIMEOUT
SMS_PROVIDER_ERROR
TOTP_INVALID_SECRET
CONCURRENCY_LIMIT_EXCEEDED      // session 超过硬上限（默认 5）
TIMEOUT                         // 通用超时（单独的更具体错误优先）
PRECONDITION_FAILED             // 例：未登录就调 oauth_get_code
```

agent 看 `code` 决策，看 `message` 显示给人。

---

## 7. SMS provider 接口（可插拔）

```js
// mcp-server/src/providers/sms/index.js
interface SmsProvider {
  name: string
  getPhone({ service, country }): Promise<{ number, activationId }>
  waitCode({ activationId, timeoutMs }): Promise<{ code } | throws SMS_TIMEOUT>
  cancel({ activationId }): Promise<void>
}
```

- 通过环境变量 `SMS_PROVIDER=hero-sms` + `HERO_SMS_API_KEY=...` 选择。
- MVP 只实现 hero-sms（照搬 `common/sms.js`）。
- `smsBehavior=manual` 时 `google.login` 跳过 provider，弹窗+polling 等用户操作。

---

## 8. 配置 / 环境

**Secret 策略（§15 决策 9）**：敏感配置走 **env 兜底 + tool 参数覆盖**。server 启动时读 env 作为默认值，tool 调用若传了对应参数则覆盖之。与 `auto_chrome` 现状一致，零迁移成本。

| env / CLI | 作用 | 默认 |
|---|---|---|
| `CHROME_PATH` | Chrome 可执行文件 | 自动探测 |
| `HTTPS_PROXY` | Node fetch 代理（已在 stage3 修复） | 无 |
| `CLIENT_ID` | OAuth client id（§5.7 / §5.8 tool 参数可覆盖） | 无 |
| `CLIENT_SECRET` | OAuth client secret（§5.8 tool 参数可覆盖） | 无 |
| `SMS_PROVIDER` | SMS provider 名 | hero-sms |
| `HERO_SMS_API_KEY` | hero-sms key（**env-only**，不接受 tool 参数覆盖） | 必填（若用 hero-sms） |
| `MAX_SESSIONS` | 并发 session 硬上限 | 5 |
| `CHROME_DATA_ROOT` | session dataDir 前缀 | `/tmp/stealth-chrome-mcp` |
| `KEEP_BROWSER_OPEN` | 退出时是否保留 Chrome 进程（debug 用） | false |
| `LOG_LEVEL` | debug / info / warn / error | info |
| `LOG_FILE` | 日志文件路径（stdio 模式下必开） | 无 |
| CLI `--base-port` | debug port 起点 | 9234 |

---

## 9. 观测

- **MCP 协议 stdout 必须干净**（只传 JSON-RPC）。所有日志走 **stderr**（默认）或 `LOG_FILE`。
- 每个 tool 调用开始/结束打点（duration、sessionId）。
- `google.login` 内部 state 历史记录在日志中，出错时作为 `stateHistory` 字段返回给 caller。
- 失败时自动截图保存 `$CHROME_DATA_ROOT/<sessionId>/error_<timestamp>.png`，路径在 error message 中给出。

---

## 10. 生命周期 & 清理

```
server 启动
  ├─ 注册 SIGTERM / SIGINT handler → registry.closeAll()
  ├─ 注册 uncaughtException → 日志 + 尝试优雅关闭
  └─ MCP 协议 stdio 初始化

tool 调用
  chrome.launch → spawn Chrome → puppeteer.connect → registry.create
  chrome.close  → browser.disconnect → proc.kill → registry 清理 dataDir

server 退出
  → registry.closeAll 并行 terminate 所有 Chrome
  → 等待 max 5s，超时 SIGKILL
```

---

## 11. 并发模型

- **不同 session 可并发** 所有 tool。
- **同一 session 串行**：MCP server 内部为每个 session 做一把 mutex，同一 session 的 tool 按到达顺序执行。原因：puppeteer page 不是并发安全的。
- **硬上限 5 个并发 session**：`chrome.launch` / `chrome.connect` 在当前活跃 session 数已达 5 时拒绝，返回错误 `CONCURRENCY_LIMIT_EXCEEDED`。可通过 env `MAX_SESSIONS` 覆盖（≥1）。

---

## 12. 现有 common/ 需要的小重构

| 文件 | 改动 |
|---|---|
| `common/chrome.js` | `launchRealChrome` 改成可注入 `dataDir` / `extraArgs`，不再硬编码 `chrome_data_temp_pipeline_N` |
| `common/google-login.js` | 把 `sms.js` 从直接 require 改为**参数注入 smsProvider**。让登录状态机不耦合具体 SMS 实现。 |
| `common/sms.js` | 提取为 hero-sms provider 实现，符合 §7 接口 |
| `common/state.js` | **不动**，业务侧用；MCP 不依赖 |
| `common/totp.js` | 不动，MCP 直接 require |
| `3_local_oauth.js` | 把 `startCbServer` / `buildAuthUrl` / `obtainAuthCode` / `exchangeCode` 抽到 `common/oauth.js`，MCP require 它 |

**这些重构对现有 stage 1/2/3 脚本透明**（参数注入默认值 = 原行为），可以分步做。

---

## 13. Skill 层（概览，细节下轮）

**原则**：每个业务 stage 独立成一个 skill —— 流程变化时只改对应 skill，不牵动其他业务。

所有 skill 放独立 repo **`/usr/src/workspace/github/QQhuxuhui/my-skills`**（与 `auto_chrome` 解耦，便于在 Claude Code / Hermes 里按需引用）。

### 技术类 skill（跨业务共享，随 MCP 一起演进）

```
my-skills/google-login-playbook/SKILL.md
  - 账号对象 schema（email/password/totp_secret/fa_secret/recovery_email）
  - SMS / TOTP / recovery 何时触发，如何选择 smsBehavior
  - stuck / rejected / sms_needed 各错误的诊断方向
  - session 复用策略（跨调用、跨 member）

my-skills/oauth-token-harvest/SKILL.md
  - 四步流程（login → oauth_get_code → exchange_code → refresh）
  - CLIENT_ID / CLIENT_SECRET / scopes 约定
  - refresh token 管理
```

### 业务类 skill（每个对应一条 pipeline，彼此独立）

```
my-skills/google-invite/SKILL.md            （原 stage 1: 1_invite.js）
  - 角色：host 登录、进 family group 页、发邀请
  - 5 members / host 配额逻辑
  - 已邀请 / 未邀请判断

my-skills/google-accept/SKILL.md            （原 stage 2: 2_accept.js）
  - 角色：member 登录、接受邀请邮件/通知
  - 真实鼠标点击 accept-invitation 的坑

my-skills/google-oauth-validate/SKILL.md    （原 stage 3: 3_local_oauth.js 业务部分）
  - probeAntigravity / getProjectId / completeValidationFlow 业务实现
  - credentials.json upsert 规则
  - reauth 条件

my-skills/gpt-plus/SKILL.md                 （原 6_gpt_plus.js）
  - 独立业务，结构类似上述
```

**分拆原则**：stage 1/2/3 流程可能调整（例如换 OAuth scope、增加新验证步骤），彼此相互独立；合并成单个 skill 会让一处改动波及无关业务。每个 skill 只描述"调什么 tool、顺序、出错怎么办"，**不重复实现**登录状态机或任何 MCP 里已有的原子能力。

---

## 14. MVP 切片（推荐第一次提交范围）

**总估**：5-7 天（含把现有一条业务跑通作为回归基准）。

Milestone 0 — MCP 核心骨架（2-3 天，本地 PoC）：
- `chrome.launch` / `chrome.connect` / `chrome.close` / `chrome.list`
- `google.login`（阻塞式，SMS=skip，TOTP 用 account.totp_secret；含主动检测 rejected 页）
- stdio MCP server、session registry、硬并发上限 5、一个集成测试（启动 Chrome + 登录一个测试账号 + 关闭）

Milestone 1 — OAuth + 首条业务跑通（+2 天）：
- `google.oauth_get_code` + `oauth.exchange_code`
- `my-skills/google-login-playbook` + `my-skills/oauth-token-harvest`（技术 skill）
- `my-skills/google-oauth-validate`（把 stage 3 改写成 skill）
- 用现有 3 个账户回归，对齐之前"3/3 verified"的结果

Milestone 2 — SMS 完整 + 错误产物（+1-2 天）：
- SMS provider 接口 + hero-sms 实现
- `sms.*` tools + `google.login` 的 `smsBehavior=auto`
- 完整错误码 + 截图产物

Milestone 3（可选，按需拿）— 其他业务迁移：
- `my-skills/google-invite`（stage 1）、`my-skills/google-accept`（stage 2）、`my-skills/gpt-plus`
- 每个 stage 独立做，不互相阻塞

---

## 15. 决策记录

| # | 议题 | 决定 |
|---|---|---|
| 1 | 包名 | `stealth-chrome-mcp` |
| 2 | session 默认数据目录 | `/tmp`（isolated，每次新临时目录） |
| 3 | `chrome.connect` 是否 MVP | **做**，纳入 Milestone 0 |
| 4 | `google.login` 是否主动检测 "Couldn't sign you in" | **是**，命中立即返回 `status=rejected`（实现细节见 §5.6） |
| 5 | Skill 存放位置 | 独立 repo `/usr/src/workspace/github/QQhuxuhui/my-skills`（与 `auto_chrome` 解耦） |
| 6 | 并发上限 | **硬编码 5**，可通过 env `MAX_SESSIONS` 覆盖；超限抛 `CONCURRENCY_LIMIT_EXCEEDED` |
| 7 | 失败截图格式 | base64 PNG 内嵌在返回值（§5.6 `screenshot` 字段） |
| 8 | 错误码 `GOOGLE_CHALLENGE_UNSUPPORTED` | 保留，预留 passkey / 风控新挑战 |
| 9 | Secret 管理（CLIENT_ID / CLIENT_SECRET / HERO_SMS_API_KEY） | **env 兜底 + tool 参数覆盖**。SMS key 仅 env。详见 §8 |
| 10 | 测试策略 | **纯 E2E（真账号）**，不做 Chrome mock / CDP replay。详见 §16 |
| 11 | 发布方式 | **仅本地路径**，不发 npm。`mcp-server/` 放 `auto_chrome` 子目录 |
| 12 | puppeteer-core 版本 | 锁定 `^24.2.1`（与 `src/package.json` 一致） |

所有设计项已明确，可以开始实现。

---

## 16. 测试策略

**原则**：纯 E2E，真账号 + 真 Google。不做 Chrome mock / CDP snapshot replay —— 登录状态机跟 Google UI 强耦合，mock 维护成本高于收益，replay 在 UI 改版时等同失效。

### 测试层次

1. **冒烟测试 (smoke)**：1 个预设测试账号 + 1 次 `chrome.launch` → `google.login` → `chrome.close` 走通。每次改动 MCP 手动跑一次。
2. **回归测试 (regression)**：M1 阶段用现有 3 个 `auto_chrome` 账户跑 stage 3 的新 skill 版，对齐"3/3 verified"结果作为 baseline。后续重大改动前重跑。
3. **canary 账号**：每条业务 skill 维护 1 个不纳入生产批次的测试账号，手动周期性回归（例如每周或 Google UI 变化后）。
4. **无 CI gate**：这些测试都是本地手动，不塞 PR 必过。真账号无法稳定放 CI；CI 只跑 lint + 纯函数单测（`totp.generate`、`oauth.exchange_code` 的错误响应解析等）。

### 需要的固定资产

- **测试账号池**：≥3 个专用 Google 账号，完整 `{email, password, totp_secret, recovery_email}`，与生产账号分开，不进 `members.txt`。
- **测试 OAuth client**：避免用生产 `CLIENT_ID`（避免测试跑挂风控影响真实业务）。
- **SMS 余额**：若要测 SMS 分支，hero-sms 留少量专用余额。

### 不做

- 纯函数之外的单元测试（理由见"原则"）
- 并发压测（硬上限 5，人工测 3 并发够用）
- 性能基准测试（不是设计目标）
