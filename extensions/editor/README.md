# editor — 编辑器相关能力四合一

把四个原本独立的编辑器扩展合并为一个（合成入口 `index.ts`，真融合为单一扩展）：
外部编辑器打开、Wails GUI 编辑器、圆角输入框、Ctrl+C 历史保存。

## 子模块

| 文件 | 能力 | 注册 |
|------|------|------|
| `editor-gui.ts` | `/prompt-edit-gui` Wails GUI 编辑器，读历史队列 `~/.pi/agent/queue/cliphist.json` | `registerCommand` |
| `editor-margin.ts` | 圆角边框 + 可配边距的输入编辑器 | `session_start` → `setEditorComponent` |
| `ctrl-c-safety.ts` | Ctrl+C 保存当前输入到历史队列（editor-gui 读取） | `registerShortcut` |
| `external-editor-shortcuts.ts` | Ctrl+O 打开工作目录、`/open-editor` 打开文件/目录 | `registerShortcut` + `registerCommand` |

依赖：`lib/gui-runner`（editor-gui 的 Wails 启动器）。

## editor-margin 详情

带边框和左右边距的输入编辑器。自定义 Pi TUI 的编辑区域渲染，在输入框周围添加圆角边框和可配置的边距。

### 视觉效果

```
左边距   ╭───────────────╮   右边距
空白区域  │  输入内容...  │  空白区域
空白区域  ╰───────────────╯  空白区域
```

### 实现

- 继承 `CustomEditor` 基类，覆写 `render(width)` 方法
- 从 `settings.json` 读取 `editorMargin` 字段（默认 2）
- 处理顶部 ╭─╮、底部 ╰─╯、中间 │content│ 的渲染
- 兼容自动补全行、内容截断

### 事件钩子

- `session_start` — 通过 `ctx.ui.setEditorComponent()` 替换默认编辑器

### 依赖

- `@earendil-works/pi-coding-agent` — CustomEditor, ExtensionAPI
- `@earendil-works/pi-tui` — truncateToWidth, visibleWidth
