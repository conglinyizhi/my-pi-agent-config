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
- **密钥管理**：通过 `../../lib/auth.ts` 获取 API key

### 依赖

- `../../lib/auth.ts` — API key 管理
- `smol-toml` — TOML 解析
- `@earendil-works/pi-coding-agent` — ProviderConfig, ProviderModelConfig 类型
