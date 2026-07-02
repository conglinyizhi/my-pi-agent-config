# subagent

## 功能概述

将任务委派给具备隔离上下文的专门 agents。每次调用 subagent 时启动一个独立的 `pi` 进程，获得隔离的上下文窗口。使用 JSON 模式捕获 subagent 的结构化输出。

## 提供的工具

### `subagent` 工具

支持三种执行模式：

- **Single** — `{ agent: "name", task: "..." }` 单任务模式
- **Parallel** — `{ tasks: [{ agent, task, cwd? }] }` 并行执行，最多 8 个任务，并发度 4
- **Chain** — `{ chain: [{ agent, task, cwd? }] }` 串行执行，用 `{previous}` 占位符传递上一步输出

参数：
- `agentScope`: `"user"` | `"project"` | `"both"`，默认 `"user"`
- `confirmProjectAgents`: 运行项目本地 agents 前是否确认，默认 `true`
- `cwd`: agent 进程的工作目录（单任务模式）

## 架构

### 文件结构

```
subagent/
├── index.ts    # 主入口：工具注册、执行、渲染
├── agents.ts   # Agent 配置发现与加载
└── README.md   # 本文件
```

### 执行流程

1. `discoverAgents()` 从 `~/.pi/agent/agents/` 和 `<project>/.pi/agents/` 发现 agent 配置
2. 根据模式（single/parallel/chain）分发执行
3. 通过 `spawn("pi", ["--mode", "json", "-p", "--no-session", ...])` 启动子进程
4. 解析子进程的 JSON 行输出（`message_end`、`tool_result_end` 事件）
5. 收集用量统计（token 数、轮次、费用）

### 关键设计

- **隔离性**：每个 subagent 是独立进程，上下文不污染主会话
- **进度推送**：通过 `onUpdate` 回调实时推送子进程输出到 TUI
- **中止支持**：通过 AbortSignal 级联中止子进程（SIGTERM → 5s → SIGKILL）
- **安全确认**：运行项目本地 agents 前弹窗确认（防供应链攻击）
- **输出截断**：并行模式下单任务输出上限 50KB
- **临时文件**：agent 的 systemPrompt 写入临时文件，通过 `--append-system-prompt` 注入

### 依赖

- `./agents.ts` — Agent 配置发现
- `../../lib/concurrency` — 并发限制工具
- `../../lib/format-utils` — Token 格式化
- `../../lib/message-utils` — 消息输出提取
