# 林汐 Web GUI 计划书

> 状态：草案 | 日期：2025-07-30 | 工具链：Vite+

## 目标

将 pi 部署在服务端，通过手机/平板/任意浏览器进行 AI 辅助开发。保持林汐旗舰人格一致，扩展在 TUI 和 Web GUI 下行为无差异。

## 架构

```
┌──────────────────────────┐    ┌──────────────────────────────────┐
│  pi-web-gui (前端)        │    │  pi-webd (服务端)                 │
│  Vue 3 + Tailwind CSS    │◄──►│  pi-web sessiond                 │
│  Vite+ 构建 · 纯静态站    │    │  + ExtensionUIContext Proxy 扩展  │
│  可部署 CDN / 手机 PWA   │    │  (复用 pi-web 的 session 管理)    │
└──────────────────────────┘    └──────────────────────────────────┘
```

**决策：Vue 前端从零写，Vite+ 统筹全工具链。**

理由：
- Vite+ 内置 Vite + Rolldown（Rust 打包，Rollup 插件兼容）+ Vitest + Oxlint/Oxfmt
- Vue 核心团队同源（VoidZero），SFC 编译、HMR 优化均为原生支持
- `vp env` 管 Node 版本、`vp run` 管 monorepo 任务、`vp pack` 可打包独立二进制
- pi-web sessiond API 已稳定——直接消费其 WebSocket + REST 接口

---

## 工具链

| 层 | 选型 | 说明 |
|----|------|------|
| 前端框架 | Vue 3 (Composition API) | SFC + `<script setup>` |
| CSS | Tailwind CSS 4 | 减少 CSS 代码量 80%+ |
| Markdown | `marked` | GFM + breaks |
| Diff | `diff` | unified diff 解析 + 逐行着色 |
| 构建 | Vite+ (`vp dev` / `vp build`) | Vite + Rolldown 内核 |
| 测试 | Vitest（Vite+ 内置） | `vp test` |
| Lint/Format | Oxlint + Oxfmt（Vite+ 内置） | `vp check` |
| PWA | `vite-plugin-pwa` | 手机添加到主屏幕 |
| 包管理 | pnpm | Vite+ `vp install` 自动识别 |
| 后端 | pi-web sessiond（复用） | pi agent 生命周期 + 会话管理 |

## 插件兼容统一：TUI = GUI

### 现状审计

#### `ctx.mode !== "tui"` 直接退出（4 处·5 行）

| 文件 | 修复 |
|------|------|
| `external-editor-shortcuts.ts` | `ctx.mode !== "tui"` → `!ctx.hasUI` |
| `skill-kit/index.ts` | `ctx.mode !== "tui"` → `!ctx.hasUI` |
| `ask-question/index.ts` | `ctx.mode !== "tui"` → `!ctx.hasUI` |
| `session-browse/index.ts` | 同上（2 处） |

#### SDK 模式下退化的 API（pi-web Proxy 扩展）

| API | TUI | SDK 默认 | Web GUI 目标 |
|-----|-----|---------|-------------|
| `ctx.ui.custom(factory)` | 渲染 TUI 组件 | 返回 undefined | 对话框系统 → Web 面板 |
| `ctx.ui.setWidget(key, lines)` | 编辑器挂件 | no-op | 前端 widget zone |
| `ctx.ui.setEditorComponent(f)` | 替换编辑器 | no-op | PromptEditor 扩展点 |
| `ctx.ui.setWorkingIndicator(o)` | 工作指示器 | no-op | 前端 loading |
| `ctx.ui.setFooter(f)` | 替换 footer | no-op | StatusBar 自定义 |
| `ctx.ui.confirm/select/input` | 对话框 | RPC 协议 | ✅ 已有 |
| `ctx.ui.setStatus` | 状态行 | Fire-and-forget | ✅ 已有 |
| `ctx.ui.notify` | 通知 | Fire-and-forget | ✅ 已有 |

### 统一方案

pi-web 的 `PiSessionService` 已用 Proxy 包裹 `ExtensionUIContext`，拦截了 `confirm/select/input/notify`。扩展此 Proxy，覆盖全部退化 API：

- `custom(factory)` → 提取数据 → `PendingExtensionDialogStore.open({ kind: "custom", payload })` → WebSocket → 浏览器渲染 → answer → Promise resolve
- `setWidget` / `setEditorComponent` / `setWorkingIndicator` / `setFooter` → WebSocket 事件 → 前端对应区域渲染

`shared/apiTypes.ts` 中 `ExtensionDialogKind` 加 `"custom"`。改动 ~50 行。

**扩展代码零改动**（除 4 处语义修正）。

---

## 路线

```
Phase 1              Phase 2                   Phase 3
Vue 前端MVP          移植 6 个 Electron GUI     TUI/GUI 完全统一
+ Proxy API 扩展      + 扩展语义修正             (持续)
(4-5天)               (按优先级逐个)
```

---

## Phase 1：Vue 前端 MVP + Proxy API 扩展

### 1.1 项目初始化

```bash
# 全局装 Vite+
curl -fsSL https://vite.plus | bash

# 或项目依赖
pnpm add -D vite-plus @voidzero-dev/vite-plus-core

# 初始化
vp create vue . -- --template tailwind
pnpm add marked diff vite-plugin-pwa
```

`vite.config.ts` 骨架：

```ts
import { defineConfig } from 'vite-plus'
import vue from '@vitejs/plugin-vue'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  plugins: [vue(), VitePWA({ /* ... */ })],
  server: { proxy: { '/api': 'http://127.0.0.1:8504' } }
})
```

### 1.2 前端组件

| 组件 | 说明 | 估量 |
|------|------|------|
| `App.vue` | 布局骨架 | ~30行 |
| `ChatView.vue` | WebSocket 流式消息列表 | ~150行 |
| `MessageBubble.vue` | 单条消息渲染 | ~60行 |
| `MarkdownRenderer.vue` | `marked` + 代码块复制 | ~50行 |
| `ToolExecutionCard.vue` | 工具调用 + diff 内嵌 | ~120行 |
| `DiffViewer.vue` | unified diff 逐行着色 | ~80行 |
| `PromptEditor.vue` | 输入框 + 模型选择 | ~100行 |
| `StatusBar.vue` | token 统计 + 右对齐「林汐」 | ~50行 |
| `ExtensionDialogCard.vue` | Phase 2 面板底座 | ~80行 |

Composables：

| Composable | 说明 |
|------------|------|
| `useSession` | 会话 CRUD、WebSocket 连接管理 |
| `useChat` | 消息流处理、text_delta 拼接 |
| `useModel` | 模型列表、切换 |
| `useStatus` | 状态栏数据（token、context、cost） |
| `useExtensionDialogs` | 扩展 UI 事件处理（Phase 2 核心） |

总计：~20 文件，~1500 行 SFC + ~300 行 composables。Tailwind 免除大量 CSS。

### 1.3 StatusBar 核心产出

```
↑1.2k ↓0.5k 45%/200k $0.012       林汐 · claude-sonnet-4-20250514
```

左：统计 | 右：`getExtensionStatuses().get("trident")` → 林汐 / 母港 + 模型名

### 1.4 Proxy API 扩展（pi-web sessiond）

在 `PiSessionService` Proxy 中新增拦截：`custom`、`setWidget`、`setEditorComponent`、`setWorkingIndicator`、`setFooter`。

`shared/apiTypes.ts` 扩展 `ExtensionDialogKind` 加 `"custom"`。

### Phase 1 产出

- `vp dev` → `localhost:5173` 聊天 + Markdown + Diff + 状态栏
- 状态栏右下角「林汐」
- 扩展的 `confirm/select/input/notify/setStatus` 全部可用
- `custom/setWidget/setEditorComponent` 在 Proxy 层有 web 实现

---

## Phase 2：移植 Electron GUI + 修复所有扩展

### 2.1 Electron GUI → Web 面板

```
ExtensionDialogKind."custom"
  → payload: { panel: "todo" | "permission-gate" | "queue-config" | ..., data: {...} }
  → 前端 ExtensionDialogCard 按 payload.panel 分发到对应 Vue 组件
  → 复用现有 Electron GUI 的 Vue 源码
```

每个 GUI 的 `rsbuild.config.ts` → `vite.config.ts`（机械翻译，10 行以内）。Vue 源码不动。

### 2.2 优先级

| # | GUI | 优先级 | 触发方式 |
|---|-----|--------|---------|
| 1 | `permission-gate/gui` | **P0** | 自动拦截 |
| 2 | `trident-routing/gui` | **P0** | `/gui:scan-todo` |
| 3 | `editor-gui` | P1 | `/prompt-edit-gui` |
| 4 | `trident-queue/gui` | P1 | 路由配置 |
| 5 | `trident-queue/gui-manager` | P2 | 队列管理 |
| 6 | `trident-queue/gui-review` | P2 | 队列审查 |

### 2.3 其余扩展 GUI 适配

| 扩展 | TUI API | Web 等效 |
|------|---------|----------|
| `plan-mode` | `setWidget` | Phase 1 widget zone |
| `goal` | `setWidget` | Phase 1 widget zone |
| `trident-queue` | `setWidget` | Phase 1 widget zone |
| `stream-monitor` | `custom` + `setWorkingIndicator` | Phase 1 Proxy |
| `editor-margin` | `setEditorComponent` | Phase 1 PromptEditor 扩展 |
| `for-grok-4-5` | `hasUI` 分支 | `hasUI=true` → 自动走 WebSocket |
| `confirm-destructive` | `hasUI` 守卫 | 已适配 |
| `session-browse` | `custom` | Phase 1 Proxy |

### Phase 2 完成标准

- 6 个 Electron GUI 全在浏览器内可用
- 所有扩展的 TUI API 在 Web 模式下有等效行为
- 手机可触屏操作权限审计、TODO 调度
- Electron 进程不再需要

---

## Phase 3：TUI/GUI 完全统一

- 验证所有扩展从 TUI 切到 GUI 功能一致
- `ctx.ui.custom` 两种模式调用方式统一（可能随 pi 上游演进）
- 持续发现和填补差距

---

## 手机使用场景

```
服务器跑 pi-webd（NAS / 云服务器）
  │  Tailscale / Cloudflare Tunnel / Nginx
  │
  ▼
手机浏览器 → 前端静态站 → WebSocket → pi-webd → pi agent
PWA 添加到主屏幕 → 体验接近原生 App
```

---

## 关键风险

| 风险 | 缓解 |
|------|------|
| Vite+ 0.x 有 breaking change | 锁定版本；VoidZero 是正式公司，有 LTS 承诺 |
| Electron GUI rsbuild → vite 迁移 | 机械翻译，每个 10 行 |
| pi-web sessiond API 不稳定 | `shared/apiTypes.ts` 为契约，前端只依赖这些类型 |
| `ctx.ui.custom` 签名兼容 | Proxy 拦截 + `"custom"` dialog kind 已覆盖 |
| pi-web 上游更新 | sessiond 只读不改（除 Proxy 扩展），前端完全独立 |

---

## 下一步

1. `curl -fsSL https://vite.plus | bash` 装 Vite+
2. `vp create vue` 初始化项目 + Tailwind
3. 实现 `useSession` + `useChat`（WebSocket 连接 pi-webd）
4. `ChatView` + `MarkdownRenderer` → 能聊天
5. pi-webd Proxy 扩展（`custom` / `setWidget` / `setEditorComponent`）
6. 修复 4 处 `ctx.mode !== "tui"` 语义
7. Phase 2 P0（permission-gate + todo GUI）
