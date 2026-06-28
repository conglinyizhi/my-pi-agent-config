---
name: pi-docs
description: 指导智能体如何阅读pi自身的文档、SDK、扩展、主题、技能和TUI。仅当用户询问pi本身或其内置功能时使用。包括部分 Pi 扩展插件
---

# Pi 文档参考

当用户询问 pi 本身、其 SDK、扩展、主题、技能或 TUI 时，按以下步骤定位并阅读文档：

1. **定位 pi 包目录**
   - 运行 `which pi` 获取 wrapper 脚本路径。
   - 读取该 wrapper 脚本，找到包含 `node_modules/@earendil-works/pi-coding-agent/dist/cli.js` 的路径；该路径的上两级目录即为 pi 包根目录 `<PI_PKG>`。
   - 如果 `which pi` 不可用，可尝试 `command -v pi`。

2. **阅读对应文档**
   - 主文档：`<PI_PKG>/README.md`
   - 附加文档：`<PI_PKG>/docs/`
   - 示例：`<PI_PKG>/examples/`

3. **路径解析规则**
   - `docs/...` 在 `<PI_PKG>/docs` 下解析。
   - `examples/...` 在 `<PI_PKG>/examples` 下解析。
   - 不要把这些路径当作当前工作目录下的文件。

4. **按需阅读的主题映射**
   - 扩展 → `docs/extensions.md`、`examples/extensions/`
   - 主题 → `docs/themes.md`
   - 技能 → `docs/skills.md`
   - 提示模板 → `docs/prompt-templates.md`
   - TUI 组件 → `docs/tui.md`
   - 快捷键 → `docs/keybindings.md`
   - SDK 集成 → `docs/sdk.md`
   - 自定义 provider → `docs/custom-provider.md`
   - 添加模型 → `docs/models.md`
   - pi 包 → `docs/packages.md`

5. 完整阅读相关 `.md` 文件，并遵循其中的交叉引用（例如 TUI API 详情参阅 `tui.md`）。

## 非官方插件

- MCP 插件:https://github.com/nicobailon/pi-mcp-adapter/ 仓库下可参考的内容：`README.md`、`OAUTH.md`
