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

另外会把 **cwd 等于当前目录** 的 session 用 `●` 高亮（交互列表里为绿色，文本列表里加 `(当前目录)` 标记），方便一眼定位「我在当前目录的历史 session」。

## 命令

| 命令 | 作用 |
|------|------|
| `/session-switch` | 交互选择并 `switchSession`（首屏最近 30 条，往下翻自动加载更多） |
| `/session-switch 15` | 只显示最近 15 条 |
| `/session-switch shin` | 按关键词过滤（cwd/名称/首条/全文 AND） |
| `/session-switch list` | 只看文本列表，不切换 |
| `/session-switch list 20 tmp` | 文本 + 条数 + 过滤 |
| `/session-switch:fast-fork` | 从当前 session 当前位置 `fork` 出一个新 session 文件继续对话 |
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

- **懒加载**：`SessionManager.listAll()` 会把每个 `.jsonl` 整个读出来解析（算名称 / 首条消息 / 消息数），
  几百个 session（本项目实测 326 个文件、385MB）要一两秒。交互模式改成：
  - 先 `readdir` + `stat` 只拿文件名和修改时间（~15ms），按最后活动倒序
  - 首屏只解析最近 **30 条**（~260ms），光标接近已加载末尾（差 5 条）时再解析下一批 30 条
  - 底部状态栏显示 `已加载 30/326 · 继续向下翻加载更多`；带过滤时显示 `已加载 N 条匹配 · 已扫描 x/y 个文件`
  - 带过滤时会一直扫描到凑够一批匹配或扫完所有文件，不会出现「空列表却还能往下翻」
  - 解析出的 `SessionInfo` 与官方同形（名称取最后一条 `session_info`，`modified` 取最后一条消息活动时间，
    回退到 header 时间 / mtime），所以格式化与高亮逻辑不用改
- 文本列表（`/session-switch list`）仍一次性加载，默认只取 30 条
- TUI：`SelectList` + `DynamicBorder`；Enter → `ctx.switchSession(path)`
- **当前目录高亮**：以 `ctx.sessionManager.getCwd()` 为基准，用 `theme.fg("success", …)` 给匹配 cwd 的 session 的 label/description 上色（主题缺该 token 时回退为纯文本 `●` 标记）

## 与内置 `/resume` 对照

| | `/resume` | `/session-switch` |
|--|-----------|-------------|
| 默认范围 | 当前目录 | **全部 workdir** |
| 高亮当前目录 | 天然仅当前目录 | **`●` 高亮 + `(当前目录)` 标注** |
| 时间显示 | 相对（`3h`） | **绝对 + 相对** |
| 文本导出 | 无 | `/session-switch list` |
| LLM 工具 | 无 | `list_sessions` |

`/session-switch:fast-fork`：以当前 `ctx.sessionManager.getLeafId()` 为入口，
用 `ctx.fork(leafId, { position: "at", withSession })` 把当前 active path 复制成一个新 session 文件，
切入后即可在 fork 出的分支里继续对话，不会改动原 session 文件。

> **stale ctx 坑**：fork / switchSession 成功后旧 `ctx` 立即失效——pi 的 `ctx.ui` 是惰性 getter，
> 连读一下都会抛 `stale after session replacement`。所以清 status / 通知这类收尾动作只能写在
> `withSession(newCtx)` 里；确实要在旧 `ctx` 上做的（取消、替换前就失败的报错）统一走 `runOnOldCtx` 兜底。
> 回归测试：`node --experimental-strip-types --test extensions/session-browse/stale-ctx.test.ts`

停电抢救推荐路径：

```text
/session-switch list 20
# 或交互：
/session-switch
# 想开新分支继续：
/session-switch:fast-fork
```
