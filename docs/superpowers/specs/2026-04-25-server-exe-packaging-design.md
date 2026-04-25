# 把本地 UI/API 服务打包成 Windows 单文件 exe

**Date**: 2026-04-25
**Status**: Approved
**Owner**: GGbond

## 背景与目标

当前 `src/server.js` 启动一个 Fastify 5 服务，监听 `127.0.0.1:3000`，提供仪表盘、账号管理、运行历史等本地 UI，并通过 `child_process.fork()` 调度 `orchestrator.js` 跑 pipeline（stage1 invite / stage2 accept / stage3 oauth）。开发者本地用 `node src/server.js` 启动；现在要做成可分发的 Windows exe，让团队成员**双击即用**，不需要装 Node、不需要 `npm install`、不需要懂命令行。

## 范围决策（澄清结果）

| 维度 | 决策 |
|---|---|
| 分发对象 | 团队多人（不是给开发者本人，也不是公开分发） |
| 后端服务（PG / Antigravity） | **共享**：所有团队成员连同一套远程后端，`.env` 写死打进 exe |
| 运行体验 | 黑色 console 窗口 + 自动开默认浏览器；关窗 = 关服务（不做托盘、不做后台静默） |
| exe 用途 | **完整 pipeline runtime**：UI + 账号管理 + 真实跑 invite/accept/oauth（不是只读模式） |
| Chrome 来源 | **用户系统 Chrome**：`common/chrome.js::findChrome()` 在用户机器上找；Chromium 不打进 exe |
| 数据/日志位置 | **exe 同目录的 `data/` 子文件夹**：截图、user-data-dir、credentials.json 全在那 |

## 非目标

- 不做 macOS / Linux 的对应可执行（团队都是 Windows）
- 不打包 Chromium（团队都已装 Chrome）
- 不做系统托盘 / 后台静默 / 单实例锁（端口冲突由 listen 失败天然兜底）
- 不做自动更新（YAGNI；版本升级靠手动覆盖 exe）
- 不打包 `mcp-server/` 子项目（独立工具，与 server.js 无关）
- 不做错误日志中心化上报
- 不做优雅 shutdown（关窗即结束，PG 连接交给对端回收）
- 第一版不打包 macOS/Linux 目标

## 工具选型

**选用 [@yao-pkg/pkg](https://github.com/yao-pkg/pkg)**（社区维护的 pkg fork，支持 Node 22）。

### 为什么不用 Node SEA

Node 20+ 内置的 Single Executable App 是更"政治正确"的官方方案，但对当前代码侵入大：

- `child_process.fork(scriptPath)` 在 SEA 下不能直接给磁盘上不存在的 snapshot 路径——必须改成"自己 spawn 自己 + argv 分流" dispatcher 模式。`routes/pipeline.js`、`routes/ops.js`、`orchestrator.js` 都要改。
- `@fastify/static` 用 `fs.readFileSync` 读 `public/` 资源，SEA 内嵌资源用 `sea.getAsset()` API，二者不兼容——要自己写 Fastify 路由替代 static plugin。

`@yao-pkg/pkg` 自带运行时 hook：

- 拦截 `fork(<snapshot path>, ...)` 自动转成 `spawn(process.execPath, ...)` + 内部 dispatcher，应用代码零改动
- `fs` 模块在 snapshot 虚拟路径上的读操作走 vfs hook，`@fastify/static` 直接用

预估工作量差距：pkg 方案 ~1-1.5 天，SEA 方案 ~3-4 天。第一版选 pkg；如未来 yao-pkg 维护中断或 Node 大版本不兼容，再迁 SEA。

### 不用 Electron 的原因

不符合"黑窗 + 默认浏览器"决策（Electron 自带 chromium 做窗口），且体积反而大 +200 MB。

## 架构

### 最终产物

单文件 `dist/auto_chrome.exe`（约 80 MB），团队成员放桌面或任意自己可写的文件夹，双击即用。

### 打进 exe 的内容

- Node 22 runtime（pkg 内嵌）
- `src/` 下所有 `.js`（含 `*.test.js` 排除规则）：`server.js`、`orchestrator.js`、`auth.js`、`1_invite.js`、`2_accept.js`、`3_local_oauth.js`、`3_sub2api.js`、`4_verify.js`、`6_gpt_plus.js`、`delete_members.js`、`host-login.js`、`stages/**`、`common/**`、`routes/**`、`db/**`、`sync/**`、`host-login/**`
- `node_modules/`：fastify、@fastify/static、dotenv、pg、puppeteer-core、undici
- `public/`：3 个 HTML + `css/` + `js/`（pkg snapshot 资产）
- `.env`：共享后端的 `PG_HOST`/`ANTIGRAVITY_URL` 等（pkg assets）
- `src/db/schema.sql`：DB schema 文件（pkg assets）
- `node_modules/puppeteer-core/lib/**/*.json`：兜底 puppeteer 的 protocol JSON 资源（pkg 偶尔漏）

### 不打进 exe 的内容

- Chrome 浏览器：运行时用 `common/chrome.js::findChrome()` 找用户系统 Chrome
- `data/` 子目录：运行时由 `paths.js` 在 exe 同目录创建
- `mcp-server/` 子项目：独立工具，与 server 无关
- `scripts/`：开发期 DB 初始化脚本，团队用户用不到

### 双击启动流程

1. exe 启动，console 窗口出现
2. 入口顶层挂 `uncaughtException` / `unhandledRejection` 守护（pkg 模式下打印堆栈+等键退出，防一闪退）
3. `paths.js` 加载，决定 `exeDir = path.dirname(process.execPath)`，创建 `data/`、`data/chrome-profiles/`、`data/debug/`（mkdirSync recursive）
4. dotenv 按 `[exeDir/.env, snapshot/.env]` 顺序加载，第一个存在的胜出
5. 启动横幅打印（版本、data dir、监听地址）
6. `build()` 注册路由
7. `reapOrphanRuns()` 扫 DB 里 `status='running'` 但 PID 不存活的 run 标 cancelled
8. `app.listen({ host: '127.0.0.1', port: 3000 })`
9. 注册 antigravity 定时 sync（已有逻辑）
10. `if (process.pkg)` 调 `openDefaultBrowser('http://127.0.0.1:3000')`，用 `cmd /c start "" <url>` 拉起默认浏览器
11. 用户操作 UI；点"开始运行"→ `routes/pipeline.js` fork orchestrator（pkg hook 接管，spawn 自己作 child）→ orchestrator 跑 stage 1/2/3
12. **关闭 console 窗口或 Ctrl+C** = 服务退出

## 数据目录策略

### 单一来源：`src/common/paths.js`（新增）

```js
const path = require('path');
const fs = require('fs');

const isPkg = !!process.pkg;
const exeDir = isPkg
  ? path.dirname(process.execPath)
  : path.resolve(__dirname, '..', '..');  // dev: repo root

function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
  return p;
}

let dataDir;
try {
  dataDir = ensureDir(path.join(exeDir, 'data'));
} catch (e) {
  if (isPkg && e.code === 'EACCES') {
    // 把更友好的消息塞进 error，让顶层 uncaughtException 守护打印 + 等键退出
    e.userMessage = `无法在 ${exeDir} 创建 data 目录（权限不足）。\n请把 auto_chrome.exe 移到桌面或自己可写的文件夹再运行。`;
  }
  throw e;
}

const chromeProfilesDir = ensureDir(path.join(dataDir, 'chrome-profiles'));
const debugDir = ensureDir(path.join(dataDir, 'debug'));

module.exports = {
  isPkg,
  exeDir,
  dataDir,
  chromeProfilesDir,
  debugDir,
  credentialsFile: path.join(dataDir, 'credentials.json'),
  failedFile: path.join(dataDir, 'failed.json'),
  enableApiFailedFile: path.join(dataDir, 'enableAPI_failed.json'),
};
```

### 目录布局（运行时）

```
auto_chrome.exe
data/
  chrome-profiles/
    pipeline_0/, pipeline_1/, ...     ← worker 用
    pipeline_H252/, pipeline_H254/    ← stage2 host monitor 用
    host_login_253/, ...              ← host-login 用
    auth_0/, ...                      ← auth.js CLI 用
  debug/
    *.png                             ← 所有 debug 截图
  credentials.json                    ← OAuth token 缓存
  failed.json                         ← state.js 写
  enableAPI_failed.json               ← auth.js 写
```

### 需要修改的硬编码路径（11 处）

| 文件:行 | 现状 | 改为 |
|---|---|---|
| `common/chrome.js:80, 117` | `chrome_data_temp_pipeline_<id>` | `chromeProfilesDir/pipeline_<id>` |
| `common/chrome.js:771` | `debug_<name>_<ts>.png`（在 src/） | `debugDir/<name>_<ts>.png` |
| `host-login/flow.js:83` | `chrome_data_temp_host_login_<id>` | `chromeProfilesDir/host_login_<id>` |
| `stages/accept/index.js:42` | `chrome_data_temp_pipeline_H<id>` | `chromeProfilesDir/pipeline_H<id>` |
| `auth.js:375` | `chrome_data_temp_auth_<id>` | `chromeProfilesDir/auth_<id>` |
| `auth.js:1171` | `debug_*.png` | `debugDir/*` |
| `auth.js:29-31` | `credentials.json`, `failed.json`, `enableAPI_failed.json` | `credentialsFile / failedFile / enableApiFailedFile` |
| `3_local_oauth.js:82` | `credentials.json` | `credentialsFile`（保留 `process.env.CRED_FILE` 优先覆盖） |
| `common/state.js:9` | `failed.json` | `failedFile` |
| `routes/pipeline.js:29` | `pgrep -af chrome_data_temp_pipeline_` | `pgrep -af 'chrome-profiles[/\\\\]pipeline_'` |

### legacy `.txt` 输入（不动）

`auth.js` / `delete_members.js` / `routes/migrate.js` 仍有 `accounts.txt` / `hosts.txt` / `members.txt` 的多路径 fallback——DB 化前的产物。**不强行迁移**，仅在 `auth.js:1758-1760` 的 candidate 列表前部追加 `path.join(dataDir, 'accounts.txt')`，保持兼容。

## fork 子进程在 pkg 下的工作方式

### 现有 fork 调用零改动

`routes/pipeline.js:74-77` 和 `routes/ops.js:48-51`：

```js
const orchestratorPath = path.resolve(__dirname, '..', 'orchestrator.js');
const child = fork(orchestratorPath, args, {
  stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  detached: true,
});
```

pkg 运行时拦截：发现 `orchestratorPath` 是 snapshot 路径就 spawn `process.execPath`（exe 自己），通过环境变量告诉 child 要执行哪个内嵌脚本。child 进程：

- `__filename` / `__dirname` 仍解析到 snapshot 路径
- `require.main === module` 仍成立 → orchestrator 的 main() 正常跑
- `detached: true` 是 spawn 标准 option，不受影响 → setsid 正常 → `process.kill(-pid)` 整组杀依然有效（之前 PR 实现的 cancel/force-kill 完全保留）

### `.env` 加载（小升级，仅在 server 入口）

```js
const envCandidates = [
  path.join(exeDir, '.env'),                 // exe 旁可选覆盖
  path.resolve(__dirname, '..', '.env'),     // bundled snapshot
];
const envPath = envCandidates.find(p => fs.existsSync(p));
if (envPath) require('dotenv').config({ path: envPath });
```

打进 exe 的 `.env` 是默认；团队成员想临时改某字段（如 SERVER_PORT），把一个 `.env` 放 exe 旁就覆盖。

### orchestrator 等子进程的 .env 加载

orchestrator.js 现有的 `require('dotenv').config({ path: require('path').resolve(__dirname, '..', '.env') })` 在 pkg 模式下会指向 snapshot 内 `.env`——pkg vfs 接住，能读到。**不动**。

orchestrator 是否也应该尝试 exeDir/.env 覆盖？是。把 .env 加载逻辑也抽到 paths.js，所有 entry 共用：

```js
// paths.js 追加
function loadEnv() {
  const dotenv = require('dotenv');
  const envCandidates = [
    path.join(exeDir, '.env'),
    path.resolve(__dirname, '..', '..', '.env'),
  ];
  const envPath = envCandidates.find(p => fs.existsSync(p));
  if (envPath) dotenv.config({ path: envPath });
  return envPath;
}
module.exports.loadEnv = loadEnv;
```

`server.js` 和 `orchestrator.js` 都改成 `require('./common/paths').loadEnv()`。

## 启动横幅、浏览器拉起、端口冲突

### 横幅

```
============================================
  auto_chrome v0.1.0
============================================

  data dir : C:\Users\you\Desktop\data
  listen   : http://127.0.0.1:3000

  正在打开浏览器...

  关闭此窗口或按 Ctrl+C 退出服务
============================================
```

### `openDefaultBrowser`（无外部依赖）

```js
function openDefaultBrowser(url) {
  const { spawn } = require('child_process');
  const opts = { detached: true, stdio: 'ignore' };
  try {
    if (process.platform === 'win32') {
      // 第一个 "" 是 start 命令必需的窗口标题占位符
      spawn('cmd', ['/c', 'start', '""', url], opts).unref();
    } else if (process.platform === 'darwin') {
      spawn('open', [url], opts).unref();
    } else {
      spawn('xdg-open', [url], opts).unref();
    }
  } catch (_) { /* 浏览器拉不起也不影响 server */ }
}
```

### `start()` 末尾追加（仅 pkg 模式）

```js
if (process.pkg) {
  printStartupBanner();
  openDefaultBrowser(`http://${HOST}:${PORT}`);
}
```

开发期 `node src/server.js` 不会自动开浏览器，行为完全不变。

### 端口冲突（第二次双击）

```js
try {
  await app.listen({ port: PORT, host: HOST });
} catch (e) {
  if (e.code === 'EADDRINUSE') {
    console.error(`\n端口 ${PORT} 已被占用——可能已有一个 auto_chrome 在跑。`);
    console.error(`请在浏览器打开 http://${HOST}:${PORT}`);
    console.error(`按任意键退出...`);
    await waitForKeypress();
  } else {
    app.log.error(e);
  }
  process.exit(1);
}
```

## 错误处理

| 场景 | 改造 |
|---|---|
| **PG 连不上** | `start()` 捕获 ECONNREFUSED/ETIMEDOUT，console 打印"PG 连接失败：检查网络或联系管理员"，等键退出 |
| **data/ 不可写** | `paths.js` 在 ensureDir 失败时友好提示"请把 exe 移到可写文件夹"，等键退出 |
| **找不到 Chrome** | `routes/pipeline.js` 在 fork 前预检 `findChrome()`，null 直接返 422 `{error: '未找到系统 Chrome'}`；UI 弹窗。零 run row 浪费 |
| **fork 失败** | `routes/pipeline.js` 和 `ops.js` 的 fork 调用包 try/catch，失败返 500 + error |
| **未捕获异常** | 入口顶层 `uncaughtException` / `unhandledRejection` 守护，pkg 模式下打印 + 等键退出 |
| **端口冲突** | listen 失败友好提示（见上） |

### `waitForKeypress`（无依赖）

```js
async function waitForKeypress() {
  return new Promise(resolve => {
    process.stdin.setRawMode?.(true);
    process.stdin.resume();
    process.stdin.once('data', () => {
      process.stdin.setRawMode?.(false);
      process.stdin.pause();
      resolve();
    });
  });
}
```

### 入口顶层守护（`server.js` 文件最顶部）

```js
if (process.pkg) {
  process.on('uncaughtException', e => {
    if (e.userMessage) {
      console.error(`\n[FATAL] ${e.userMessage}`);
    } else {
      console.error('\n[FATAL]', e.message);
      console.error(e.stack);
    }
    console.error('\n按任意键退出...');
    process.stdin.resume();
    process.stdin.once('data', () => process.exit(1));
  });
  process.on('unhandledRejection', e => {
    console.error('\n[UNHANDLED REJECTION]', e?.message || e);
    if (e?.stack) console.error(e.stack);
  });
}
```

## 构建产物与分发

### 新增 / 修改文件

#### `package.json`（repo 根新增——build harness）

```json
{
  "name": "auto_chrome-build",
  "version": "0.1.0",
  "private": true,
  "scripts": {
    "build": "pkg src/server.js --config pkg.config.json --output dist/auto_chrome.exe"
  },
  "devDependencies": {
    "@yao-pkg/pkg": "^6.4.0"
  }
}
```

#### `pkg.config.json`（repo 根新增）

```json
{
  "pkg": {
    "scripts": [
      "src/**/*.js",
      "!src/**/*.test.js"
    ],
    "assets": [
      "public/**/*",
      ".env",
      "src/db/schema.sql",
      "node_modules/puppeteer-core/lib/**/*.json"
    ],
    "targets": ["node22-win-x64"]
  }
}
```

#### `.gitignore` 追加

```
dist/
data/
```

### 构建步骤

```bash
npm install           # 拉 @yao-pkg/pkg
npm run build         # → dist/auto_chrome.exe
```

首次构建 ~3 分钟（pkg 下载 Node 22 Windows base，缓存在 `~/.pkg-cache/`）。

### 版本号

- **单一来源**：repo 根新增的 `package.json`（build harness）的 `version` 字段
- 注意 **`src/package.json` 的 `version` 是另一个无关字段**（"antigravity-batch-auth"，当前 10.0.0）；exe 版本号读根的 `package.json`，不读 src 的
- 启动横幅 / banner：在 `paths.js` 输出 `version`：
  ```js
  // paths.js 追加
  const pkgRoot = path.resolve(__dirname, '..', '..', 'package.json');
  module.exports.version = require(pkgRoot).version;
  ```
  `paths.js` 在 `src/common/`，`../../package.json` = repo 根的 build-harness package.json。pkg 打包时根 `package.json` 自动被识别（pkg 的 entry 解析依赖它）
- 第一版 `0.1.0`

### 发布前 smoke test 清单

必须在真 Windows 上跑过才发布：

- [ ] 双击 → console 出现 → 浏览器开到 `http://127.0.0.1:3000` → UI 加载
- [ ] 仪表盘 dryRun=true 跑一次 → DB 看到 run row
- [ ] dryRun=false 跑 stage 1 真实邀请 → `tasklist | findstr auto_chrome` 看到 2 个进程
- [ ] 取消按钮 → orchestrator 进程消失，server 在
- [ ] 强制杀按钮 → 残留 chrome 也清光（`tasklist | findstr chrome` 干净）
- [ ] 关 console 窗口 → 端口释放（`netstat -ano | findstr 3000` 无）
- [ ] 第二次双击 → 友好提示端口被占
- [ ] 把 exe 移到 `Program Files\xxx` → 友好提示 data 不可写
- [ ] 在 exe 旁放 `.env` 含 `SERVER_PORT=3001` → 用新端口启动
- [ ] **puppeteer 兼容性**：跑一次完整 stage 1 不报 `Cannot find module 'devtools-protocol/...'`

### 分发流程

1. 开发机构建 → `dist/auto_chrome.exe`
2. 发文件给团队（IM / 网盘 / 共享磁盘）
3. 团队成员放桌面，双击

无安装步骤、无配置步骤。

### 升级流程

1. 改代码 → bump `package.json.version` → `npm run build`
2. 把新 exe 推给团队覆盖旧的

不做自动更新（YAGNI）。

## 实施 Plan（高层）

### Phase 1：路径单一化（不依赖 pkg，可独立合并）

1. 新增 `src/common/paths.js`
2. 改 11 处硬编码路径
3. 跑现有测试验证无回归（特别是 `routes/pipeline.test.js`、`stages/reconcile.test.js` 等）
4. 开发模式 `node src/server.js` 跑一次确认 data/ 出现在 repo 根

### Phase 2：pkg 兼容改造

1. `server.js` 顶部加 `process.pkg` 守护 + 启动横幅 + `openDefaultBrowser` + 端口冲突友好处理
2. `routes/pipeline.js` fork 前预检 `findChrome()`
3. `routes/pipeline.js` / `ops.js` fork 调用包 try/catch
4. `paths.js` 追加 `loadEnv()`，`server.js` / `orchestrator.js` 改用

### Phase 3：构建配置

1. repo 根加 `package.json` + `pkg.config.json`
2. `.gitignore` 追加 `dist/`、`data/`
3. `npm install` → `npm run build`
4. 拷 exe 到 Windows，按 smoke test 清单逐条验证

### Phase 4：迭代修补

如 smoke test 发现 puppeteer-core 报 `Cannot find module`，按需在 `pkg.config.json` 的 `assets` 里追加缺失的资源 glob，重 build。
