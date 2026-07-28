---
name: gui-kit
description: GUI 构建骨架——gui-kit.mjs + Vue + rsbuild + esbuild 模式
---

# GUI Kit

所有 Electron GUI 使用统一骨架：`#lib/gui-kit.mjs` 处理主进程模板代码，`renderer/` 目录放 Vue 组件，esbuild + rsbuild 编译。

## 目录结构

```
extensions/*/gui/
├── app.ts              ← 用 createGuiApp() 配置窗口 + 数据注入
├── renderer/
│   ├── index.html      ← HTML 模板（通常不动）
│   ├── index.ts        ← Vue 入口（createApp(App).mount('#app')）
│   └── App.vue         ← 主组件（写界面逻辑）
├── rsbuild.config.ts   ← 构建配置（复制模板）
└── dist/               ← 产物（gitignore）
```

## app.ts 模板

```typescript
import { createGuiApp } from "#lib/gui-kit";

createGuiApp({
  name: "窗口标题",
  width: 1000,
  height: 700,
  requestFile: process.argv[2],
  responseFile: process.argv[3],
  inject: (request, { responseFile }) => ({
    // 注入到 window.__INIT_DATA__ 的数据
    ...request,
    responseFile,
  }),
});
```

## 构建

```
pnpm build:gui-<name>   # esbuild app.ts + rsbuild renderer
```

已有脚本：
- `build:gui-editor` — editor-gui
- `build:gui-gate` — permission-gate
- `build:gui-setup` — trident-queue

## 渲染进程通信

- 主进程注入 `window.__INIT_DATA__`（含 `responseFile` 路径）
- Vue 组件通过 `(window as any).__INIT_DATA__` 读取
- 响应：`fs.writeFileSync(responseFile, JSON.stringify({...}))` + `window.close()`

## 注意事项

- 每次改 `renderer/` 或 `app.ts` 后需要重新构建
- 新 GUI 按以上模板创建，`rsbuild.config.ts` 从已有 GUI 复制
- `#lib/gui-kit.mjs` 不要直接修改——所有 GUI 共享
