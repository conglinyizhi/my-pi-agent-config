import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import type { InputCapability, ModelOverride, RawProvider, ResolvedApiFormat } from "./types.ts";

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

export function parseModelIds(models: string): string[] {
  return models
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

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
    ids = parseModelIds(provider.models);
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
  return (data.data ?? []).map((m) => m.id).sort();
}

export function buildModelConfig(id: string, provider: RawProvider, override?: ModelOverride): Omit<ProviderModelConfig, "api"> {
  const defaults = provider.defaults ?? {};
  const anthropic = ANTHROPIC_MODELS.find((m) => m.id === id);

  const contextWindow = override?.contextWindow ?? anthropic?.contextWindow ?? defaults.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
  const maxTokens = override?.maxTokens ?? anthropic?.maxTokens ?? defaults.maxTokens ?? DEFAULT_MAX_TOKENS;
  const input = override?.input ?? anthropic?.input ?? defaults.input ?? ["text"];
  const reasoning = override?.reasoning ?? anthropic?.reasoning ?? defaults.reasoning ?? false;

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
