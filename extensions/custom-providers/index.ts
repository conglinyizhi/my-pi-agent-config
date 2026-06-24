import { readFileSync, writeFileSync } from "node:fs";
import { type ExtensionAPI, getAgentDir, type ProviderConfig, type ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import { detectApiFormat } from "./detector.ts";
import { loadProvidersConfig } from "./loader.ts";
import { resolveModels, toPiApi } from "./models.ts";
import type { RawProvider, ResolvedApiFormat } from "./types.ts";

const PLACEHOLDER_MODEL = "auto-detect";
const CONFIG_PATH = `${getAgentDir()}/providers.toml`;
const AUTH_PATH = `${getAgentDir()}/auth.json`;

export default async function customProvidersExtension(pi: ExtensionAPI) {
  let config: { providers: RawProvider[]; raw: string } | null = null;
  try {
    config = loadProvidersConfig(CONFIG_PATH);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    pi.on("session_start", async (_event, ctx) => {
      ctx.ui.notify(`Failed to load providers.toml: ${message}`, "error");
    });
    return;
  }
  if (!config) return;

  const { providers, raw } = config;
  const pending = new Map<string, RawProvider>();

  for (const provider of providers) {
    const apiKey = getApiKey(provider.id);
    if (!apiKey) {
      pi.on("session_start", async (_event, ctx) => {
        ctx.ui.notify(`Custom provider "${provider.id}" has no API key in auth.json`, "warning");
      });
      continue;
    }

    const explicitApi = provider.api && provider.api !== "auto";
    const explicitModels = provider.models && provider.models !== "auto";

    if (explicitApi && explicitModels) {
      const format = provider.api as ResolvedApiFormat["format"];
      try {
        const models = await resolveModels(provider, format, provider.baseUrl, apiKey);
        pi.registerProvider(provider.id, buildProviderConfig(provider, provider.baseUrl, toPiApi(format), models));
      } catch (err) {
        console.error(`[custom-providers] Failed to register ${provider.id}:`, err);
      }
    } else {
      pending.set(provider.id, provider);
      registerPlaceholder(pi, provider);
    }
  }

  pi.on("model_select", async (event, ctx) => {
    const modelId = event.model.id;
    const sepIndex = modelId.lastIndexOf(":");
    if (sepIndex < 0) return;
    const providerId = modelId.slice(0, sepIndex);
    const id = modelId.slice(sepIndex + 1);
    if (id !== PLACEHOLDER_MODEL) return;

    const provider = pending.get(providerId);
    if (!provider) return;

    if (!ctx.hasUI) {
      ctx.ui.notify(`Provider "${providerId}" requires TUI to activate.`, "warning");
      return;
    }

    const apiKey = getApiKey(providerId);
    if (!apiKey) {
      ctx.ui.notify(`Provider "${providerId}" has no API key in auth.json`, "error");
      return;
    }

    const choice = await ctx.ui.select(`Provider "${providerId}" needs to detect API format / fetch models.`, [
      "Detect automatically",
      "Set to openai-new",
      "Set to openai-old",
      "Set to anthropic",
      "Skip",
    ]);

    if (!choice || choice === "Skip") return;

    let resolved: ResolvedApiFormat | null = null;

    if (choice === "Detect automatically") {
      ctx.ui.notify(`Detecting API format for "${providerId}"...`, "info");
      if (provider.api === "anthropic") {
        resolved = { format: "anthropic", baseUrl: provider.baseUrl };
      } else {
        resolved = await detectApiFormat(provider.baseUrl, apiKey);
      }
      if (!resolved) {
        ctx.ui.notify(`Could not detect API format for "${providerId}". Set it explicitly in providers.toml.`, "error");
        return;
      }
    } else {
      const formatMap: Record<string, ResolvedApiFormat["format"]> = {
        "Set to openai-new": "openai-new",
        "Set to openai-old": "openai-old",
        "Set to anthropic": "anthropic",
      };
      resolved = { format: formatMap[choice], baseUrl: provider.baseUrl };
    }

    try {
      ctx.ui.notify(`Fetching models for "${providerId}"...`, "info");
      const models = await resolveModels(provider, resolved.format, resolved.baseUrl, apiKey);
      pi.unregisterProvider(providerId);
      pi.registerProvider(providerId, buildProviderConfig(provider, resolved.baseUrl, toPiApi(resolved.format), models));

      if (provider.api === "auto") {
        await lockApiFormat(provider, resolved.format, raw);
      }

      ctx.ui.notify(`Provider "${providerId}" activated with ${models.length} model(s).`, "info");
    } catch (err) {
      ctx.ui.notify(`Failed to activate "${providerId}": ${err instanceof Error ? err.message : String(err)}`, "error");
    }
  });
}

function buildProviderConfig(provider: RawProvider, baseUrl: string, api: ProviderModelConfig["api"], models: ProviderModelConfig[]): ProviderConfig {
  return {
    name: provider.name ?? provider.id,
    baseUrl,
    api,
    models,
    authHeader: true,
  };
}

function registerPlaceholder(pi: ExtensionAPI, provider: RawProvider) {
  const guessedApi: ProviderModelConfig["api"] = provider.api === "anthropic" ? "anthropic-messages" : "openai-responses";
  pi.registerProvider(provider.id, {
    name: provider.name ?? provider.id,
    baseUrl: provider.baseUrl,
    api: guessedApi,
    authHeader: true,
    models: [
      {
        id: PLACEHOLDER_MODEL,
        name: "Auto-detect...",
        api: guessedApi,
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 1,
        maxTokens: 1,
      },
    ],
  });
}

function getApiKey(providerId: string): string | undefined {
  try {
    const raw = readFileSync(AUTH_PATH, "utf8");
    const auth = JSON.parse(raw) as Record<string, { type?: string; key?: string }>;
    const entry = auth[providerId];
    if (entry?.type === "api_key" && entry.key) return entry.key;
    if (entry?.key) return entry.key;
    return undefined;
  } catch {
    return undefined;
  }
}

async function lockApiFormat(provider: RawProvider, format: ResolvedApiFormat["format"], rawToml: string): Promise<void> {
  const apiValue = format;
  const lines = rawToml.split("\n");

  let currentProviderStart = -1;
  let currentProviderId: string | null = null;
  let apiLine = -1;
  let baseUrlLine = -1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim().startsWith("[[providers]]")) {
      if (currentProviderId === provider.id) break;
      currentProviderStart = i;
      currentProviderId = null;
      apiLine = -1;
      baseUrlLine = -1;
      continue;
    }
    if (currentProviderStart < 0) continue;

    const idMatch = line.match(/^id\s*=\s*"([^"]+)"/);
    if (idMatch) {
      currentProviderId = idMatch[1];
      continue;
    }
    if (currentProviderId !== provider.id) continue;

    if (line.match(/^api\s*=\s*/)) {
      apiLine = i;
    } else if (line.match(/^base_url\s*=\s*/)) {
      baseUrlLine = i;
    } else if (line.trim().startsWith("[[providers]]")) {
      break;
    }
  }

  if (currentProviderId !== provider.id) return;

  if (apiLine >= 0) {
    lines[apiLine] = `api = "${apiValue}"`;
  } else if (baseUrlLine >= 0) {
    lines.splice(baseUrlLine + 1, 0, `api = "${apiValue}"`);
  } else {
    lines.splice(currentProviderStart + 1, 0, `api = "${apiValue}"`);
  }

  writeFileSync(CONFIG_PATH, lines.join("\n"), "utf8");
}
