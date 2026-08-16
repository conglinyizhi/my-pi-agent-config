---
name: which-pi-docs
description: 用于查询 pi 的文档和源码的所在位置
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

## 插件开发规范（写扩展前必读）

编写 pi 扩展时，同时遵循两条准则：

1. **API 按 pi 官方规范**：扩展本体只用 pi 官方扩展 API
   （`registerTool` / `registerCommand` / `pi.on(事件)` / `appendEntry` /
   `sendMessage` / `ctx.ui`），参考 `<PI_PKG>/docs/extensions.md` 与
   `<PI_PKG>/examples/extensions/`。DSH（DeepSeek Harness）的 cordis 插件形态
   在 pi 里无法加载，**不要照搬 DSH 的插件框架写法**。
2. **内部设计习惯借鉴 DSH**（我们移植扩展时的准则，已落地的例子：
   `extensions/prompt-sections`、`extensions/dsh-goal`、`extensions/dsh-jobs`、
   `extensions/dsh-tools`）：
   - 状态用 `appendEntry` 写会话（事件溯源，不进 LLM 上下文），恢复时折叠
   - 进程本地状态不持久化（重启后显式重建，不做"自动复活"）
   - last-wins 全量快照、CAS（ref + revision）防陈旧写

### KV 缓存命中规则（最重要）

系统提示词前缀是模型请求 KV 缓存命中的关键——**前缀的任何逐轮变化都会导致
缓存全失效**。写插件时必须遵守：

**会破坏缓存（禁止）**：
- 会话中途增删/激活/停用工具（`setActiveTools`、动态注册工具）——工具目录属于前缀
- `before_agent_start` 里每轮拼接变化的系统提示词
- 把动态内容（cwd/日期/模型名等）放在系统提示词头部
- 拦截/改写 provider 请求 payload（wire 层重写，如 pi-v4-anchor 的做法）
- 每轮变化 `promptGuidelines` / `promptSnippet`

**不破坏缓存（推荐做法）**：
- `appendEntry` 持久化状态（CustomEntry 不进 LLM 上下文）
- 工具描述（description/promptSnippet/promptGuidelines）写成编译期常量，一次性注册
- 需要给模型看的**动态内容**用 `sendMessage` / `sendUserMessage` 作为消息注入
  （放前缀之外），如 goal 的 `<goal_round>` 续行消息
- `ctx.ui` 交互、命令、文件操作与请求前缀无关，随意用
- 需要"给模型看"的**稳定指导文本**（策略/工具用法/规则）：
  - 若项目启用了 prompt-sections，注册为固定 order 的段
    （约定：-100 身份 / 0 默认 / 50 策略 / 100-199 工具指导 / 200+ 动态），
    让稳定文本固定在前缀里、动态变量解析后放尾部
  - 否则静态写入工具 `promptGuidelines`，不逐轮变化

**配方一句话**：按 pi 规范写 API、按 DSH 习惯设计状态、
按"稳定前缀 + 动态消息尾部"组织提示词。
