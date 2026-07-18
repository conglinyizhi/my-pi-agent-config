# thinking-only-continue

大模型**只吐了思维链、正文去掉空白后一个字都没有**时，自动续跑，并发送**警告级**通知；同时拦截「任务完成」通知。

## 触发条件

最后一条 `assistant` 消息同时满足：

1. `type: text` 拼起来去空白后长度为 0（含完全没有 text 块）
2. 没有 `toolCall`
3. 有非空 `thinking`，**或** `stopReason === "length"`（截断）
4. 非用户取消（`aborted`）
5. 非 pi 可自动重试的网络错误（交给内置重试）
6. thinking **未**表达「已完成 / 无需再追问」（见下）

真实场景里常见 `stopReason: "stop"` + 仅 `thinking` 块。

### 不续跑的收工信号（thinking 内）

满足任一则**不**自动追问，视为大模型已做出完成回答：

- 同时包含「完成」与「简单回复」（与逻辑）
- 或包含「不要再调用工具」

## 行为

| 步骤 | 动作 |
|------|------|
| 1 | `markSuppressTaskComplete()`，`task-notification` 跳过「任务完成」 |
| 2 | TUI `warning` + 桌面 `urgency: critical`：「大模型 API 出现了异常截断输出，自动进行重试」 |
| 3 | `sendUserMessage(...)` 排队开启新一轮（`agent_end` 时仍在 streaming，必须带 `deliverAs`） |

连续异常截断输出最多自动续 **3** 次，超限报错并停止。

## 与 task-notification 协作

共享模块：`lib/continuation-guard.ts`

- 本扩展在 `message_end`（早于 `agent_end`）写入 suppress 标志
- `task-notification` 在发送完成通知前检查 `shouldSuppressTaskComplete()`

## 使用

扩展目录自动加载。`/reload` 或重启 pi 后生效。

无需命令；失败时 status 栏会短暂显示「异常截断输出，准备自动续跑…」。
