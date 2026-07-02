# task-notification

## 功能概述

当用户任务完全处理完成时发送桌面通知。监听 agent 生命周期事件，智能判断是否应该通知。

## 通知策略

- **正常完成** → 立即发送通知
- **用户手动取消**（`stopReason === "aborted"`）→ 不通知
- **可重试的网络错误** → 延迟 3 秒通知，若 agent 在此期间恢复（触发 `agent_start`）则取消
- **不可重试错误导致终止** → 发送通知

## 初始化

启动时检测系统通知工具是否可用（`notify-send` / `osascript`），不可用时在 TUI 中提示安装。

## 事件钩子

- `agent_start` — 取消所有延迟通知（agent 重试/恢复）
- `agent_end` — 根据 stopReason 决定是否通知
- `session_start` — 通知工具不可用时弹提示

## 依赖

- `../../lib/notify-send` — 桌面通知发送 + 支持检测
- `../../lib/message-utils` — 消息摘要提取
- `../../lib/error-utils` — 可重试错误判断
