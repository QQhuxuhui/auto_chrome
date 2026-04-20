# 启动流程弹窗 —— 已满母号可选（阶段 2/3）设计

日期：2026-04-20
影响范围：`public/index.html` 启动流程弹窗（纯前端）

## 1. 问题

启动流程弹窗在「指定母号」模式下，会把 `slot_free === 0` 的母号禁用掉（勾选
框灰色，标记「已满」）。只有同时勾选「删除未知家庭成员」才会放开。

这条规则对阶段 1（发邀请）是合理的 —— 家庭组占位已满，没法再加人。
但它也误伤了阶段 2（接受邀请）和阶段 3（授权）：这两个阶段只操作**已存在**
的成员，不会新增占位。

实例：`surendarkumar987654322@gmail.com`（host id 244）下挂 5 个成员，全部
`invite_pending`。此时 `slot_used = 5`、`slot_free = 0`，弹窗把它锁死。
想跑阶段 2 接受这 5 封邀请时无从选起。

`slot_used` 的口径定义在 `src/db/hosts.js:7`：
`['invite_pending', 'accept_failed', 'oauth_failed', 'joined', 'done']`
—— pending 也算占位，符合 Google 家庭组的实际规则，不改。

## 2. 设计原则

「已满」约束只对阶段 1 有意义。弹窗应当按用户实际勾选的阶段来决定要不要
禁用已满母号。

## 3. 行为规格

### 3.1 母号列表项显示与禁用条件

核心规则：`form.stages1 && !form.removeUnknown && h.slot_free === 0` 时禁用。

四处受影响视觉元素：

| 位置 | 条件 |
|---|---|
| `<input :disabled="...">` | `isHostBlocked(h)` ≡ `form.stages1 && !form.removeUnknown && h.slot_free === 0` |
| 外层 `<label>` 的 `opacity-50` | 同上 |
| 「已满」红字徽标 | `form.stages1 && h.slot_free === 0 && !form.removeUnknown` |
| 「已满（reconcile 可能回收空位）」琥珀色徽标 | `h.slot_free === 0 && form.removeUnknown`（与阶段 1 无关，信息性展示） |

「空位 N/5」灰色数字**永远显示**，仅作信息。红字「已满」只在阶段 1 被勾
且未勾 `removeUnknown` 时提示「此 host 会被阻止」。琥珀徽标在任何勾
`removeUnknown` 的场景下都显示，提醒用户"此 host 现在满员，但 reconcile
阶段可能回收空位"。

`isHostBlocked(h)` 作为独立方法挂在 Alpine 组件上，供 HTML 与 JS 复用
（`selectAllHosts` 用它过滤、onToggleStage1 的语义里隐含同一条件）。

### 3.2 全选按钮

```
if (form.stages1 && !form.removeUnknown) {
    pool = hostsList.filter(h => h.slot_free > 0);  // 现行逻辑
} else {
    pool = hostsList;                                // 全取
}
form.selectedHosts = pool.map(h => h.email);
```

### 3.3 阶段 1 切换的边界情况

用户先只勾阶段 2/3 选中了已满 host，随后回勾阶段 1 时，需要主动处理已经
在 `selectedHosts` 里的"现在不合法"项。做法：

在阶段 1 checkbox 上挂 `@change` 监听，**从未勾变为勾选时**执行：

```
if (!form.removeUnknown) {
    const conflicts = selectedHosts.filter(email => {
        const h = hostsList.find(x => x.email === email);
        return h && h.slot_free === 0;
    });
    if (conflicts.length > 0) {
        const ok = confirm(
            `已选中 ${conflicts.length} 个已满母号：${conflicts.join(', ')}\n` +
            `它们无法接收新邀请。\n` +
            `继续勾选阶段 1 将自动取消这些母号的选中。\n\n继续？`
        );
        if (ok) {
            // 从 selectedHosts 剔除 conflicts
            form.selectedHosts = selectedHosts.filter(e => !conflicts.includes(e));
        } else {
            // 阶段 1 恢复未勾状态
            form.stages1 = false;
        }
    }
}
```

从勾选变为未勾时不做特殊处理。勾了 `removeUnknown` 时也不做特殊处理（现
行逻辑已允许已满 host 被选）。

### 3.4 提交校验

`submitStart()` 不需要新增校验：UI 已保证 `form.stages1 && selectedHosts`
中不含已满 host（除非 `removeUnknown`）。后端无改动。

## 4. 非目标（YAGNI）

- 不改 `slot_used` 的口径定义。
- 不改后端 `/api/pipeline/start`，不改 `/api/hosts`。
- 不给弹窗加「显示已满母号」独立开关 —— 行为现在完全由阶段勾选推导。
- 不处理「阶段 1 已勾，用户取消阶段 1」的情况（此时只是解禁，已选中项
  无需动）。

## 5. 测试点

手工测试（浏览器 → http://127.0.0.1:3000/）：

| # | 操作 | 期望 |
|---|------|------|
| 1 | 只勾阶段 2，打开母号列表 | 已满 host 不灰，可勾选，无「已满」徽标 |
| 2 | 只勾阶段 1 | 已满 host 灰色禁用，显示「已满」红字（回归） |
| 3 | 只勾阶段 2 → 选中已满 host → 回勾阶段 1 → 点「继续」 | 阶段 1 保持勾选，已满 host 从选中里消失 |
| 4 | 同上最后一步点「取消」 | 阶段 1 checkbox 恢复未勾，已满 host 仍在选中里 |
| 5 | 勾 `removeUnknown` + 阶段 1 | 已满 host 可选，显示琥珀色「已满（reconcile 可能回收空位）」（回归） |
| 5b | 仅勾 `removeUnknown`（不勾阶段 1） | 已满 host 可选；琥珀徽标**仍显示**（信息性） |
| 6 | 未勾阶段 1 时点「全选」 | 列表全选（含已满） |
| 7 | 勾阶段 1 未勾 removeUnknown 时点「全选」 | 只选 `slot_free > 0` 的（回归） |

## 6. 实现清单（`public/index.html`）

1. L95 阶段 1 checkbox 增加 `@change="onToggleStage1($event)"`
2. L114-115 `:class` / `:disabled` 条件前置 `form.stages1 &&`
3. L118-119 两个徽标的 `x-show` 条件前置 `form.stages1 &&`
4. L197-203 `selectAllHosts()` 按 `form.stages1` 分支
5. 新增 `onToggleStage1(e)` 方法实现 §3.3 逻辑
