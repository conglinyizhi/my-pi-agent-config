import { readFileSync } from "node:fs";
import { parse } from "smol-toml";
import type { InputCapability, ModelOverride, ProviderDefaults, ProvidersConfig, RawProvider } from "./types.ts";

export function parseProvidersToml(raw: string): ProvidersConfig {
  const parsed = parse(raw) as { providers?: Array<Record<string, unknown>> };
  const providers = (parsed.providers || []).map(normalizeProvider);
  validateProviders(providers);
  return { providers };
}

export function loadProvidersConfig(configPath: string): { providers: RawProvider[]; raw: string } | null {
  try {
    const raw = readFileSync(configPath, "utf8");
    const { providers } = parseProvidersToml(raw);
    return { providers: providers || [], raw };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw err;
  }
}

function normalizeProvider(raw: Record<string, unknown>): RawProvider {
  const defaults = raw.defaults as Record<string, unknown> | undefined;
  const models = raw.models;

  return {
    id: raw.id as string,
    name: raw.name as string | undefined,
    baseUrl: raw.base_url as string,
    api: raw.api as RawProvider["api"],
    models: typeof models === "string" ? models : Array.isArray(models) ? models.map(normalizeModelOverride) : undefined,
    defaults: defaults ? normalizeDefaults(defaults) : undefined,
  };
}

function normalizeModelOverride(raw: Record<string, unknown>): ModelOverride {
  return {
    id: raw.id as string,
    name: raw.name as string | undefined,
    contextWindow: raw.context_window as number | undefined,
    maxTokens: raw.max_tokens as number | undefined,
    input: raw.input as InputCapability[] | undefined,
    reasoning: raw.reasoning as boolean | undefined,
    costInput: raw.cost_input as number | undefined,
    costOutput: raw.cost_output as number | undefined,
    costCacheRead: raw.cost_cache_read as number | undefined,
    costCacheWrite: raw.cost_cache_write as number | undefined,
  };
}

function normalizeDefaults(raw: Record<string, unknown>): ProviderDefaults {
  return {
    contextWindow: raw.context_window as number | undefined,
    maxTokens: raw.max_tokens as number | undefined,
    input: raw.input as InputCapability[] | undefined,
    reasoning: raw.reasoning as boolean | undefined,
    costInput: raw.cost_input as number | undefined,
    costOutput: raw.cost_output as number | undefined,
    costCacheRead: raw.cost_cache_read as number | undefined,
    costCacheWrite: raw.cost_cache_write as number | undefined,
  };
}

function validateProviders(providers: RawProvider[]): void {
  if (!Array.isArray(providers)) {
    throw new Error("providers must be an array");
  }
  for (const p of providers) {
    if (!p.id || typeof p.id !== "string") {
      throw new Error("provider id is required");
    }
    if (!p.baseUrl || typeof p.baseUrl !== "string") {
      throw new Error(`provider ${p.id} baseUrl is required`);
    }
  }
}
