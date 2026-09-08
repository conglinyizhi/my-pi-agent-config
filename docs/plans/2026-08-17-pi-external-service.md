# pi 外部服务 / pi-web 统一设计（现行版）

> 状态：设计草案 · 未实现 · **暂缓**（2026-09 决定先搁置：体量太大且没找到合适的运行方式）
> 合并自：`2026-08-17-pi-external-service`（主干）· `2026-08-15-pi-web-frontend-plan`（调研/选型/排期）· `pi-web-unified-plan`（已归档，保留其中仍然有效的结论）
> 目标：给 pi coding agent 建一个「外部服务」，让任何设备上的终端/浏览器都能远程驱动
> 三方：pi（agent）· Go 中间服务端 · 浏览器前端

## 0. 文档沿革与取代关系

同一个项目的三份计划，按时间演进如下。**本文是唯一现行版**，其余三份已归档到 `docs/plans/backup/`。

| 日期 | 文档 | 当时结论 | 现状 |
|---|---|---|---|
| 07-30 | `backup/pi-web-gui-plan.md` | Vite+ 前端路线 | 已归档 |
| 07-30 | `backup/pi-webd-server-plan.md` | pi-webd 服务端路线 | 已归档 |
| 08-01 | `backup/pi-web-unified-plan.md` | 保留 pi-web **sessiond** + 自建 **pi-webd（Node/Fastify）** + Vue 3 重写前端 | **两处关键选择已被取代**（见下），其余结论并入本文 |
| 08-15 | `backup/2026-08-15-pi-web-frontend-plan.md` | 官方 RPC 冒烟实测通过；Go bridge + Vue 3 + SQLite 索引；P0–P3 排期 | 内容并入本文 §2/§12/§13/§14 |
| 08-17 | 本文 | 控制面/数据面切分、多进程、away 语义等 5 条拍板 | 现行版主干 |

**被取代的两处（08-01 → 08-15/08-17）**：

| 维度 | 旧路线（08-01） | 现行 |
|---|---|---|
| 会话通道 | 保留 pi-web 的 **sessiond**（Node，ws + `seq` 序号） | 官方 `pi --mode rpc`（stdio JSON-lines）——08-15 冒烟实测事件流全通（pi 0.84.1 / pi-server 0.84.2），无需自研会话层 |
| 中间层 | 自建 **pi-webd**（Node 22+ / Fastify / socket.io） | **Go 单二进制**（spawn pi + WS + 静态资源 + SQLite），见 §2/§4 |

**仍然有效的旧结论（已并入本文）**：

- `ctx.ui.custom(factory)` 无法 Web 化（factory 是代码，不能序列化）→ 扩展富 UI 走「声明式数据 + 前端渲染」，见 §9
- 4 处 `ctx.mode !== "tui"` 守卫**不改**（`ctx.hasUI` 在 RPC 下也是 true，改成 `!hasUI` 是错误方向），见 §9
- TUI 与 Web **共享同一套提示词体系**（`buildSystemPrompt()` 无 mode 参数），人格/技能无双份管理
- 前端复用 `wails-gui/frontend/src/views/*.vue` 的 Vue 源码（Electron 已全量迁移到 Wails），见 §13

## 1. 目标与非目标

### 目标

- 把 pi 部署为**常驻服务**，通过浏览器（或任意终端）远程下达任务、查看流式输出、回复对话框、查看状态栏。
- 扩展行为与 TUI 下**语义一致**：扩展只提供数据，渲染交给前端（TUI 主题 / web 组件各自实现）。
- 支持「长任务 + 离开很久再回来」的场景：对话框可无限挂起等待人工。

### 非目标（本阶段明确不碰）

- 多用户 / 多租户 / 完整权限体系（先单用户 + token）。
- 全组件 UI 序列化（不做 JSON-schema 组件树，只做「通用原语 + 数据」）。
- 替换 pi 核心的 RPC 协议（只在其上叠加数据面）。

## 2. 总体架构

三方（浏览器 · Go · N 个 pi 子进程）、两条协议边界：

```
浏览器 ── WebSocket/Socket.IO ──► Go 中间层 ── stdio JSON-lines（RPC 控制面）──► pi 子进程
                                     ▲
                                     └──── Unix socket（数据面）────────────────── 扩展（pi 进程内）
```

- **Go 中间层**是「协议适配器 + 有状态信使」：spawn 并持有 pi 子进程、session 注册表、鉴权、对话框队列、WS hub、数据面 socket server。
- **pi 只认 stdin/stdout 的 JSON-lines RPC**（`pi --mode rpc`），不直接说 WebSocket。
- **扩展跑在 pi 进程内**（完整 Node 环境），经数据面 socket 直连 Go。
- 前端选型与组件清单见 §13，会话查询索引见 §12。

## 3. 通信边界：控制面 vs 数据面（核心决策）

两条通道各司其职，这是整个项目最需要钉死的一条边界：

| | 控制面 | 数据面 |
|---|---|---|
| 通道 | pi stdin/stdout（RPC JSON-lines） | Unix socket（扩展 ↔ Go） |
| 承载 | agent 环（`prompt/steer/follow_up/abort`、`text_delta`、tool 事件）、`ctx.ui` 对话框及其应答 | status-bus 快照、`working` 态、扩展自定义消息、遥测 |
| 方向 | 双向，含阻塞对话框 | 双向（以扩展→Go 为主） |
| 铁律 | **对话框应答必须回 stdin**（pi 的 pending promise 只被 stdin 的 `extension_ui_response` 解开） | **不承载对话框应答、不承载 agent 环** |

拆开的理由：pi 的 RPC 只有固定的 `extension_ui_request` 方法集（select/confirm/input/editor/notify/setStatus/setWidget/setTitle/set_editor_text），**表达不了「任意扩展定义的结构化消息」**；而扩展又不能直接写 pi 的 stdout（会污染 RPC JSON 流）。socket 补这个缺口。

## 4. 进程模型

**子进程，不用 sibling 进程。**

- pi 的 RPC 协议就是 stdio，Go 用 `exec.Command("pi", "--mode", "rpc")` 持 `StdinPipe`/`StdoutPipe`，**管道本身就是通信通道**，零桥接。
- 生命周期归 Go：pi 崩溃 → Go 重启；Go 退出 → kill pi。（**未设计**：Go 自身崩溃时的孤儿 pi 收割、pi 重启后 in-flight turn / pending 对话框 / status-bus 的恢复语义。）
- **并发会话 = 每会话一个子进程（已定）**：用户实测并发上限 2–4 个任务（会边跑边切到别的任务发消息），不做单进程 + `switch_session`。Go 注册表 `map[sessionId]→bridge{stdin,stdout,pid}`，**同一 session 同一时刻只允许一个进程持有**（session→pid 互斥，防两个进程写同一 session 存储）。
  - 代价：N× 扩展实例 + N× Node 内存；status-bus 单例天然按进程/会话隔离。
  - **已核（`pi --help`）**：`--session <path|id>` / `--session-id <id>` 支持启动即落在指定会话（`--session-id` 不存在则创建），所以**开新会话 = 一步 spawn 定 pin**，无需 `switch_session`。Go 用 `--session-dir <dir>` 把所有 pi 进程的会话存储收口到同一目录。
- 层级：`systemd → Go（守护）→ pi（子进程）`。

Go 侧读写模式：写 stdin 加一把 mutex 串行化；读 stdout 用单个 goroutine 逐行 scan + 按 `type` 分发 JSON 事件。

## 5. 卡点与解法对照

| # | 卡点 | 解法 |
|---|---|---|
| 1 | 流式无持续通道 | WebSocket/Socket.IO（已定）。`text_delta` 经 Go 推给浏览器 |
| 2 | 对话框双向异步 + 阻塞 | Go 端 pending 队列：按 `id` 关联、用户没响应则无限挂起（禁止自动应答）、重连重放（见 §8） |
| 3 | TUI-only API 过不了 RPC | 逐扩展加 RPC 降级路径（`custom`→声明式数据降级；见 §9） |
| 4 | session 枚举不在 RPC | Go 端自建 session 注册表（sessionId ↔ 子进程 ↔ jsonl 路径）+ 直接枚举 `--session-dir`（RPC 无 `list_sessions`，靠目录枚举补） |
| 5 | 桌面 GUI / 桌面通知是服务端本地概念 | GUI→web 面板；notify→WS 推送 |
| 6 | 安全（凭据 + shell 权限） | Go 端 token 鉴权 + 数据面 socket 鉴权（见 §10） |
| 7 | status-bus 进程内状态出不去 | 数据面 socket 目标（见 §6/§7） |

## 6. 状态栏工具（status-bus）设计汇总（已实现）

> 已落地，见 `lib/status-bus.ts`、`extensions/status-bus/index.ts`、`lib/status-bus.test.ts`（13 测试）、`extensions/status-bus/README.md`。
> 提交：`dbb584f`（核心）、`d01dbea`（接入）、`b9b8dbd`（JSON 契约 + 数据/渲染分离）、`10c6329`（结构化状态草案）。

### 6.1 核心机制

`ctx.ui` 在会话内是单例（`ExtensionRunner.uiContext`），`attach(ctx.ui)` 幂等地包住 `setStatus/setWidget/setWorking*`，记录进规范存储后转发原生实现（TUI 透传）。零迁移、扩展无感知。

### 6.2 数据 / 渲染分离原则

总线只承载**数据**，不承载**渲染**（着色、排版、顺序、是否显示是前端职责）：

- `statuses[*].text` 存**去 ANSI 的纯文本**；TUI 着色由 `theme.fg` 在透传时完成，web 侧自行渲染。
- 总线不做语义反解（不从颜色码猜 success/warning/accent）。

### 6.3 JSON 契约（`getSnapshot()`，100% 可序列化）

```ts
interface StatusSnapshot {
  version: number;                 // 每次变更单调递增，仅进程内顺序计数（不上线）
  statuses: Record<string, { text: string; updatedAt: number }>;
  widgets: Record<string, WidgetEntry>;
  working: { message?: string; visible?: boolean; indicator?: { frames?: string[]; intervalMs?: number } };
}

type WidgetPayload =
  | { kind: "lines"; lines: string[] }                                        // setWidget(key, string[])
  | { kind: "factory"; serialized: false; note: string };                     // setWidget(key, 组件工厂) 占位
```

- `version` 是进程内单调递增计数，仅作内部顺序/未来增量用；**不上线**——重连走服务端全量推送（见 §11 决策 4）。
- `WidgetPayload` 的 `kind` 判别是给 web 团队的自解释接口；`factory` 用 `serialized:false` 显式标记「函数不可序列化，web 无等效，应走声明式数据降级」。

### 6.4 结构化状态契约草案（未实现）

`StatusEntry` 演进为 `{ text, level?, updatedAt }`，`level` 由扩展**显式提供**（`default|accent|success|warning|error|muted`），总线不猜。供给方式：总线新增可选结构化入口 `statusBus.setStatus(key, { text, level })`，写结构化 store + 渲染转发原生，旧扩展零迁移。

## 7. 数据面：Unix socket 设计（已定：弃文件热路径）

### 7.1 决策

- **文件 sink 弃用**（热路径）：延迟 + 硬盘写寿命。
- 数据面热路径 = **Unix socket**，扩展 ↔ Go 直连，内存传输。

### 7.2 通道形态

- Go 为**每个 pi 子进程**监听一个 socket：`/tmp/pi-agent/<sessionId>.sock`，`chmod 0600`。**目录 `/tmp/pi-agent/` 也须 0700 + 归 Go 所有**（防同机用户在 `/tmp` 预建同名 symlink 劫持），或改用 `$XDG_RUNTIME_DIR`。
- 顺序天然正确：Go 先 listen → 把 `PI_BRIDGE_SOCKET` + `PI_BRIDGE_TOKEN` 塞进子进程环境变量 → spawn pi → 扩展连上。
- 收口成 `lib/bridge.ts` 约定：扩展统一 import，不各自裸连。提供 `connectBridge()`（带重连）+ 类型化 `send()`。

### 7.3 鉴权（必须，否则成外泄通道）

现有 `sandbox-guard`/`gate` 只拦截 `tool_call`，**看不到扩展直接开 socket**；而扩展里有 `skill-boot` 拉下来的第三方 skill。裸 socket = 绕过全部防护的外泄通道。至少：

1. 按会话隔离 socket 路径 + `chmod 0600`；
2. 连接时校验 `PI_BRIDGE_TOKEN`；
3. 可选 `SO_PEERCRED` 校验对端 PID 就是 Go 自己 spawn 的 pi。

### 7.4 生命周期

pi 崩/重启 → 扩展重连（带退避）；Go 重启 → 全部重连 + 客户端重订阅。**归属用 per-session socket 隐式完成，消息不带 `sessionId`**；`version` 也不上线（见 §11 决策 4）。

## 8. 长任务 / 无限延时 / 对话框队列

### 8.1 「无限延时」本身免费

RPC 的 `select/confirm/input/editor` **不传 `timeout` 就永久阻塞**，协议不强制超时。

### 8.2 两个关键事实

1. **超时是 pi 进程内部强制，客户端无法延长**（`rpc.md`：agent 侧到点自动用默认值 resolve）。所以「无限延时」的开关在**扩展调用处（不传 timeout）**，Go 端救不了。
2. **`ask_user_question` 工具目前 TUI-only**（`extensions/ask-question/index.ts`：`ctx.mode !== "tui"` 直接报错 + 用 `custom()`），RPC 下根本没有这条路。

### 8.3 三件必做（都在配置目录这边）

1. **「away」= 单一前端的全局状态 + 无限挂起、禁止自动应答**（非 settings 布尔）：Go 维护「是否有前端在线」，前端断开即 away（单点登录，见 §11 决策 3）。用户没响应 → 对话框无限挂起（不传 timeout，§8.1），**禁止自动应答**——自动同意是万劫不复的风险，默认选项会跑出与用户意图相悖的结果。away 信号 Go→扩展走 RPC 或 socket 二选一（推荐 socket：扩展已连数据面，天然下行）。
2. **`ask-question` 补 RPC 路径**：RPC 下用 `ctx.ui.select`/`ctx.ui.input`（这俩能过 RPC）替代 `custom()`，丢多 tab 花哨 UI 但功能在。
3. **Go 端 durable pending 队列 + 重连重放**：pending dialog 存 Go 内存（主路径，不落盘）；浏览器断开一小时回来，Go 按 session+dialog id 重放；Go 本身不主动超时、**不自动应答**。

### 8.4 区分两个场景

| 场景 | 行为 |
|---|---|
| 前端在线 | 对话框立即展示，等人工应答（不传 timeout = 无限挂起） |
| away（前端断开） | 对话框 park 在 Go 内存队列，用户回来重放；**禁止自动应答** |

> 注：对话框队列写盘仅在「要求 Go/pi 重启后仍不丢 pending」时才做，且是**偶发一次写**（非热路径），与 §7 弃文件热路径不冲突。

## 9. TUI-only 迁移清单（数据降级 + 前端渲染）

「拟态对话框」是**渲染层的事**：数据层只把扩展的结构化数据送到前端，面板如何渲染由前端（TUI / web）各自实现。扩展侧做 `ctx.mode !== "tui"` 的降级分支（富 UI 降级成结构化数据），Go 只提供通用传输，不负责面板语义。

具体面板机制（openPanel 之类）本阶段不建模、整体后置；坚持「通用原语 + 数据」，不做全组件序列化。

> 4 处 `ctx.mode !== "tui"` 守卫（`external-editor-shortcuts` / `skill-kit` / `ask-question` / `session-browse`）**不改**：`ctx.hasUI` 在 RPC 下也是 `true`，改成 `!hasUI` 是错误方向；Web 下 `ctx.mode` 不是 `"tui"`，现有守卫行为正确。

| 扩展 | TUI-only API | RPC 现状 | 迁移方向 |
|---|---|---|---|
| ask-question | `custom()` + mode 守卫 | 直接报错 | `custom()`→`select/input`（能过 RPC） |
| session-browse | `custom()` ×2 + mode 守卫 | 返回 undefined | →声明式列表面板 |
| copy-code-block | `custom()` | 返回 undefined | →声明式选择面板 |
| stream-monitor | `custom()` | 返回 undefined | →数据面遥测 + 前端渲染 |
| skill-boot | `custom()`（skill 选择器） | 返回 undefined | →声明式选择面板；`setWidget` 是 string[]，RPC 可过 |
| editor/editor-margin | `setEditorComponent()` | no-op | 前端已有编辑器，此项可弃 |
| editor/ctrl-c-safety | `getEditorText?.()` | 恒返回 "" | editor state 走数据面 |
| put-http-proxy | `getEditorText()` | 恒返回 "" | 同上 |
| editor/editor-gui | `runGuiWindow("editor")` | 桌面窗口 | →web 面板 |
| sandbox-permissions/gate | `runGuiWindow("gate")` | 桌面窗口 | →web 审批面板（含 away 模式挂起） |
| sandbox-permissions/allow | `runGuiWindow` | 桌面窗口 | →web 面板 |
| trident-routing | `runGuiWindow("routing")` + `setWidget`（工厂） | 桌面窗口 | →web 面板；`setWidget` 是**组件工厂**（RPC 忽略），走 status-bus 工厂占位 |
| trident-subagent | `runGuiWindow("setup")` | 桌面窗口 | →web 面板 |

（停用扩展 `thinking-translator`、`opencode-models` 不在迁移范围。）

## 10. 安全模型

1. **浏览器 ↔ Go**：WebSocket/Socket.IO 握手带 Bearer token（Go 端校验）。
2. **数据面 socket**：per-session 路径 + token + 可选 SO_PEERCRED（见 §7.3）。
3. **凭据不出服务器**：`auth.json`/`providers.toml`/`mcp-cache.json` 永不随消息出 Go。
4. **agent 有 shell 权限**：这是「谁能在服务器上跑命令」的边界，等价于「谁能连 Go」，所以 token 是第一条防线，不是可选项。
5. **沙箱是安全边界，但对话框仍一律等人工**：即使沙箱保护内，对话框应答也不自动进行（away 下尤其禁止）；`sandbox-permissions` 提权对话框是移动边界本身的机制，必须 fail-closed。
6. **单点登录**：Go 只允许一个活跃登录；多网页 tab 共享同一登录，第二个独立登录被拒绝/踢出。

## 11. 已定决策（2026-08-17 拍板）

1. **进程模型 = 多进程并发**：每会话一个 pi 子进程，实测并发上限 2–4 个任务（会边跑边切到别的任务发消息）。Go 注册表 `map[sessionId]→bridge`，同一 session 同一时刻只允许一个进程持有（session→pid 互斥）。代价：N× 扩展实例 + N× Node 内存；status-bus 单例天然按进程/会话隔离。**已核**：`--session <path|id>` / `--session-id <id>` 启动即 pin 会话，开新会话 = 一步 spawn，无需 `switch_session`；`--session-dir` 收口会话存储 + 目录枚举替代缺失的 `list_sessions`。
2. **数据面协议 = 直接复用 StatusChange，最小信封**：per-session socket 使 `sessionId` 隐式归属、服务端全量推送使 `version` 不做线上握手，信封只剩 `type` 判别（`status|widget|working|snapshot|hello`），payload 逐字段沿用 status-bus 契约。用户关切「信封浪费资源」成立——最终几乎零封装。
3. **away = 单一前端全局状态 + 无限挂起、禁止自动应答**：单点登录，前端在线与否即「是否 away」。用户没响应 → 对话框无限挂起（不传 timeout），**禁止自动应答**（自动同意 = 万劫不复的风险；默认选项 = 跑出与用户意图相悖的结果）。away 信号 Go→扩展走 RPC 或 socket 二选一（推荐 socket）。Go 需支持多网页同时接入 + 一个用户只登录一次。
4. **断线重连 = 服务端全量推送，无 version 握手**：浏览器不报版本；Socket.IO 每次 `connection`（含自动重连）Go 把当前最新快照 + 消息树整体推过去，幂等、无状态。status-bus 的 `version` 退化为进程内单调计数，不上线。
5. **前端渲染器 = 前端职责**：渲染清单是给前端的需求文档，不是后端决策；数据层只发 key→value（对话框 payload / status / 遥测）。Web 用拟态实现对话框、选择器、复杂菜单（强于 TUI）。§9 表格即「数据契约清单」。

## 12. 会话查询与索引

控制面走 RPC，查询面走本地索引——两者分开，避免「列历史会话」这种事去解析大 JSONL。

- pi 会话存储就是 JSONL（无 SQLite 驱动）
- 中间层后台把 JSONL **增量索引进 SQLite**：FTS5 全文 + 会话树 + 消息
- 前端会话列表 / 历史 / 搜索走 SQLite（快，且不整载大文件）
- 长会话（实测有 105MB 量级的 JSONL）不整载：`get_entries` 分段 + 索引 + 虚拟列表
- 选型：`modernc.org/sqlite`（纯 Go 无 CGO，本地单用户工具够用）

> 与 §5 卡点 4 配合：目录枚举解决「有哪些会话」，索引解决「会话里有什么」。

## 13. 前端与体验借鉴

前端框架是前端职责（§11 决策 5），但既定事实是 **Vue 3**：`wails-gui/frontend` 已是 Vue 3 + Vite，可直接复用视图源码。

### 13.1 选型

| 层 | 选型 | 理由 |
|---|---|---|
| 框架 | Vue 3（Composition API + SFC）+ Vite + Pinia | 主力栈；wails-gui 已有源码 |
| Markdown | markdown-it + highlight.js | 轻、成熟 |
| 编辑器 | CodeMirror 6（P2，默认键位，vim 可选） | 中文 IME 好 |
| UI 组件 | 自建核心组件 + 少量 naive-ui | 依赖少优先 |
| 构建 | Vite（wails-gui 同栈，不再走 rsbuild） | — |

### 13.2 组件清单（沿用 08-01 规划，按现行架构对齐）

| 组件 | 说明 |
|---|---|
| `ChatView.vue` | 流式消息列表 |
| `MessageBubble.vue` | 单条消息 |
| `MarkdownRenderer.vue` | markdown + 代码块复制 |
| `ToolExecutionCard.vue` | 工具调用 + diff 内嵌 |
| `DiffViewer.vue` | unified diff 着色 |
| `PromptEditor.vue` | 输入框 + 模型选择 |
| `StatusBar.vue` | token 统计 + 状态栏（消费 status-bus 契约） |
| `ExtensionDialogCard.vue` | 扩展对话框 / 面板底座 |

Composables：`useSession` / `useChat` / `useModel` / `useStatus` / `useExtensionDialogs`

### 13.3 偷 DSH 的体验（照抄体验，不抄代码）

- thinking 块折叠（details + 状态）
- 工具调用卡片（参数/结果折叠、失败红字）
- 增量流式渲染（事件驱动 store + 虚拟列表）
- `<system-reminder>` 特殊底色块（markdown 渲染时识别）
- 状态栏：模型 / thinking / 缓存命中率（数据来自 usage）
- 会话侧边栏（列表 / 树 / 切换）
- 暗色主题 + 代码高亮

**核心**：DSH 体验好 = 每个运行时事件都有视觉反馈。RPC 事件流天然支持同样映射，与框架无关。

### 13.4 桌面 GUI → Web 面板迁移优先级

permission-gate（P0）→ trident-routing（P0）→ editor-gui（P1）→ trident-queue gui（P1）→ gui-manager（P2）→ gui-review（P2）

## 14. 分阶段路线（未启动）

体量太大，暂缓；下面是可执行的切分，启动时按这个顺序。阶段划分沿用 08-15 的 P0–P3，验收点吸收 08-01 的并行策略。

| 阶段 | 内容 | 预估 | 验收 |
|---|---|---|---|
| P0 | Go 中间层（spawn + WS + 静态资源 + 数据面 socket）+ Vue 壳（消息流含 thinking 折叠、输入框、abort、`get_entries` 恢复会话） | 1–2 天 | 浏览器完成一轮含工具调用的对话 |
| P1 | 会话树/切换/分支、模型与 thinking 选择、状态栏（token/缓存命中率）、命令面板、扩展 UI 模态（select/confirm/input/editor/notify） | 3–5 天 | TUI 里的常用交互在 Web 端可用 |
| P2 | 主题映射、Vue 插槽体系、CodeMirror 6、图片粘贴、SQLite 全文搜索、移动端 | 1–2 周 | 手机浏览器可用 |
| P3 | 长会话虚拟列表、缓存友好（头部稳定 + append-only）、TUI/Web 双开 | — | 105MB 会话不卡 |

并行提示（来自 08-01）：前端 MVP 可以在中间层完成前先跑（`vite dev` + proxy 直连 RPC），不要串行等待。

### 14.1 目录结构

```
pi-web/
├── bridge/          # Go：main.go + protocol.go + ws.go + sqlite.go
├── web/             # Vue 3 + Vite
│   └── src/
│       ├── views/ components/ stores/ rpc/ markdown/
└── shared/          # 协议类型（对齐 pi rpc-types）
```

## 15. 风险与对策

| 风险 | 对策 |
|---|---|
| 扩展 UI 降级 | RPC 只转发 select/confirm/input/notify/setStatus/setWidget/setTitle/editor；`setFooter`/`setHeader`/`custom` overlay 在 Web 下失效 → P0 先用 permission-gate / plan-mode / goal 验证降级行为（§9 清单） |
| 进程生命周期 | 中间层管 pi 子进程 spawn/重启/重连；浏览器断线恢复（P0 必做）。**未设计**：中间层自身崩溃时的孤儿 pi 收割、pi 重启后 in-flight turn / pending 对话框 / status-bus 的恢复语义 |
| 增量合并器 | `message_update` 是 delta（已实测），需按 assistantMessageEvent 顺序合并 |
| 长会话 | 105MB JSONL 不整载：`get_entries` 分段 + SQLite 索引 + 虚拟列表 |
| 并发内存 | 每会话一个 pi 子进程 = N× 扩展实例 + N× Node 内存（§11 决策 1 的代价，已知并接受） |
| 安全 | token 是第一条防线（agent 有 shell 权限）；数据面 socket 需 per-session 路径 + token + 可选 `SO_PEERCRED`（§10） |
| 范围膨胀 | 服务端只做聊天 + 认证 + 代理，不做 projects/git/machines（08-01 教训） |

## 16. 相关文档

- `docs/plans/backup/pi-web-unified-plan.md`：旧 pi-web 路线（sessiond + Fastify），**已归档**；仍然有效的结论已并入本文 §0/§9/§13
- `docs/plans/backup/2026-08-15-pi-web-frontend-plan.md`：08-15 调研原件，**已归档**；内容并入本文 §2/§12/§13/§14
- `docs/plans/backup/pi-webd-server-plan.md`、`backup/pi-web-gui-plan.md`：更早的路线（已归档）
- `docs/plans/2026-08-15-pi-platform-capability-inventory.md`：`ctx.ui` 完整能力面与 RPC 退化现状
- `extensions/status-bus/README.md`：status-bus 的 JSON 契约与结构化状态草案（本文 §6 的来源）
