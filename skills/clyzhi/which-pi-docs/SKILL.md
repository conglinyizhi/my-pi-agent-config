---
name: which-pi-docs
description: 查询 pi 的文档和源码所在位置；包含 pi 插件开发规范（扩展文件布局与加载范围、不要破坏 KV 缓存命中）。创建或修改 pi 扩展/插件前必读本技能。
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

## 扩展的文件布局（先看这一节，错了 pi 直接起不来）

pi 的扩展发现范围：

| 位置 | 会被当扩展加载？ |
|---|---|
| `extensions/*.ts`、`extensions/*.js` | **会**。根目录下的每个 `.ts` / `.js` 都是一个扩展入口 |
| `extensions/*.mjs` | 不会 |
| `extensions/<名字>/index.ts`、`index.js` | **会**。子目录只认这两个文件名 |
| `extensions/<名字>/` 下的其它文件 | 不会。它们只是普通模块，由 index 去 import |
| `<cwd>/.pi/extensions/`、settings.json 的 `extensions` 数组、`pi --extension <文件>` | 会 |

**本仓库真实踩过的坑**：把测试写成 `extensions/foo.test.ts`（放在根下），pi 启动时把它当扩展加载，它不导出 factory，于是启动失败：

```
Error: Failed to load extension ".../extensions/foo.test.ts":
Extension does not export a valid factory function
Hint: Start without extensions using "pi -ne".
```

同样的道理，根下的**任何**辅助模块（常量表、类型、工具函数）都会被当扩展加载一次，所以不要往 `extensions/` 根目录丢非扩展文件。

**约定**：

- 一个扩展要么是根下的单文件，要么是一个目录（入口 `index.ts`）
- 扩展自己的测试、fixture、内部模块，放**它自己的目录里**：`extensions/<名字>/index.test.ts` 是安全的（入口只有 index）
- 新建单文件扩展若要配套测试，从一开始就建成目录（`extensions/<名字>/index.ts` + `index.test.ts`），不要写成根下的 `foo.test.ts`
- `.mjs` 不在加载范围内（仓库里的 `task-notification.test.mjs` 就是这么活下来的），但那是恰好，新文件优先放子目录
- 扩展内部的辅助模块也可以放 `lib/`（与扩展同享），但那属于公共模块，别只为一个扩展往里丢

**自检**（改完扩展、启动 pi 之前跑一遍）：

```bash
cd ~/.pi/agent && for f in extensions/*.ts; do
  grep -q "export default function" "$f" || echo "✗ $f 没有 factory，会被当扩展加载而报错"
done
```

新增或改动扩展后要 `/reload` 才会加载；`pi --extension <文件>` 用于临时调试单个扩展；`pi -ne` 可以不带扩展启动，用来区分“pi 本身起不来”还是“某个扩展把它带崩了”。

## 插件开发规范（写扩展前必读）

编写 pi 扩展时，同时遵循两条准则：

1. **API 只用 pi 官方扩展 API**：`registerTool` / `registerCommand` /
   `pi.on(事件)` / `appendEntry` / `sendMessage` / `ctx.ui`，参考
   `<PI_PKG>/docs/extensions.md` 与 `<PI_PKG>/examples/extensions/`。
2. **参考仓库已有扩展的写法**：`extensions/prompt-sections`、
   `extensions/dsh-goal`、`extensions/dsh-jobs`、`extensions/dsh-tools`：
   - 状态用 `appendEntry` 写会话（不进 LLM 上下文），恢复时折叠
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

**配方一句话**：按 pi 官方规范写 API，按"稳定前缀 + 动态消息尾部"组织提示词。
