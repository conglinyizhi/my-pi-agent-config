# 林汐 Web GUI 与访问服务整合计划

> 状态：草案 | 日期：2025-08-01 | 整合自：pi-webd-server-plan + pi-web-gui-plan

> ⚠️ 2026 迁移标注：本文提到的「6 个 Electron GUI」已于 2026 全量迁移到 **Wails**（`wails-gui/`，单二进制 + windowName 路由，Electron 链已退役）。
> 若后续执行 pi-web 统一，迁移路径应从 Wails 出发（复用 `wails-gui/frontend/src/views/*.vue` 源码），不再是 rsbuild→vite。

上游仓库：https://github.com/jmfederico/pi-web （仅保留其 sessiond 层，前端 Lit 与 web server 层废弃）

## 背景与决策

目标：将 pi 部署在服务端，通过手机/平板/任意浏览器访问。保持林汐旗舰人格一致，扩展在 TUI 和 Web GUI 下行为无差异，并逐步摆脱 TUI 的积弊。

**核心决策：重写，而非扩展 pi-web。**

| 决策 | 理由 |
|------|------|
| 前端用 Vue 3 重写 | pi-web 现有前端是 Lit（5.5 万行）；Vue 训练数据多、生态熟悉；现有 6 个 Electron GUI 已是 Vue，可复用源码 |
| 服务端自建 pi-webd | pi-web 的 web server 层（app.ts）承载大量不需要的业务（projects/git/machines/plugins）；只要聊天 + 认证 + 代理 |
| WebSocket 用 socket.io | 自带重连、事件路由、认证中间件；生态熟悉 |
| 只保留 pi-web sessiond | 它负责 pi agent 生命周期，4000+ 行经过测试，不重写 |

**部署形态**：公网可达，但**只有持有 token 的人能访问**。

---

## 架构

```
手机 / 浏览器
  ↕ HTTPS + Bearer Token + socket.io
pi-webd（自建 Fastify）              ← 本计划产出 A
  ├─ auth 中间件（token 校验）
  ├─ socket.io 服务端（浏览器入口）
  ├─ socket.io ↔ ws 适配层
  ├─ 静态文件服务（Vue dist）
  └─ token 管理 API
  ↕ HTTP + 原生 ws（Unix socket）
pi-web sessiond（保留，最小 patch）   ← 本计划产出 C
  ↕ pi SDK
pi agent
```

注意：**pi-web 是「web server + sessiond」两层**，本计划只保留 sessiond 层（`src/server/sessiond.ts`），web server 层（`src/server/app.ts`）与 Lit 前端（`src/client/`）整体废弃，由 pi-webd + Vue 前端替代。

---

## 现状审计（基于 pi-web 源码）

### sessiond 的 WebSocket 协议

- sessiond 用原生 `ws`，端点：`/api/sessions/:id/events`、`/api/sessions/events`、`/api/events`
- 消息是 **JSON 文本帧**：`{ type, ...payload, seq }`（`seq` 为会话内递增序号，客户端用于丢弃快照后重复的 live 事件）
- 事件类型见 `shared/apiTypes.ts` 的 `SessionUiEvent` / `RealtimeEvent`

**含义**：浏览器用 socket.io 时，pi-webd 的适配层要把 socket.io 事件 ↔ sessiond JSON 帧做格式转换，**不是字节透传**。适配层是 pi-webd 的核心复杂度，单独一个模块。

### ExtensionUIContext 退化现状（pi-web 的 Proxy 已拦截/未拦截）

pi-web 的 `sessionUiContext()` 返回 `new Proxy(baseUiContext, ...)`，当前只拦截：

| API | pi-web 现状 | 本计划 |
|-----|------------|--------|
| `confirm` / `select` / `input` | ✅ 已拦截（PendingExtensionDialogStore → 浏览器回答） | 保留 |
| `notify` | ✅ 已拦截（command.output 事件） | 保留 |
| `theme` | ✅ 已拦截（plainTextTheme） | 保留 |
| `setStatus` | 透传（Pi headless 下 fire-and-forget） | 前端消费 |
| `custom` | ❌ 未拦截（返回 undefined） | **新增拦截** |
| `setWidget` | ❌ 未拦截 | **新增拦截** |
| `setEditorComponent` | ❌ 未拦截 | **新增拦截** |
| `setWorkingIndicator` / `setWorkingMessage` / `setWorkingVisible` | ❌ 未拦截 | **新增拦截** |
| `setFooter` / `setHeader` / `setTitle` | ❌ 未拦截 | **新增拦截** |

（完整签名见 `@earendil-works/pi-coding-agent` 的 `ExtensionUIContext`）

### `ctx.mode !== "tui"` 直接退出（4 处·5 行）

**修正前提**（基于 pi 官方文档 extensions.md/rpc.md）：

- `ctx.hasUI` 在 TUI 和 RPC 模式下**都是 `true`**（RPC 下 dialog/notify 经 JSON 协议可用）
- TUI-specific 功能（`custom()`、组件工厂、终端输入）必须用 `ctx.mode === "tui"` 守卫
- 因此「`ctx.mode !== "tui"` → `!ctx.hasUI`」是**错误替换**：会把 RPC 模式误判为有 TUI 能力

| 文件 | 现状 | 正确修法 |
|------|------|---------|
| `external-editor-shortcuts.ts` | `ctx.mode !== "tui"` 退出 | 保持 `ctx.mode !== "tui"`（custom 在 Web 下仍不可用） |
| `skill-kit/index.ts` | 同上 | 同上 |
| `ask-question/index.ts` | 同上 | 同上 |
| `session-browse/index.ts` | 同上（2 处） | 同上 |

**结论**：这 4 处守卫**不改**。Web GUI 下 `ctx.mode` 是 `"rpc"`（或 pi-webd 自定义值），`custom()` 依然不可用，守卫行为正确。

### 提示词体系：TUI 与 Web 同源（不分裂）

确认依据（pi SDK 源码 + pi-web 源码）：

- `buildSystemPrompt()` 的输入只有 customPrompt / tools / snippets / guidelines / cwd / contextFiles / skills，**无 mode 参数**——TUI 与 SDK 用同一函数，产物一致
- pi-web 的 sessiond 用标准 `createAgentSessionFromServices`，**未传 systemPromptOverride / customPrompt**，不注入自己的提示词
- 提示词来源是配置不是模式：`SYSTEM.md`、`~/.pi/agent/prompts/*.md`、skills、context files，TUI 与 Web 加载路径一致

**结论**：Web 与 TUI 共享同一套提示词体系（含林汐人格与技能），无双份管理负担。Web 端只负责渲染层差异（Vue 组件 vs TUI 组件），不触碰提示词构建。

---

## 产出 A：pi-webd 服务端

### 技术选型

| 层 | 选型 |
|----|------|
| 运行时 | Node.js 22+ |
| 框架 | Fastify |
| WebSocket | `socket.io`（浏览器侧）+ `ws`（sessiond 桥接） |
| Token 存储 | JSON 文件（`~/.pi-webd/tokens.json`，权限 0600） |
| Token 生成 | `crypto.randomUUID()` |
| 静态文件 | `@fastify/static` |
| 日志 | pino |

### Token 认证

- 所有 HTTP 请求与 socket.io 连接需带 `Authorization: Bearer <token>`
- 动态管理：生成 / 列出 / 吊销，无需重启
- Token 元数据：名称、创建时间、最后使用时间

### API

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/api/status` | 健康检查（**无 token**，注册顺序先于 `/api/*` 代理） |
| `*` | `/api/*` | HTTP 代理 → sessiond |
| `GET` | `/socket.io/*` | socket.io 升级（`io.use` 校验 token） |
| `POST` | `/admin/tokens` | 生成 token（admin token） |
| `GET` | `/admin/tokens` | 列出 token |
| `DELETE` | `/admin/tokens/:id` | 吊销 token |
| `GET` | `/*` | 静态文件 |

**路由注册顺序必须明确**：`/api/status` 在 `/api/*` 代理之前注册，否则被吞。

### socket.io ↔ ws 适配层（核心模块）

```
浏览器 socket.io 事件 ──► pi-webd 适配层 ──► sessiond 原生 ws（JSON 帧）
浏览器 socket.io 事件 ◄── pi-webd 适配层 ◄── sessiond 原生 ws（JSON 帧）
```

职责：
- socket.io 事件名 ↔ sessiond `event.type` 映射
- `seq` 序号透传（浏览器据此做快照去重）
- 重连：sessiond 断开时 socket.io 侧广播状态，不伪造消息
- sessiond 侧用 `ws+unix:` 连接（pi-web 的 `SessionDaemonClient.connectWebSocket` 模式）

### Admin token 首次发放

远程部署下控制台不可达，首次启动把 admin token 写入 `tokens.json` 并打印路径，而非仅打印控制台。

---

## 产出 B：Vue 前端

### 技术选型

| 层 | 选型 |
|----|------|
| 框架 | Vue 3 (Composition API, `<script setup>`) |
| CSS | Tailwind CSS 4 |
| WebSocket | socket.io-client |
| Markdown | `marked` |
| Diff | `diff` |
| 构建 | Vite（沿用现有 Electron GUI 的 rsbuild→vite 迁移路径） |
| PWA | `vite-plugin-pwa` |

### 组件

| 组件 | 说明 |
|------|------|
| `ChatView.vue` | socket.io 流式消息列表 |
| `MessageBubble.vue` | 单条消息 |
| `MarkdownRenderer.vue` | marked + 代码块复制 |
| `ToolExecutionCard.vue` | 工具调用 + diff 内嵌 |
| `DiffViewer.vue` | unified diff 着色 |
| `PromptEditor.vue` | 输入框 + 模型选择 |
| `StatusBar.vue` | token 统计 + 右对齐「林汐 · 母港 + 模型名」 |
| `ExtensionDialogCard.vue` | 扩展对话框面板底座 |

Composables：`useSession` / `useChat` / `useModel` / `useStatus` / `useExtensionDialogs`。

### 6 个 Electron GUI → Web 面板

```
ExtensionDialogKind."custom"
  → payload: { panel: "todo" | "permission-gate" | "queue-config" | ..., data: {...} }
  → 前端 ExtensionDialogCard 按 panel 分发
  → 复用现有 Electron GUI 的 Vue 源码（rsbuild.config.ts → vite.config.ts 机械翻译）
```

优先级：permission-gate（P0）→ trident-routing（P0）→ editor-gui（P1）→ trident-queue gui（P1）→ gui-manager（P2）→ gui-review（P2）。

---

## 产出 C：sessiond 最小 patch

### custom(factory) 的可行性约束（重要）

`ctx.ui.custom(factory)` 的 factory 是**代码**（接收 tui/theme/keybindings/done，返回 Component）。
Web 端无法把 JS 函数序列化到浏览器渲染——「拦截 custom → 提取数据 → 浏览器渲染」**不成立**。

因此 custom 保持 TUI-only（RPC/Web 下返回 undefined），Web 面板走**新的声明式 API**：

```ts
// 新增：声明式面板（数据驱动，可序列化）
ctx.ui.openPanel({ panel: "todo" | "permission-gate" | "queue-config" | ..., data: {...} })
```

6 个 Electron GUI 迁移时改为调用 `openPanel`（复用各自 Vue 源码），custom 本身不迁移。

### Proxy 中新增拦截

在 pi-web 的 `src/server/sessions/piSessionService.ts` 的 `sessionUiContext()` 中新增：

- `openPanel` → `PendingExtensionDialogStore.open({ kind: "custom", payload })`（`ExtensionDialogKind` 加 `"custom"`，承载 panel+data）→ 浏览器渲染 → answer → resolve
- `setWidget` / `setFooter` / `setHeader` / `setTitle` → WebSocket 事件 → 前端对应区域
- `setEditorComponent` → 前端 PromptEditor 扩展点
- `setWorkingIndicator` / `setWorkingMessage` / `setWorkingVisible` → 前端 loading 状态
- `custom` / `setEditorComponent` 等 TUI-only 方法**不拦截**，保持返回 undefined

改动集中在 sessionUiContext + 事件类型，主体不动。

### 4 处 `ctx.mode !== "tui"` 守卫

**不改**（见上文：`hasUI` 在 RPC 下也是 true，改用 `!hasUI` 是错误方向；Web 下 `ctx.mode` 非 `"tui"`，现有守卫行为正确）。

---

## 阶段计划（解除原计划死锁）

原两份计划互相把对方设为前置。本计划明确：**A、B 并行开发，C 是 B 的依赖但独立可测。**

### Phase 1：A 服务端最小可用（~3 天）

- Fastify 启动 + token 认证中间件
- `/api/status` 健康检查
- socket.io 服务端 + token 校验
- **sessiond 桥接探针**：50 行验证连 sessiond ws、收 JSON 帧、转发格式正确
- 静态文件（先放占位 HTML）

### Phase 2：B 前端 MVP（~5 天，与 Phase 1 并行）

- Vue 项目初始化（Vite + Tailwind）
- `useSession` + `useChat`（socket.io 连 pi-webd）
- `ChatView` + `MarkdownRenderer` → 能聊天
- `StatusBar`（林汐 · 母港）
- 本地 `vite dev` + proxy 直连 sessiond，不依赖 pi-webd 完成

### Phase 3：C Proxy 扩展（~1 天）

- 新增 `openPanel`（声明式面板，数据驱动）拦截 → 浏览器渲染
- 补 `setWidget` / `setFooter` / `setHeader` / `setTitle` / `setWorking*` 拦截
- `custom` / `setEditorComponent` 等 TUI-only 方法不拦截，保持 undefined
- 前端 `ExtensionDialogCard` 对接

### Phase 4：GUI 迁移 + 公网部署（~2 天）

- 6 个 Electron GUI 逐批迁移
- token 管理 CLI + admin API
- systemd unit + Caddy/Tailscale 反代
- 手机 PWA 验证

---

## 关键风险

| 风险 | 缓解 |
|------|------|
| socket.io ↔ ws 适配层 | Phase 1 先写 50 行探针验证消息格式，再铺全量 |
| sessiond API 不稳定 | `shared/apiTypes.ts` 为契约，只依赖这些类型 |
| 重写范围过大 | 服务端只做聊天+认证+代理，不做 projects/git/machines |
| admin token 远程发放 | 写入 tokens.json + 打印路径 |
| `custom(factory)` 无法 Web 化 | 改走声明式 `openPanel`，custom 保持 TUI-only（已确认） |

---

## 下一步

1. 初始化 pi-webd 仓库（pnpm init + Fastify + socket.io + TypeScript）
2. 写 sessiond 桥接探针，确认 JSON 帧格式
3. 初始化 Vue 项目，跑通 `vite dev` + proxy
4. 确认 pi-webd 自定义 mode 值与 4 处 `ctx.mode !== "tui"` 守卫的兼容性
