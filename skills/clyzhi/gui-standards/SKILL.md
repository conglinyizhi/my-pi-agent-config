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
│   ├── index.html      ← 含 CSP 标签，从现有 GUI 复制
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

```html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, "Microsoft YaHei", monospace; }
</style>
</head>
<body>
<div id="app"></div>
</body>
</html>
```

CSP 说明：`default-src 'self'` 只允许加载本地资源，`style-src 'unsafe-inline'` 是 Vue scoped 样式必须的。纯本地 Electron 窗口无远程内容，消除 Electron 安全警告即可。

## 注意事项

- 改 `renderer/` 或 `app.ts` 后需重新构建
- 新 GUI 复制现有 `rsbuild.config.ts` 即可
- `#lib/gui-kit.mjs` 不要直接修改——所有 GUI 共享
