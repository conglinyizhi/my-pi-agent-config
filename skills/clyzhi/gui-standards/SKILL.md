---
name: gui-standards
description: pi 扩展 GUI 开发规范——gui-kit 骨架 + 目录结构 + 构建流水线
---

# GUI 开发规范

## 架构

所有 Electron GUI 使用统一骨架：

- `#lib/gui-kit.mjs` — 主进程模板代码
- `renderer/App.vue` — 界面逻辑（Vue 3）
- esbuild 编译 `app.ts` → `app.js`
- rsbuild 编译 `renderer/` → `dist/`

## 目录结构

```
extensions/<name>/gui/
├── app.ts              ← createGuiApp() 配置
├── renderer/
│   ├── index.html      ← 通常不动
│   ├── index.ts        ← Vue 入口
│   └── App.vue         ← 主组件
├── rsbuild.config.ts   ← 从已有 GUI 复制
└── dist/               ← gitignore
```

## app.ts 模板

```typescript
import { createGuiApp } from "#lib/gui-kit";
createGuiApp({
  name: "窗口标题",
  inject: (request, { responseFile }) => ({ ...request, responseFile }),
});
```

## 构建

```bash
pnpm build:gui-<name>   # 一次完成 esbuild + rsbuild
```

已有：
- `build:gui-editor` — editor-gui
- `build:gui-gate` — permission-gate
- `build:gui-setup` — trident-queue

## 通信

- 主进程注入 `window.__INIT_DATA__`
- Vue 组件读 `window.__INIT_DATA__`
- 响应：`fs.writeFileSync(responseFile, JSON.stringify(...))` + `window.close()`

## 注意事项

- 改 `renderer/` 或 `app.ts` 后需重新构建
- 新 GUI 复制现有 `rsbuild.config.ts` 即可
- `#lib/gui-kit.mjs` 不要直接修改——所有 GUI 共享
