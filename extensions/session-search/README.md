# session-search

## 功能概述

跨所有项目和目录搜索历史 session 对话内容。让 LLM 可以查找之前讨论过的主题、代码片段、关键决策、Bug 修复等。当用户询问「我们之前讨论过 XX 吗」或需要回顾历史对话时使用。

## 提供的工具

### `search_sessions` 工具

参数：
- `query`: string — 搜索关键词，多个词语用空格分隔（AND 逻辑）
- `limit`: number? — 返回结果数量上限，默认 10，最大 20
- `project`: string? — 限制在特定项目目录中搜索（匹配 session 文件路径子串）

## 实现细节

- 使用 `SessionManager.listAll()` 列出所有 session
- 用 `SessionManager.open()` 逐个打开并扫描 entries
- 关键词按空格分词，全部匹配（AND 逻辑）
- 文本提取支持 string 和 array 两种 content 格式
- 结果截断到 400 字符
- 跳过无法打开的 session（容错）

## 依赖

- `@earendil-works/pi-coding-agent` — SessionManager
- `typebox` — 参数类型定义
