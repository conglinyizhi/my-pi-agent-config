import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import { parseCommaList } from "../../lib/string-utils";
import type { InputCapability, ModelOverride, RawProvider, ResolvedApiFormat } from "./types.ts";
import { detectPlatform, type RealModelPrice } from "./platform-detect.ts";

/** @deprecated 请使用 lib/string-utils 中的 parseCommaList */
export const parseModelIds = parseCommaList;

/** fetchModelIds 的返回类型：模型 ID + 可选的价格 */
interface FetchedModelEntry {
  id: string;
  displayName?: string;
  price?: RealModelPrice;
}

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

  let fetched: FetchedModelEntry[];
  if (provider.models === "auto") {
    fetched = await fetchModelIds(format, baseUrl, apiKey);
  } else if (typeof provider.models === "string") {
    fetched = parseCommaList(provider.models).map(id => ({ id }));
  } else {
    fetched = modelArray.map((m) => ({ id: m.id }));
  }

  const api = toPiApi(format);
  return fetched.map((entry) => {
    const override = overrides.get(entry.id);
    const config = buildModelConfig(entry.id, provider, override, entry.price);
    return { ...config, api };
  });
}

async function fetchModelIds(
  format: ResolvedApiFormat["format"],
  baseUrl: string,
  apiKey: string,
): Promise<FetchedModelEntry[]> {
  if (format === "anthropic") {
    return ANTHROPIC_MODELS.map((m) => ({ id: m.id }));
  }

  // 尝试平台检测：如果是 New API / One API，直接用它的模型列表和价格
  try {
    const detected = await detectPlatform(baseUrl, apiKey);
    if (detected.models && detected.models.length > 0) {
      return detected.models.map(m => ({
        id: m.id,
        displayName: m.displayName,
        price: m.price ?? undefined,
      }));
    }
    // 检测不到平台或没有模型，继续走标准 OpenAI 流程
  } catch {
    // 平台检测失败，静默降级
  }

  // 标准 OpenAI /v1/models
  const url = `${baseUrl}/models`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) {
    throw new Error(`Failed to fetch models from ${url}: ${res.status} ${res.statusText}`);
  }
  const data = (await res.json()) as { data?: Array<{ id: string }> };
  return (data.data || []).map((m) => ({ id: m.id })).sort((a, b) => a.id.localeCompare(b.id));
}

export function buildModelConfig(
  id: string,
  provider: RawProvider,
  override?: ModelOverride,
  detectedPrice?: RealModelPrice,
): Omit<ProviderModelConfig, "api"> {
  const defaults = provider.defaults || {};
  const anthropic = ANTHROPIC_MODELS.find((m) => m.id === id);

  const contextWindow = override?.contextWindow ?? anthropic?.contextWindow ?? defaults.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
  const maxTokens = override?.maxTokens ?? anthropic?.maxTokens ?? defaults.maxTokens ?? DEFAULT_MAX_TOKENS;
  const input = override?.input ?? anthropic?.input ?? defaults.input ?? ["text"];
  const reasoning = override?.reasoning ?? anthropic?.reasoning ?? defaults.reasoning ?? false;

  // 价格优先级：手动覆盖 > 从平台接口检测到的价格 > 默认值 0
  const costInput = override?.costInput ?? detectedPrice?.input ?? defaults.costInput ?? 0;
  const costOutput = override?.costOutput ?? detectedPrice?.output ?? defaults.costOutput ?? 0;
  const costCacheRead = override?.costCacheRead ?? detectedPrice?.cacheRead ?? defaults.costCacheRead ?? 0;
  const costCacheWrite = override?.costCacheWrite ?? detectedPrice?.cacheWrite ?? defaults.costCacheWrite ?? 0;

  return {
    id,
    name: override?.name ?? anthropic?.name ?? id,
    reasoning,
    input,
    cost: {
      input: costInput,
      output: costOutput,
      cacheRead: costCacheRead,
      cacheWrite: costCacheWrite,
    },
    contextWindow,
    maxTokens,
    compat: { supportsDeveloperRole: false },
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
