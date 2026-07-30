# 林汐 Web GUI 计划书

> 状态：草案 | 日期：2025-07-30 | 更新：Vue + Tailwind · 插件兼容统一 · 前后端分离

## 目标

将 pi 部署在服务端，通过手机/平板/任意浏览器进行 AI 辅助开发。保持林汐旗舰人格一致，扩展在 TUI 和 Web GUI 下行为无差异。

## 架构

```
┌──────────────────────────┐    ┌──────────────────────────────────┐
│  pi-web-gui (前端)        │    │  pi-webd (服务端)                 │
│  Vue 3 + Tailwind CSS    │◄──►│  pi-web sessiond                 │
│  Vite 构建 · 纯静态站     │    │  + ExtensionUIContext Proxy 扩展  │
│  可部署 CDN / 手机 PWA   │    │  (复用 pi-web 的 session 管理)    │
└──────────────────────────┘    └──────────────────────────────────┘
```

**决策：前端从零写，不复用 pi-web 的 Lit 组件。**

理由：Lit → Vue 迁移成本不比从零写低。Vue + Tailwind 生态更熟，组件库更丰富，代码量反而少。pi-web sessiond 的 API 已经是稳定的——直接消费它的 WebSocket + REST 接口。

---

## 插件兼容统一：TUI = GUI

### 现状审计

扩展中存在两类 TUI 守卫，导致切换到 Web GUI 后功能退化：

#### `ctx.mode !== "tui"` 直接退出（4 处）

| 文件 | 影响 |
|------|------|
| `external-editor-shortcuts.ts` | 外部编辑器快捷键失效 |
| `skill-kit/index.ts` | skill-kit GUI 模式不可用 |
| `ask-question/index.ts` | 交互式问答 UI 不可用 |
| `session-browse/index.ts` | 会话浏览器不可用 |

**修复**：`ctx.mode !== "tui"` → `!ctx.hasUI`。`hasUI` 才是正确的语义——“能不能显示 UI”。pi-web 的 sessiond 已经设 `hasUI = true`。

#### `ctx.hasUI` 检查通过、但底层 API 在 SDK 模式下退化（10+ 处）

| API | TUI 行为 | SDK 模式 | Web GUI 目标 |
|-----|---------|---------|-------------|
| `ctx.ui.custom(factory)` | 渲染 TUI 组件 | 返回 undefined | → 通过对话框系统渲染 Web 面板 |
| `ctx.ui.setWidget(key, lines)` | 编辑器上方/下方挂件 | no-op | → 前端 widget zone |
| `ctx.ui.setEditorComponent(factory)` | 替换编辑器 | no-op | → PromptEditor 扩展点 |
| `ctx.ui.setStatus(key, text)` | footer 状态行 | Fire-and-forget | ✅ 已可用 |
| `ctx.ui.confirm/select/input` | TUI 对话框 | RPC 协议 | ✅ pi-web 已有 |
| `ctx.ui.notify` | TUI 通知 | Fire-and-forget | ✅ 已可用 |
| `ctx.ui.setWorkingIndicator` | 工作指示器 | no-op | → 前端 loading 状态 |

### 统一方案

pi-web 的 `PiSessionService` 已经用 Proxy 包裹 `ExtensionUIContext`，拦截 `confirm/select/input/notify`。扩展这个 Proxy，覆盖全部退化 API：

```
扩展调用 ctx.ui.custom(factory)
  → Proxy 拦截
  → 识别调用来自 pi-web 上下文
  → PendingExtensionDialogStore.open({ kind: "custom", payload })
  → WebSocket → 浏览器渲染面板
  → 用户操作 → WebSocket answer → Promise resolve
```

`setWidget`、`setEditorComponent`、`setWorkingIndicator` 同理——转为 WebSocket 消息，前端按类型渲染。

**扩展代码零改动**（除了 4 处 `ctx.mode !== "tui"` 语义修正）。

---

## 技术选型

| 层 | 选型 | 理由 |
|----|------|------|
| 前端框架 | Vue 3 (Composition API) | 用户熟悉 + 生态成熟 |
| CSS | Tailwind CSS 4 | 减少 CSS 代码量 80%+ |
| Markdown | `marked` | GFM + breaks，跟 pi-web 同款 |
| Diff | `diff` | unified diff 解析 + 逐行着色 |
| 构建 | Rsbuild (`@rsbuild/core` + `@rsbuild/plugin-vue`) | 与现有 Electron GUI 统一工具链；Rspack 内核，生产构建快 |
| PWA | `@rsbuild/plugin-pwa` 或手动 manifest | 手机添加到主屏幕 |
| 后端 | pi-web sessiond（复用） | 已有 pi agent 生命周期 + 会话管理 |

可选 SCSS 补充 Tailwind 覆盖不到的场景（代码块样式等）。

---

## 路线

```
Phase 1              Phase 2                   Phase 3
Vue 前端MVP          移植 6 个 Electron GUI     TUI/GUI 完全统一
+ Proxy API 扩展      + 4 处扩展语义修正         (持续)
(4-5天)               (按优先级逐个)
```

---

## Phase 1：Vue 前端 MVP + Proxy API 扩展

### 1.1 Vue 前端（新项目）

组件清单：

| 组件 | 说明 | 估量 |
|------|------|------|
| `App.vue` | 布局：chat 区 + status bar | ~30行 |
| `ChatView.vue` | WebSocket 流式消息列表 | ~150行 |
| `MessageBubble.vue` | 单条消息（user/assistant 样式） | ~60行 |
| `MarkdownRenderer.vue` | `marked` 渲染 + 代码块复制按钮 | ~50行 |
| `ToolExecutionCard.vue` | 工具调用/结果卡片 + diff | ~120行 |
| `DiffViewer.vue` | unified diff 逐行着色 | ~80行 |
| `PromptEditor.vue` | 输入框 + 模型选择器 | ~100行 |
| `StatusBar.vue` | token 统计 + agent 名右对齐 | ~50行 |
| `ExtensionDialogCard.vue` | 扩展对话框/面板（Phase 2 底座） | ~80行 |

Composables：

| Composable | 说明 |
|------------|------|
| `useSession` | 会话 CRUD、WebSocket 连接管理 |
| `useChat` | 消息流处理、text_delta 拼接 |
| `useModel` | 模型列表、切换 |
| `useStatus` | 状态栏数据（token、context、cost） |
| `useExtensionDialogs` | 扩展 UI 事件处理（Phase 2 核心） |

总计估计：~20 文件，~1500 行 Vue SFC + ~300 行 composables。Tailwind 免除大量 CSS。

包管理器：全程 pnpm。pi-web fork 的 monorepo 也改为 pnpm workspace。

构建工具链：Rsbuild（`@rsbuild/core` + `@rsbuild/plugin-vue`）。现有 Electron GUI 全用这套，统一后 Phase 2 的 Vue dist 可直接复用，不用维护两套构建配置。Tailwind 通过 PostCSS 插件接入（rsbuild 内置 PostCSS 支持，`tailwindcss` + `@tailwindcss/postcss`）。

### 1.2 Proxy API 扩展（改动 pi-web sessiond）

在 `piSessionService.ts` 的 Proxy 中新增拦截：

- `ctx.ui.custom(factory)` → 提取数据 → `openExtensionDialog({ kind: "custom", payload })`
- `ctx.ui.setWidget(key, lines)` → WebSocket `widget.changed` 事件 → 前端渲染
- `ctx.ui.setEditorComponent(factory)` → WebSocket → 前端 PromptEditor 扩展
- `ctx.ui.setWorkingIndicator(opts)` → WebSocket → 前端 loading 状态
- `ctx.ui.setFooter(factory)` → WebSocket → 前端 StatusBar 自定义

`shared/apiTypes.ts` 扩展 `ExtensionDialogKind` 加 `"custom"`。总改动 ~50 行。

### 1.3 扩展语义修正（4 处）

```
external-editor-shortcuts.ts  ctx.mode !== "tui" → !ctx.hasUI
skill-kit/index.ts            ctx.mode !== "tui" → !ctx.hasUI
ask-question/index.ts         ctx.mode !== "tui" → !ctx.hasUI
session-browse/index.ts       同上（2 处）
```

### Phase 1 产出

- 手机打开 `https://pi.your-server.com` → 聊天 + Markdown + Diff + 状态栏
- 状态栏右下角「林汐」
- 扩展的 `confirm/select/input/notify/setStatus` 全部可用
- `custom/setWidget/setEditorComponent` 在 Proxy 层有 web 实现

---

## Phase 2：移植 Electron GUI + 修复所有扩展

### 2.1 扩展对话框系统 → GUI 面板

```
ExtensionDialogKind 加 "custom"
  → payload: { panel: "todo" | "permission-gate" | "queue-config" | ..., data: {...} }
  → 前端按 payload.panel 分发到对应 Vue 组件
  → 复用现有 Electron GUI 的 Vue 源码（dist/ 不变）
```

### 2.2 面板优先级

| # | GUI | 优先级 | 原触发 |
|---|-----|--------|--------|
| 1 | `permission-gate/gui` | **P0** | 自动拦截 |
| 2 | `trident-routing/gui` | **P0** | `/gui:scan-todo` |
| 3 | `editor-gui` | P1 | `/prompt-edit-gui` |
| 4 | `trident-queue/gui` | P1 | 路由配置 |
| 5 | `trident-queue/gui-manager` | P2 | 队列管理 |
| 6 | `trident-queue/gui-review` | P2 | 队列审查 |

### 2.3 其余扩展的 GUI 适配

| 扩展 | TUI API | Web 等效 |
|------|---------|----------|
| `plan-mode` | `setWidget` | Phase 1 widget zone |
| `goal` | `setWidget` | Phase 1 widget zone |
| `trident-queue` | `setWidget` + 队列卡片 | Phase 1 widget zone |
| `stream-monitor` | `custom` + `setWorkingIndicator` | Phase 1 Proxy |
| `editor-margin` | `setEditorComponent` | Phase 1 PromptEditor 扩展 |
| `for-grok-4-5` | `hasUI` 分支（通知、进度） | `hasUI=true` → 自动走 WebSocket |
| `confirm-destructive` | `hasUI` 守卫 | 已适配 |
| `session-browse` | `custom` | Phase 1 Proxy |

### Phase 2 完成标准

- 6 个 Electron GUI 全在浏览器内可用
- 所有扩展的 TUI API 调用在 Web 模式下有等效行为
- 手机上权限审计、TODO 调度可触屏操作

---

## Phase 3：TUI/GUI 完全统一

- 验证所有扩展从 TUI 切到 GUI 功能一致
- `ctx.ui.custom` 在两种模式下调用方式统一（可能是 pi 上游改动）
- TUI 专有 API 在 GUI 下优雅退化
- 持续发现和填补差距

---

## 手机使用场景

```
服务器跑 pi-webd（NAS / 云服务器）
  │  Tailscale / Cloudflare Tunnel / Nginx
  │
  ▼
手机浏览器 → 前端静态站 → WebSocket → pi-webd → pi agent
PWA 添加到主屏幕
```

---

## 关键风险

| 风险 | 缓解 |
|------|------|
| pi-web sessiond API 不稳定 | 以 `shared/apiTypes.ts` 为契约，前端只依赖这些类型 |
| Vue 前端重建 ChatView 工作量 | ChatView 核心只是 WebSocket + 消息列表，不复杂 |
| `ctx.ui.custom` 签名兼容 | Proxy 拦截 + `"custom"` dialog kind 已覆盖 |
| pi-web 上游更新 | sessiond 只读不改（除 Proxy 扩展），前端完全独立 |

---

## 下一步

1. 初始化 Rsbuild + Vue 3 + Tailwind 项目骨架（参考现有 `gui/rsbuild.config.ts` 模式）
2. 实现 `useSession` + `useChat` composable（WebSocket 连接 pi-webd）
3. 实现 `ChatView` + `MarkdownRenderer` → 完成「能聊天」
4. pi-webd Proxy 扩展（`custom` / `setWidget` / `setEditorComponent`）
5. 修复 4 处 `ctx.mode !== "tui"` 语义
6. Phase 2 P0（permission-gate + todo GUI）
