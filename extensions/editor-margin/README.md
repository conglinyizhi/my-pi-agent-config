# editor-margin

## 功能概述

带边框和左右边距的输入编辑器。自定义 Pi TUI 的编辑区域渲染，在输入框周围添加圆角边框和可配置的边距。

## 视觉效果

```
左边距   ╭───────────────╮   右边距
空白区域  │  输入内容...  │  空白区域
空白区域  ╰───────────────╯  空白区域
```

## 实现

- 继承 `CustomEditor` 基类，覆写 `render(width)` 方法
- 从 `settings.json` 读取 `editorMargin` 字段（默认 2）
- 处理顶部 ╭─╮、底部 ╰─╯、中间 │content│ 的渲染
- 兼容自动补全行、内容截断

## 事件钩子

- `session_start` — 通过 `ctx.ui.setEditorComponent()` 替换默认编辑器

## 依赖

- `@earendil-works/pi-coding-agent` — CustomEditor, ExtensionAPI
- `@earendil-works/pi-tui` — truncateToWidth, visibleWidth
