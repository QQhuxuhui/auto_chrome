# Stage 2 manual 模式跳过母号登录

日期：2026-04-22
影响范围：`src/orchestrator.js`（reconcile gate 扩展）、`src/stages/accept/index.js`（manual 早返）、`src/orchestrator/orchestrator-flags.test.js`（矩阵单测）。

## 1. 背景

今天的流程在两层都会登母号（host）：

1. **orchestrator reconcile 前奏** —— 进 stage 2/3 前登每个 host 扫 family page，做 DB ↔ Google 状态对齐。今天只有 `stages === ['3']` 时跳过（commit 4e715bf）。
2. **Stage 2 host-monitor** —— 每个 host 起一个独立 Chrome，登 host 常驻轮询 family/details 页，对每个 member 的 accept 做权威裁决（commit a48ab31 / 2026-04-20 spec）。

host-monitor 的设计初衷（见 [2026-04-20 spec](./2026-04-20-stage2-host-authoritative-verification-design.md)）是解决两类 auto-mode 的系统性偏差：

- 子号流程假失败（SMS 超时但 Google 已接受）
- 子号流程假成功（点了接受但 Google 没 commit）

在手工介入（`ACCEPT_MODE=manual`）场景下，操作人自己就是那个权威裁决 —— 盯着 member-side 浏览器操作完、关窗后告一段落。host 监听带来的收益消失，但成本（host 登录撞 CAPTCHA / verify_phone、一次 host 登入的风控代价）照付。

## 2. 目标

用户以 manual 模式运行 stage 2/3 时，**彻底不登 host**；auto 模式保持今天的 host-authoritative 行为不动。

## 3. 行为规则

判定 `manualMode = String(process.env.ACCEPT_MODE || '').toLowerCase() === 'manual'`。

### 3.1 Reconcile 前奏 gate

`shouldRunReconcile(stageSelection, { manualMode })` 返回 `true` 当且仅当：

- `stageSelection.runInlineReconcile`（用户显式 `--stages reconcile,…`），或
- 不满足以下任一跳过条件：
  - **原条件**：`stages === ['3']`
  - **新条件**：`manualMode === true` 且 `stages ⊆ {'2', '3'}`

结论矩阵：

| stages | ACCEPT_MODE | runInlineReconcile | shouldRunReconcile |
|---|---|---|---|
| `['1','2','3']` | auto | false | true |
| `['1','2','3']` | manual | false | true（stage 1 需要容量信息）|
| `['1','2']` | manual | false | true |
| `['2','3']` | auto | false | true |
| `['2','3']` | manual | false | **false** |
| `['2']` | auto | false | true |
| `['2']` | manual | false | **false** |
| `['3']` | auto | false | false（原 stage3Only）|
| `['3']` | manual | false | false |
| 任意 | 任意 | true | true（逃生门）|

### 3.2 Stage 2 内部 host-monitor

`processOneHost` 入口，manual 模式早返：直接走已有的 `runHostWithoutMonitor` 路径，跳过 `launchHostMonitorChrome` / `HostMonitor` / 首次 `initialFamilyMap` scrape。

- `decide()` 的 `manual_no_monitor` 分支已存在（`flowResult` 直接裁决），无需改动判定逻辑
- `runHostWithoutMonitor` 今天同时承担"auto 模式 host-monitor 启动失败的降级"和"manual 模式主路径"两个角色，降级语义不变

## 4. 代码改动

### 4.1 `src/orchestrator.js`

**新增** 纯函数 `shouldRunReconcile(stageSelection, env)`（导出给测试）：

```js
function shouldRunReconcile(stageSelection, env) {
    if (stageSelection.runInlineReconcile) return true;
    const stages = stageSelection.stages;
    const stage3Only = stages.length === 1 && stages[0] === '3';
    const manualMode = String(env.ACCEPT_MODE || '').toLowerCase() === 'manual';
    const manualStage23Subset = manualMode && stages.length > 0
        && stages.every(s => s === '2' || s === '3');
    return !(stage3Only || manualStage23Subset);
}
```

**替换** `main()` 里 158-168 行的 inline 判断为调用该函数。日志文案分歧：

- `stage3Only` → 保留原文案 `stage 3 only, skipping reconcile prelude`
- manual subset → 新文案 `manual mode, stages ⊆ {2,3}, skipping reconcile prelude`

### 4.2 `src/stages/accept/index.js`

`processOneHost`（173 行）第一行（在 `wlog.info(...)` 之后）加：

```js
if (isManualMode()) {
    wlog.info(`Stage2 manual mode: skipping host-monitor, going straight to member workers`);
    return runHostWithoutMonitor({ host, members, concurrency, runId, chromePath });
}
```

原 host-monitor 启动逻辑（`launchHostMonitorChrome` 开始的 try/catch）保持不变，auto 模式继续走。

### 4.3 `src/orchestrator/orchestrator-flags.test.js`

新增 `shouldRunReconcile` 的矩阵测试：

- `['3']` + auto → false
- `['3']` + manual → false
- `['2']` + auto → true
- `['2']` + manual → false
- `['2','3']` + manual → false
- `['1','2','3']` + manual → true
- `['1','2']` + manual → true
- 任意 + runInlineReconcile=true → true
- `['1']` + manual → true
- 空 stages + 任意 → 由既有 parseStageSelection 默认成 `['1','2','3']`，不在本函数测试范围

### 4.4 Stage 2 manual 路径的集成测试

不新增针对 `processOneHost` 的测试 —— 该函数的 manual/auto 分支只是入口路由，目标函数 `runHostWithoutMonitor` 本身已在 `member-worker` / `decide` 的既有测试覆盖中。新增测试 ROI 低。

## 5. 不改动的地方（YAGNI）

- UI：不加"跳过母号"勾选框，完全靠 `.env` 的 `ACCEPT_MODE=manual` 切换。per-run 切换暂无需求。
- `HostMonitor` / `launchHostMonitorChrome`：不删，auto 模式继续用。
- `runHostWithoutMonitor`：签名不动，manual 主路径 + auto 降级共用。
- 数据库 schema / members 状态机：不动。
- `.env.example`：可选加一行 `# ACCEPT_MODE=manual   # skip host login in stage 2 / reconcile prelude`，但不强制。

## 6. 验收

1. `ACCEPT_MODE=manual` + UI 只勾 stage 2 → orchestrator 日志出现 `manual mode, stages ⊆ {2,3}, skipping reconcile prelude`，后续每个 host 进入 stage 2 时日志出现 `Stage2 manual mode: skipping host-monitor`，**全程不出现** `googleLogin` 针对 host 账号的记录、**不启动** `chrome_data_temp_pipeline_H*` profile。
2. `ACCEPT_MODE` 不设（或 `auto`） + UI 只勾 stage 2 → 行为和今天完全一致（reconcile 跑、host-monitor 起）。
3. `ACCEPT_MODE=manual` + UI 勾 stage 1+2 → reconcile 照跑（stage 1 需要容量信息），stage 2 内部 host-monitor 仍 skip。
4. `node --test src/orchestrator/orchestrator-flags.test.js` 全绿。

## 7. 回退

单一 commit，`git revert` 即可恢复。`runHostWithoutMonitor` 的 auto 降级语义不变，revert 不会留下行为残留。
