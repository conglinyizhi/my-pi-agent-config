# session-browse

跨 **所有 workdir** 浏览 / 筛选历史 session，按**最后活动时间**排序，可选一键 resume。同时支持全文搜索历史对话内容。

> 已合并原 `session-search` 插件的全文搜索功能，两个职责统一为「session 管理」。
> - **浏览层**：解决「我上次在哪个目录、几点停的」
> - **搜索层**：解决「我们之前讨论过 XX 吗」

## 为什么需要

内置 `/resume` 默认是 **Current Folder**；跨目录要先 **Tab → All**。  
本扩展默认就是 All，并同时显示：

- 绝对时间（`07-15 21:56`）
- 相对时间（`3h`）
- cwd
- 消息数
- 名称 / 首条用户消息

## 命令

| 命令 | 作用 |
|------|------|
| `/sessions` | 交互选择并 `switchSession` |
| `/sessions 15` | 只显示最近 15 条 |
| `/sessions shin` | 按关键词过滤（cwd/名称/首条/全文 AND） |
| `/sessions list` | 只看文本列表，不切换 |
| `/sessions list 20 tmp` | 文本 + 条数 + 过滤 |
| `/find-session …` | 同上别名 |

## 工具（LLM）

### `list_sessions`

- `limit`：默认 20，最大 50
- `filter`：可选关键词

用于停电恢复场景：让模型直接列出「最近活跃的 session + 目录 + 时间」。

### `search_sessions`

- `query`：关键词（空格 AND 逻辑）
- `limit`：默认 10，最大 20
- `project`：可选，限制项目目录

全文搜索历史 session 对话内容（逐条 entry 扫描）。用于「我们之前讨论过 XX 吗」场景。

## 实现

- `SessionManager.listAll()` —— 官方跨项目枚举，已按 `modified` 降序
- `modified` 取自 session 内最后一条 message 的活动时间（非仅 mtime）
- TUI：`SelectList` + `DynamicBorder`；Enter → `ctx.switchSession(path)`

## 与内置 `/resume` 对照

| | `/resume` | `/sessions` |
|--|-----------|-------------|
| 默认范围 | 当前目录 | **全部 workdir** |
| 时间显示 | 相对（`3h`） | **绝对 + 相对** |
| 文本导出 | 无 | `/sessions list` |
| LLM 工具 | 无 | `list_sessions` |

停电抢救推荐路径：

```text
/sessions list 20
# 或交互：
/sessions
```
