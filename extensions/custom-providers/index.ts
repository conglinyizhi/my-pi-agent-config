import { writeFileSync } from "node:fs";
import { type ExtensionAPI, getAgentDir, type ProviderConfig, type ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import { parse, stringify } from "smol-toml";
import { getApiKey } from "../../lib/auth.ts";
import { detectApiFormat } from "./detector.ts";
import { loadProvidersConfig } from "./loader.ts";
import { resolveModels, toPiApi } from "./models.ts";
import { diffModelLists, formatDiffReport, formatTokens, fmtPrice } from "./provider-diff.ts";
import { findModelCandidates, buildMatchedModel } from "./models-dev.ts";
import type { InputCapability, ModelOverride, RawProvider, ResolvedApiFormat } from "./types.ts";
import { fastAddHandler } from "./fast-add.ts";

const PLACEHOLDER_MODEL = "auto-detect";
const CONFIG_PATH = `${getAgentDir()}/providers.toml`;

export default async function customProvidersExtension(pi: ExtensionAPI) {
  const pending = new Map<string, RawProvider>();
  const registeredIds = new Set<string>();
  let rawToml = "";

  // /provider:* 子命令必须始终注册，不能因 providers.toml 不存在而被跳过

  // /provider:fast-add —— 快速添加自定义供应商
  pi.registerCommand("provider:fast-add", {
    description: "快速添加自定义供应商：/provider:fast-add <URL> <API Key> [模型名...]",
    handler: async (args, ctx) => {
      let input = args.trim();

      // 无参时引导用户交互式填写
      if (!input) {
        const url = await ctx.ui.input(
          "API 地址（必填，如 https://api.example.com/v1）",
          "https://",
        );
        if (!url?.trim()) {
          ctx.ui.notify("已取消", "info");
          return;
        }

        const apiKey = await ctx.ui.input(
          "API Key（必填）",
          "",
        );
        if (!apiKey?.trim()) {
          ctx.ui.notify("已取消（API Key 为必填项）", "info");
          return;
        }

        const models = await ctx.ui.input(
          "模型名（可选，逗号分隔；留空则自动从 API 拉取）",
          "",
        );

        input = [url.trim(), apiKey.trim(), models?.trim()].filter(Boolean).join(" ");
      }

      await fastAddHandler(input, ctx, pi);
    },
  });

  // /provider:reload —— 重新加载 providers.toml
  pi.registerCommand("provider:reload", {
    description: "重新加载 ~/.pi/agent/providers.toml 中的自定义供应商配置",
    handler: async (_args, ctx) => {
      let config: { providers: RawProvider[]; raw: string } | null = null;
      try {
        config = loadProvidersConfig(CONFIG_PATH);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        ctx.ui.notify(`重新加载 providers.toml 失败: ${message}`, "error");
        return;
      }
      if (!config) {
        ctx.ui.notify("providers.toml 不存在，可用 /provider:fast-add 添加供应商", "info");
        return;
      }
      const diffs = await registerProviders(config.providers, config.raw);
      const baseMsg = `已重新加载 providers.toml（${registeredIds.size} 个供应商）`;
      if (diffs.length > 0) {
        ctx.ui.notify(`${baseMsg}\n${diffs.join("\n")}`, "info");
      } else {
        ctx.ui.notify(baseMsg, "info");
      }
    },
  });

  // /provider:reload-online —— 从供应商侧重新拉取模型列表
  pi.registerCommand("provider:reload-online", {
    description: "从供应商侧重新拉取模型列表并更新 providers.toml（适用于供应商新增了模型）",
    handler: async (_args, ctx) => {
      let config: { providers: RawProvider[]; raw: string } | null = null;
      try {
        config = loadProvidersConfig(CONFIG_PATH);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        ctx.ui.notify(`加载 providers.toml 失败: ${message}`, "error");
        return;
      }
      if (!config) {
        ctx.ui.notify("providers.toml 不存在，可用 /provider:fast-add 添加供应商", "info");
        return;
      }

      let totalNew = 0;
      let totalSkipped = 0;
      let totalRefreshed = 0;
      const allModelsToWrite: Record<string, ModelOverride[]> = {};
      const allDiffs: Array<{ providerId: string; report: string | null }> = [];

      for (const provider of config.providers) {
        const apiKey = getApiKey(provider.id);
        if (!apiKey) {
          ctx.ui.notify(`跳过 "${provider.id}"：未配置 API Key`, "info");
          totalSkipped++;
          continue;
        }

        // 确定 API 格式
        const explicitApi = provider.api && provider.api !== "auto";
        let format: ResolvedApiFormat["format"];
        if (explicitApi) {
          format = provider.api as ResolvedApiFormat["format"];
        } else {
          ctx.ui.notify(
            `跳过 "${provider.id}"：api 为 "auto"，请先运行 /provider:reload 完成格式检测`,
            "info",
          );
          totalSkipped++;
          continue;
        }

        // 记录已有的模型 ID（用于对比）
        const existingIds = new Set<string>();
        if (typeof provider.models === "string" && provider.models !== "auto") {
          for (const id of provider.models.split(/[,，、]+/).map(s => s.trim())) {
            existingIds.add(id);
          }
        } else if (Array.isArray(provider.models)) {
          for (const m of provider.models) {
            existingIds.add(m.id);
          }
        }

        try {
          ctx.ui.notify(`正在从 "${provider.id}" 拉取最新模型列表...`, "info");

          // 强制从 API 拉取：构造一个 models="auto" 的临时 provider
          const fetchProvider: RawProvider = { ...provider, models: "auto" };
          const models = await resolveModels(fetchProvider, format, provider.baseUrl, apiKey);

          if (models.length === 0) {
            ctx.ui.notify(`"${provider.id}" API 返回 0 个模型，跳过`, "warning");
            totalSkipped++;
            continue;
          }

          // 对比找出新模型
          const newModels = models.filter(m => !existingIds.has(m.id));

          // 构建旧模型列表（用于完整差异对比）
          const oldModels = await buildOldModelList(provider, format);

          // 反注册旧的、注册新的
          pi.unregisterProvider(provider.id);
          registeredIds.delete(provider.id);
          pending.delete(provider.id);

          pi.registerProvider(
            provider.id,
            buildProviderConfig(provider, provider.baseUrl, toPiApi(format), models, apiKey),
          );
          registeredIds.add(provider.id);
          totalRefreshed++;

          // 构建要写回 TOML 的模型覆盖列表（合并已有覆盖 + 新模型 models.dev 匹配）
          const existingOverrides: ModelOverride[] = Array.isArray(provider.models)
            ? provider.models
            : [];
          const existingOverrideMap = new Map<string, ModelOverride>();
          for (const m of existingOverrides) existingOverrideMap.set(m.id, m);

          // 所有模型（含已有）批量匹配 models.dev
          const allModelIds = models.map(m => m.id);
          const matchedDevMap = new Map<string, Parameters<typeof buildMatchedModel>[1]>();
          {
            const matchResults = await Promise.allSettled(
              allModelIds.map(async id => {
                const { candidates } = await findModelCandidates(id);
                return { id, candidate: candidates[0] || null };
              }),
            );
            for (const r of matchResults) {
              if (r.status === "fulfilled" && r.value.candidate) {
                matchedDevMap.set(r.value.id, r.value.candidate);
              }
            }
          }

          // 构建写回 TOML 的覆盖列表
          const mergedOverrides: ModelOverride[] = await Promise.all(
            models.map(async m => {
              const existing = existingOverrideMap.get(m.id);
              const devCandidate = matchedDevMap.get(m.id);

              if (existing && devCandidate) {
                // 已有模型 + models.dev 匹配：能力更新，价格看 cost_locked
                const matched = await buildMatchedModel(m.id, devCandidate);
                return {
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
                };
              }
              if (existing) {
                // 已有模型但 models.dev 无匹配：保留原配置
                return existing;
              }
              if (devCandidate) {
                // 新模型 + models.dev 匹配
                const matched = await buildMatchedModel(m.id, devCandidate);
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
              // 新模型无匹配：默认值
              return {
                id: m.id,
                name: m.name !== m.id ? m.name : undefined,
                contextWindow: m.contextWindow,
                maxTokens: m.maxTokens,
                input: m.input as InputCapability[],
                reasoning: m.reasoning,
                costInput: m.cost.input,
                costOutput: m.cost.output,
                costCacheRead: m.cost.cacheRead,
                costCacheWrite: m.cost.cacheWrite,
              };
            }),
          );
          allModelsToWrite[provider.id] = mergedOverrides;

          // 下线模型（toml 有但 API 不再返回）
          const apiModelIds = new Set(models.map(m => m.id));
          const removedOverrides = [...existingOverrideMap.keys()]
            .filter(id => !apiModelIds.has(id));
          if (removedOverrides.length > 0) {
            ctx.ui.notify(
              `"${provider.id}" ${removedOverrides.length} 个模型已下线: ${removedOverrides.join(", ")}`,
              "info",
            );
          }

          // 能力/定价更新提醒
          const capabilityUpdates: string[] = [];
          const priceUpdates: string[] = [];
          for (const m of mergedOverrides) {
            const existing = existingOverrideMap.get(m.id);
            if (!existing) continue;
            // 能力（input 排序后比较避免顺序差异）
            const oldInput = [...(existing.input || [])].sort();
            const newInput = [...(m.input || [])].sort();
            const changes: string[] = [];
            if (existing.contextWindow !== m.contextWindow) changes.push(`上下文: ${formatTokens(existing.contextWindow ?? 0)} → ${formatTokens(m.contextWindow ?? 0)}`);
            if (JSON.stringify(oldInput) !== JSON.stringify(newInput)) changes.push(`模态: ${oldInput.join("+") || "无"} → ${newInput.join("+")}`);
            if (existing.reasoning !== m.reasoning) changes.push(`推理: ${existing.reasoning ? "是→否" : "否→是"}`);
            if (changes.length > 0) capabilityUpdates.push(`  ${m.id}: ${changes.join("，")}`);
            // 价格（仅非 locked）
            if (existing.cost_locked) continue;
            const oldIn = existing.costInput ?? 0;
            const oldOut = existing.costOutput ?? 0;
            const newIn = m.costInput ?? 0;
            const newOut = m.costOutput ?? 0;
            if (oldIn !== newIn || oldOut !== newOut) {
              priceUpdates.push(`  ${m.id}: ${fmtPrice(oldIn)}/${fmtPrice(oldOut)} → ${fmtPrice(newIn)}/${fmtPrice(newOut)}`);
            }
          }
          if (capabilityUpdates.length > 0) {
            ctx.ui.notify(`"${provider.id}" 能力更新:\n${capabilityUpdates.join("\n")}`, "info");
          }
          if (priceUpdates.length > 0) {
            ctx.ui.notify(`"${provider.id}" 定价更新:\n${priceUpdates.join("\n")}`, "info");
          }

          const pricedCount = mergedOverrides.filter(m => (m.costInput ?? 0) > 0 || (m.costOutput ?? 0) > 0).length;
          const priceNote = pricedCount > 0 ? `，${pricedCount} 个含定价` : "";
          const newCount = models.filter(m => !existingOverrideMap.has(m.id)).length;
          const removedCount = removedOverrides.length;

          // 差异报告：mergedOverrides（含 models.dev 更新）vs 旧 toml
          const newModelsResolved: ProviderModelConfig[] = mergedOverrides.map(o => ({
            id: o.id,
            name: o.name || o.id,
            api: toPiApi(format),
            reasoning: o.reasoning ?? false,
            input: ((o.input as InputCapability[]) || ["text"]).slice().sort() as InputCapability[],
            cost: {
              input: o.costInput ?? 0,
              output: o.costOutput ?? 0,
              cacheRead: o.costCacheRead ?? 0,
              cacheWrite: o.costCacheWrite ?? 0,
            },
            contextWindow: o.contextWindow ?? 128000,
            maxTokens: o.maxTokens ?? 4096,
            compat: { supportsDeveloperRole: false },
          } as ProviderModelConfig));
          // 旧模型列表也要包含已下线的（供 diff 报告移除）
          const diff = diffModelLists(oldModels, newModelsResolved);
          const report = formatDiffReport(diff, provider.id);
          allDiffs.push({ providerId: provider.id, report });

          if (newCount > 0 || removedCount > 0 || capabilityUpdates.length > 0 || priceUpdates.length > 0) {
            const parts: string[] = [];
            if (newCount > 0) { parts.push(`${newCount} 个新模型`); totalNew += newCount; }
            if (removedCount > 0) parts.push(`${removedCount} 个已下线`);
            parts.push(`${pricedCount} 个含定价`);
            ctx.ui.notify(`"${provider.id}" ${parts.join("，")}`, "info");
          } else {
            ctx.ui.notify(`"${provider.id}" 模型列表无变化（${models.length} 个模型${priceNote}）`, "info");
          }
        } catch (err) {
          ctx.ui.notify(
            `"${provider.id}" 拉取失败: ${err instanceof Error ? err.message : String(err)}（保留现有注册）`,
            "error",
          );
          totalSkipped++;
        }
      }

      // 写回 providers.toml
      if (totalRefreshed > 0) {
        try {
          const tomlConfig = parseProvidersTomlForWrite(config.raw);
          for (const [providerId, models] of Object.entries(allModelsToWrite)) {
            const providerEntry = tomlConfig.providers?.find(p => p.id === providerId);
            if (providerEntry) {
              providerEntry.models = models.map(m => tomlModelEntry(m));
            }
          }
          const newContent = stringify(tomlConfig);
          // 只有内容真正改变时才写入
          if (newContent !== config.raw) {
            writeFileSync(CONFIG_PATH, newContent, "utf8");
          }
        } catch (err) {
          ctx.ui.notify(
            `更新 providers.toml 失败: ${err instanceof Error ? err.message : String(err)}`,
            "warning",
          );
        }
      }

      // 汇总
      const summary: string[] = [];
      if (totalRefreshed > 0) summary.push(`${totalRefreshed} 个供应商已刷新`);
      if (totalNew > 0) summary.push(`${totalNew} 个新模型`);
      if (totalSkipped > 0) summary.push(`${totalSkipped} 个跳过`);
      if (summary.length === 0) summary.push("无可用供应商");
      ctx.ui.notify(summary.join("，"), "info");

      // 差异报告（有变更才展示）
      const changedDiffs = allDiffs.filter(d => d.report && !d.report.includes("无变化"));
      for (const d of changedDiffs) {
        ctx.ui.notify(d.report!, "info");
      }
    },
  });

  // 模型选择事件 —— 仅在初始化后注册一次，reload 时不重复注册
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
      pi.registerProvider(providerId, buildProviderConfig(provider, resolved.baseUrl, toPiApi(resolved.format), models, apiKey));

      if (provider.api === "auto") {
        await lockApiFormat(provider, resolved.format, rawToml);
      }

      const pricedCount = models.filter(m => m.cost.input > 0 || m.cost.output > 0).length;
      const priceNote = pricedCount > 0 ? `，${pricedCount} 个模型含定价` : "";
      ctx.ui.notify(`Provider "${providerId}" activated with ${models.length} model(s)${priceNote}.`, "info");
    } catch (err) {
      ctx.ui.notify(`Failed to activate "${providerId}": ${err instanceof Error ? err.message : String(err)}`, "error");
    }
  });

  // ---- 加载与注册逻辑 ----

  /** 从已有 provider 配置重建旧模型列表（用于变更对比） */
  async function buildOldModelList(
    provider: RawProvider,
    format: ResolvedApiFormat["format"],
  ): Promise<ProviderModelConfig[]> {
    // 用当前配置（非 auto）解析模型列表
    const oldProvider: RawProvider = {
      ...provider,
      // 如果 models 是 "auto"，回退到空（说明此前未完成激活，旧模型列表为空）
      models: provider.models === "auto" ? [] : provider.models,
    };
    try {
      return await resolveModels(oldProvider, format, provider.baseUrl, "");
    } catch {
      return [];
    }
  }

  async function registerProviders(providers: RawProvider[], raw: string): Promise<string[]> {
    // 清理前：捕获旧模型列表
    const oldSnapshots = new Map<string, ProviderModelConfig[]>();
    for (const provider of providers) {
      const explicitApi = provider.api && provider.api !== "auto";
      if (explicitApi) {
        const format = provider.api as ResolvedApiFormat["format"];
        oldSnapshots.set(provider.id, await buildOldModelList(provider, format));
      }
    }

    // 清理旧注册
    for (const id of registeredIds) {
      pi.unregisterProvider(id);
    }
    registeredIds.clear();
    pending.clear();
    rawToml = raw;

    for (const provider of providers) {
      const apiKey = getApiKey(provider.id);
      if (!apiKey) {
        continue;
      }

      const explicitApi = provider.api && provider.api !== "auto";
      const explicitModels = provider.models && provider.models !== "auto";

      if (explicitApi && explicitModels) {
        const format = provider.api as ResolvedApiFormat["format"];
        try {
          const models = await resolveModels(provider, format, provider.baseUrl, apiKey);
          pi.registerProvider(provider.id, buildProviderConfig(provider, provider.baseUrl, toPiApi(format), models, apiKey));
          registeredIds.add(provider.id);
        } catch {
          // provider 注册失败，跳过
        }
      } else {
        pending.set(provider.id, provider);
        registerPlaceholder(pi, provider, apiKey);
        registeredIds.add(provider.id);
      }
    }

    // 构建新模型列表并生成差异报告
    const diffs: string[] = [];
    for (const provider of providers) {
      const explicitApi = provider.api && provider.api !== "auto";
      if (!explicitApi) continue;
      const format = provider.api as ResolvedApiFormat["format"];
      const newModels = await buildOldModelList(provider, format);
      const oldModels = oldSnapshots.get(provider.id) || [];
      const diff = diffModelLists(oldModels, newModels);
      const report = formatDiffReport(diff, provider.id);
      if (report) diffs.push(report);
    }

    return diffs;
  }

  // ---- 初始化 ----

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

  if (!config) {
    // providers.toml 不存在，提示用户可创建
    pi.on("session_start", async (_event, ctx) => {
      ctx.ui.notify("可用 /provider:fast-add 添加自定义供应商，或手动编辑 ~/.pi/agent/providers.toml 后 /provider:reload", "info");
    });
    return;
  }

  await registerProviders(config.providers, config.raw);
}

function buildProviderConfig(provider: RawProvider, baseUrl: string, api: ProviderModelConfig["api"], models: ProviderModelConfig[], apiKey: string): ProviderConfig {
  return {
    name: provider.name || provider.id,
    baseUrl,
    api,
    apiKey,
    models,
    authHeader: true,
  };
}

function registerPlaceholder(pi: ExtensionAPI, provider: RawProvider, apiKey: string) {
  const guessedApi: ProviderModelConfig["api"] = provider.api === "anthropic" ? "anthropic-messages" : "openai-responses";
  pi.registerProvider(provider.id, {
    name: provider.name || provider.id,
    baseUrl: provider.baseUrl,
    api: guessedApi,
    apiKey,
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

/** 解析 TOML 原始内容为可写回的对象（保留完整结构） */
function parseProvidersTomlForWrite(raw: string): { providers?: Array<Record<string, unknown>> } {
  const parsed = parse(raw) as { providers?: Array<Record<string, unknown>> };
  if (!parsed.providers) parsed.providers = [];
  return parsed;
}

/** 将 ModelOverride 转为 TOML 写入用的对象 */
function tomlModelEntry(m: ModelOverride): Record<string, unknown> {
  const entry: Record<string, unknown> = { id: m.id };
  if (m.name !== undefined && m.name !== m.id) entry.name = m.name;
  if (m.contextWindow !== undefined) entry.context_window = m.contextWindow;
  if (m.maxTokens !== undefined) entry.max_tokens = m.maxTokens;
  if (m.costInput !== undefined && m.costInput > 0) entry.cost_input = m.costInput;
  if (m.costOutput !== undefined && m.costOutput > 0) entry.cost_output = m.costOutput;
  if (m.costCacheRead !== undefined && m.costCacheRead > 0) entry.cost_cache_read = m.costCacheRead;
  if (m.costCacheWrite !== undefined && m.costCacheWrite > 0) entry.cost_cache_write = m.costCacheWrite;
  if (m.reasoning !== undefined) entry.reasoning = m.reasoning;
  if (m.input !== undefined && m.input.length > 1) entry.input = m.input;
  if (m.cost_locked) entry.cost_locked = true;
  return entry;
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
