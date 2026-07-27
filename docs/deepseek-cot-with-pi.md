# 第三方代理上的 DeepSeek 模型 CoT 丢失问题 & 修复

## 问题

通过 `/provider:fast-add` 添加的第三方代理上的 deepseek 模型，会因为三个原因导致 Chain-of-Thought 思维链在对话中丢失。**所有第三方代理都有这个问题**，不限于特定供应商。

### 坑 1：thinkingFormat 未自动检测

pi 的 `detectCompat()` 通过 provider 名或 baseUrl 判断：

```js
const isDeepSeek = provider === "deepseek" || baseUrl.includes("deepseek.com");
```

第三方代理的 provider 名和 baseUrl 通常都不会匹配 `"deepseek"` 或 `"deepseek.com"`。因此 `thinkingFormat` 回退到 `"openai"`（默认），不会发送 `thinking: { type: "enabled" }`，只发送 `reasoning_effort`。

虽然 DeepSeek 默认启用 thinking 所以模型仍然会思考，但无法显式关闭 thinking，也无法精确匹配 DeepSeek 的 thinking 参数格式。

### 坑 2：requiresReasoningContentOnAssistantMessages 缺失

此 compat 字段仅在 `isDeepSeek` 时自动设为 true。第三方代理上为 false。正常情况下 thinking 块通过 `thinkingSignature` 机制还原成 `reasoning_content`，但没有兜底——如果某条 assistant 消息没有 thinking 块，工具调用轮次会缺少 `reasoning_content` 字段导致 DeepSeek API 400。

### 坑 3：跨模型切换 CoT 丢失

`transformMessages.js` 的 `isSameModel` 检查包含 model.id 严格匹配：

```js
const isSameModel = assistantMsg.model === model.id;
```

同 provider 下从 deepseek-v4-pro 切到 deepseek-v4-flash → `isSameModel = false` → 所有 thinking block 被转成纯文本，不再以结构化 `reasoning_content` 回传。

## 修复

### 即时修复：无需修改 providers.toml

`models.ts::detectCompat()` 在每次注册模型时自动检测——模型 ID 匹配 `/^deepseek/i` 则自动注入：

```js
{
  thinkingFormat: "deepseek",
  requiresReasoningContentOnAssistantMessages: true,
  supportsDeveloperRole: false
}
```

`/reload` 时 extension 走 `resolveModels()` → `buildModelConfig()` → `detectCompat()`，自动生效。
`providers.toml` 保持干净，compat 由扩展代码驱动，不是配置文件持久化的内容。

### 非 deepseek 模型的手动配置

某些非 deepseek 模型（如 kimi-k3 等）可能需要同样的 CoT 回传行为。在 TOML 中添加：

```toml
[[providers.models]]
id = "kimi-k3"
[providers.models.compat]
thinking_format = "deepseek"
requires_reasoning_content_on_assistant_messages = true
```

合并优先级：TOML 模型级 > TOML provider 级 > 自动检测，手动配置不会被自动检测覆盖。

### 长期修复：custom-providers 扩展

1. **types.ts**: 添加 `CompatOverride` 类型
2. **loader.ts**: 解析 TOML 中的 `[providers.models.compat]` 和 `[providers.compat]`
3. **models.ts**: `buildModelConfig` 增加 `detectCompat()`，模型 ID 匹配 `/^deepseek/i` 自动设置 compat
4. **fast-add.ts**: `tomlModel` 支持写入 compat；`pi.registerProvider` 携带 compat

### 跨模型 CoT 的限制

cross-model CoT 丢失是 pi 核心的限制（`transformMessages.js`），无法在扩展层面修复。缓解方式：避免在同 provider 内频繁切换模型。

## 相关文件

- `~/.pi/agent/providers.toml` — 供应商配置
- `~/.pi/agent/extensions/custom-providers/` — 扩展源码（types.ts, loader.ts, models.ts, fast-add.ts）
