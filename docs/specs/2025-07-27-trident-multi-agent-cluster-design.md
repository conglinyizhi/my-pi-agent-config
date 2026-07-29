# 三叉戟 · pi 多 Agent 集群设计（修订版）

> 代号"三叉戟"——OC Agent 为唯一入口，三条能力分叉（闲聊/翻译/讨论），一键 task_new 贯通翻译→记录→执行全链路。

## 一、架构总览

```
                         你
                         │
                    ┌────▼────┐
                    │ OC Agent │  ← 唯一对话入口（林汐）
                    └────┬────┘
                         │ 判断：闲聊 / 任务？
              ┌──────────┼──────────┐
              ▼          ▼          ▼
           闲聊       task_new    技术讨论
         (就是聊天)   (一键贯通)  (技术搭档)
                         │
              ┌──────────▼──────────┐
              │   task_new 内部链路   │
              │                     │
              │ 1. translate(翻译)   │  ← translator 模型
              │ 2. GUI 确认 ←── 你   │  ← 同意 / 修改 / 提意见
              │ 3. task_create      │  ← 写入事项队列
              │ 4. subagent 执行     │  ← worker 模型
              │ 5. task_update      │  ← 自动回写状态
              └─────────────────────┘
```

核心原则：LLM 只看到一个入口——`task_new`。内部翻译→创建→执行→回写全自动，LLM 不需要手动编排工作流。

## 二、LLM 心智模型

**唯一入口：**

```
用户说"帮我做X" → OC 调 task_new(用户原话) → 等着看结果
用户问"我手上有什么事" → OC 调 task_list → 回答
```

**管理工具（辅助）：**

| 工具 | 用途 |
|------|------|
| `task_new` | **唯一入口**：翻译 + 创建 + 执行，一气呵成 |
| `task_list` | 查看当前事项 |
| `task_update` | 手动改状态/追加备注 |
| `task_delete` | 归档或删除 |

LLM 不需要知道 translate_task、subagent 的存在。那些是 `task_new` 内部实现细节。

## 三、组件设计

### 3.1 OC Agent（林汐）

已实现。角色设定见 `SYSTEM.md`，舰队指挥隐喻 + 技术搭档人格。
扩展 `trident-routing` 提供：
- 会话开场白（随机选择风格）
- 母港模式（`/homeport`，开发调试用，保留 write/edit）
- 非母港模式：禁止 write/edit，强制通过 task_new 调度

### 3.2 task_new（核心工具）

**注册在 trident-queue 扩展中。**

内部流程：

```
task_new(utterance)
  │
  ├─ 1. 调翻译（translator 模型，独立 pi 进程，无工具）
  │     输入：用户原话
  │     输出：title + goal + constraints + context
  │
  ├─ 2. 弹 GUI 确认（Electron 弹窗）
  │     展示翻译结果：title / goal / constraints / context
  │
  │     用户三选一：
  │     ✅ 同意  → 用翻译结果直接继续
  │     ✏️ 修改  → 在 GUI 中直接编辑 prompt，改完继续
  │     💬 提意见 → 输入反馈文字，退回给 OC 重新翻译
  │
  │     退回重译时，OC 收到反馈意见，
  │     可重新调 task_new 或手动修改后继续
  │
  ├─ 3. task_create（生成 kebab-case id，写入 active/）
  │     状态：pending → executing
  │
  ├─ 4. 起 subagent（worker 模型，隔离 pi 进程）
  │     prompt = 确认后的 title + goal + constraints + context
  │     cwd = 当前项目目录
  │     timeout = 600s
  │
  └─ 5. 根据 subagent 结果自动 task_update
        成功 → done（附结果摘要）
        失败 → blocked（附错误信息）
```

**GUI 实现：** 复用 `/trident-setup` 的 Electron + 临时文件通信模式。
翻译结果写入 `/tmp/trident-review-*.json`，Electron 窗口展示并等待用户操作，
结果写回 response 文件，task_new 根据返回值决定下一步。

**LLM 看到的签名：**

```
task_new(utterance: string) → 翻译结果 + 用户确认状态 + 执行结果
```

### 3.3 翻译（内部函数）

不暴露为独立工具。从 `trident-translator` 提取核心逻辑，作为 `task_new` 的内部步骤。

保留 `providers.roles.toml` 中的 `translator` 角色配置，与 OC 不同模型形成第二视角。

翻译 prompt 包含隐私剥离规则：私人角色名、个人经历等用中性措辞替换后再写入 task context。

### 3.4 subagent（内部函数）

不暴露为独立工具。从 `extensions/subagent/` 提取核心逻辑，作为 `task_new` 的内部步骤。

保留 `providers.roles.toml` 中的 `worker` 角色配置（便宜模型）。

起隔离 pi 进程，`PI_SUBAGENT=1` 环境变量防止递归注册。

**MCP 接入：** 启动参数显式传 `--mcp-config ~/.pi/agent/mcp.json`，
确保 subagent 进程有 MCP 工具可用（pi-mcp-adapter 通过 `mcp()` 工具代理）。
不依赖自动发现，行为确定。

### 3.5 事项队列

**存储不变：** `~/.pi/agent/queue/{active,done,blocked}/`

**状态机精简：**

```
pending → executing → done
                ↘ blocked
```

去掉 planning、reviewing——没有编排层，不需要这些中间态。

**TaskItem 结构不变：**

```json
{
  "id": "kebab-case",
  "title": "...",
  "source": "chat",
  "status": "pending|executing|done|blocked",
  "created_at": "ISO-8601",
  "subtasks": [],
  "context": "..."
}
```

### 3.6 模型路由

`providers.roles.toml`：

```toml
[roles]
oc = "deepseek/deepseek-v4-pro"
translator = "deepseek/deepseek-v4-flash"
worker = "deepseek/deepseek-v4-flash"
```

去掉 planner、reviewer——不需要。

### 3.7 状态指示器

trident-queue widget：在 TUI 底部显示活跃事项数量 + 简要状态。

### 3.8 /task-manager（任务管理 GUI）

命令 `/task-manager`，启动 Electron GUI，提供：

- **任务列表**：所有活跃/阻塞任务，带状态图标
- **查看详情**：点击单个任务，展示完整 context、执行日志、时间线
- **紧急终止**：对 executing 状态的任务发送 SIGTERM → SIGKILL，状态标记为 blocked

实现：复用 `/trident-setup` 的 Electron + 临时文件通信模式。

### 3.9 权限放行 GUI 关联 task

当 subagent 内部触发了 permission-gate 审批弹窗时，弹窗应显示是哪个 task 发起的。

实现：
- task_new 启动 subagent 时设置环境变量 `PI_TASK_ID=xxx`
- permission-gate 读取 `PI_TASK_ID`，有值时在 GUI 标题/内容中展示
- task_new 终止 subagent（超时或 /task-manager 强制关停）时清理进程

## 四、仓库策略

| 内容 | 位置 | 开源 |
|------|------|------|
| OC 角色卡 | `SYSTEM.md` | ✅ |
| trident-routing（权限 + 母港 + 开场白 + MCP 拦截） | `extensions/trident-routing/` | ✅ |
| trident-queue（task_* 工具 + 事项队列 + GUI） | `extensions/trident-queue/` | ✅ |
| lib/translate.ts（翻译核心） | `lib/translate.ts` | ✅ |
| lib/subagent-run.ts（subagent 执行核心） | `lib/subagent-run.ts` | ✅ |
| 模型路由表 | `providers.roles.toml` | ❌ gitignore |
| 事项队列 | `~/.pi/agent/queue/` | ❌ gitignore |

## 五、当前状态

### ✅ 已完成

- OC Agent（林汐人格 + SYSTEM.md）
- trident-routing（开场白、母港模式、工具限制、MCP 拦截）
- trident-queue（task_create/list/update/delete + widget + /trident-setup + /task-manager）
- lib/translate.ts（翻译核心，供 task_create 内部调用）
- lib/subagent-run.ts（subagent 执行核心，含 MCP + PI_TASK_ID + onSpawn）
- gui-review（任务确认弹窗，支持多任务审核）
- gui-manager（任务管理面板，多选批量启停 + 单任务详情）
- providers.roles.toml（oc/translator/worker，无 planner/reviewer）
- 事项队列文件存储
- 状态机：pending→executing→done/blocked
- permission-gate 审批弹窗显示 PI_TASK_ID
- OC 禁止 MCP 工具（be-* + mcp），仅 worker 可用
- task_create 始终异步发射，支持字符串数组并行
- trident-translator 扩展已删除（逻辑在 lib/translate.ts）

### ⚠️ 待清理

- `extensions/subagent/` 独立工具注册仍在，可移除（逻辑已在 lib/subagent-run.ts）

### 📋 未来可做

- 模型降级策略（worker 失败自动换聪明模型）
- OC Agent 定期总结
- 隐私剥离的独立实现（当前只在翻译 prompt 里口头要求）

## 六、不做的

- 不做编排层（planner/reviewer/chain/parallel）
- 不做模块化提示词系统
- 不做双模型视角可选（翻译结果直接给 OC 判断，不让你来回选）
- 不做多用户支持
- 不做 Web UI
