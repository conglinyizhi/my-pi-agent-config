# stream-monitor

## 功能概述

状态栏看流式是否还在动、大概多快、工具跑了多久。数字是粗估，不是账单。

## 状态栏显示

- **流式中**：`⚡ 123 tok/s  |  1.2k tok  |  35.2s`
- **流式结束**：保留最终快照（全程平均 tok/s），直到下一次流式 `start`
- **单个工具**：`🔧 bash (2m15s)`
- **并行工具**：`🔧 bash +2 (2m15s)`（最早启动的那个 + 额外个数）
- **空闲且无快照**：隐藏

## 实现要点

- **token**：`estimateTextTokens` 粗估（CJK≈1/字，ASCII≈4 字/token），够看趋势即可
- **速度**：3 秒滑动窗口；结束后用全程平均
- **刷新**：delta 500ms 节流 + ticker 推进工具计时/窗口
- **并行工具**：`Map<toolCallId>`，end 只删对应 id
- **指示器**：session 起脉冲 `· • ● •`，shutdown 恢复默认
- **清理**：`session_shutdown` / `agent_end` 清残留

## 事件

`session_start` · `session_shutdown` · `message_update` · `message_end` · `tool_execution_*` · `agent_end`
