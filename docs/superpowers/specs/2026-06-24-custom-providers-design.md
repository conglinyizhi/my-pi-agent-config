# Custom Providers 扩展设计文档

## 1. 背景与目标

Pi 目前通过 `extensions/opencode-models.ts` 动态注册 OpenCode provider。用户希望有一个通用扩展，通过独立的 TOML 配置文件灵活地增删任意兼容 OpenAI 或 Anthropic API 规范的第三方 provider，而无需修改代码或把密钥写入可被 git 追踪的文件。

目标：
- 新增 `~/.pi/agent/providers.toml` 作为 provider 配置源（不进入 git）。
- 密钥继续存放在 `~/.pi/agent/auth.json`（已存在且被 gitignore）。
- 支持 OpenAI 新格式（responses）、旧格式（chat completions）、自动探测；支持 Anthropic messages。
- `model-name` 支持逗号分隔的固定列表，或 `auto` 通过 API 拉取。
- 自动探测与模型拉取均按需触发，避免启动时浪费 token。
- 探测成功后把实际 API 类型写回 TOML，实现“锁定”。
- 对 baseUrl 做归一化与多后缀兼容，提高中转站探测成功率。

## 2. 设计原则

- **配置即代码**：provider 的增删通过编辑 TOML + `/reload` 完成，不引入运行时写配置命令。
- **懒加载**：所有需要联网的探测、拉模型列表操作都在用户首次尝试使用该 provider 时触发，并先经 TUI 确认。
- **失败不阻塞**：单个 provider 配置错误不影响其他 provider 或 Pi 主体功能。
- **最小侵入**：通过 `pi.registerProvider` / `pi.unregisterProvider` 与现有模型注册机制集成，不直接操作 `models.json`。
- **安全默认**：未配置密钥（auth.json 中无对应 key）的 provider 仅提示，不注册。

## 3. 文件结构

在 `extensions/custom-providers/` 目录下实现：

```text
extensions/custom-providers/
├── index.ts      # 扩展入口：订阅 session_start，调度加载与注册
├── types.ts      # 内部类型定义（RawProvider、ResolvedProvider、ModelOverride 等）
├── loader.ts     # 读取 ~/.pi/agent/providers.toml 并解析为原始配置
├── detector.ts   # OpenAI API 格式探测、baseUrl 归一化
└── models.ts     # 固定/自动模型列表构建、Anthropic 内置模型、元数据默认值
```

## 4. TOML 配置格式

文件位置：`~/.pi/agent/providers.toml`。示例如下：

```toml
[[providers]]
id = "deepseek"
name = "DeepSeek"
base_url = "https://api.deepseek.com"
api = "openai-old"        # 可选值：openai-new | openai-old | auto | anthropic
models = "auto"           # 字符串：auto 或逗号分隔；也可写完整模型表

# provider 级默认值（对 auto/未覆盖的模型生效）
defaults.context_window = 64000
defaults.max_tokens = 8192
defaults.input = ["text"]

[[providers]]
id = "siliconflow"
name = "SiliconFlow"
base_url = "https://api.siliconflow.cn/v1"
api = "auto"
models = "Qwen/Qwen2.5-72B-Instruct, deepseek-ai/DeepSeek-V3"

[[providers]]
id = "my-anthropic-proxy"
name = "Anthropic Proxy"
base_url = "https://proxy.example.com/anthropic"
api = "anthropic"
models = "auto"

[[providers]]
id = "custom-openai"
name = "Custom OpenAI"
base_url = "https://ai.example.com"
api = "auto"

[[providers.models]]
id = "gpt-4o"
name = "GPT-4o"
context_window = 128000
max_tokens = 16384
input = ["text", "image"]
cost_input = 2.5
cost_output = 10.0

[[providers.models]]
id = "o3-mini"
name = "o3-mini"
reasoning = true
context_window = 200000
max_tokens = 100000
```

字段说明：

| 字段 | 必填 | 说明 |
|------|------|------|
| `id` | 是 | provider 唯一标识，也对应 `auth.json` 中的 key 名。 |
| `name` | 否 | 显示名，默认等于 `id`。 |
| `base_url` | 是 | API 基础地址。 |
| `api` | 否 | `openai-new` / `openai-old` / `auto` / `anthropic`，默认 `auto`。 |
| `models` | 否 | `auto`、逗号分隔模型 ID 字符串，或完整模型表数组。默认 `auto`。 |
| `defaults.*` | 否 | provider 级默认元数据。 |
| `[[providers.models]]` | 否 | 对 `models = "auto"` 或逗号模型做额外覆盖。 |

`models` 的三种写法：
1. `models = "auto"`：自动拉取（OpenAI 调 `/v1/models`，Anthropic 用内置列表）。
2. `models = "model-a, model-b"`：固定 ID 列表，trim 后注册。
3. `[[providers.models]]`：显式模型表，id 必填。

模型元数据默认值（可被 `defaults` 或单条模型覆盖）：
- `input = ["text"]`
- `reasoning = false`
- `context_window = 128000`
- `max_tokens = 4096`
- `cost_input / cost_output / cost_cache_read / cost_cache_write = 0`

## 5. 加载与注册流程

扩展加载时（`session_start` 或 `/reload`）：

1. **loader.ts** 读取 `providers.toml`。
   - 文件不存在：静默跳过（首次使用可提示）。
   - 解析失败：通过 `ctx.ui.notify` 报错误，不注册任何 provider。
2. 对每个 `providers` 条目：
   - 检查 `auth.json` 是否存在 `id` 对应的 `api_key` 类型条目；不存在则记录警告并跳过。
   - 将原始配置缓存到内存。
   - 如果 `api` 为显式值且 `models` 不是 `auto`：立即注册 provider（显式配置无需探测）。
   - 如果 `api = auto` 或 `models = auto`：**不立即联网**，但注册一个占位模型 `<provider>:auto-detect`。
     - 占位模型使用猜测的 `api`（OpenAI 类先用 `openai-new`，Anthropic 用 `anthropic-messages`），仅用于展示和触发，不会真正发起聊天请求。

## 6. 懒探测与 baseUrl 归一化

### 6.1 触发时机

当用户执行以下操作之一时，触发探测或模型拉取：
- 通过 `/model <provider>:auto-detect` 选中占位模型。
- 通过 `/model <provider>:<model>` 选择该 provider 的模型（显式 api 但 models=auto 时，拉取模型列表）。
- 默认模型正好是该 provider 的模型（启动时如默认模型命中 auto-detect，则弹窗确认后探测）。

触发前，若 `ctx.hasUI` 为真，先弹窗询问：

```text
provider "xxx" 需要联网探测 API 格式 / 拉取模型列表。
是否继续？
[继续探测] [跳过] [设为 openai-new] [设为 openai-old] [设为 anthropic]
```

用户选择显式格式则直接按该格式注册并写回 TOML，不再发请求。

### 6.2 探测算法

对 OpenAI 类 provider：

1. **baseUrl 归一化**：尝试多种 baseUrl 变体：
   - 用户填写的原始值
   - 去除末尾 `/v1` 后的值
   - 添加 `/v1` 后的值
   - 添加 `/chat/completions` 或 `/responses` 完整路径前的合理根路径
2. 对每个候选 baseUrl，先尝试发送一个极小的 `openai-responses` 请求（例如 `max_tokens=1` 或仅调用 `/responses` 的 endpoint 探测）。
3. 若返回 2xx 且结构符合，锁定为 `openai-new`。
4. 否则尝试 `openai-completions` 的 `/chat/completions` 极小请求。
5. 若成功，锁定为 `openai-old`。
6. 若都失败，提示用户手动指定 `api`。

探测或模型拉取成功后：
1. 移除占位模型 `<provider>:auto-detect`。
2. 用确定后的 `api` 和实际模型列表重新注册 provider。
3. 如用户当前正在切换模型，自动将目标模型切为实际模型（若存在）。

探测请求必须：
- 使用真实 API key。
- 不消耗或仅消耗可忽略 token（如用不存在的 model ID 触发 404 来验证 endpoint 存在，但避免 400 误判）。
- 设置较短超时（如 10 秒）。

### 6.3 Anthropic

`api = anthropic` 不探测格式。若用户显式选择 anthropic，直接注册为 `anthropic-messages`。

## 7. 模型列表获取

### 7.1 OpenAI 类

当 `models = auto` 且已确定 api 格式（或显式 openai-new/old）后：
- 调用 `GET {baseUrl}/models`（兼容 `/v1` 归一化）。
- 解析 `data[].id`。
- 用 provider 级 `defaults` 填充元数据；若 `[[providers.models]]` 中有同名 id，则合并覆盖。
- 注册到 Pi。

### 7.2 Anthropic

Anthropic 没有公开 `/models` 端点，使用内置常量列表：

```ts
const ANTHROPIC_MODELS = [
  "claude-sonnet-4-20250514",
  "claude-opus-4-20250514",
  "claude-3-5-sonnet-latest",
  "claude-3-5-haiku-latest",
  "claude-3-opus-latest",
  "claude-3-sonnet-20240229",
  "claude-3-haiku-20240307",
];
```

内置模型附带推荐元数据（contextWindow、maxTokens、input capabilities）。用户可通过 TOML 覆盖。

### 7.3 固定列表

`models = "a, b"` 直接解析为 id 列表，用 defaults 填充元数据，再应用模型表覆盖。

## 8. 锁定与写回

探测成功或用户显式选择格式后：
1. 在内存中把该 provider 的 `api` 更新为锁定值。
2. 写回 `providers.toml`：仅修改该 provider 的 `api` 字段，保留注释与格式。
   - 实现方式：读取原始 TOML 文本，定位到对应 `[[providers]]` 块，替换 `api = "..."` 行。
   - 若该字段不存在，在 `base_url` 行后插入。
3. 写回失败时仅通过 `ctx.ui.notify` 提示，不阻断当前使用。

## 9. 错误处理与用户通知

| 场景 | 行为 |
|------|------|
| providers.toml 不存在 | 静默跳过，可选 info 提示“可创建 providers.toml 添加自定义 provider”。 |
| providers.toml 解析失败 | notify error，不注册任何自定义 provider。 |
| auth.json 缺少对应 key | notify warning，跳过该 provider。 |
| 探测全部失败 | notify error，建议用户手动设置 `api`。 |
| 拉取模型列表失败 | notify warning，退化为使用 TOML 中显式模型或内置 Anthropic 列表。 |
| 写回 TOML 失败 | notify warning，当前 session 仍使用锁定值。 |

所有网络错误都应包含 provider id、baseUrl、错误摘要。

## 10. 安全

- 密钥只从 `auth.json` 读取，绝不写入 TOML。
- TOML 文件不加入 git（已由 `~/.pi/agent/` 位于用户 home 下天然隔离；若用户把 agent 目录做成 git 仓库，需确保 `.gitignore` 包含 `providers.toml` 与 `auth.json`）。
- 探测请求仅使用最小 payload，避免泄露敏感上下文。

## 11. 测试策略

由于扩展依赖 Pi 运行时与真实 API，测试以单元 + 集成脚本为主：

1. **单元测试**（使用 Node test runner 或 Vitest）：
   - `loader.ts`：解析各种合法/非法 TOML。
   - `detector.ts`：baseUrl 归一化生成候选列表。
   - `models.ts`：固定列表解析、defaults 与模型表合并。
2. **集成验证**：
   - 配置一个本地 mock server（如 nock 或 tiny http server），验证 OpenAI responses/completions 的探测顺序与锁定写回。
   - 在 Pi 中执行 `/reload` 后检查 `/model` 列表是否出现自定义 provider。
3. **类型检查**：`pnpm exec tsc --noEmit` 通过。
4. **格式检查**：`pnpm exec biome check extensions/custom-providers` 通过。

## 12. 后续可扩展（本阶段不做）

- 支持 OAuth provider 注册。
- 支持自定义 `headers` 与 `authHeader` 开关。
- 通过命令 `/provider-add` 交互式添加（本次设计仅通过 TOML）。
- 支持模型能力自动推断（通过模型 ID 前缀匹配）。
