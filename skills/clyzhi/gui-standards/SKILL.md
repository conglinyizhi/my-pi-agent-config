---
name: gui-standards
description: pi 扩展 GUI 开发规范——Electron 宿主 + windowName 路由 + 文件 JSON 协议；加窗口、接平台能力、开 devtools、出问题往哪查
disable-model-invocation: true
---

# GUI 开发规范（Electron）

## 架构

所有 GUI 窗口由**同一个 Electron 宿主**提供，用系统装的 electron，没有编译步骤：

- `bin/gui` — 启动器壳脚本：`exec electron gui/electron/main.js <windowName> <requestFile> <responseFile>`
- `gui/electron/main.js` — 主进程：窗口配置表、IPC 处理、写响应文件
- `gui/electron/preload.cjs` — 渲染进程唯一的宿主接口（`window.piGui`）
- `gui/electron/init-data.js` — 窗口表与 `buildInitData`（请求 JSON → 前端结构）
- `gui/frontend/` — Vue 3 前端（产物 `dist/`）

协议与调用方无关：读 `request.json`，写 `<responseFile>.ready`（渲染就绪）与 `<responseFile>`（提交后退出）。
Go 侧（hub）与 TS 侧（`lib/gui-runner.ts`）共用这一套，所以换引擎不动调用方。

## 目录结构

```
gui/
├── electron/
│   ├── main.js          ← 窗口表 + IPC（getInitData / submit / markReady / openFile / copyText）
│   ├── preload.cjs      ← contextBridge 暴露 window.piGui（沙箱下 preload 不支持 ESM，用 .cjs）
│   └── init-data.js     ← 窗口配置与字段映射（测试：init-data.test.mjs）
└── frontend/            ← Vue 工程，与引擎无关
    ├── index.html
    └── src/
        ├── main.js      ← 平台选择 + 窗口路由壳 + 全局错误兜底
        ├── platform/    ← 平台接口与各宿主的 adapter（electron / browser / detect）
        ├── domain/      ← 不依赖 Vue、DOM、宿主的纯逻辑（node --test 直接测）
        ├── components/  ← 领域展示组件
        └── views/       ← 窗口页面编排
```

Wails 那一套（Go 宿主、旧二进制、当时的规范）已归档：`archive/wails-gui/` 与 `archive/gui-standards-wails/`。
归档不参与运行，也不再是候选位——要复活得先请回来并显式指路。

## 加一个窗口

1. `gui/electron/init-data.js` 的 `WINDOW_CONFIGS` 加一项（标题 / 尺寸 / 最小尺寸）
2. 同文件的 `buildInitData` 加分支：请求 JSON 的哪些字段铺给前端
3. `frontend/src/views/` 加视图，`frontend/src/main.js` 的 `views` 表登记 windowName
4. 调用方用 `lib/gui-runner.ts`：`runGuiWindow(name, request)`（等结果）或 `launchGuiWindow`（只拉起）
5. 测试：`init-data.test.mjs` 断字段映射；视图逻辑下沉到 `domain/` 并写 node --test 用例

## 平台能力的接法

视图只吃 `platform` 接口（`usePlatform()`），**不许**直接碰 `window.piGui`。加一项能力要动四处：

1. `gui/electron/preload.cjs` 暴露方法
2. `gui/electron/main.js` 注册 `ipcMain.handle("pi-gui:<name>")`
3. `frontend/src/platform/electron.js` 加同名方法
4. `frontend/src/platform/browser.js` 补桩（浏览器预览用）

一份 dist 同时服务 Electron 与其它宿主：`platform/detect.js` 按宿主注入的东西认（有 `piGui` 走 Electron）。

## 调试

- **F12 / Ctrl+Shift+I** 随时开 devtools；`PI_GUI_DEV=1` 启动即开（detached 窗口）
- 手动起一次看报错：`PI_GUI_DEV=1 bin/gui gate <请求.json> <响应.json>`
- 渲染进程崩溃会打 `render-process-gone`，Electron 自身日志走 stderr
- 受限环境（容器 / 沙箱）里 Chromium 需要 `/dev/shm`，起不来时报 "Failed to move to new namespace"，
  这种场合加 `PI_GUI_ELECTRON_ARGS=--no-sandbox`（正常桌面会话不需要）

## 构建与验证

- 前端：`cd gui/frontend && node_modules/.bin/vite build`。产物用 `file://` 直接加载，
  所以 vite 的 `base` 必须是 `./`（绝对路径在 file:// 下取不到资源）
- 前端纯逻辑：`node --test src/domain/**/*.test.js`、`node --test src/platform/electron.test.js`
- 宿主字段映射：`node --test gui/electron/init-data.test.mjs`
- 端到端：`scripts/gui-fasttest.ts`（拉起窗口并断言渲染就绪）

## 约定

- GUI 交互元素带语义化 `data-name`（配合用户脚本做元素定位）
- 窗口渲染前出错要落到 `#fatal-error` 错误条，别白板
- `getInitData` 失败必须显式报错，不静默给空数据

## 出问题先看哪里

1. 起不来：`guiBinaryCandidates()` 的两个候选位有没有可执行的 `bin/gui`；PATH 里有没有 `electron`
2. 白屏：`gui/frontend/dist/index.html` 是否构建过
3. 起得来但没反应：devtools 里看 `pi-gui:*` 的 IPC 有没有报错
4. 回退终端审批的原因与修复步骤：`lib/gui-diagnosis.ts` 会按真实缺项给命令（不看模板）
