# Pi Web 前端规划（pi-web）

> 目标：给 pi coding agent 增加一个浏览器渲染器，摆脱 TUI。Vue 3 前端 + Go 桥接 + 官方 RPC 通道，偷 DSH 的交互设计但代码全自研。
> 状态：2026-08 调研完成，RPC 冒烟测试通过（v0.84.1 / pi-server v0.84.2）。

## 一、核心结论

1. **不用改 pi**：官方 RPC 模式（`pi --mode rpc`，stdin/stdout JSONL）已把运行时全量暴露，冒烟测试实测完整事件流可达（agent_start → message_start/update(增量delta) → message_end → turn_end → agent_end → agent_settled）。
2. **官方服务端/客户端分离进度**：`@earendil-works/pi-server` v0.84.2 已发布（协议层 `pi-protocol` CBOR、传输层 `PiServerListener` Unix/WebSocket、服务骨架 `PiServer`）——但**未接入 coding-agent、无 CLI、无前端**，且 API 标注 Experimental。短期不依赖，持币观望。
3. **DSH 不是 pi 的包装层**：DSH 只依赖 `@earendil-works/pi-ai`（LLM 客户端库）作为 `dsh-llm-pi-ai` 的对照实现；agent/session/sandbox/插件体系全自研。但"自研前端不难"成立——因为接口是现成的。
4. **存储**：pi 会话存储就是 JSONL（无 SQLite 驱动，CHANGELOG 已查证）。Web 查询通道用 **Go SQLite 增量索引**（偷 DSH session-query-sqlite 的思路），控制通道走 RPC。
5. **社区项目**：全是 React/Next 早期玩具（0.0.x~0.3.x），只作交互参考不作依赖。

## 二、架构

```
浏览器 (Vue 3 + Vite + Pinia)
   │  WebSocket (JSON-RPC 转发)
   ▼
Go bridge（单二进制：spawn pi + WS + HTTP 静态资源 + SQLite 索引）
   │  spawn
   ▼
pi --mode rpc（headless，写 JSONL 不变 → TUI/Web 可双开同一会话）
```

- **控制/事件通道**：官方 RPC 原样转发（命令：prompt/steer/follow_up/abort/new_session/switch_session/fork/clone/compact/get_state/get_entries/get_tree/get_messages/get_commands/set_model/set_thinking_level/bash…）
- **查询通道**：bridge 后台把 JSONL 增量索引进 SQLite（FTS5 全文 + 会话树 + 消息），前端会话列表/历史/搜索走 SQLite，快且不解析大文件
- **事件→视图**：`message_update` 是增量 delta，前端需要增量合并器（P0 重点）

## 三、技术选型

| 层 | 选型 | 理由 |
|---|---|---|
| 前端 | Vue 3 (Composition API + SFC) + Vite + Pinia | 主力栈；React 无熟练度证据 |
| Markdown | markdown-it + highlight.js | 轻、成熟（DSH 用 micromark 是 React 栈的选择） |
| 编辑器 | CodeMirror 6（P2；默认键位，vim 可选） | 中文 IME 好；无 vim 肌肉记忆不强求 |
| UI 组件 | 自建核心组件 + 少量 naive-ui | 依赖少优先 |
| 桥接 | Go 单二进制（CGO_ENABLED=0，embed 静态资源） | 无 Docker；内存优先；Go 是主力语言 |
| SQLite | modernc.org/sqlite（纯 Go 无 CGO） | 本地单用户工具常用持久化 |
| WebSocket | github.com/coder/websocket | 最小依赖 |

## 四、偷 DSH 前端设计清单（照抄体验，不抄代码）

- thinking 块折叠（details + 状态）
- 工具调用卡片（ToolCard：参数/结果折叠、失败红字）
- 增量流式渲染（事件驱动 store + 虚拟列表）
- <system-reminder> 特殊底色块（markdown 渲染时识别）
- 状态栏：模型/thinking/缓存命中率%（cacheHitPercent 思路，数据来自 usage）
- 会话侧边栏（列表/树/切换）
- 暗色主题 + 代码高亮

**核心**：DSH 体验好 = 每个运行时事件都有视觉反馈。RPC 事件流天然支持同样映射，与框架无关。

## 五、分阶段

- **P0（1-2 天）**：Go bridge（spawn+WS+静态）+ Vue 壳（消息流含 thinking 折叠 + 输入框 + abort + 会话恢复 get_entries）。验收：浏览器完成一轮含工具调用的对话。
- **P1（3-5 天）**：会话树/切换/分支、模型与 thinking 选择、状态栏（token/缓存命中率）、命令面板、扩展 UI 模态（select/confirm/input/editor/notify）。
- **P2（1-2 周）**：主题映射、Vue 插槽体系（EntryRenderer/Widget 概念）、CodeMirror 6、图片粘贴、SQLite 全文搜索、移动端。
- **P3**：长会话虚拟列表、缓存友好（沿用审计结论：头部稳定、append-only）、TUI/Web 双开。

## 六、风险与对策

1. **扩展 UI 降级**：RPC 只转发 select/confirm/input/notify/setStatus/setWidget/setTitle/editor/set_editor_text；setFooter/setHeader/custom overlay 在 Web 下失效 → P0 先跑 permission-gate/plan-mode/goal 验证降级行为。
2. **进程生命周期**：bridge 管 pi 子进程 spawn/重启/重连；浏览器断线恢复（P0 必做）。
3. **增量合并器**：message_update 是 delta（已实测），需按 assistantMessageEvent 顺序合并。
4. **长会话**：105MB JSONL 不整载，get_entries 分段 + SQLite 索引 + 虚拟列表。

## 七、目录结构

```
pi-web/
├── bridge/          # Go：main.go + protocol.go + ws.go + sqlite.go
├── web/             # Vue 3 + Vite
│   └── src/
│       ├── views/ components/ stores/ rpc/ markdown/
└── shared/          # 协议类型（对齐 pi rpc-types）
```
