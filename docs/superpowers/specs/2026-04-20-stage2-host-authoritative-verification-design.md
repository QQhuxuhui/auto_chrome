# Stage 2 以母号家庭页为权威的接受邀请验证

日期：2026-04-20
影响范围：`src/2_accept.js`（拆分）、`src/stages/accept/*`（新）、`src/orchestrator.js`（小改），兼容性 shim。

## 1. 问题

当前 stage 2（接受家庭邀请）的成功/失败以**子号 accept flow 的技术性完成**为准：
Gmail 登录 → 找邀请邮件 → 点 `family/join` 链接 → 走完验证流程 → return truthy。

这带来两种系统性偏差：

1. **表面失败实际成功**。子号流程在 SMS 超时 / challenge 卡住 / verify_phone 接码失败等
   中途挂掉，但 Google 侧邀请可能已经在更早一步被接受。run 194 就是典型：
   5 个成员 stage 2 在 SMS 接码处全部抛错，reconcile 事后发现它们在 Google
   家庭里都是 joined 状态，被动纠偏。
2. **表面成功实际未生效**。子号 click 了邀请链接、看见"已加入"提示，但 Google
   后台没最终 commit（偶发，和家庭组 server-side 延迟 / 风控有关）。当前没有
   任何机制在当轮 run 里识别出来，要等下一次 reconcile。

## 2. 设计原则

**母号家庭页是唯一权威。** 子号 accept flow 只是"触发器"，它的 return 值不是
最终裁决；谁在 Google 家庭组里、谁还是 pending，以母号
`myaccount.google.com/family/details` 页面显示的状态为准。

同时，为了不阻塞/拖慢 happy path，监控是**旁路**的 —— 有一个独立的
host-monitor Chrome 实例常驻登 host、定时 scrape 家庭页，与 member worker 之间
通过进程内事件解耦。

## 3. 架构

```
runStage2({ runId, hostIds, concurrency })
    for each host in hostIds (sequential):
        hm = new HostMonitor(host)
        await hm.start()                    # 登 host + 首次 scrape 校准
        workers = [launchMemberWorker() × concurrency]
        runMemberLoop(host, workers, hm)    # 同今天的 flat queue，但只取这个 host 的成员
        await hm.stop()
        teardown(workers)
```

### 3.1 HostMonitor（常驻 scraper）

**职责：** 独立 Chrome，登入 host 后在 `family/details` 页面长驻轮询。

**`hm.start()` 语义：** 返回前必须保证（a）host 已登录、（b）首次完整 scrape
已完成、（c）`familyState[host]` 已校准。这样之后启动 member worker、任何
`awaitHostConfirmation` 都能依赖 `state` 已初始化。 首次校准失败（login 或 scrape）
→ `start()` 不抛但进入 degraded。

- 端口：`BASE_DEBUG_PORT + 100 + (hostId % 50)`，避开 member workers 的 `9234+workerId`
- user-data-dir：`src/chrome_data_temp_pipeline_H${hostId}`
- 首次 scrape 校准完整 familyState；随后每 `HOST_MONITOR_POLL_INTERVAL_MS`（默认 60000ms）
  轮询一次
- 每轮 scrape 完 emit `'scrape-done'` 事件；订阅者为 member worker 的
  `awaitHostConfirmation`
- 只抓**列表页**（新 helper `scrapeFamilyListPage`），**不进**详情页取 email
  —— 详情 click 对每个 joined 成员要 ~3s，5 成员一轮 scrape 要 15s+，不适合定时
  轮询。列表页一次足够判断每个 target email 的 pending/joined 状态

**列表页 scrape 输出：**
```js
{
    pending: [{ href: 'family/invitation/...', email: 'foo@bar.com' }, ...],
    joinedHrefs: ['family/member/....', ...],  // 不带 email
    scrapedAt: Date.now(),
}
```

**familyState[host] 数据结构：**
```js
{
    // 以 email 为 key（email 从 DB 和 reconcile 拿，对于 pending 也从列表页拿）
    'foo@bar.com': { status: 'pending', href: '...', lastSeenAt: Date },
    'bar@baz.com': { status: 'joined',  href: '...', lastSeenAt: Date },
    ...
}
```

**状态迁移规则（每次 scrape 后）：**
- target email 的 href 出现在 `pending[]` → `status='pending'`
- target email 的 href 不在 `pending[]` **且** `joinedHrefs` 里有它的 href → `status='joined'`
- 两个都没有 → `status='unknown'`（邀请被撤销 / 过期 / host 异常）

对于"joined href 对应哪个 target email"这个映射，有两种来源：
1. 首次校准时由 `scrapeFamilyMembers`（慢版）建立的完整 `{href → email}` 映射
2. 后续 pending 的 href 从 `pending[]` 里还能直接拿到 email
对于运行中从 pending 转 joined 的 target，href 从 pending 列表消失，我们认为它
进入 joined（不需要再去详情验证 —— 反正下轮完整 reconcile 会做 ground-truth 校对）

### 3.2 MemberWorker（和今天基本一致）

**未变：** 每个 member 走 `acceptInvite(memberAccount, browser, workerId)` —— Gmail 登录
→ 找邀请邮件 → 点 `family/join` 链接 → 走 `googleLogin` 的验证 state machine。

**变的是 worker 拿到 accept flow 结果之后：**

```js
async function processMember(member) {
    await logEvent('stage2', 'start', member);

    let flowResult, flowError;
    try {
        flowResult = await Promise.race([
            acceptInvite(memberAccount, worker.browser, worker.id),
            hardTimeout(ACCEPT_HARD_TIMEOUT_MS),
        ]);
    } catch (e) {
        flowError = e;
    }

    // c 逻辑：给 host-monitor 2 分钟窗口做最终裁决
    const hostStatus = await awaitHostConfirmation(hm, member.email, {
        timeoutMs: 2 * 60 * 1000,
    });

    const decision = decide({ flowResult, flowError, hostStatus });
    await applyDecision(member, decision);
}
```

### 3.3 decide()（纯函数，带单测）

输入：`{ flowResult: boolean, flowError: Error | null, hostStatus: 'joined' | 'pending' | 'unknown' | 'timeout' | 'degraded' }`

输出：`{ finalStatus: 'done' | 'accept_failed', eventType, message }`

| flowError | flowResult | hostStatus == 'joined' | finalStatus | eventType | message |
|---|---|---|---|---|---|
| null | truthy | yes | `done` | `success` | null |
| null | truthy | no（pending/unknown/timeout/degraded） | `accept_failed` | `accept_failed_unconfirmed` | "flow ok but host-page not confirmed within 2min" |
| Error | — | yes | `done` | `success` | `"flow threw: ${err.message} but host confirmed joined"` |
| Error | — | no | `accept_failed` | `fail` | `err.message` |
| null | falsy | yes | `done` | `success` | `"flow returned falsy but host confirmed joined"` |
| null | falsy | no | `accept_failed` | `fail` | `"acceptInvite returned falsy"` |

Note `hostStatus === 'degraded'`：host-monitor 登录失败或 3x scrape 失败后的降级标记。
等价于"host 未确认"，所以走未 joined 分支。

### 3.4 awaitHostConfirmation(hm, email, opts)

伪代码：
```js
function awaitHostConfirmation(hm, email, { timeoutMs }) {
    return new Promise((resolve) => {
        // 立刻查一次当前 familyState（可能 monitor 刚 scrape 完）
        if (hm.state[email]?.status === 'joined') return resolve('joined');
        if (hm.degraded) return resolve('degraded');

        const onScrape = () => {
            if (hm.state[email]?.status === 'joined') {
                cleanup(); resolve('joined');
            }
        };
        const onDegrade = () => { cleanup(); resolve('degraded'); };
        const timer = setTimeout(() => {
            cleanup();
            resolve(hm.state[email]?.status || 'timeout');
        }, timeoutMs);

        hm.on('scrape-done', onScrape);
        hm.on('degraded', onDegrade);
        function cleanup() {
            clearTimeout(timer);
            hm.off('scrape-done', onScrape);
            hm.off('degraded', onDegrade);
        }
    });
}
```

## 4. 生命周期 & 异常处理

### 4.1 host-monitor 启动失败 → 降级

若 host login 失败（密码错 / 账号禁用 / 撞不可自动化的 challenge），**不整体 abort**：

- `hm.degraded = true`，emit `'degraded'`
- member worker 继续跑 accept flow（和今天行为一样）
- 所有 `awaitHostConfirmation` 立即 resolve `'degraded'`
- decide() 走"host 未确认"分支

此时行为等价于今天 + 多一层 `accept_failed_unconfirmed` 诊断事件，不倒退。

### 4.2 运行中 scrape 出错

- 单次失败：记 `lastScrapeError`，继续下一轮
- 连续 ≥ 3 次失败：降级（同 4.1）

### 4.3 Chrome 崩溃

- host-monitor Chrome 死：尝试 `restartChrome` 1 次 + 重新登 host + 重建 familyState；再死降级
- member worker Chrome 死：沿用现有 `isChromeAlive` + `restartChrome` 逻辑

### 4.4 收尾（per host）

```
所有 member 都 settle（decide 写完）
await 一轮完整 scrape 完成（最多 1 × polling interval）
hm.stop() → stopSignal → loop 退出 → browser.close() + proc.kill()
familyState[host] = null
下一个 host
```

### 4.5 concurrency 行为

- `concurrency=1`：1 host-monitor + 1 member worker = 2 Chrome
- `concurrency=3`：1 host-monitor + 3 member worker = 4 Chrome
- host-monitor 是 per-host 全局唯一，member worker 并行不影响它

## 5. 文件 / 模块结构

```
src/stages/accept/
    index.js              # runStage2 入口，协调 hm + workers，per-host 循环
    host-monitor.js       # HostMonitor 类，EventEmitter，暴露 .start() .stop() .state .on(...)
    family-scrape-fast.js # scrapeFamilyListPage(page) —— 只抓列表页
    member-worker.js      # acceptInvite() 搬过来，接口不变
    decide.js             # decide({ flowResult, flowError, hostStatus }) → { finalStatus, eventType, message }
    decide.test.js        # decide 纯函数单测，覆盖 §3.3 的 6 行裁决表
```

`src/2_accept.js` 变成 shim：

```js
module.exports = require('./stages/accept');
```

保持 `require('./2_accept')` 的现有调用方（orchestrator.js 等）不破。

`src/stages/reconcile.js` 保留 `scrapeFamilyMembers` 原貌，reconcile 的行为不变。
HostMonitor 首次校准时**可以**复用它来建立初始 `{href → email}` 映射。

## 6. 环境变量

| 变量 | 默认 | 作用 |
|---|---|---|
| `HOST_MONITOR_POLL_INTERVAL_MS` | 60000 | 每轮 scrape 间隔 |
| `HOST_MONITOR_GRACE_MS` | 120000 | `awaitHostConfirmation` 默认 timeout（= §1 的 2min 宽限） |
| `HOST_MONITOR_MAX_SCRAPE_FAILS` | 3 | 连续 scrape 失败多少次触发降级 |

## 7. 测试

1. **`decide.test.js` 单测**：6 个分支全覆盖，纯函数无需 mock
2. **手工端到端**：像 run 194 一样跑一次 5-member 批次，观察
   - 子号 accept flow 报错但 host 翻 → 最终 `done` + `success` 事件（带原 flow error 备注）
   - 子号 accept flow OK 但 host 2min 没翻 → `accept_failed` + `accept_failed_unconfirmed` 事件
   - host login 失败 → 降级行为退化为今天的 stage 2
3. **UI 事件时间线回归**：events 表新事件类型 `accept_failed_unconfirmed` 能被 `/api/pipeline/runs/:id`
   正常返回、前端渲染不崩

## 8. 非目标（YAGNI）

- 不支持**跨 host 并行**（§1 选 A：每 host 串行）。未来要 scale，再开 fan-out monitor
- 不改 `members.status` 枚举 / DB schema。所有新信号走 events 表
- 不改 reconcile（它今天已经做开头的 ground-truth 纠偏，保留）
- host-monitor 不替代 reconcile —— reconcile 是整体 run 的前置；host-monitor 是
  stage 2 范围内的实时信号，职责分明
- 不做 SMS / 接码重试策略改进（是另一个 bug 类别，单独治理）
- host-monitor 不跟 stage 3 / reconcile 共享，仅为 stage 2 服务

## 9. 迁移与兼容

- 数据库：无 schema 改动
- API：`/api/pipeline/runs/:id` 的 events 会多一种 `event_type`；前端无需代码改动
  就能显示（已按字符串渲染）
- 现有 `require('./2_accept')` 路径保留 shim 兼容
- 回滚：删 `src/stages/accept/` 子目录 + 把 `2_accept.js` 的 shim 回退到原 981 行代码即可

## 10. 实现顺序建议

1. `decide.js` + `decide.test.js`（纯函数先写，最快定锚）
2. `family-scrape-fast.js`（独立抓取，独立可测）
3. `host-monitor.js`（EventEmitter，依赖 chrome.js launchRealChrome + googleLogin）
4. `member-worker.js`（从 2_accept.js 搬 acceptInvite，接口不动）
5. `index.js`（runStage2 新版，串起以上所有）
6. `2_accept.js` 改为 shim
7. 手工端到端跑一次

每一步可独立 commit。
