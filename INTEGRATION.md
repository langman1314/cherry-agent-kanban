# Agent 监控看板 — Cherry Studio 集成指南

## 📋 文件清单

| 文件 | 用途 |
|------|------|
| `server.js` | 看板后端服务 (端口 3457) |
| `public/index.html` | 看板前端界面 |
| `report.js` | **Node.js CLI 状态上报工具** ← 主力工具 |
| `dashboard-hook.sh` | Bash 封装脚本（备用） |

## 🚀 启动看板

```bash
cd /d/Desktop/cherryAi_texty/控制面板制作/agent-dashboard
node server.js
```

打开浏览器访问: http://localhost:3457

## 🔌 在你的 Agent 代码中集成

### 方式一：直接用 Bash 调用 report.js（推荐）

在你的 agent 的**提示词/系统指令**中，约定在关键节点通过 **Bash 工具** 调用 report.js：

```javascript
// === Agent 启动时 ===
node /d/Desktop/cherryAi_texty/控制面板制作/agent-dashboard/report.js start \
  --name "代码搜索" --type "sub" --stage "搜索中..." --parentId "主agent-id"

// === 进度更新时 ===
node /d/Desktop/cherryAi_texty/控制面板制作/agent-dashboard/report.js update \
  --id "<上一步返回的 agent-id>" --stage "解析结果" --progress 60

// === 完成时 ===
node /d/Desktop/cherryAi_texty/控制面板制作/agent-dashboard/report.js end \
  --id "<agent-id>" --status "completed"

// === 失败时 ===
node /d/Desktop/cherryAi_texty/控制面板制作/agent-dashboard/report.js end \
  --id "<agent-id>" --status "failed" --error "连接超时"
```

### 方式二：使用 Bash 脚本（source 导入函数）

```bash
source /d/Desktop/cherryAi_texty/控制面板制作/agent-dashboard/dashboard-hook.sh

# 启动 agent（会自动设置 $AGENT_ID 环境变量）
dash_start "文件分析" "sub" "加载中..."

# 更新状态
dash_update "$AGENT_ID" "解析中..." 50

# 结束
dash_end "$AGENT_ID" "completed"
```

### 方式三：在你的 SOUL.md 中声明看板上报作为默认行为

在 agent 的 `SOUL.md` 中添加：

```markdown
## 状态上报 (Dashboard)

开始任何子任务时，通过 Bash 调用看板 API 上报状态：
- 启动: node /d/.../report.js start --name "<任务名>" --type "<main|sub>" --stage "<阶段>"
- 更新: node /d/.../report.js update --id "<id>" --stage "<阶段>" --progress <0-100>
- 结束: node /d/.../report.js end --id "<id>" --status "<completed|failed>"
```

## ⚙️ 看板运行模式

### 模式 A：常驻运行（推荐）
```bash
# 开机启动，或放在后台一直运行
node server.js &
```

### 模式 B：按需启动
```bash
# 在启动主 agent 前启动看板，任务结束后关闭
node server.js
# ... 执行任务 ...
# Ctrl+C 关闭
```

## 🔄 数据流完整链路

```
Agent (你的任务代码)
  │
  ├─ Bash: report.js start          ──→  POST /api/agent/start
  ├─ Bash: report.js update         ──→  POST /api/agent/update
  ├─ Bash: report.js end            ──→  POST /api/agent/end
  │
  ▼
server.js (看板后端)
  │
  ├─ 更新内存中的 agent 状态
  └─ SSE 广播 → 前端自动刷新
```

## ✅ 验证集成是否成功

```bash
# 1. 启动看板
node /d/Desktop/cherryAi_texty/控制面板制作/agent-dashboard/server.js

# 2. 打开浏览器 http://localhost:3457

# 3. 手动测试上报
node /d/Desktop/cherryAi_texty/控制面板制作/agent-dashboard/report.js start --name "测试" --type "main" --stage "验证"

# 4. 浏览器看板上应该立刻出现一个 agent 卡片！
```