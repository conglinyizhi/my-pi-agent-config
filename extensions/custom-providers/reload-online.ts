/**
 * /provider:reload-online 的拉取与合并。
 *
 * 供应商之间并行打 /models；models.dev 匹配按模型 ID 去重后再限并发。
 * 注册、写盘、通知顺序仍按 providers.toml 里的原顺序，由调用方收口。
 */

import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import { mapWithConcurrencyLimit } from "../../lib/concurrency.ts";
import {
  buildMatchedModel as defaultBuildMatchedModel,
  findModelCandidates as defaultFindModelCandidates,
  type ModelCandidate,
} from "./models-dev.ts";
import { buildModelConfig, resolveModels as defaultResolveModels, toPiApi } from "./models.ts";
import { isProtected, preserveProtectedUpdate } from "./model-protection.ts";
import { diffModelLists, formatDiffReport, formatTokens, fmtPrice } from "./provider-diff.ts";
import { parseInputCapabilities, toPiInput, type ModelOverride, type RawProvider, type ResolvedApiFormat } from "./types.ts";

export const PROVIDER_FETCH_CONCURRENCY = 8;
export const MODELS_DEV_CONCURRENCY = 5;

export type NotifyLevel = "info" | "warning" | "error";

export interface Notice {
  message: string;
  level: NotifyLevel;
}

export interface ReloadSkip {
  kind: "skip";
  providerId: string;
  reason: "no-api-key" | "api-auto";
}

export interface ReloadEmpty {
  kind: "empty";
  providerId: string;
}

export interface ReloadError {
  kind: "error";
  providerId: string;
  message: string;
}

export interface ReloadSuccess {
  kind: "ok";
  provider: RawProvider;
  apiKey: string;
  format: ResolvedApiFormat["format"];
  models: ProviderModelConfig[];
  mergedOverrides: ModelOverride[];
  oldModels: ProviderModelConfig[];
  newCount: number;
  removedIds: string[];
  capabilityUpdates: string[];
  priceUpdates: string[];
  pricedCount: number;
  report: string | null;
}

export type ReloadProviderResult = ReloadSkip | ReloadEmpty | ReloadError | ReloadSuccess;

export interface ReloadOnlineOutcome {
  results: ReloadProviderResult[];
  notices: Notice[];
  totalNew: number;
  totalSkipped: number;
  totalRefreshed: number;
  modelsToWrite: Record<string, ModelOverride[]>;
  diffs: Array<{ providerId: string; report: string | null }>;
}

export interface ReloadOnlineDeps {
  getApiKey: (id: string) => string | undefined;
  resolveModels?: typeof defaultResolveModels;
  findModelCandidates?: typeof defaultFindModelCandidates;
  buildMatchedModel?: typeof defaultBuildMatchedModel;
  providerConcurrency?: number;
  modelsDevConcurrency?: number;
  /** 通知一旦产生就回调；用来在等待拉取时先把进度打出去 */
  onNotice?: (notice: Notice) => void;
}

type FetchDecision =
  | { kind: "skip"; reason: ReloadSkip["reason"] }
  | { kind: "fetch"; format: ResolvedApiFormat["format"]; apiKey: string };

type FetchAttempt =
  | {
      index: number;
      kind: "ok";
      provider: RawProvider;
      apiKey: string;
      format: ResolvedApiFormat["format"];
      models: ProviderModelConfig[];
      oldModels: ProviderModelConfig[];
    }
  | { index: number; kind: "empty"; providerId: string }
  | { index: number; kind: "error"; providerId: string; message: string };

export function classifyReloadTarget(
  provider: RawProvider,
  apiKey: string | undefined,
): FetchDecision {
  if (!apiKey) return { kind: "skip", reason: "no-api-key" };
  if (!provider.api || provider.api === "auto") return { kind: "skip", reason: "api-auto" };
  return { kind: "fetch", format: provider.api, apiKey };
}

export async function buildOldModelList(
  provider: RawProvider,
  format: ResolvedApiFormat["format"],
  resolve: typeof defaultResolveModels = defaultResolveModels,
): Promise<ProviderModelConfig[]> {
  const oldProvider: RawProvider = {
    ...provider,
    models: provider.models === "auto" ? [] : provider.models,
  };
  try {
    return await resolve(oldProvider, format, provider.baseUrl, "");
  } catch {
    return [];
  }
}

export function applyOnlineProtection(
  fetched: ProviderModelConfig[],
  provider: RawProvider,
  format: ResolvedApiFormat["format"],
): ProviderModelConfig[] {
  const models = [...fetched];
  const existingOverrides: ModelOverride[] = Array.isArray(provider.models) ? provider.models : [];
  const onlineIds = new Set(models.map(m => m.id));
  for (const protectedModel of existingOverrides) {
    if (isProtected(protectedModel, "remove") && !onlineIds.has(protectedModel.id)) {
      models.push({
        ...buildModelConfig(protectedModel.id, provider, protectedModel),
        api: toPiApi(format),
      });
      continue;
    }
    if (isProtected(protectedModel, "update") && onlineIds.has(protectedModel.id)) {
      const index = models.findIndex(model => model.id === protectedModel.id);
      if (index >= 0) {
        models[index] = {
          ...buildModelConfig(protectedModel.id, provider, protectedModel),
          api: toPiApi(format),
        };
      }
    }
  }
  return models;
}

export async function matchModelsDev(
  ids: string[],
  findCandidates: typeof defaultFindModelCandidates = defaultFindModelCandidates,
  concurrency: number = MODELS_DEV_CONCURRENCY,
): Promise<Map<string, ModelCandidate>> {
  const unique = [...new Set(ids)];
  const rows = await mapWithConcurrencyLimit(unique, concurrency, async (id) => {
    try {
      const { candidates } = await findCandidates(id);
      return { id, candidate: candidates[0] || null };
    } catch {
      return { id, candidate: null };
    }
  });
  const matched = new Map<string, ModelCandidate>();
  for (const row of rows) {
    if (row.candidate) matched.set(row.id, row.candidate);
  }
  return matched;
}

export async function mergeOneOverride(
  model: ProviderModelConfig,
  existing: ModelOverride | undefined,
  devCandidate: ModelCandidate | null | undefined,
  buildMatched: typeof defaultBuildMatchedModel = defaultBuildMatchedModel,
): Promise<ModelOverride> {
  if (existing && devCandidate) {
    const matched = await buildMatched(model.id, devCandidate);
    return preserveProtectedUpdate({
      id: matched.id,
      name: matched.name !== matched.id ? matched.name : existing.name,
      contextWindow: matched.contextWindow,
      maxTokens: matched.maxTokens,
      input: matched.input,
      reasoning: matched.reasoning,
      costInput: existing.cost_locked ? existing.costInput : matched.costInput,
      costOutput: existing.cost_locked ? existing.costOutput : matched.costOutput,
      costCacheRead: existing.cost_locked ? existing.costCacheRead : matched.costCacheRead,
      costCacheWrite: existing.cost_locked ? existing.costCacheWrite : matched.costCacheWrite,
      cost_locked: existing.cost_locked,
      cotReplay: existing.cotReplay,
      compat: existing.compat,
      do_not: existing.do_not,
    }, existing);
  }
  if (existing) return existing;
  if (devCandidate) {
    const matched = await buildMatched(model.id, devCandidate);
    return {
      id: matched.id,
      name: matched.name !== matched.id ? matched.name : undefined,
      contextWindow: matched.contextWindow,
      maxTokens: matched.maxTokens,
      input: matched.input,
      reasoning: matched.reasoning,
      costInput: matched.costInput,
      costOutput: matched.costOutput,
      costCacheRead: matched.costCacheRead,
      costCacheWrite: matched.costCacheWrite,
    };
  }
  return {
    id: model.id,
    name: model.name !== model.id ? model.name : undefined,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    input: parseInputCapabilities(model.input) ?? ["text"],
    reasoning: model.reasoning,
    costInput: model.cost.input,
    costOutput: model.cost.output,
    costCacheRead: model.cost.cacheRead,
    costCacheWrite: model.cost.cacheWrite,
  };
}

export async function reloadProvidersOnline(
  providers: RawProvider[],
  deps: ReloadOnlineDeps,
): Promise<ReloadOnlineOutcome> {
  const resolve = deps.resolveModels ?? defaultResolveModels;
  const findCandidates = deps.findModelCandidates ?? defaultFindModelCandidates;
  const buildMatched = deps.buildMatchedModel ?? defaultBuildMatchedModel;
  const providerConcurrency = deps.providerConcurrency ?? PROVIDER_FETCH_CONCURRENCY;
  const modelsDevConcurrency = deps.modelsDevConcurrency ?? MODELS_DEV_CONCURRENCY;

  const classified = providers.map(provider => ({
    provider,
    decision: classifyReloadTarget(provider, deps.getApiKey(provider.id)),
  }));

  const results: ReloadProviderResult[] = new Array(providers.length);
  const notices: Notice[] = [];
  const emit = (notice: Notice) => {
    notices.push(notice);
    deps.onNotice?.(notice);
  };
  let totalSkipped = 0;

  const fetchJobs = classified
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => item.decision.kind === "fetch");

  if (fetchJobs.length === 1) {
    emit({
      level: "info",
      message: `正在从 "${fetchJobs[0].item.provider.id}" 拉取最新模型列表...`,
    });
  } else if (fetchJobs.length > 1) {
    emit({
      level: "info",
      message: `正在并行拉取 ${fetchJobs.length} 个供应商的模型列表...`,
    });
  }

  for (let i = 0; i < classified.length; i++) {
    const { provider, decision } = classified[i];
    if (decision.kind !== "skip") continue;
    const skip: ReloadSkip = { kind: "skip", providerId: provider.id, reason: decision.reason };
    results[i] = skip;
    emit(skipNotice(skip));
    totalSkipped++;
  }

  const fetched = fetchJobs.length === 0
    ? []
    : await mapWithConcurrencyLimit(fetchJobs, providerConcurrency, async (job): Promise<FetchAttempt> => {
      const { provider, decision } = job.item;
      if (decision.kind !== "fetch") {
        return { index: job.index, kind: "error", providerId: provider.id, message: "内部错误：未进入拉取分支" };
      }
      try {
        const fetchProvider: RawProvider = { ...provider, models: "auto" };
        const [modelsRaw, oldModels] = await Promise.all([
          resolve(fetchProvider, decision.format, provider.baseUrl, decision.apiKey),
          buildOldModelList(provider, decision.format, resolve),
        ]);
        if (modelsRaw.length === 0) {
          return { index: job.index, kind: "empty", providerId: provider.id };
        }
        return {
          index: job.index,
          kind: "ok",
          provider,
          apiKey: decision.apiKey,
          format: decision.format,
          models: applyOnlineProtection(modelsRaw, provider, decision.format),
          oldModels,
        };
      } catch (err) {
        return {
          index: job.index,
          kind: "error",
          providerId: provider.id,
          message: err instanceof Error ? err.message : String(err),
        };
      }
    });

  const oks: Extract<FetchAttempt, { kind: "ok" }>[] = [];
  for (const item of fetched) {
    if (item.kind === "ok") {
      oks.push(item);
      continue;
    }
    results[item.index] = item.kind === "empty"
      ? { kind: "empty", providerId: item.providerId }
      : { kind: "error", providerId: item.providerId, message: item.message };
    totalSkipped++;
  }

  const matchedDevMap = await matchModelsDev(
    oks.flatMap(item => item.models.map(model => model.id)),
    findCandidates,
    modelsDevConcurrency,
  );

  let totalNew = 0;
  let totalRefreshed = 0;
  const modelsToWrite: Record<string, ModelOverride[]> = {};
  const diffs: Array<{ providerId: string; report: string | null }> = [];

  for (const ok of oks) {
    const existingOverrides: ModelOverride[] = Array.isArray(ok.provider.models) ? ok.provider.models : [];
    const existingOverrideMap = new Map(existingOverrides.map(model => [model.id, model]));
    const mergedOverrides = await Promise.all(
      ok.models.map(model =>
        mergeOneOverride(model, existingOverrideMap.get(model.id), matchedDevMap.get(model.id), buildMatched),
      ),
    );

    const apiModelIds = new Set(ok.models.map(model => model.id));
    const removedIds = [...existingOverrideMap.keys()].filter(id => {
      const existing = existingOverrideMap.get(id);
      return !apiModelIds.has(id) && existing !== undefined && !isProtected(existing, "remove");
    });

    const { capabilityUpdates, priceUpdates } = collectUpdates(mergedOverrides, existingOverrideMap);
    const pricedCount = mergedOverrides.filter(model => (model.costInput ?? 0) > 0 || (model.costOutput ?? 0) > 0).length;
    const newCount = ok.models.filter(model => !existingOverrideMap.has(model.id)).length;
    const newModelsResolved = mergedOverrides.map(model => overrideToRuntime(model, ok.format));
    const report = formatDiffReport(diffModelLists(ok.oldModels, newModelsResolved), ok.provider.id);

    results[ok.index] = {
      kind: "ok",
      provider: ok.provider,
      apiKey: ok.apiKey,
      format: ok.format,
      models: ok.models,
      mergedOverrides,
      oldModels: ok.oldModels,
      newCount,
      removedIds,
      capabilityUpdates,
      priceUpdates,
      pricedCount,
      report,
    };
    totalRefreshed++;
    totalNew += newCount;
  }

  for (const result of results) {
    if (!result) continue;
    if (result.kind === "ok") {
      modelsToWrite[result.provider.id] = result.mergedOverrides;
      diffs.push({ providerId: result.provider.id, report: result.report });
      for (const notice of noticesForFetched(result)) emit(notice);
      continue;
    }
    if (result.kind === "skip") continue;
    for (const notice of noticesForFetched(result)) emit(notice);
  }

  return { results, notices, totalNew, totalSkipped, totalRefreshed, modelsToWrite, diffs };
}

function skipNotice(skip: ReloadSkip): Notice {
  if (skip.reason === "no-api-key") {
    return { level: "info", message: `跳过 "${skip.providerId}"：未配置 API Key` };
  }
  return {
    level: "info",
    message: `跳过 "${skip.providerId}"：api 为 "auto"，请先运行 /provider:reload 完成格式检测`,
  };
}

function noticesForFetched(result: Exclude<ReloadProviderResult, ReloadSkip>): Notice[] {
  if (result.kind === "empty") {
    return [{ level: "warning", message: `"${result.providerId}" API 返回 0 个模型，跳过` }];
  }
  if (result.kind === "error") {
    return [{
      level: "error",
      message: `"${result.providerId}" 拉取失败: ${result.message}（保留现有注册）`,
    }];
  }

  const providerId = result.provider.id;
  const notices: Notice[] = [];
  if (result.removedIds.length > 0) {
    notices.push({
      level: "info",
      message: `"${providerId}" ${result.removedIds.length} 个模型已下线: ${result.removedIds.join(", ")}`,
    });
  }
  if (result.capabilityUpdates.length > 0) {
    notices.push({ level: "info", message: `"${providerId}" 能力更新:\n${result.capabilityUpdates.join("\n")}` });
  }
  if (result.priceUpdates.length > 0) {
    notices.push({ level: "info", message: `"${providerId}" 定价更新:\n${result.priceUpdates.join("\n")}` });
  }

  const priceNote = result.pricedCount > 0 ? `，${result.pricedCount} 个含定价` : "";
  if (result.newCount > 0 || result.removedIds.length > 0 || result.capabilityUpdates.length > 0 || result.priceUpdates.length > 0) {
    const parts: string[] = [];
    if (result.newCount > 0) parts.push(`${result.newCount} 个新模型`);
    if (result.removedIds.length > 0) parts.push(`${result.removedIds.length} 个已下线`);
    parts.push(`${result.pricedCount} 个含定价`);
    notices.push({ level: "info", message: `"${providerId}" ${parts.join("，")}` });
  } else {
    notices.push({
      level: "info",
      message: `"${providerId}" 模型列表无变化（${result.models.length} 个模型${priceNote}）`,
    });
  }
  return notices;
}

function collectUpdates(
  mergedOverrides: ModelOverride[],
  existingOverrideMap: Map<string, ModelOverride>,
): { capabilityUpdates: string[]; priceUpdates: string[] } {
  const capabilityUpdates: string[] = [];
  const priceUpdates: string[] = [];
  for (const model of mergedOverrides) {
    const existing = existingOverrideMap.get(model.id);
    if (!existing) continue;
    const oldInput = [...(existing.input || [])].sort();
    const newInput = [...(model.input || [])].sort();
    const changes: string[] = [];
    if (existing.contextWindow !== model.contextWindow) {
      changes.push(`上下文: ${formatTokens(existing.contextWindow ?? 0)} → ${formatTokens(model.contextWindow ?? 0)}`);
    }
    if (JSON.stringify(oldInput) !== JSON.stringify(newInput)) {
      changes.push(`模态: ${oldInput.join("+") || "无"} → ${newInput.join("+")}`);
    }
    if (existing.reasoning !== model.reasoning) {
      changes.push(`推理: ${existing.reasoning ? "是→否" : "否→是"}`);
    }
    if (changes.length > 0) capabilityUpdates.push(`  ${model.id}: ${changes.join("，")}`);
    if (existing.cost_locked) continue;
    const oldIn = existing.costInput ?? 0;
    const oldOut = existing.costOutput ?? 0;
    const newIn = model.costInput ?? 0;
    const newOut = model.costOutput ?? 0;
    if (oldIn !== newIn || oldOut !== newOut) {
      priceUpdates.push(`  ${model.id}: ${fmtPrice(oldIn)}/${fmtPrice(oldOut)} → ${fmtPrice(newIn)}/${fmtPrice(newOut)}`);
    }
  }
  return { capabilityUpdates, priceUpdates };
}

function overrideToRuntime(
  override: ModelOverride,
  format: ResolvedApiFormat["format"],
): ProviderModelConfig {
  return {
    id: override.id,
    name: override.name || override.id,
    api: toPiApi(format),
    reasoning: override.reasoning ?? false,
    input: toPiInput(override.input),
    cost: {
      input: override.costInput ?? 0,
      output: override.costOutput ?? 0,
      cacheRead: override.costCacheRead ?? 0,
      cacheWrite: override.costCacheWrite ?? 0,
    },
    contextWindow: override.contextWindow ?? 128000,
    maxTokens: override.maxTokens ?? 4096,
    compat: { supportsDeveloperRole: false },
  } as ProviderModelConfig;
}
