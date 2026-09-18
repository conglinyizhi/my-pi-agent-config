import { writeFileSync } from "node:fs";
import { type ExtensionAPI, getAgentDir, type ExtensionCommandContext, type ProviderConfig, type ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import { parse, stringify } from "smol-toml";
import { getApiKey } from "../../lib/auth.ts";
import { detectApiFormat } from "./detector.ts";
import { loadProvidersConfig } from "./loader.ts";
import { resolveModels, toPiApi } from "./models.ts";
import { diffModelLists, formatDiffReport } from "./provider-diff.ts";
import type { ModelOverride, RawProvider, ResolvedApiFormat } from "./types.ts";
import { fastAddHandler } from "./fast-add.ts";
import { fastDelHandler } from "./fast-del.ts";
import { fastEditHandler } from "./fast-edit.ts";
import { fastEditWithCopyHandler } from "./fast-edit-with-copy.ts";
import { buildOldModelList, reloadProvidersOnline } from "./reload-online.ts";

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

  const fastDelCommand = {
    description: "删除自定义供应商（支持模糊匹配和 TUI 选择）",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      await fastDelHandler(args, ctx, pi);
    },
  };
  pi.registerCommand("provider:fast-del", fastDelCommand);
  pi.registerCommand("provider:fast-remove", fastDelCommand);

  // /provider:fast-edit —— 交互式编辑供应商 / 模型配置
  pi.registerCommand("provider:fast-edit", {
    description: "交互式编辑供应商/模型配置（API 切换、新增模型、模型微调）：/provider:fast-edit [供应商名]",
    handler: async (args, ctx) => {
      const result = await fastEditHandler(args, ctx);
      if (!result?.changed) return;
      await reloadProviders(ctx);
      ctx.ui.notify(`✅ ${result.summary}`, "info");
    },
  });

  // /provider:fast-edit-with-copy —— 复刻已有模型到指定供应商并微调
  pi.registerCommand("provider:fast-edit-with-copy", {
    description:
      "复刻某个模型的配置到指定供应商并微调（如微调数据的测试模型）：/provider:fast-edit-with-copy [目标供应商] [源模型] [新模型ID]",
    handler: async (args, ctx) => {
      const result = await fastEditWithCopyHandler(args, ctx);
      if (!result?.changed) return;
      await reloadProviders(ctx);
      ctx.ui.notify(`✅ ${result.summary}`, "info");
    },
  });

  // /provider:reload —— 重新加载 providers.toml
  pi.registerCommand("provider:reload", {
    description: "重新加载 ~/.pi/agent/providers.toml 中的自定义供应商配置",
    handler: async (_args, ctx) => {
      await reloadProviders(ctx);
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

      const outcome = await reloadProvidersOnline(config.providers, {
        getApiKey,
        onNotice: (notice) => ctx.ui.notify(notice.message, notice.level),
      });

      for (const result of outcome.results) {
        if (result.kind !== "ok") continue;
        pi.unregisterProvider(result.provider.id);
        registeredIds.delete(result.provider.id);
        pending.delete(result.provider.id);
        pi.registerProvider(
          result.provider.id,
          buildProviderConfig(
            result.provider,
            result.provider.baseUrl,
            toPiApi(result.format),
            result.models,
            result.apiKey,
          ),
        );
        registeredIds.add(result.provider.id);
      }

      const { totalNew, totalSkipped, totalRefreshed, modelsToWrite: allModelsToWrite, diffs: allDiffs } = outcome;

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

  /** 重新加载 providers.toml 并热更新已注册的供应商（reload 命令与 fast-edit 共用） */
  async function reloadProviders(ctx: ExtensionCommandContext): Promise<void> {
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
  if (m.input !== undefined) entry.input = m.input;
  if (m.do_not !== undefined && m.do_not.length > 0) entry.do_not = m.do_not;
  if (m.cost_locked) entry.cost_locked = true;
  if (m.cotReplay !== undefined) entry.cot_replay = m.cotReplay;
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
