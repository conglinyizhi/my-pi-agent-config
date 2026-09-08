# custom-providers

## 功能概述

管理自定义 AI 模型供应商。支持从 `~/.pi/agent/providers.toml` 加载供应商配置，自动检测 API 格式（OpenAI/Anthropic），拉取模型列表，并注册到 Pi 的模型选择系统。

## 提供的命令

### `/provider:fast-add`

快速添加自定义供应商。

- **有参**：`/provider:fast-add <URL> <API Key> [模型名...]`
  - 参数顺序任意，分隔符支持空格 / 逗号 / 分号
  - URL 与 API Key 必填；模型名可选（留空则从 API 自动拉取）
- **无参**：进入交互式引导，逐步填写 URL / Key / 模型名

### `/provider:fast-del` / `/provider:fast-remove`

删除自定义供应商，两个命令是同一功能的别名。

- **有参**：按供应商标识符、名称或地址进行大小写不敏感的包含匹配
- 匹配多个时展开 TUI 选择，避免模糊匹配误删
- 无参时展开全部供应商供选择
- 选中后需要二次确认，同时移除 `providers.toml` / `auth.json` 配置并注销运行时 provider

### `/provider:fast-edit`

交互式编辑供应商 / 模型配置，不用手改 `providers.toml`。

- **有参**：`/provider:fast-edit <供应商名>`，按标识符/名称/地址模糊匹配预筛选；无参时列出全部供应商
- **选择供应商后** 进入操作菜单：
  - `✏️ 编辑模型参数` —— 微调现有模型：上下文窗口、最大输出、价格（含缓存读写价）、推理开关、输入模态、CoT 回传、`cost_locked`、compat 等；菜单内还提供「删除此模型」
  - `➕ 新增模型` —— 在当前供应商下添加新模型，输入 ID 后同菜单逐个配置参数
  - `🔧 编辑供应商配置` —— 切换 API 格式（`openai-old` → `openai-new` → `anthropic` → `auto`）、改地址/名称、默认参数（`defaults.*`）、provider 级 CoT 回传与 compat
  - `💾 保存并退出` —— 写回 `providers.toml` 并自动重新加载；`❌ 放弃修改` 不写盘
- 所有修改先落在内存，统一保存；数字/文本字段预填当前值，输入 `clear` / `清除` 清空该字段（回退默认）
- 能列成选项的字段就不用敲：思考返回格式是 10 个格式的单选，输入模态是「文字 / 文字+图片 / 图片」三选一，API 格式、开关类字段、保护级别也全是选择
- 数字字段支持单位与千位分隔：`1M` / `512K` / `1.5M` / `100万`、`1_000_000`、`1,000,000` 都行，不带后缀时保留小数（价格用）；菜单里的大数字顺带标出 `1.0M` / `384K`
- 菜单里的字段名用白话中文（如「历史消息需带思考」「工具参数流式下发」），选中后对话框里会给出这个开关到底管什么、以及对应的 TOML 路径；布尔值显示为「开启 / 关闭」
- 菜单第一行是 `🛡 保护（reload-online 不覆盖 / 不删除）`。改过字段的模型与新增的模型会默认打开它并弹提示，挡住 `reload-online` 覆盖配置或删除模型；想放开就在这行选「不保护」。

### `/provider:fast-edit-with-copy`

复刻某个已有模型的配置到指定供应商，再微调——适合「微调数据的测试模型」这类只在母模型基础上改几个字段的场景。

- **用法**：`/provider:fast-edit-with-copy [目标供应商] [源模型] [新模型ID]`
  - 全空则逐步交互；单个参数命中供应商时当作目标，否则当作源模型关键词
  - 源模型可以是任意供应商下的模型（跨供应商复制），支持关键词过滤与 TUI 选择
- **复刻规则**：除 `id` / 名称 / `do_not` / `cost_locked` 外逐字段深拷贝（含 `compat`、`input`、价格、`cot_replay`、`thinking_level_map` 等）
  - 新模型 ID 必填且不能与目标供应商下已有模型重名；名称默认回退为新 ID，可在微调菜单里改
  - 复刻出的新模型会问要不要挡住 `reload-online`，默认 `do_not = ["remove", "update"]`（不覆盖配置、不删除模型）；源模型自带 `do_not` 时也可选完整继承
  - 源与目标供应商 `api` 格式不同时给出 compat 可能不适用的提示
- **微调**：确认后进入与 `/provider:fast-edit` 相同的字段菜单，改完选「↩ 返回」即写盘；也可选「直接保存」跳过
- 写盘后自动 reload，新模型立即可用

### 长列表选择（vim 式）

供应商 / 模型 / 字段这类可能很长的列表（选项超过 5 项且处于 TUI 模式）走 `lib/vim-select.ts` 的自绘选择器，其余短菜单仍用 pi 内置选择器。

| 按键 | 作用 |
| --- | --- |
| `数字` + `j` / `↓` | 下移 N 行（无数字时 1 行，到末尾停住） |
| `数字` + `k` / `↑` | 上移 N 行 |
| `/` | 进入模糊过滤；输入即筛，`Enter` 保留过滤退出，`Esc` 清空过滤退出 |
| `Backspace` / `Ctrl-U` | 过滤模式下删末字符 / 清空过滤词；正常模式下 `Backspace` 取消计数 |
| `Enter` / `Esc` | 选中 / 取消 |

过滤用模糊匹配并按匹配度排序（`dv4` 能命中 `deepseek-v4-flash`），空过滤词保持原顺序。

### `/provider:reload`

重新加载 `~/.pi/agent/providers.toml`，热更新已注册的供应商。

### 事件钩子

- **`model_select`** — 当用户选择 `auto-detect` 占位模型时触发，引导完成 API 格式检测和模型拉取

## 架构

### 文件结构

```
custom-providers/
├── index.ts                 # 主入口：命令注册、模型选择事件、加载逻辑
├── types.ts                 # 类型定义（RawProvider, ResolvedApiFormat）
├── loader.ts                # providers.toml 解析与验证
├── detector.ts              # API 格式自动检测（请求 /models 端点）
├── models.ts                # 模型列表解析（/models 端点）与格式映射
├── fast-add.ts              # /provider:fast-add 命令实现
├── fast-del.ts              # /provider:fast-del 和 /provider:fast-remove 命令实现
├── fast-edit.ts             # /provider:fast-edit 命令实现（交互式编辑供应商/模型）
├── fast-edit-with-copy.ts   # /provider:fast-edit-with-copy 命令实现（复刻模型并微调）
├── fast-edit-with-copy.test.ts  # 复刻逻辑测试
├── models-dev.ts            # 开发环境模型配置
├── models-dev-static.json   # 静态模型数据
├── loader.test.ts           # loader 测试
├── detector.test.ts         # detector 测试
├── models.test.ts           # models 测试
└── README.md                # 本文件
```

### 执行流程

1. **启动时**：`loadProvidersConfig()` 解析 providers.toml
2. **显式配置**：同时提供了 `api` 和 `models` → 直接注册
3. **自动检测**：缺少 `api` 或 `models` → 注册占位模型 `auto-detect`
4. **用户选择占位模型时**：触发 API 格式检测 → 拉取模型列表 → 替换占位注册
5. **首次检测后**：将检测结果写回 providers.toml（`lockApiFormat`）

### 关键设计

- **延迟激活**：不完全配置的供应商先注册占位模型，用户首次选择时才激活
- **格式自动检测**：请求 `/models` 端点，根据响应结构判断 OpenAI/Anthropic
- **配置持久化**：检测结果自动写回 providers.toml，下次启动直接使用
- **reload 安全**：reload 时清理旧注册，避免重复注册
- **隐藏模型保护**：模型覆盖项可设置 `do_not = ["remove", "update", "edit"]`。`remove` 防止 `reload-online` 因供应商不返回而删除模型；`update` 防止在线元数据覆盖本地配置；`edit` 防止 `/provider:fast-edit` 修改或删除模型。三个动作可单独或组合使用，未知动作会被忽略。
- **默认保护**：`/provider:fast-edit` 里改过字段的模型、新建的模型，以及 `/provider:fast-edit-with-copy` 复刻出来的模型，都会默认补上 `do_not = ["remove", "update"]` 并弹一条提示；已有任何 `do_not` 配置的不动。字段菜单第一行 `🛡 保护` 可改保护级别或关掉。
- **密钥管理**：通过 `../../lib/auth.ts` 获取 API key

### 依赖

- `../../lib/auth.ts` — API key 管理
- `smol-toml` — TOML 解析
- `@earendil-works/pi-coding-agent` — ProviderConfig, ProviderModelConfig 类型
