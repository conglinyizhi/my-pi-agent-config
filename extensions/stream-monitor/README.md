# stream-monitor

## 功能概述

流式状态监视器，在 TUI 状态栏实时显示：
- Token 流入速度（tok/s，基于 3 秒滑动窗口计算）
- 累计 token 数和已用时间
- 工具执行时的运行时长

## 状态栏显示

- **流式输出中**：`⚡ 123 tok/s | 4.2k tok | 35.2s`
- **工具执行中**：`🔧 bash (2m15s)`
- **空闲**：隐藏

## 实现细节

- **流速计算**：3 秒滑动窗口，`.length` 估算而非精确 tokenize（`estimateTokens`）
- **节流**：`text_delta` 事件频发，500ms 节流更新 UI
- **自定义工作指示器**：替换默认旋转动画为 `W- O- R- K-` 帧序列
- **无状态缓存**：不缓存 ctx，每次从事件参数获取，避免 session 替换后过期引用

## 事件钩子

- `session_start` — 重置状态、设置自定义工作指示器
- `message_update` — 追踪 text_delta 更新流速
- `message_end` — 流式结束，清除状态
- `tool_execution_start/update/end` — 显示/更新/清除工具执行状态

## 依赖

- `../lib/token-utils` — estimateTokens
- `@earendil-works/pi-coding-agent` — ExtensionAPI
