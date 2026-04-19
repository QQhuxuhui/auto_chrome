# 账号库 + 管理面板设计

**日期**：2026-04-19
**作者**：huxuhui（via brainstorming）
**涉及范围**：用远程 Postgres 取代 `hosts.txt` / `members.txt` / `failed.json`，新增 Fastify 本地服务 + 静态 UI 做账号 CRUD 和 pipeline 状态可视化。同时修复 Stage 2 邮件匹配误命中 welcome/notification 邮件的 bug。

---

## 1. 背景与目标

现在账号以 `hosts.txt`（母号）+ `members.txt`（子号）方式存放，失败记录进 `failed.json`。规模小时够用，但：

- 没有状态可视化：不知道哪个子号跑到哪一步
- 母号与子号的绑定关系不可见：stage 3 成功后也没记录"这个 token 来自哪个 host"
- 失败账号难管理：`failed.json` 记录但不好 reset
- 没法批量/远程管理

业务目标（用户原话）：

1. 母号、子号通过页面批量上传保存到数据库
2. 启动程序时从数据库拿还有空位的母号和可用子号
3. 每个 stage 都更新数据库，知道每个账号的状态
4. 页面可以手动 CRUD 账号
5. 可选指定 host 启动；不选时自动填充 host slot 直到子号耗尽
6. Stage 3 拿到 token 后更新绑定关系（member ↔ host），UI 可见

额外约束：

- 程序跑在本地（Puppeteer 需要 Chrome GUI）
- 数据库远程（用户自有：`104.194.91.23:5444`，库 `auto_chrome`，Postgres 15.17）
- 规模：母号 + 子号合计 100 ~ 1000 长期持有

---

## 2. 架构总览

### 进程与模块

```
┌─────────────────────────────────────────────────────────────┐
│  Node 主进程 (npm run server)                                 │
│                                                              │
│  ┌─────────────────┐        ┌──────────────────────────┐    │
│  │ Fastify HTTP    │ fork   │ Orchestrator 模块         │    │
│  │   :3000         │ ─────▶ │  • runStage1(hostIds[])   │    │
│  │  • GET /        │        │  • runStage2()            │    │
│  │  • /api/*       │        │  • runStage3()            │    │
│  └────────┬────────┘        └────────┬─────────────────┘    │
│           │ pg pool                  │ pg pool              │
└───────────┼──────────────────────────┼──────────────────────┘
            ▼                          ▼
     ┌──────────────────────────────────────┐
     │   Postgres 104.194.91.23:5444        │
     │   DB: auto_chrome                    │
     └──────────────────────────────────────┘

┌─────────────────────────────────────────────┐
│  浏览器（本地）: http://localhost:3000        │
│   • 账号管理（CRUD + 批量上传）               │
│   • 仪表盘（每 3s 轮询 /api/status）          │
│   • 启动 pipeline（选 host + 配置）           │
└─────────────────────────────────────────────┘
```

### 启动方式

- `npm run server` / `node src/server.js`：起 Fastify + 开 3000 端口。server 进程本身不跑 pipeline，等 UI 触发。
- `./run_pipeline.sh --stage N`（保留）：直接调 `orchestrator.js`，不起 HTTP server。现有脚本/CI 不动。
- UI 点 `Start`：server 通过 `child_process.fork('src/orchestrator.js', [...flags])` 起独立子进程。子进程崩溃不波及 HTTP server。IPC 只用来回传"pipeline 结束"事件；运行时状态统一通过 DB 读取。

### 关键设计原则

- **DB 是唯一事实来源**。UI 和 orchestrator 都读 DB，orchestrator 不维护进程内状态（避免 kill/restart 丢失）。
- **幂等**。pipeline 任何时候被 kill 再启动，能从 DB 状态恢复。依赖 `status` 字段和单条 UPDATE 的原子性。
- **Google family 页对齐**。Stage 1 启动前（实际上是任何 run 启动时）先抓每个参与 host 的家庭成员列表，与 DB 对齐。避免 DB 漂移。
- **UI 不直接操纵 pipeline 运行时状态**。要 reset / abandon 子号必须走专门 API，避免误点把运行中的 pipeline 搞乱。

---

## 3. 数据库 Schema

4 张表：`hosts`、`members`、`events`（审计/时间线）、`pipeline_runs`（每次启动一行）。

### DDL

```sql
-- 母号
CREATE TABLE hosts (
  id              BIGSERIAL PRIMARY KEY,
  email           TEXT NOT NULL UNIQUE,
  password        TEXT NOT NULL,
  recovery_email  TEXT,
  totp_secret     TEXT,
  notes           TEXT,
  disabled        BOOLEAN NOT NULL DEFAULT FALSE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 子号
CREATE TABLE members (
  id              BIGSERIAL PRIMARY KEY,
  email           TEXT NOT NULL UNIQUE,
  password        TEXT NOT NULL,
  recovery_email  TEXT,
  totp_secret     TEXT,
  notes           TEXT,

  status          TEXT NOT NULL DEFAULT 'new' CHECK (status IN (
    'new',                  -- 从未处理
    'invite_pending',       -- stage1 已发邀请
    'invite_failed',        -- stage1 失败（可重试）
    'joined',               -- stage2 完成，已在 Google family
    'accept_failed',        -- stage2 失败（可重试）
    'oauth_failed',         -- stage3 失败（可重试）
    'done',                 -- stage3 成功，已拿 token
    'abandoned',            -- 手动放弃
    'removed_from_family'   -- 曾加入但被移除/离开
  )),

  host_id         BIGINT REFERENCES hosts(id) ON DELETE SET NULL,

  fail_count      INT NOT NULL DEFAULT 0,   -- 所有 stage 共享的失败计数
  last_error      TEXT,
  last_error_at   TIMESTAMPTZ,

  invited_at      TIMESTAMPTZ,
  joined_at       TIMESTAMPTZ,
  done_at         TIMESTAMPTZ,

  token           TEXT,        -- stage3 产出（refresh_token，一串字符）
  token_meta      JSONB,       -- 选填：scope / expires_at / 其他未来扩展

  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_members_status  ON members(status);
CREATE INDEX idx_members_host    ON members(host_id);

-- 事件流（时间线 + 调试）
CREATE TABLE events (
  id          BIGSERIAL PRIMARY KEY,
  member_id   BIGINT REFERENCES members(id) ON DELETE CASCADE,
  host_id     BIGINT REFERENCES hosts(id)   ON DELETE SET NULL,
  run_id      BIGINT,
  stage       TEXT,        -- 'stage1' | 'stage2' | 'stage3' | 'reconcile'
  event_type  TEXT NOT NULL, -- 'start' | 'success' | 'fail' | 'skip' | 'note'
  message     TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_events_member ON events(member_id, created_at DESC);
CREATE INDEX idx_events_run    ON events(run_id);

-- 每次启动记录
CREATE TABLE pipeline_runs (
  id           BIGSERIAL PRIMARY KEY,
  started_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at  TIMESTAMPTZ,
  launched_by  TEXT NOT NULL,   -- 'ui' | 'cli'
  stages       TEXT NOT NULL,   -- '1,2,3' / '2' 等
  host_filter  JSONB,           -- [] = auto；["h1@...","h2@..."] = 指定
  concurrency  INT,
  pid          INT,
  status       TEXT NOT NULL DEFAULT 'running'
                 CHECK (status IN ('running','completed','failed','cancelled')),
  error        TEXT,
  stats        JSONB            -- { stage1:{ok,ng}, stage2:{...}, ... }
);
```

### Slot 语义（永远派生，不存）

```sql
-- 一个 host 当前占用的 slot 数（pending + final）
SELECT COUNT(*) FROM members
WHERE host_id = $hostId
  AND status IN ('invite_pending','accept_failed','oauth_failed','joined','done');

-- slot_free = 5 - slot_used
```

不存 `hosts.slot_used` 字段。这样 reconcile 把某子号从 `joined` → `removed_from_family` 时 slot 自动更新，不会漂移。Google 家庭组上限硬编码为 5。

### 状态机转移

| 触发 | from | to | 动作 |
|---|---|---|---|
| stage1 start | `new` / `invite_failed` | `invite_pending` | 写 `host_id`、`invited_at` |
| stage1 fail | `invite_pending` | `invite_failed` | 清 `host_id`、`fail_count++` |
| stage2 success | `invite_pending` | `joined` | 写 `joined_at` |
| stage2 fail | `invite_pending` | `accept_failed` | 保留 `host_id`、`fail_count++` |
| stage3 success | `joined` / `oauth_failed` | `done` | 写 `done_at`、`token` |
| stage3 fail | `joined` / `oauth_failed` | `oauth_failed` | 保留 `host_id`、`fail_count++` |
| reconcile: Google 没这人 | `joined` / `done` | `removed_from_family` | 清 `host_id` |
| reconcile: Google 有这人 | `invite_pending` | `joined` | 补 `joined_at` |
| 手动放弃 | any | `abandoned` | 清 `host_id` |
| fail_count 达到 3 | 任意 `_failed` | `abandoned` | 自动晋升为 abandoned |

### 存储决策

- 密码 / TOTP **明文存**（和现有 `members.txt` 同等安全级别；用户自建 DB）
- `fail_count` **跨 stage 共享**：同一个子号在 stage 1/2/3 失败会累加同一个计数器，到 3 就 abandon。避免反复失败刷 Google。
- `token` 就是一串字符（refresh token），`token_meta` JSONB 预留未来（scope、expires_at 等）
- **email 在 hosts 和 members 表内各自 UNIQUE，但允许同一 email 同时出现在两张表**（某账号先做 host 后做 member 的场景）。不做跨表 UNIQUE 约束；bulk upload 到哪张表按 API 路径决定。

---

## 4. HTTP API

**统一约定**：

- 无鉴权；Fastify 绑 `127.0.0.1` only
- 请求/响应 JSON；错误 `{error: "msg"}` + 合适 HTTP code
- 分页 `?page=1&pageSize=50`（默认 50）

### Hosts

| Method | Path | 说明 |
|---|---|---|
| GET | `/api/hosts` | 列表，带 `slot_used` / `slot_free`（实时派生）。支持 `?disabled=0`、`?search=email%` |
| POST | `/api/hosts/bulk` | 批量导入。body: `{lines: "email:pass:rec:totp\n..."}` 或 `{accounts: [...]}`。返回 `{inserted, skipped, errors[]}`。冲突默认 skip |
| PATCH | `/api/hosts/:id` | 改字段（含 `disabled`） |
| DELETE | `/api/hosts/:id` | 删；关联 `members.host_id` 自动置 NULL |

### Members

| Method | Path | 说明 |
|---|---|---|
| GET | `/api/members` | 列表。支持 `?status=a,b`、`?host_id=N`、`?search=`、`?has_token=1` |
| GET | `/api/members/:id` | 详情 + 最近 50 条 events |
| POST | `/api/members/bulk` | 批量导入。格式同 hosts。冲突默认 skip |
| PATCH | `/api/members/:id` | 改字段；特殊动作用 action param：`?action=reset`（清状态回 `new` + 清 `host_id` + 清 `fail_count`）、`?action=abandon` |
| DELETE | `/api/members/:id` | 删（级联删 events） |

### Pipeline

| Method | Path | 说明 |
|---|---|---|
| POST | `/api/pipeline/start` | body: `{stages: "1,2,3", hostFilter: [], concurrency: 1}`。返回 `{runId, pid}`。若已有 `status=running` 的 run，拒绝 409 |
| POST | `/api/pipeline/runs/:id/cancel` | SIGTERM 子进程（10s 后升级 SIGKILL） |
| GET | `/api/pipeline/runs` | 最近 N 次 runs |
| GET | `/api/pipeline/runs/:id` | 详情 + 该 run 的 events（最多 500 条） |

### Dashboard

| Method | Path | 说明 |
|---|---|---|
| GET | `/api/status` | `{byStatus: {new: 12, ...}, hosts: {total, withFreeSlot, freeSlotsTotal, disabled}, currentRun: {...} or null}` |

### Migration

| Method | Path | 说明 |
|---|---|---|
| POST | `/api/migrate/txt` | body: `{hostsPath?, membersPath?}`。复用 `common/state.js#parseAccounts`，批量 upsert（skip on conflict） |

### Ops

| Method | Path | 说明 |
|---|---|---|
| POST | `/api/reconcile` | 手动触发 reconcile。body: `{hostIds?: [...]}`（空则全部已启用 host）。返回变更统计。不需要 pipeline 在跑 |

### 静态 UI

| Path | 说明 |
|---|---|
| `/` | `public/index.html` 仪表盘 |
| `/accounts` | 账号管理 |
| `/runs` | 历史 runs |
| `/public/*` | 静态资源 |

### 运维约束

- **只允许一个 run 并发**：启动前检查 `pipeline_runs.status='running'` 数量，有则 409
- **cancel 先 SIGTERM 后 SIGKILL**：给 10s 关 Chrome / flush events
- **bulk 上传复用 `common/state.js`**：`parseAccounts` 已支持 `:` / `\t` / `----` / 3 列 / 4 列 / TOTP 识别
- **列表过滤最小化**：100–1000 量级可以前端拉全量+客户端过滤，后端只给 `status / host_id / search` 基础参数

---

## 5. UI 页面

三页共用 Tailwind 深色风（延续 repo 根 `index.html` 的 `#0a0a0f` + glass card 调性）。

### `/` 仪表盘

```
┌─ Gemini Family Pipeline ─────────────────────────────────────┐
│ [Dashboard] [Accounts] [Runs]                                 │
├───────────────────────────────────────────────────────────────┤
│  Current Run                                                  │
│  ┌───────────────────────────────────────────────────────┐   │
│  │ # 17  running  · stages 1,2,3 · pid 4823              │   │
│  │ Stage1 ok 8 / ng 0      Stage2 ok 3 / ng 1            │   │
│  │ Stage3 ok 1 / ng 0                                    │   │
│  │ Started 2m ago · [Cancel]                             │   │
│  └───────────────────────────────────────────────────────┘   │
│                                                               │
│  Member Status                    Host Capacity               │
│  ┌───────────────────────┐  ┌────────────────────────────┐   │
│  │ new            12     │  │ total            5          │   │
│  │ invite_pending  4     │  │ with free slot   3          │   │
│  │ joined          8     │  │ free slots total 9          │   │
│  │ done           15     │  │ disabled         1          │   │
│  │ failed(*)       2     │  └────────────────────────────┘   │
│  │ abandoned       1     │                                    │
│  └───────────────────────┘                                    │
│                                                               │
│  [▶ Start Pipeline]                                           │
└───────────────────────────────────────────────────────────────┘
```

Alpine.js 每 3s 拉 `/api/status`。

**Start 弹窗**：

```
Start Pipeline
├ Stages:      [x] 1 Invite  [x] 2 Accept  [x] 3 OAuth
├ Hosts:       ● Auto (all hosts with free slot)
│              ○ Select: [ ] host1@...  [ ] host2@...
├ Concurrency: [ 1 ] ▼  (1–5)  ← 默认 1
└ [Cancel]  [Start]
```

### `/accounts` 账号管理

**顶部横幅**（只有当检测到本地 txt 且 DB 空或明显少于 txt 时显示）：

```
┌────────────────────────────────────────────────────────────┐
│ 🔔 检测到本地 hosts.txt / members.txt (3 hosts, 2 members)  │
│    → [从 txt 导入]    （导入后此横幅消失）                  │
└────────────────────────────────────────────────────────────┘
```

**Tab: Hosts**

| ☐ | email | slot used/total | disabled | actions |
|---|---|---|---|---|
| ☐ | huxuhui123@gmail.com | 4 / 5 | off | [Edit] [Delete] |

顶部：`[+ 批量导入] [+ 单个添加] [搜索: ___]`
批量导入 → 弹出 textarea 粘 `email:pass:rec:totp` 一行一个 → POST bulk → 显示 `{inserted, skipped, errors}`。

**Tab: Members**

| ☐ | email | status | host | fail | token | actions |
|---|---|---|---|---|---|---|
| ☐ | foo@gmail.com | joined | huxuhui123@... | 0 | — | [Detail] [Reset] [Abandon] |
| ☐ | bar@gmail.com | done | huxuhui123@... | 0 | `abc12345…` `[Copy]` | [Detail] |

- `token` 列**默认只显示前 8 字符** + Copy 按钮；详情抽屉里显示全部
- 顶部过滤器：`status: [全部 ▼]  host: [全部 ▼]  search: ___`
- 批量操作：`[Reset 选中] [Abandon 选中] [Delete 选中]`

**Detail 抽屉**（右侧滑入，不是独立页面）：显示所有字段 + 时间线（近 50 条 events，按 `created_at DESC`）+ 手动 `edit / reset / abandon / delete`。

### `/runs` 历史

- 表格：最近 50 次 runs；行点开展开 events（按 stage 分组）
- 正在 `running` 的 run 高亮顶置

### UI 实现约定

- **无构建步骤**：`public/` 下纯静态 HTML + `app.js` 用 Alpine.js CDN
- **3 秒轮询**：`/` 和 `/runs` 页 Alpine `setInterval` 拉 `/api/status`；离开页面清 interval
- **样式**：Tailwind CDN，延续 `index.html` 深色风

---

## 6. Pipeline 代码集成

### 文件改动总览

| 文件 | 动作 | 说明 |
|---|---|---|
| `src/1_invite.js` / `src/2_accept.js` / `src/3_local_oauth.js` | 重写 `main()` | 工作项从 DB 拉（按 status），写状态走 DB。核心 per-account 函数（`inviteMember`、`acceptInvite`、oauth 流程）原样保留 |
| `src/common/state.js` | 瘦身 + 保留 | `parseAccounts` / `buildGroups` 保留（bulk upload 复用）。`addFailedRecord` / `failed.json` 弃用（events 表替代） |
| `src/2_accept.js`（Bug fix） | 收紧邮件匹配 | 见下一节 |
| `run_pipeline.sh` | 小改 | 启动前插一行 `pipeline_runs(launched_by='cli')`，然后 `node src/orchestrator.js --run-id N --stages 1,2,3` |

### 新增文件

```
src/
├── orchestrator.js          ← UI fork 和 CLI 都调用
├── db/
│   ├── index.js             ← pg Pool + query helper
│   ├── schema.sql           ← 完整 DDL（见 Section 3）
│   ├── hosts.js             ← listHosts / upsertHost / ...
│   ├── members.js           ← listMembers / transitionStatus / ...
│   ├── events.js            ← logEvent
│   └── runs.js              ← createRun / updateRun / listRuns
├── stages/
│   ├── stage1.js            ← runStage1({runId, hostFilter, concurrency})
│   ├── stage2.js
│   ├── stage3.js
│   └── reconcile.js         ← reconcileHostFamily(hostAccount)
├── server.js                ← Fastify + static + routes
└── routes/
    ├── hosts.js
    ├── members.js
    ├── pipeline.js
    ├── status.js
    └── migrate.js

public/
├── index.html               ← 仪表盘
├── accounts.html            ← 账号管理
├── runs.html                ← 历史
├── css/app.css
└── js/app.js

scripts/
├── init-db.js               ← 读 schema.sql 执行一次
└── migrate-txt.js           ← CLI 形式的 txt → DB 迁移
```

### Orchestrator 流程

```
orchestrator.runPipeline({ runId, stages, hostFilter, concurrency })
│
├─ 1. reconcile phase（任何 stage 启动前都跑一次）
│    for each host in (hostFilter || all enabled hosts):
│        loginHost → 抓 Google family page → diff DB → patch states
│
├─ 2. if stages includes 1:
│    work = SELECT members
│             WHERE status IN ('new','invite_failed')
│               AND fail_count < 3
│             ORDER BY created_at ASC
│    pickHost 分配（见下）；runStage1（并发 = concurrency）
│       success → invite_pending, host_id, invited_at
│       fail    → invite_failed, host_id=NULL, fail_count++
│                 if fail_count >= 3 → abandoned
│
├─ 3. if stages includes 2:
│    work = SELECT members
│             WHERE status='invite_pending' AND host_id IS NOT NULL
│             ORDER BY invited_at ASC
│    runStage2
│       success → joined, joined_at
│       fail    → accept_failed（host_id 保留）, fail_count++
│                 if fail_count >= 3 → abandoned
│
├─ 4. if stages includes 3:
│    work = SELECT members
│             WHERE status IN ('joined','oauth_failed')
│               AND fail_count < 3
│             ORDER BY joined_at ASC NULLS LAST, updated_at ASC
│    runStage3
│       success → done, token, done_at
│       fail    → oauth_failed, fail_count++
│                 if fail_count >= 3 → abandoned
│
└─ 5. 更新 pipeline_runs: finished_at, stats, status='completed'
```

### Host 分配（stage 1，伪码）

```js
for each member m in work (按 created_at ASC):
  candidates = hosts WHERE (hostFilter 空 OR email IN hostFilter)
                      AND disabled = false
                      AND slot_free > 0
  if candidates 空: break  // 没 host 可用，剩下留下次
  host = candidates 按 (slot_used ASC, created_at ASC) 第一个
  assign m → host, 发起邀请
```

**分配策略 = 铺开（spread），不是压满（pack）**：`slot_used ASC` 优先选已占用最少的 host。理由：一个 host 若被 Google 风控，损失的子号最少。若以后需要"压满"策略（1 个 host 先塞满 5 人再开下一个）只要把排序改成 `slot_used DESC`。

**自选 host 超容量场景**：剩余子号本次不处理，下次用 auto 模式跑会被捡起。

### Stage 2 邮件匹配 Bug fix（重点）

**现状**（2026-04-19 实测发现）：`searchKeywords` 里 `google one` / `family group` 过松，会误中：

- `welcome to google one, you've been added to ...`（加入后的 welcome 邮件）
- `your new family group member, X joined your family group`（host 侧的"新成员加入"通知）

误中后点错链接，landing page 没有 accept 按钮，最终 `accept_not_confirmed` / `chrome-error://`。

**修复方案**：

1. 邮件匹配必须满足：行文本或 href 包含 `family/join`（这是 Google 邀请邮件专属的 URL 段）
2. 显式排除关键词（任一命中即 skip 该行）：
   - `welcome to google one`
   - `joined your family`
   - `your new family group member`
   - `you've been added to`
   - `你已加入` / `加入了你的家庭组`
3. 若扫完收件箱没找到 family/join 的邀请邮件，**先做一次"对该 member 的 reconcile"**（即用 host 账号登录，看 Google family 页是否已有该 member）：
   - 若已在家庭里 → 更新 `status=joined`、`joined_at=NOW()`、写 `events(event_type='skip', message='already in family, skipped stage2')`、return success（orchestrator 会在 stage 3 阶段把它捡起）
   - 若不在家庭里 → 视为邀请邮件尚未到达，继续轮询直到 `INVITE_WAIT_TIMEOUT`，超时抛 `invite_email_timeout` → `accept_failed`

### Events 写入时机

| 时机 | stage | event_type | 说明 |
|---|---|---|---|
| stage 入口 | stageN | start | — |
| 成功 | stageN | success | — |
| 失败 | stageN | fail | error message |
| reconcile 变更 | reconcile | note | "pending → joined via family page" |
| 跳过（已 joined） | stageN | skip | "already joined, skipping stageN" |

### Graceful shutdown (SIGTERM)

1. 停止派发新工作
2. 等 worker 完成当前账号（最多 30s）
3. 关 Chrome
4. `pipeline_runs.status='cancelled'`, `finished_at=NOW()`
5. exit 0

---

## 7. 错误处理

| 层 | 处理 |
|---|---|
| Chrome / puppeteer | per-account try/catch → 写 events + `_failed` 状态 + `fail_count++`；必要时 `restartChrome` |
| 业务逻辑 | 同上；`members.last_error` 存消息供 UI 显示 |
| orchestrator 外层 | catch → `pipeline_runs.status='failed'`；子进程 exit(1) |
| HTTP 层 | Fastify error hook 统一 `{error}` + 合适 code |

**不做的事**：

- 不自动无限重试（fail_count 到 3 就 abandon）
- 失败不自动重排到另一个 host：stage 1 fail 释放 slot 可重分配；stage 2/3 fail 保留 `host_id`（Google 那边已经有 pending/joined）

**幂等保证**：orchestrator 工作项按 `status + fail_count < 3` 过滤，kill 再启动能从中断点继续。

---

## 8. 测试策略

### 单元测试（`node --test`）

- `db/members.js` 状态转移：在真 DB 上事务 + rollback 验证
- `orchestrator.pickHost`：mock DB，覆盖 slot_used 排序 / hostFilter 边界 / 无候选返回 null
- `common/state.js#parseAccounts`：全分隔符 / 列数 / TOTP 识别 / 坏行
- **Stage 2 邮件匹配**：给定一批邮件行 DOM 片段，断言真·邀请邮件命中、welcome/notification 邮件不命中

### 集成测试

- Fastify `app.inject()`：bulk upload → list → delete 闭环
- `scripts/init-db.js` 对空 DB 跑出全部表且无报错

### 端到端

不自动化。依赖手动验证：

1. 1 host + 1 member 跑 stage 1 → UI 状态 `invite_pending`
2. 子号 Gmail 看到邀请邮件 → 跑 stage 2 → UI `joined` → Google family 页对齐
3. 跑 stage 3 → `token` 填充 → UI Copy 可用

### 观察性

- 各 stage 日志仍写 `logs/stage*_YYYYMMDD_HHMMSS.log`（现有逻辑不动）
- 关键状态转移**同时**写 `events` 表（UI 看这个）
- Fastify 请求日志进 stdout

---

## 9. 非目标（Out of Scope）

明确不做的：

- 多用户 / 鉴权 / SSO
- 跨机部署 / HA
- DB 加密列
- websocket / SSE 实时推送（轮询够用）
- 自动重试无上限（fail_count=3 硬 abandon）
- 失败自动重排到另一个 host
- 移动端专门适配（Tailwind 响应式够用）
- ORM / TypeScript

---

## 10. 依赖变化

`package.json` 新增：

```json
{
  "dependencies": {
    "fastify": "^5.x",
    "@fastify/static": "^7.x",
    "pg": "^8.x"
  },
  "scripts": {
    "server": "node src/server.js",
    "db:init": "node scripts/init-db.js"
  }
}
```

前端零依赖安装（Tailwind + Alpine.js 全 CDN）。

---

## 11. 迁移路径

1. 新增 DB 表（`npm run db:init`）
2. 新增 server / orchestrator / stages 文件，旧的 stage 脚本保留但 `main()` 改成 DB 读写
3. 启动 UI（`npm run server`），点"从 txt 导入"按钮把现有 `hosts.txt` / `members.txt` 灌入
4. 验证：UI 能看到所有账号，跑一轮 stage 1（手动开小量）观察
5. 确认无误后把 `members.txt` / `hosts.txt` 重命名为 `.bak`（不删，怕万一）
6. `failed.json` 保留但不再写入（events 表替代）

---

## 附录 A：DB 连接

- Host: `104.194.91.23`
- Port: `5444`
- User: `root`
- Database: `auto_chrome`
- Postgres 版本：15.17

密码存到 `.env`（`PG_PASSWORD`），不 commit。

## 附录 B：配置默认值

| 配置 | 默认值 | 来源 |
|---|---|---|
| `concurrency` | 1 | UI 启动表单 / `--concurrency` flag |
| `fail_count` 上限 | 3 | 硬编码（后续如需可挪 env） |
| Google family 上限 | 5 | 硬编码（Google 产品规则） |
| UI 轮询间隔 | 3000ms | `public/js/app.js` |
| SIGTERM 等待 | 30s | orchestrator shutdown |
| Server 监听 | `127.0.0.1:3000` | `src/server.js` |
