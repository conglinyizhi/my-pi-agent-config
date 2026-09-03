---
name: gui-standards
description: pi 扩展 GUI 开发规范——Wails 单二进制 + windowName 路由 + 文件 JSON 协议（2026 迁移后）
disable-model-invocation: true
---

# GUI 开发规范（Wails）

## 架构

所有 GUI 窗口由**单一 Wails 二进制** `wails-gui` 提供（Go + WebKitGTK 4.1，Vue 3 前端）。
2026 年已从 Electron 全量迁移（6 个窗口），旧 Electron 链（gui-kit.mjs / rsbuild / esbuild / build:gui-*）已删除。

- `wails-gui/main.go` — 窗口配置表（windowName → 标题 / 尺寸）
- `wails-gui/app.go` — Go 侧方法：`GetInitData`（按窗口分支）/ `GetWindowName` / `SaveResponse` / `MarkReady` / `OpenFile` / `LoadReasons` / `SaveReason`
- `wails-gui/frontend/src/main.js` — 窗口路由壳（windowName → 视图）+ 全局错误兜底
- `wails-gui/frontend/src/views/*.vue` — 6 个窗口视图
- extension 侧用 `lib/gui-runner.ts` 启动窗口（替代 Electron spawn + 轮询）

## 目录结构

```
wails-gui/
├── main.go                ← 窗口配置（windowName / 标题 / 尺寸）
├── app.go                 ← GetInitData（按窗口分支）/ SaveResponse / MarkReady / OpenFile
└── frontend/
    ├── index.html         ← body 必须 margin:0（防 WebKitGTK 白边）
    └── src/
        ├── main.js        ← 窗口路由壳 + window error 兜底（防白板）
        ├── gui-theme.css  ← 共享样式（顶部有全局 box-sizing:border-box）
        └── views/         ← 5 个窗口视图
lib/gui-runner.ts          ← extension 侧统一启动器（findGuiBinary + runGuiWindow）
```

## 窗口名映射

| windowName | 视图 | 调用方 |
|---|---|---|
| setup | SetupView | extensions/trident-subagent（/gui:trident-setup）|
| subagents | SubagentsView | extensions/trident-subagent（/gui:subagents）|
| routing | RoutingView | extensions/trident-routing |
| gate | GateView | extensions/sandbox-permissions（gate/allow） |
| editor | EditorView | extensions/editor |

## extension 侧调用

```typescript
import { findGuiBinary, runGuiWindow } from "../../lib/gui-runner";

if (!findGuiBinary()) {
  ctx.ui.notify("未找到 wails-gui，请先构建", "error");
  return;
}
const result = await runGuiWindow("gate", { command, taskId, rules }, { timeoutMs: 120_000, signal });
// result = { ok, data?, reason?: "timeout" | "aborted" | "exited" | "unavailable" }
// ok=false 时按 reason 区分语义：aborted/unavailable → 回退 TUI；timeout/exited → 视为取消
```

## 构建

```bash
cd ~/.pi/agent/wails-gui
wails build -tags webkit2_41
# 必带 -tags webkit2_41：Arch 上 webkit2gtk-4.0 的 libjxl.so 依赖已断，4.1 匹配 libjxl 0.12
# 漏了 -tags 会链接失败，报错特征：libwebkit2gtk-4.0.so undefined reference to Jxl*（JXL_0 符号）
# 修改 frontend/src/** 后必须重新 wails build（二进制内嵌前端资源，不重建则跑旧 UI）；
# 只改 extension 侧（lib/gui-runner.ts 等）无需重建
# 产物：wails-gui/build/bin/wails-gui（约 8.8MB，启动 ~288ms）
```

## 测试

```bash
pnpm test:gui   # node scripts/gui-fasttest.ts —— 并行启动 6 窗口，等 .ready/.error sidecar 判定渲染就绪
```

## 协议（文件 JSON，沿用 Electron 时代设计）

1. extension 写 `request.json` 到临时目录
2. `spawn(wails-gui, [windowName, requestFile, responseFile])`
3. 前端 `GetInitData()` 读 request → 用户操作 → `SaveResponse()` 写 response
4. extension 300ms 轮询 response 文件（helper 已封装）

## 新增窗口步骤

1. `main.go` 窗口配置表加一行（windowName / 标题 / 尺寸）
2. `frontend/src/views/` 新建视图 + `main.js` 的 views 对象注册
3. `app.go` 的 `GetInitData()` 加窗口分支
4. extension 用 `runGuiWindow(newName, req, opts)` 调用
5. `scripts/gui-fasttest.ts` 加测试项

## WebKitGTK 已知坑

- 前端 `select` 需 `appearance:none` 才吃 CSS 背景
- index.html body 必须 `margin:0`（防白边）
- 全局 `box-sizing:border-box` 在 gui-theme.css 顶部
- IME（fcitx5）需 `gtk_im_module=fcitx` 环境变量（已实测可用）
- 启动首帧冷缓存 ~466ms，热缓存稳定 ~285ms
