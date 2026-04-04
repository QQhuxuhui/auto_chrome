# Gemini Ultra 家庭组自动化全流程设计

**日期：** 2026-04-03  
**状态：** 已确认  
**范围：** 多主账号批量邀请成员、接受邀请、添加 sub2api、处理二次验证的全流程自动化

---

## 1. 业务背景

用户购买了多个 Google Gemini Ultra 会员，每个会员账号（主账号）可邀请最多 5 个家庭组成员共享会员权益。

完整业务流程：
1. 主账号登录 Gemini Ultra 家庭组管理页，发送邮件邀请给 5 个成员
2. 成员账号登录 Gmail，点击邀请邮件中的链接接受邀请
3. 在 sub2api 平台用成员账号的 refresh_token 创建 antigravity 类型账号
4. 在 sub2api 平台测试账号，若需要二次验证则访问验证 URL 完成验证

所有主账号与成员账号按顺序一一对应分组（主账号1对应成员1-5，主账号2对应成员6-10，依此类推）。

---

## 2. 整体架构

### 方案选型

采用**多阶段分脚本**方案：4个独立脚本，通过共享 `state.json` 跟踪进度。

优势：
- 每阶段可单独重跑，失败不需要从头开始
- 邀请发送与邮件接收之间有时间间隔，分阶段天然合理
- 各脚本职责单一，便于维护和调试

### 文件结构

```
auto_chrome/
├── hosts.txt              # 主账号文件 (email:password)
├── members.txt            # 被邀请成员账号文件 (email:password)
├── state.json             # 进度状态文件（自动生成）
├── failed.json            # 失败记录文件（自动生成）
├── accounts.txt           # 原有文件，保持不动
├── run.bat                # 原有启动脚本，保持不动
├── run_pipeline.bat       # 新的全流程启动脚本
└── src/
    ├── auth.js            # 原有文件，保持不动
    ├── package.json       # 新增依赖
    ├── .env               # 新增 sub2api 配置项
    ├── common/
    │   ├── chrome.js      # 从 auth.js 抽取：Chrome 启动/连接/重启逻辑
    │   ├── logger.js      # 从 auth.js 抽取：日志系统
    │   └── state.js       # 状态文件读写（mutex 保护）
    ├── 1_invite.js        # 阶段1：主账号发送家庭邀请
    ├── 2_accept.js        # 阶段2：成员账号接受邀请
    ├── 3_add_sub2api.js   # 阶段3：在 sub2api 平台添加成员账号
    └── 4_verify.js        # 阶段4：处理 sub2api 二次验证
```

---

## 3. 状态文件结构

`state.json` 记录每组的完整进度：

```json
[
  {
    "groupId": 1,
    "host": "host1@gmail.com",
    "members": ["m1@gmail.com", "m2@gmail.com", "m3@gmail.com", "m4@gmail.com", "m5@gmail.com"],
    "stage1_invited": true,
    "stage2_accepted": [true, true, false, false, false],
    "stage3_added": [true, true, false, false, false],
    "stage4_verified": [true, false, false, false, false],
    "refreshTokens": {
      "m1@gmail.com": "1//xxx...",
      "m2@gmail.com": "1//yyy..."
    }
  }
]
```

字段说明：
- `stage1_invited`：布尔值，该组的5封邀请是否全部发出
- `stage2_accepted`：数组，每个成员是否已接受邀请
- `stage3_added`：数组，每个成员是否已添加到 sub2api
- `stage4_verified`：数组，每个成员是否已完成二次验证
- `refreshTokens`：从原有 auth.js 流程获取的 refresh_token，供阶段3使用

---

## 4. 各阶段详细设计

### 阶段1 — `1_invite.js`：发送家庭邀请

**输入：** `hosts.txt`、`members.txt`  
**输出：** `state.json`（更新 `stage1_invited`）

流程：
1. 读取两个文件，按5个一组分组，初始化 `state.json`
2. 跳过已标记 `stage1_invited: true` 的组
3. 每个主账号：启动 Chrome → 登录 Google → 访问 Gemini Ultra 家庭组管理页 → 逐一输入5个成员邮箱发送邀请
4. 成功后更新该组 `stage1_invited: true`

并发数：默认1（避免主账号触发风控），可通过 `--concurrency` 调整

---

### 阶段2 — `2_accept.js`：成员接受邀请

**输入：** `state.json`（读取 `stage1_invited: true` 的组）  
**输出：** `state.json`（更新 `stage2_accepted`）

流程：
1. 找出所有 `stage1_invited: true` 且 `stage2_accepted` 未全部完成的成员
2. 每个成员：启动 Chrome → 登录 Google → 访问 Gmail → 搜索邀请邮件（关键词：`Google One` 或 `家庭组`）→ 点击邮件中的接受链接
3. 若邮件未到达：每30秒轮询一次，最多等待10分钟
4. 成功后更新该成员 `stage2_accepted[i]: true`

并发数：默认3

**超时处理：**
- 超过10分钟仍无邮件 → 标记为 `stage2_timeout`，记录到 `failed.json`，跳过继续

---

### 阶段3 — `3_add_sub2api.js`：添加到 sub2api

**输入：** `state.json`（读取 `stage2_accepted: true` 的成员）  
**输出：** `state.json`（更新 `stage3_added`）

流程：
1. 登录 sub2api 平台（`SUB2API_URL`，用户名+密码来自 `.env`）
2. 对每个待添加成员：
   - 若 `refreshTokens` 中有该成员的 token → 直接用 refresh_token 创建 antigravity 类型账号
   - 若无 token → 先走 Google Auth 流程获取 token，再创建账号
3. 成功后更新 `stage3_added[i]: true` 并保存 refresh_token

并发数：默认1（sub2api 平台操作串行，避免会话冲突）

---

### 阶段4 — `4_verify.js`：处理二次验证

**输入：** `state.json`（读取 `stage3_added: true` 的成员）  
**输出：** `state.json`（更新 `stage4_verified`）

流程：
1. 登录 sub2api 平台 → 找到目标成员账号 → 点击"测试"按钮
2. 根据弹窗结果分三种情况处理：
   - **直接通过** → `stage4_verified[i]: true`
   - **弹出验证URL** → 提取 URL → 用 Chrome 新标签访问 → 完成验证流程 → 回到平台再次点击测试确认 → `stage4_verified[i]: true`
   - **其他失败** → 记录到 `failed.json`，`stage4_verified[i]: false`

并发数：默认1

---

## 5. 输入文件格式

### hosts.txt（主账号）
```
# 格式：email:password，每行一个
host1@gmail.com:Password123
host2@gmail.com:Password456
```

### members.txt（成员账号）
```
# 顺序即分组顺序：第1-5行对应host1，第6-10行对应host2
member1@gmail.com:Pass001
member2@gmail.com:Pass002
member3@gmail.com:Pass003
member4@gmail.com:Pass004
member5@gmail.com:Pass005
member6@gmail.com:Pass006
```

---

## 6. 配置

### .env 新增项
```
# sub2api 平台
SUB2API_URL=http://104.194.91.23:3001
SUB2API_USER=your_username
SUB2API_PASS=your_password

# 阶段2邮件等待配置
INVITE_WAIT_TIMEOUT=600
INVITE_POLL_INTERVAL=30
```

### run_pipeline.bat 用法
```bat
# 全流程
run_pipeline.bat

# 只跑某一阶段
run_pipeline.bat --stage 2
run_pipeline.bat --stage 3,4

# 只处理某一组
run_pipeline.bat --group 2

# 重跑失败记录
run_pipeline.bat --retry-failed
```

---

## 7. 错误处理策略

| 错误类型 | 处理方式 |
|----------|----------|
| 单个账号失败 | 记录错误，继续处理下一个 |
| Chrome 崩溃 | 自动重启（复用现有逻辑） |
| 网络超时 | 单账号最多重试2次 |
| 密码错误/账号被封 | 直接跳过，记录到 failed.json |
| 邮件超时未到达 | 标记 stage2_timeout，跳过 |
| sub2api 二次验证失败 | 记录到 failed.json |

### failed.json 格式
```json
[
  {
    "stage": 2,
    "groupId": 1,
    "memberEmail": "m3@gmail.com",
    "reason": "invite_email_timeout",
    "time": "2026-04-03T10:00:00Z"
  },
  {
    "stage": 4,
    "groupId": 2,
    "memberEmail": "m8@gmail.com",
    "reason": "verify_failed: unknown error",
    "time": "2026-04-03T10:05:00Z"
  }
]
```

---

## 8. 技术依赖

- **现有：** `puppeteer-core`、`dotenv`
- **新增：** 无（sub2api 平台操作通过浏览器自动化完成，不需要额外 HTTP 库）
- **Node.js：** >= 16.0.0
- **Chrome：** 系统已安装的真实 Chrome
