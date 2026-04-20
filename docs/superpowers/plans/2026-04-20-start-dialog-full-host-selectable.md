# 启动流程弹窗 —— 已满母号可选（阶段 2/3）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 启动流程弹窗里，当未勾选阶段 1（发邀请）时，允许用户选中已满的母号，以便跑阶段 2/3。

**Architecture:** 纯前端（Alpine.js 绑定表达式与方法改动），改动全部集中在 `public/index.html`。四处视觉条件前置 `form.stages1 &&`；新增 `onToggleStage1()` 方法处理"回勾阶段 1 时清理已满 host 选中"的 confirm 流程；`selectAllHosts()` 按阶段 1 状态分支。

**Tech Stack:** Alpine.js 3.x（CDN），无构建步骤，无前端测试框架，验证=浏览器手工测试。

**Spec:** `docs/superpowers/specs/2026-04-20-start-dialog-full-host-selectable-design.md`

---

## 文件结构

本次改动只修改一个文件：

- **Modify:** `public/index.html`
  - L95：阶段 1 checkbox 加 `@change`
  - L114：`<label>` 的 `:class` 条件
  - L115：`<input>` 的 `:disabled` 条件
  - L118：红字「已满」的 `x-show`
  - L119：琥珀「已满（reconcile 可能回收空位）」的 `x-show`
  - L197-203：`selectAllHosts()` 方法体
  - 在 `selectAllHosts()` 下方新增 `onToggleStage1(e)` 方法

测试：浏览器手工（无自动化测试基础设施）。

---

## Task 1: HTML 视觉条件前置 `form.stages1 &&`

把四处视觉条件从「`slot_free === 0` + `removeUnknown` 组合」改成「仅在阶段 1 被勾选时才适用」。

**Files:**
- Modify: `public/index.html:114-119`

- [ ] **Step 1: 用 Read 确认当前 L113-121 的原文**

Run:
```
Read /usr/src/workspace/github/QQhuxuhui/auto_chrome/public/index.html (offset=113, limit=10)
```

Expected: 看到如下完整 template 块：
```html
                        <template x-for="h in hostsList" :key="h.id">
                            <label class="block hover:bg-slate-800/50 rounded px-1 py-0.5" :class="(!form.removeUnknown && h.slot_free === 0) ? 'opacity-50' : ''">
                                <input type="checkbox" :value="h.email" x-model="form.selectedHosts" :disabled="!form.removeUnknown && h.slot_free === 0">
                                <span x-text="h.email" class="mono"></span>
                                <span class="text-xs text-slate-400 ml-1" x-text="`(空位 ${h.slot_free}/5)`"></span>
                                <span x-show="h.slot_free === 0 && !form.removeUnknown" class="text-xs text-red-400 ml-1">已满</span>
                                <span x-show="h.slot_free === 0 && form.removeUnknown" class="text-xs text-amber-400 ml-1">已满（reconcile 可能回收空位）</span>
                            </label>
                        </template>
```

- [ ] **Step 2: 改 `<label>` 的 `:class` 表达式（L114）**

Edit:
- old_string:
  ```
  <label class="block hover:bg-slate-800/50 rounded px-1 py-0.5" :class="(!form.removeUnknown && h.slot_free === 0) ? 'opacity-50' : ''">
  ```
- new_string:
  ```
  <label class="block hover:bg-slate-800/50 rounded px-1 py-0.5" :class="(form.stages1 && !form.removeUnknown && h.slot_free === 0) ? 'opacity-50' : ''">
  ```

- [ ] **Step 3: 改 `<input>` 的 `:disabled` 表达式（L115）**

Edit:
- old_string:
  ```
  <input type="checkbox" :value="h.email" x-model="form.selectedHosts" :disabled="!form.removeUnknown && h.slot_free === 0">
  ```
- new_string:
  ```
  <input type="checkbox" :value="h.email" x-model="form.selectedHosts" :disabled="form.stages1 && !form.removeUnknown && h.slot_free === 0">
  ```

- [ ] **Step 4: 改红字「已满」的 `x-show`（L118）**

Edit:
- old_string:
  ```
  <span x-show="h.slot_free === 0 && !form.removeUnknown" class="text-xs text-red-400 ml-1">已满</span>
  ```
- new_string:
  ```
  <span x-show="form.stages1 && h.slot_free === 0 && !form.removeUnknown" class="text-xs text-red-400 ml-1">已满</span>
  ```

- [ ] **Step 5: 改琥珀「已满（reconcile 可能回收空位）」的 `x-show`（L119）**

Edit:
- old_string:
  ```
  <span x-show="h.slot_free === 0 && form.removeUnknown" class="text-xs text-amber-400 ml-1">已满（reconcile 可能回收空位）</span>
  ```
- new_string:
  ```
  <span x-show="form.stages1 && h.slot_free === 0 && form.removeUnknown" class="text-xs text-amber-400 ml-1">已满（reconcile 可能回收空位）</span>
  ```

- [ ] **Step 6: Grep 验证四处条件已全部前置**

Run:
```
Grep pattern="slot_free === 0" path="public/index.html" output_mode="content" -n=true
```

Expected: 四处匹配，全部以 `form.stages1 &&` 开头（或 `form.stages1 && !form.removeUnknown` 开头），无一处仅 `slot_free === 0` 裸判。

---

## Task 2: 改写 `selectAllHosts()` 按阶段 1 分支

**Files:**
- Modify: `public/index.html:197-203`

- [ ] **Step 1: Read 当前 selectAllHosts 原文**

Run:
```
Read /usr/src/workspace/github/QQhuxuhui/auto_chrome/public/index.html (offset=197, limit=7)
```

Expected 看到（方法定义首行 8 空格缩进，方法体 12 空格缩进）：
```
        selectAllHosts() {
            // 勾了「删除未知家庭成员」时，满员 host 也可选（reconcile 后可能回收空位）
            const pool = this.form.removeUnknown
                ? this.hostsList
                : this.hostsList.filter(h => h.slot_free > 0);
            this.form.selectedHosts = pool.map(h => h.email);
        },
```

- [ ] **Step 2: 替换方法体**

Edit 的 `old_string` 使用文件的真实缩进（首行 8 空格 `selectAllHosts() {`，方法体 12 空格）：

- old_string（逐行：8 sp / 12 sp / 12 sp / 16 sp / 16 sp / 12 sp / 8 sp）：
```
        selectAllHosts() {
            // 勾了「删除未知家庭成员」时，满员 host 也可选（reconcile 后可能回收空位）
            const pool = this.form.removeUnknown
                ? this.hostsList
                : this.hostsList.filter(h => h.slot_free > 0);
            this.form.selectedHosts = pool.map(h => h.email);
        },
```
- new_string：
```
        selectAllHosts() {
            // 已满约束只在阶段 1 被勾选时生效；勾了「删除未知家庭成员」时，即便阶段 1 勾上也允许满员 host 入选。
            const pool = (this.form.stages1 && !this.form.removeUnknown)
                ? this.hostsList.filter(h => h.slot_free > 0)
                : this.hostsList;
            this.form.selectedHosts = pool.map(h => h.email);
        },
```

---

## Task 3: 新增 `onToggleStage1()` 并接到阶段 1 checkbox

在阶段 1 checkbox 上挂 `@change`；当用户"从未勾变为勾选"、且 `removeUnknown` 未勾、且 `selectedHosts` 里存在已满 host 时，弹 `confirm`：
- 确认 → 从 `selectedHosts` 剔除这些已满 host，阶段 1 保持勾选
- 取消 → `form.stages1 = false`

**Files:**
- Modify: `public/index.html:95` (加 `@change`)
- Modify: `public/index.html:197-203` 方法块下方（加新方法）

- [ ] **Step 1: 给阶段 1 checkbox 加 `@change` 绑定**

Edit:
- old_string:
  ```
                  <label class="mr-3"><input type="checkbox" x-model="form.stages1"> 1 发邀请</label>
  ```
- new_string:
  ```
                  <label class="mr-3"><input type="checkbox" x-model="form.stages1" @change="onToggleStage1($event)"> 1 发邀请</label>
  ```

- [ ] **Step 2: 在 `selectAllHosts()` 之后新增 `onToggleStage1(e)` 方法**

在 Task 2 Step 2 已改的 `selectAllHosts()` 块后追加 `onToggleStage1`。缩进：方法首行 8 空格，方法体 12 空格，嵌套体 16 空格。

- old_string（Task 2 替换后的最终块，保持与文件一致的 8/12 空格缩进）：
```
        selectAllHosts() {
            // 已满约束只在阶段 1 被勾选时生效；勾了「删除未知家庭成员」时，即便阶段 1 勾上也允许满员 host 入选。
            const pool = (this.form.stages1 && !this.form.removeUnknown)
                ? this.hostsList.filter(h => h.slot_free > 0)
                : this.hostsList;
            this.form.selectedHosts = pool.map(h => h.email);
        },
```
- new_string：
```
        selectAllHosts() {
            // 已满约束只在阶段 1 被勾选时生效；勾了「删除未知家庭成员」时，即便阶段 1 勾上也允许满员 host 入选。
            const pool = (this.form.stages1 && !this.form.removeUnknown)
                ? this.hostsList.filter(h => h.slot_free > 0)
                : this.hostsList;
            this.form.selectedHosts = pool.map(h => h.email);
        },
        onToggleStage1(e) {
            // 只在"从未勾变为勾选"时检查；勾了 removeUnknown 时不检查（已满 host 本来就允许选）
            if (!e.target.checked) return;
            if (this.form.removeUnknown) return;
            const conflicts = this.form.selectedHosts.filter(email => {
                const h = this.hostsList.find(x => x.email === email);
                return h && h.slot_free === 0;
            });
            if (conflicts.length === 0) return;
            const ok = confirm(
                `已选中 ${conflicts.length} 个已满母号：\n${conflicts.join('\n')}\n\n` +
                `它们无法接收新邀请。继续勾选阶段 1 将自动取消这些母号的选中。\n\n继续？`
            );
            if (ok) {
                this.form.selectedHosts = this.form.selectedHosts.filter(email => !conflicts.includes(email));
            } else {
                this.form.stages1 = false;
            }
        },
```

注意：Alpine.js 的 `x-model` 与 `@change` 的触发顺序：`x-model` 会先把 DOM 的 `.checked` 同步到 `form.stages1`，然后再触发 `@change` 事件。所以 `e.target.checked === true` 与 `form.stages1 === true` 一致——判断哪个都行，这里用 `e.target.checked` 是为了不依赖该顺序假设。

---

## Task 4: 浏览器手工回归测试

**Files:** 无

- [ ] **Step 1: 确认 DB / server 状态**

确保 server 已跑（先前的 bash 任务 id 应当存在；若无则重启）。打开 http://127.0.0.1:3000/。

- [ ] **Step 2: 按 spec §5 的测试表逐项验证**

| # | 操作 | 期望 | 通过？ |
|---|------|------|---|
| 1 | 只勾阶段 2，"指定母号"模式，点开列表 | `surendarkumar987654322@gmail.com` 不灰，可勾选，右侧无「已满」徽标（仅显示"空位 0/5"） | ☐ |
| 2 | 仅勾阶段 1 | 该 host 灰色禁用，显示红字「已满」 | ☐ |
| 3 | 只勾阶段 2 → 选中该 host → 回勾阶段 1 → 点「确定」 | 阶段 1 保持勾选；该 host 从 `selectedHosts` 中消失 | ☐ |
| 4 | 重复 #3 最后一步改点「取消」 | 阶段 1 checkbox 恢复未勾；该 host 仍在选中里 | ☐ |
| 5 | 勾 `removeUnknown` + 阶段 1 | 该 host 可选，显示琥珀色「已满（reconcile 可能回收空位）」 | ☐ |
| 6 | 未勾阶段 1 时点「全选」 | 列表全选（含已满 host） | ☐ |
| 7 | 勾阶段 1、未勾 `removeUnknown` 时点「全选」 | 只选 `slot_free > 0` 的 host | ☐ |

每项手工验证后打勾。如发现实际行为与期望不符，回到对应任务步骤对照实现。

- [ ] **Step 3: 提交**

```bash
git add public/index.html
git commit -m "$(cat <<'EOF'
feat(start-dialog): allow picking full hosts when stage 1 not selected

slot_free===0 should not block selection for stages 2/3 — those stages
operate on existing members and don't consume new slots. Example: host
surendarkumar987654322 has 5 invite_pending members; user couldn't pick
it to run stage 2 (accept).

- Gate each of the 4 visual constraints behind form.stages1 &&
- selectAllHosts() branches on form.stages1 + removeUnknown
- Re-checking stage 1 with full hosts already selected fires a confirm:
  OK → drop them from selection; Cancel → uncheck stage 1

Manual browser testing per spec §5 all 7 cases pass.

Spec: docs/superpowers/specs/2026-04-20-start-dialog-full-host-selectable-design.md
EOF
)"
```

---

## 自检清单（engineer 交付前必看）

- [ ] `public/index.html` 里再搜 `slot_free === 0`：四处 `x-show`/`:class`/`:disabled` 全部有 `form.stages1 &&` 前缀
- [ ] `selectAllHosts()` 按 `stages1 && !removeUnknown` 分支
- [ ] 阶段 1 checkbox 有 `@change="onToggleStage1($event)"`
- [ ] `onToggleStage1` 方法存在且逻辑正确（checked、removeUnknown、conflicts、confirm、剔除/回退）
- [ ] 表 7 项手工测试全通过
- [ ] Commit 信息链接到 spec 路径
