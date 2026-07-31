---
name: gui-standards
description: pi 扩展 GUI 开发规范——gui-kit 骨架 + 目录结构 + 构建流水线
---

# GUI 开发规范

## 架构

所有 Electron GUI 使用统一骨架：

- `#lib/gui-kit.mjs` — 主进程模板代码
- `renderer/App.vue` — 界面逻辑（Vue 3）
- esbuild 编译 `app.ts` → `app.mjs`（**必须 .mjs**：输出是 ESM，Electron 43 对 `.js` 扩展名的 ESM 加载会静默崩溃）
- rsbuild 编译 `renderer/` → `dist/`

## 目录结构

```
extensions/<name>/gui/
├── app.ts              ← createGuiApp() 配置
├── renderer/
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

## 共享样式

所有 GUI 在 `<script setup>` 开头引入：

```typescript
import "../../../../lib/gui-theme.css";
```

`lib/gui-theme.css` 定义了基础暗色主题变量和组件类：
- `.btn` / `.btn-deny` / `.btn-warn` / `.btn-allow` / `.btn-cancel` — 按钮
- `.overlay` — 覆盖层（弹层遮罩）
- `.dialog` — 对话框容器
- `.actions` / `.count` — 页脚操作栏
- `.collapse-header` / `.collapse-body` — 折叠面板

不要在每个 GUI 里重复定义这些基础样式。只需添加 GUI 特有的样式即可。

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

## index.html 模板

所有 GUI 共享 `lib/gui-index.html`。rsbuild 配置中通过 `html.template` 指向它：

```typescript
html: {
  template: "../../../lib/gui-index.html",
  title: "窗口标题",
},
```

模板内容统一维护，包含 CSP 标签消除 Electron 安全警告。新 GUI 无需创建自己的 `index.html`。

## 注意事项

- 改 `renderer/` 或 `app.ts` 后需重新构建
- 新 GUI 复制现有 `rsbuild.config.ts` 即可
- `#lib/gui-kit.mjs` 不要直接修改——所有 GUI 共享
