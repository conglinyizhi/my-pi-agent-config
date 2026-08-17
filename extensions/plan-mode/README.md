# plan-mode

## 功能概述

用于安全代码分析的只读探索模式。启用后只能使用只读工具（read、bash 白名单、grep、find、ls、ask_question），禁止文件修改。支持从 LLM 输出中提取编号计划步骤，并在执行期间追踪进度（步骤与 todo_write 共用统一存储）。

## 提供的命令

### `/plan`

切换计划模式。快捷键：`Ctrl+Alt+P`。

## 工作流程

1. **计划阶段**（只读）：用户描述需求 → LLM 输出编号计划（`Plan:` 标题下）
2. **用户确认**：展示计划步骤列表，选择「执行计划」「继续计划」「细化计划」
3. **执行阶段**（完整工具）：LLM 按顺序执行，每步用 `[DONE:n]` 标记完成
4. **自动完成**：所有步骤完成后自动通知，恢复正常模式

## 架构

### 文件结构

```
plan-mode/
├── index.ts    # 主入口：模式切换、事件钩子、进度追踪
├── utils.ts    # 工具函数：计划提取、安全命令检查、步骤标记
└── README.md   # 本文件
```

### 状态管理

- `planModeEnabled` — 是否处于计划模式
- `executionMode` — 是否处于执行模式
- `steps` — 计划步骤列表（`Step[]`：`{content, status}`，与 todo_write 共用统一存储）
- 模式开关通过 `SessionEntry(type: "custom", customType: "plan-mode")` 持久化
- 步骤列表通过统一存储 `lib/todo-store.ts` 持久化为 `dsh-todo` entry（与 todo_write 同一份）

### 关键设计

- **双模式切换**：计划模式（只读）↔ 执行模式（完整工具），通过 `pi.setActiveTools()` 切换
- **bash 白名单**：`isSafeCommand()` 检查命令是否在安全列表中
- **步骤追踪**：正则匹配 `[DONE:n]` 标记完成步骤
- **持久化恢复**：session 恢复时重新扫描消息重建步骤完成状态
- **上下文过滤**：退出计划模式后过滤掉计划相关的上下文消息
- **通知集成**：外部通知（`notify-send`）用于计划状态变更

### 事件钩子

- `tool_call` — 在计划模式中阻止非白名单 bash 命令
- `context` — 退出计划模式后清理计划上下文
- `before_agent_start` — 注入计划/执行模式上下文
- `turn_end` — 追踪步骤完成进度
- `agent_end` — 展示计划列表、询问下一步、检测计划完成
- `session_start` — 恢复持久化状态

### 依赖

- `./utils.ts` — extractTodoItems、isSafeCommand、markCompletedSteps
- `../../lib/todo-store.ts` — 统一步骤存储（Step 类型、readSteps、writeSteps）
- `@earendil-works/pi-tui` — Key 快捷键定义
