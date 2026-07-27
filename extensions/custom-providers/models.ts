import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import { parseCommaList } from "../../lib/string-utils";
import type { CompatOverride, InputCapability, ModelOverride, RawProvider, ResolvedApiFormat } from "./types.ts";

/** @deprecated 请使用 lib/string-utils 中的 parseCommaList */
export const parseModelIds = parseCommaList;

const DEFAULT_CONTEXT_WINDOW = 128000;
const DEFAULT_MAX_TOKENS = 4096;

interface AnthropicMeta {
  id: string;
  name: string;
  contextWindow: number;
  maxTokens: number;
  input: InputCapability[];
  reasoning?: boolean;
}

const ANTHROPIC_MODELS: AnthropicMeta[] = [
  { id: "claude-sonnet-4-20250514", name: "Claude 4 Sonnet", contextWindow: 200000, maxTokens: 64000, input: ["text", "image"] },
  { id: "claude-opus-4-20250514", name: "Claude 4 Opus", contextWindow: 200000, maxTokens: 64000, input: ["text", "image"] },
  { id: "claude-3-5-sonnet-latest", name: "Claude 3.5 Sonnet", contextWindow: 200000, maxTokens: 8192, input: ["text", "image"] },
  { id: "claude-3-5-haiku-latest", name: "Claude 3.5 Haiku", contextWindow: 200000, maxTokens: 8192, input: ["text"] },
  { id: "claude-3-opus-latest", name: "Claude 3 Opus", contextWindow: 200000, maxTokens: 4096, input: ["text", "image"] },
  { id: "claude-3-sonnet-20240229", name: "Claude 3 Sonnet", contextWindow: 200000, maxTokens: 4096, input: ["text", "image"] },
  { id: "claude-3-haiku-20240307", name: "Claude 3 Haiku", contextWindow: 200000, maxTokens: 4096, input: ["text", "image"] },
];

export async function resolveModels(
  provider: RawProvider,
  format: ResolvedApiFormat["format"],
  baseUrl: string,
  apiKey: string,
): Promise<ProviderModelConfig[]> {
  const overrides = new Map<string, ModelOverride>();
  const modelArray = Array.isArray(provider.models) ? provider.models : [];
  for (const m of modelArray) {
    overrides.set(m.id, m);
  }

  let ids: string[];
  if (provider.models === "auto") {
    ids = await fetchModelIds(format, baseUrl, apiKey);
  } else if (typeof provider.models === "string") {
    ids = parseCommaList(provider.models);
  } else {
    ids = modelArray.map((m) => m.id);
  }

  const api = toPiApi(format);
  return ids.map((id) => {
    const config = buildModelConfig(id, provider, overrides.get(id));
    return { ...config, api };
  });
}

async function fetchModelIds(format: ResolvedApiFormat["format"], baseUrl: string, apiKey: string): Promise<string[]> {
  if (format === "anthropic") {
    return ANTHROPIC_MODELS.map((m) => m.id);
  }

  const url = `${baseUrl}/models`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) {
    throw new Error(`Failed to fetch models from ${url}: ${res.status} ${res.statusText}`);
  }
  const data = (await res.json()) as { data?: Array<{ id: string }> };
  return (data.data || []).map((m) => m.id).sort();
}

/**
 * 根据模型 ID 和 provider 信息自动推断 compat。
 * 仅作为默认值，会被 TOML 中显式配置的 compat 覆盖。
 */
function detectCompat(id: string, _provider: RawProvider): Record<string, unknown> {
  const compat: Record<string, unknown> = { supportsDeveloperRole: false };

  // deepseek 模型：自动使用 DeepSeek thinking 格式
  if (/^deepseek/i.test(id)) {
    compat.thinkingFormat = "deepseek";
    compat.requiresReasoningContentOnAssistantMessages = true;
  }

  return compat;
}

/** 将 TOML snake_case compat 转为 JS camelCase */
function toJsCompat(raw: CompatOverride | undefined): Record<string, unknown> | undefined {
  if (!raw) return undefined;
  const c: Record<string, unknown> = {};
  if (raw.thinking_format !== undefined) c.thinkingFormat = raw.thinking_format;
  if (raw.requires_reasoning_content_on_assistant_messages !== undefined) c.requiresReasoningContentOnAssistantMessages = raw.requires_reasoning_content_on_assistant_messages;
  if (raw.requires_thinking_as_text !== undefined) c.requiresThinkingAsText = raw.requires_thinking_as_text;
  if (raw.supports_reasoning_effort !== undefined) c.supportsReasoningEffort = raw.supports_reasoning_effort;
  if (raw.supports_developer_role !== undefined) c.supportsDeveloperRole = raw.supports_developer_role;
  if (raw.force_adaptive_thinking !== undefined) c.forceAdaptiveThinking = raw.force_adaptive_thinking;
  if (raw.supports_eager_tool_input_streaming !== undefined) c.supportsEagerToolInputStreaming = raw.supports_eager_tool_input_streaming;
  return Object.keys(c).length > 0 ? c : undefined;
}

export function buildModelConfig(id: string, provider: RawProvider, override?: ModelOverride): Omit<ProviderModelConfig, "api"> {
  const defaults = provider.defaults || {};
  const anthropic = ANTHROPIC_MODELS.find((m) => m.id === id);

  const contextWindow = override?.contextWindow ?? anthropic?.contextWindow ?? defaults.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
  const maxTokens = override?.maxTokens ?? anthropic?.maxTokens ?? defaults.maxTokens ?? DEFAULT_MAX_TOKENS;
  const input = override?.input ?? anthropic?.input ?? defaults.input ?? ["text"];
  const reasoning = override?.reasoning ?? anthropic?.reasoning ?? defaults.reasoning ?? false;

  // compat 合并优先级：模型级 TOML compat > provider 级 TOML compat > 自动检测
  const autoCompat = detectCompat(id, provider);
  const providerCompat = toJsCompat(provider.compat);
  const modelCompat = toJsCompat(override?.compat);
  const mergedCompat = { ...autoCompat, ...providerCompat, ...modelCompat };

  return {
    id,
    name: override?.name ?? anthropic?.name ?? id,
    reasoning,
    input,
    cost: {
      input: override?.costInput ?? defaults.costInput ?? 0,
      output: override?.costOutput ?? defaults.costOutput ?? 0,
      cacheRead: override?.costCacheRead ?? defaults.costCacheRead ?? 0,
      cacheWrite: override?.costCacheWrite ?? defaults.costCacheWrite ?? 0,
    },
    contextWindow,
    maxTokens,
    compat: mergedCompat,
  };
}

export function toPiApi(format: ResolvedApiFormat["format"]): ProviderModelConfig["api"] {
  switch (format) {
    case "openai-new":
      return "openai-responses";
    case "openai-old":
      return "openai-completions";
    case "anthropic":
      return "anthropic-messages";
  }
}
