# talk-sleep

## 功能概述

暂存当前对话并在后续恢复。类似于「书签」功能，将当前 session 信息（ID、路径、工作目录、备注）存入 `~/.pi/talk-sleep.jsonl`，后续可通过 TUI 选择器找回并复制恢复指令。

## 提供的命令

### `/talk-sleep [备注]`

将当前对话暂存。自动记录 sessionId、sessionFile、cwd 和时间戳。仅在 session 已持久化时才可暂存（in-memory session 不支持）。

### `/talk-sleep-load`

弹出 TUI 选择器，展示所有暂存对话（按时间倒序），选中后可选：
- 复制恢复指令到剪贴板（`cd <cwd> && pi --session <id>`）
- 仅显示指令

剪贴板工具自动检测优先级：wl-copy → xclip → xsel → pbcopy。

## 数据存储

`~/.pi/talk-sleep.jsonl`：每行一个 JSON 对象：
```json
{"sessionId":"...","sessionFile":"...","cwd":"...","note":"备注","timestamp":"..."}
```

## 依赖

- Node.js fs/promises, child_process
- `@earendil-works/pi-coding-agent` — ExtensionAPI
