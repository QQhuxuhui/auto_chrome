# Antigravity-Manager 平台集成设计

**日期**：2026-04-19
**作者**：huxuhui（via design dialog）
**涉及范围**：auto_chrome pipeline 产出的账号双向同步到 Antigravity-Manager（`http://104.194.91.23:8045`），把被 Antigravity 标记为 `disabled=true` 的账号自动从 Google family 移除。

---

## 1. 背景

auto_chrome 生产链路 `invite → accept → oauth` 的最终产物是每个子号的 `refresh_token`。这个 token 需要被导入到另一个自建平台（Antigravity-Manager）的账号池。平台会根据 token 的实际使用情况自动把失效账号标 `disabled=true`（refresh 失败、429 资源耗尽、invalid_grant）。被封禁的账号占着 host 的家庭 slot 但不产生价值，应当：

1. 自动从 Google family 移除（释放 host slot）
2. 从 Antigravity 侧也删除（平台保持纯 active pool）
3. 本地 `members.status` 转为 `removed_from_family`，等待后续 stage 1 用新子号填补空位

## 2. 用户决策矩阵（设计对话输出）

| # | 问题 | 决策 |
|---|---|---|
| Q1 | 哪些 Antigravity 状态触发移除家庭组？ | 只有 `disabled=true`；`validation_blocked` 仅记录 |
| Q2 | 同步节奏 | 5 分钟定时 `setInterval` + orchestrator reconcile 阶段内嵌 |
| Q3 | Push 时机 | 仅手动（stage 3 不自动推送） |
| Q4 | 初次同步 | 按 email 小写自动匹配，回填 `antigravity.id` 到本地 member |
| Q5 | Orphan（平台有、本地没有的账号） | 完全忽略，不入库 |
| Q6 | Push UI | 每行按钮 + 顶部「批量推送待推送」按钮 |
| Q7 | 移除家庭组执行 | reconcile 阶段内嵌 + 独立 `orchestrator.js --cleanup` 子命令 |
| Q8 | Push 失败重试 | 不自动重试；`antigravity.push_error` 字段记录，UI 显示，用户手动重试 |
| Q9 | 封禁+移除后是否删 Antigravity 记录 | 删（`DELETE /api/accounts/:id`） |

## 3. 数据模型

### Schema 扩展

```sql
ALTER TABLE members ADD COLUMN IF NOT EXISTS antigravity JSONB;
CREATE INDEX IF NOT EXISTS idx_members_antigravity_id
    ON members ((antigravity->>'id'))
    WHERE antigravity IS NOT NULL;
```

`antigravity` JSONB 字段结构：

```jsonc
{
  "id": "910009b1-feb3-43db-abb9-9a846d5b0d24",   // UUID from platform; null 前 = 未推送
  "pushed_at": "2026-04-19T11:00:00Z",             // 首次推送成功时间
  "push_error": null,                              // 或 {"at":"...","code":400,"message":"..."}
  "disabled": false,                               // 镜像自平台
  "disabled_reason": null,
  "disabled_at": null,
  "validation_blocked": false,                     // 镜像但不触发动作
  "validation_blocked_until": null,
  "last_synced_at": "2026-04-19T12:00:00Z"         // 最近一次 sync 成功时间
}
```

**null 语义**：`members.antigravity IS NULL` 表示这个子号从未被推送过，也没对应平台记录。

### 新增状态

`members.status` CHECK 约束保持不变（9 个值），不新增状态。已有 `removed_from_family` 涵盖"曾加入但已移除"的场景 —— 无论是 reconcile 发现 Google 那边消失了，还是我们主动移除，都落到 `removed_from_family`。

### 状态流转新增

| 触发 | from | to | 动作 |
|---|---|---|---|
| sync 发现 `disabled=true` | any | (不变) | 只更新 `antigravity` JSONB，不改 `status` |
| reconcile 检测到 `disabled=true` 且还在 Google family 里 | `joined`/`done` | `removed_from_family` | 1. Google family 页点「移除成员」 2. `DELETE /api/accounts/:id` 3. 清 `host_id`, `antigravity.id`, `antigravity.disabled` |

## 4. 架构

```
┌───────────────────────────────────────────────────────────────┐
│ Node server (:3000)                                            │
│                                                                │
│   ┌──────────────────────┐    ┌──────────────────────────┐    │
│   │ Fastify routes       │    │ antigravity-sync.js      │    │
│   │  POST /api/          │    │  • syncFromRemote()      │    │
│   │    antigravity/sync  │    │  • pushAccount(memberId) │    │
│   │  POST .../push/:id   │◀───┤  • pushAllPending()      │    │
│   │  POST .../push-all   │    └────────┬─────────────────┘    │
│   └──────────────────────┘             │                       │
│                                        │ HTTP                   │
│   ┌──────────────────────┐             │                       │
│   │ 5min setInterval     │─────────────┘                       │
│   │ → syncFromRemote()   │                                     │
│   └──────────────────────┘                                     │
│                                                                │
└───────────────────────────────────────────────────────────────┘
                                │
                                ▼
                ┌────────────────────────────┐
                │ Antigravity-Manager :8045  │
                │  /api/accounts  (Bearer)   │
                └────────────────────────────┘

┌───────────────────────────────────────────────────────────────┐
│ orchestrator.js (forked by UI or CLI)                          │
│                                                                │
│   runReconcilePhase() 扩展:                                    │
│     1. 原有: scrape Google family, diff DB                    │
│     2. 新增 a: 先调 syncFromRemote() 刷新 antigravity 字段    │
│     3. 新增 b: 对每个 disabled=true 且还在 family 的成员,     │
│        调用 removeFromFamily() + DELETE 平台 + 更新本地       │
│                                                                │
│   新增 --cleanup 标志:                                         │
│     不跑 stage 1/2/3，只跑 runReconcilePhase()                │
└───────────────────────────────────────────────────────────────┘
```

## 5. 模块划分

### 新增文件

```
src/
├── common/
│   └── antigravity.js         ← HTTP client (fetch-based)
├── sync/
│   └── antigravity-sync.js    ← syncFromRemote, pushAccount, pushAllPending
└── routes/
    └── antigravity.js         ← POST /api/antigravity/sync|push|push-all

scripts/
└── antigravity-schema.js      ← ALTER TABLE (idempotent)
```

### `src/common/antigravity.js`

纯 HTTP 客户端，无业务逻辑。使用 `undici` 或 Node 原生 `fetch`（Node 18+）。

```javascript
// 导出:
// listAccounts() -> { accounts: [...], current_id }
// pushAccount({ refreshToken }) -> Account
// deleteAccount(id) -> void
// refreshQuotas() -> void (fire-and-forget, 202 accepted)

const BASE_URL = process.env.ANTIGRAVITY_URL || 'http://104.194.91.23:8045';
const API_KEY  = process.env.ANTIGRAVITY_API_KEY;  // 在 .env 里设
```

**`.env` 新增**：`ANTIGRAVITY_URL`、`ANTIGRAVITY_API_KEY=123Abc!@#`

### `src/sync/antigravity-sync.js`

```javascript
async function syncFromRemote() {
    // 1. GET /api/accounts
    // 2. 对每条 remote account: 按 email 小写匹配本地 member
    // 3. 匹配到: UPDATE antigravity JSONB (合并 id, disabled, validation_blocked, last_synced_at)
    // 4. 记录 orphans 数量但不入库
    // 返回: { matched, updated, newly_disabled: [{memberId, email, reason}], orphans: N }
}

async function pushAccount(memberId) {
    // 1. SELECT member; 要求 status='done' 且 token 非空
    // 2. POST /api/accounts { refreshToken: member.token }
    // 3. 成功: UPDATE antigravity = {id, pushed_at, ...}
    // 4. 失败: UPDATE antigravity.push_error = {at, code, message}
    // 返回: { success: bool, error? }
}

async function pushAllPending() {
    // SELECT members WHERE status='done' AND (antigravity IS NULL OR antigravity->>'id' IS NULL)
    // 逐个调 pushAccount；返回 { total, pushed, errors: [...] }
}
```

### `src/routes/antigravity.js`

| Method | Path | 说明 |
|---|---|---|
| POST | `/api/antigravity/sync` | 触发一次 `syncFromRemote()`，返回统计 |
| POST | `/api/antigravity/push/:id` | 推送单个 member |
| POST | `/api/antigravity/push-all` | 批量推送所有待推送 |
| GET | `/api/antigravity/orphans` | 返回 Antigravity 上有但本地没有的 email 列表（只读视图） |

### `src/server.js` 改动

在 `build()` 之后、监听之前，注册一个定时任务：

```javascript
if (process.env.SYNC_INTERVAL_MS !== '0') {
    const ms = parseInt(process.env.SYNC_INTERVAL_MS, 10) || 5 * 60 * 1000;
    setInterval(() => {
        syncFromRemote().catch(e => app.log.error('scheduled sync failed:', e.message));
    }, ms).unref();  // 不阻塞进程退出
}
```

### `src/stages/reconcile.js` 扩展

现有 `reconcileHost(hostRecord, browser, runId, wlog)` 增加一步：在登录 host 抓完 family page 后，对每个 `host_id=hostRecord.id AND antigravity.disabled=true AND Google family 里有这人` 的 member：

```javascript
// 在 family details 页点「移除成员」按钮
await removeFamilyMember(page, member.email, wlog);
// 成功则删平台记录
if (member.antigravity?.id) {
    await antigravity.deleteAccount(member.antigravity.id);
}
// 更新本地
await membersDb.markRemovedFromFamily(member.id);  // 已有函数
await membersDb.updateAntigravity(member.id, { id: null, disabled: false, disabled_reason: null });
await eventsDb.logEvent({ memberId: member.id, ..., stage: 'reconcile', eventType: 'note',
    message: `removed from family + antigravity due to platform ban: ${reason}` });
```

`removeFamilyMember(page, email)` 是一个新的 Puppeteer 辅助函数，逻辑：
1. 找到 email 所在的成员行
2. 点击该行的「...」或「移除」按钮
3. 确认弹窗
4. 等待 DOM 更新

### `src/orchestrator.js` 扩展

新增 flag `--cleanup`：
- `node orchestrator.js --run-id N --cleanup` → 只跑 `runReconcilePhase()`，跳过所有 stage
- 已有 `--reconcile-only` flag（spec 里写过）可以直接复用；不增新 flag，而是 **让 reconcile 阶段自动包含平台 disabled 清理**（不需要额外指令）
- 所以 `orchestrator.js --reconcile-only` 实际上就是 Q7 B 想要的"独立清理入口"

## 6. UI 改动

### Members 表新增「平台状态」列

| email | 状态 | 母号 | 失败 | 凭证 | **平台状态** | 操作 |
|---|---|---|---|---|---|---|
| foo@ | 已完成 | h1@ | 0 | abc... | ✅ 正常 | 详情 / **推送** / 重置 / ... |
| bar@ | 已完成 | h2@ | 0 | xyz... | — 未推送 | 详情 / **推送** / ... |
| baz@ | 已完成 | — | 0 | mno... | ❌ 已封禁 | 详情 / ... |

状态 pill（复用现有 statusLabel 机制）：
- `—` 灰色：antigravity IS NULL
- `✅ 正常`：antigravity.id 存在且 disabled=false 且 validation_blocked=false
- `⚠️ 需验证`：validation_blocked=true
- `❌ 已封禁`：disabled=true
- `❗ 推送失败`：antigravity.push_error 存在且 id 为空

每行「推送」按钮：仅当 `status='done'` 且 `antigravity.id IS NULL` 时显示，点击 → POST `/api/antigravity/push/:id`，成功后列表刷新。

### Members tab 顶部新增

`[批量推送待推送（N）]` 按钮：显示有多少 `status='done'` 未推送，点击触发 `POST /api/antigravity/push-all`，弹出进度/结果 alert。

### 仪表盘新增

「Antigravity 同步」卡片：
- 最近同步时间
- 平台账号总数、disabled 数、validation_blocked 数、未关联本地（orphan）数
- `[立即同步]` 按钮（POST `/api/antigravity/sync`）

### Member 详情抽屉新增

在「当前绑定母号（内部）」下面加：
```
平台状态
  ID:              910009b1-feb3-43db-abb9-9a846d5b0d24
  推送时间:        2026-04-19 11:00:00
  最近同步:        2026-04-19 12:05:30
  disabled:        是
  disabled_reason: invalid_grant
  [重新推送]  [手动删除平台记录]
```

## 7. 错误处理

| 场景 | 处理 |
|---|---|
| push 网络错误 / 5xx | 记 `antigravity.push_error`，不抛异常；用户点「重新推送」清错误 + 重试 |
| push 4xx（含 400 duplicate） | 同上 |
| sync 网络错误 | log warn，本次跳过；不修改 `last_synced_at` |
| sync 部分条目解析失败 | 记错误日志，继续处理其他条目 |
| reconcile 移除 family 成员失败（按钮找不到、DOM 变了） | log warn，不抛异常，不改本地 status；下轮 reconcile 重试 |
| reconcile 成功移除 family，但 DELETE 平台失败 | 本地 status 已更新，平台删除留给下轮 sync 重试（下轮 sync 会再次检测到 disabled） |
| 本地 member 已经是 `removed_from_family`，sync 又看到 disabled 标记 | 什么也不做（终态） |

**幂等性保证**：
- push 用 `antigravity.id IS NULL` 作为判断条件，已推送的不会重复推
- reconcile 移除动作在 Google 那边看到成员不存在时就是 no-op（Puppeteer 找不到行直接跳过）
- DELETE 平台记录即使失败下轮 sync 也会重试

## 8. 测试

### 单元测试

- `src/common/antigravity.js` 的 HTTP 客户端：mock fetch 验证 header / body 格式
- `src/sync/antigravity-sync.js#syncFromRemote`：mock `listAccounts()`，验证本地 UPDATE 逻辑（匹配、orphan 识别、disabled 状态反映）
- `src/sync/antigravity-sync.js#pushAccount`：mock `pushAccount()`，验证状态转移 + 错误分支

### 集成测试

- `app.inject('POST /api/antigravity/sync')` 对 live Antigravity API 跑一次（测试环境专属），验证落库
- 不自动测 `reconcileHost` 的移除动作（涉及 Google UI + Chrome）

### 手动 e2e

1. UI 点「立即同步」→ 看 dashboard 卡片数字变化
2. 对一个 `status=done` 的 member 点「推送」→ 详情里出现 id
3. （风险操作）人工在 Antigravity UI 把某个账号标 `disabled=true` → 下次 reconcile → 观察 Google family 页被自动移除 + 本地 status 变 `removed_from_family`

## 9. 配置默认值

| 配置 | 默认值 | env 变量 |
|---|---|---|
| Antigravity API URL | `http://104.194.91.23:8045` | `ANTIGRAVITY_URL` |
| Antigravity API Key | （必填，无默认） | `ANTIGRAVITY_API_KEY` |
| 同步间隔 | 300_000 ms（5 分钟） | `SYNC_INTERVAL_MS` |
| 关闭自动同步 | — | `SYNC_INTERVAL_MS=0` |
| HTTP 超时 | 10_000 ms | `ANTIGRAVITY_TIMEOUT_MS` |

## 10. 非目标

- 不做 Antigravity 账号的完整 CRUD（只 push + sync + delete）
- 不同步 quota 数据（`quota.models` 这类高频变化数据不入本地 DB；UI 详情可临时 fetch）
- 不支持 `validation_blocked` 的自动恢复追踪
- 不做历史推送审计表（events 表已经够）
- 不做多 Antigravity 实例支持（一个 URL 搞定）

## 11. 迁移路径

1. `.env` 追加 `ANTIGRAVITY_URL` + `ANTIGRAVITY_API_KEY`
2. 跑 `node scripts/antigravity-schema.js`（或直接 `npm run db:init` 如果让它检测 ALTER）加 `antigravity JSONB` 列
3. 启服务后 **首次 sync 自动触发**（或用户点仪表盘按钮）
4. 自动按 email 匹配现有 7 条 Antigravity 账号和本地 members 表，回填 `antigravity.id`
5. 后续新产出的 `status=done` 账号用户手动点「推送」

## 附录 A：依赖

- 无新 npm 包（Node 18+ 内置 `fetch`）
- 如发现 fetch 不稳定可切 `undici`（已经在 package.json 里）

## 附录 B：失败处理决策表（总表）

| 场景 | 本地 action | 平台 action | 用户可见 |
|---|---|---|---|
| push 成功 | 写 antigravity.id+pushed_at | 新账号入池 | 平台状态列变 ✅ |
| push 失败 | 写 antigravity.push_error | — | 平台状态列变 ❗ + 按钮可重试 |
| sync 发现新 disabled | 写 antigravity.disabled=true | — | 平台状态列变 ❌ |
| reconcile 移除 family 成功 | status=removed_from_family, host_id=NULL, antigravity.id=NULL | DELETE /accounts/:id | 占用列少 1 / 状态变 已移除 |
| reconcile 移除 family 失败 | 不改 | 不改 | 下轮 reconcile 再试（事件表有日志） |
| sync 发现 orphan（平台有本地没有） | 忽略 | — | 仪表盘 orphan 数 +1 |
