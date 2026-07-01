/**
 * /provider fast-add — 一行命令快速添加自定义供应商
 *
 * 新流程：
 * 1. 解析 URL 和 API Key
 * 2. 用 Key 调用 /v1/models 获取实际可用模型
 * 3. 从 models.dev 交叉匹配元数据（上下文长度、价格等）
 * 4. 让用户选择要添加的模型
 * 5. 支持多 key 分组（同域名不同 key 注册为独立 provider）
 *
 * 格式：/provider fast-add <URL>[;<API Key>]
 * 示例：
 *   /provider fast-add https://tokenflux.dev/v1;tp-xxxx
 *   /provider fast-add https://api.groq.com/openai/v1;sk-xxx
 */

import { writeFileSync, readFileSync } from "node:fs";
import {
  getAgentDir,
  type ExtensionAPI,
  type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { parse, stringify } from "smol-toml";
import type { ModelOverride, InputCapability } from "./types.ts";
import { maskKey } from "../../lib/auth";
import { extractDomainId } from "../../lib/url-utils";
import {
  discoverModelsWithCandidates,
  buildMatchedModel,
  type ModelWithCandidates,
  type ModelCandidate,
  type MatchedModel,
} from "./models-dev.ts";

// ─── 类型 ───────────────────────────────────────────

export interface FastAddInfo {
  url: string;
  providerId: string;
  providerName: string;
  models: string[];
  apiKey?: string;
  discoveredModels?: never; // 已废弃，用 modelOverrides 代替
  modelOverrides?: ModelOverride[];
  defaults?: {
    contextWindow?: number;
    maxTokens?: number;
    costInput?: number;
    costOutput?: number;
    costCacheRead?: number;
    costCacheWrite?: number;
    reasoning?: boolean;
    input?: InputCapability[];
  };
  /** 内部：用户选择的 API 格式 */
  _chosenApi?: string;
}

export type FastAddAction =
  | { kind: "confirm" }
  | { kind: "rename"; newId: string }
  | { kind: "merge"; targetId: string; keyAction: "replace" | "keep" }
  | { kind: "cancel" };

interface ExistingProvider {
  id: string;
  name?: string;
  baseUrl: string;
  api?: string;
  models?: unknown;
}

// ─── 路径 ───────────────────────────────────────────

const AGENT_DIR = getAgentDir();
const CONFIG_PATH = `${AGENT_DIR}/providers.toml`;
const AUTH_PATH = `${AGENT_DIR}/auth.json`;

// ─── 解析引擎 ───────────────────────────────────────

/** 判断字符串是否像 API Key */
function looksLikeApiKey(s: string): boolean {
  if (/^(sk-|sk-ant-|sk-or-|tp-|api-|pk-|eyJ)/i.test(s)) return true;
  if (s.length >= 20 && /^[a-zA-Z0-9_\-./=]+$/.test(s)) return true;
  return false;
}

/** 从 URL 提取默认供应商标识符（从 lib/url-utils 重新导出） */
export { extractDomainId } from "../../lib/url-utils";

/**
 * 判断字符串是否像 URL
 */
function looksLikeUrl(s: string): boolean {
  return /^https?:\/\//i.test(s) ||
    /^[a-zA-Z0-9][-a-zA-Z0-9]*\.[a-zA-Z]{2,}(:\d+)?(\/.*)?$/.test(s);
}

/** 解析用户原始输入 — 智能识别，不要求固定顺序 */
export function parseFastAddInput(raw: string): { ok: true; data: FastAddInfo } | { ok: false; error: string } {
  const input = raw.trim();
  if (!input) return { ok: false, error: "输入不能为空" };

  // 统一拆分：按 ;；,，、 和空格拆分
  const allParts = input
    .split(/[;；,，、\s]+/)
    .map(s => s.trim())
    .filter(Boolean);

  if (allParts.length === 0) {
    return { ok: false, error: "未检测到有效输入" };
  }

  // 智能分类每个 part
  let url: string | undefined;
  let apiKey: string | undefined;
  const models: string[] = [];

  for (let i = 0; i < allParts.length; i++) {
    const part = allParts[i];

    // 1. URL：第一个匹配的 URL 片段
    if (!url && looksLikeUrl(part)) {
      // 补全协议
      if (!/^https?:\/\//i.test(part)) {
        url = `https://${part}`;
      } else {
        url = part;
      }
      // URL 可能包含后续路径，需要拼接
      // 检查原始输入中 URL 是否被拆分了
      continue;
    }

    // URL 被空格拆分的情况：尝试拼接
    // 例如 "https://api.example.com /v1" 被拆成 ["https://api.example.com", "/v1"]
    if (url && part.startsWith("/") && !looksLikeApiKey(part)) {
      url = `${url}${part}`;
      continue;
    }

    // 2. API Key
    if (!apiKey && looksLikeApiKey(part)) {
      apiKey = part;
      continue;
    }

    // 3. 剩余的当作模型名
    if (!/^https?:\/\//i.test(part)) {
      models.push(part);
    }
  }

  // URL 被空格拆分的修复：从原始输入中重新提取完整 URL
  if (!url) {
    const urlMatch = input.match(/(https?:\/\/[^\s;,，；、]+)/i);
    if (!urlMatch) {
      // 尝试无协议的域名
      const domainMatch = input.match(/([a-zA-Z0-9][-a-zA-Z0-9]*\.[a-zA-Z]{2,}(:\d+)?(\/[-a-zA-Z0-9%@!~#=_+/.:,]*)?)/);
      if (domainMatch) {
        url = `https://${domainMatch[1]}`;
      } else {
        return { ok: false, error: "未检测到有效的 API 地址，需包含 http:// 或 https://" };
      }
    } else {
      url = urlMatch[1];
    }
  }

  url = url.replace(/\/+$/, "");

  // API Key 必选
  if (!apiKey) {
    return { ok: false, error: "API Key 为必选参数。格式：<URL> <API Key> [模型名...]（顺序任意）" };
  }

  // 去重模型名
  const uniqueModels = [...new Set(models)];

  const providerId = extractDomainId(url);

  return {
    ok: true,
    data: {
      url,
      providerId,
      providerName: providerId,
      models: uniqueModels,
      apiKey,
    },
  };
}

// ─── 文件读写 ───────────────────────────────────────

function loadAuthData(): Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(AUTH_PATH, "utf8"));
  } catch {
    return {};
  }
}

function loadExistingToml(): { providers: ExistingProvider[]; raw: string } | null {
  try {
    const raw = readFileSync(CONFIG_PATH, "utf8");
    const parsed = parse(raw) as { providers?: Array<Record<string, unknown>> };
    if (!Array.isArray(parsed.providers)) return null;
    return {
      providers: parsed.providers.map(p => ({
        id: p.id as string,
        name: p.name as string | undefined,
        baseUrl: (p.base_url as string) || "",
        api: p.api as string | undefined,
        models: p.models,
      })),
      raw,
    };
  } catch {
    return null;
  }
}

/** 检查 domain 是否与已有供应商重叠 */
export function findOverlap(
  domain: string,
  existing: ExistingProvider[],
): ExistingProvider[] {
  return existing.filter(p => {
    try {
      const existingDomain = new URL(p.baseUrl).hostname
        .replace(/^(api|www|v1|v2)\./i, "")
        .split(".")[0];
      return existingDomain === domain;
    } catch {
      return false;
    }
  });
}

// ─── 模型发现与选择 ─────────────────────────────────

/**
 * 从 API 发现模型并准备候选列表
 */
async function discoverModels(
  ctx: ExtensionCommandContext,
  info: FastAddInfo,
): Promise<ModelWithCandidates[] | null> {
  if (!info.apiKey) {
    return null;
  }

  ctx.ui.notify("正在从 API 拉取模型列表...", "info");

  try {
    const models = await discoverModelsWithCandidates(info.url, info.apiKey);
    return models;
  } catch (err) {
    ctx.ui.notify(
      `拉取模型列表失败: ${err instanceof Error ? err.message : String(err)}\n将使用手动输入模式`,
      "warning",
    );
    return null;
  }
}

/** 格式化候选信息用于展示 */
function formatCandidate(c: ModelCandidate): string {
  const ctx = c.contextLength ?? 0;
  const ctxStr = ctx >= 1000000
    ? `${(ctx / 1000000).toFixed(1)}M`
    : ctx >= 1000 ? `${(ctx / 1000).toFixed(0)}K` : ctx > 0 ? String(ctx) : "?";
  const mods = c.inputModalities?.join("+") || "text";
  const cost = c.cost;
  const priceStr = cost
    ? `¥${cost.input.toFixed(2)}/${cost.output.toFixed(2)}`
    : "价格未知";
  return `${c.providerName} | ${ctxStr} ctx | ${mods} | ${priceStr}`;
}

/**
 * 让用户为每个模型选择对应的 models.dev 配置
 */
async function showModelSelector(
  ctx: ExtensionCommandContext,
  candidates: ModelWithCandidates[],
): Promise<MatchedModel[]> {
  if (candidates.length === 0) {
    ctx.ui.notify("API 返回的模型列表为空", "warning");
    return [];
  }

  // 总览
  const hasCand = candidates.filter(c => c.candidates.length > 0).length;
  const noCand = candidates.length - hasCand;

  const overviewLines = candidates.map(c => {
    if (c.candidates.length > 0) {
      const best = c.candidates[0];
      return `  ✓ ${c.modelId} → ${best.providerName}${best.cost ? ` (¥${best.cost.input.toFixed(2)}/${best.cost.output.toFixed(2)})` : ""}`;
    }
    if (c.baseModelCandidates.length > 0) {
      return `  ~ ${c.modelId} → 基础定义: ${c.baseModelCandidates[0].slug}`;
    }
    return `  ✗ ${c.modelId}（无候选）`;
  });

  const choice = await ctx.ui.select(
    `发现 ${candidates.length} 个模型（${hasCand} 个有供应商配置，${noCand} 个无候选）\n${overviewLines.join("\n")}\n\n如何处理？`,
    [
      "✅ 全部接受最佳候选（有候选的自动填充，无候选的用默认值）",
      "✏️  逐个配置（为每个模型选择对应的供应商/配置）",
      "🔧 只选部分模型（先筛选要哪些）",
      "❌ 取消",
    ],
  );

  if (!choice || choice.startsWith("❌")) return [];

  if (choice.startsWith("✅")) {
    // 全部接受最佳候选
    const results: MatchedModel[] = [];
    for (const c of candidates) {
      const best = c.candidates[0] || null;
      results.push(await buildMatchedModel(c.modelId, best));
    }
    return results;
  }

  if (choice.startsWith("🔧")) {
    const input = await ctx.ui.input(
      "输入要添加的模型名（逗号分隔，留空表示全部）",
      candidates.map(c => c.modelId).slice(0, 10).join(", "),
    );
    let selectedIds: string[];
    if (!input) {
      selectedIds = candidates.map(c => c.modelId);
    } else {
      selectedIds = input.split(/[,，、]/).map(s => s.trim()).filter(Boolean);
    }
    candidates = candidates.filter(c => selectedIds.includes(c.modelId));
  }

  // 逐个配置
  const results: MatchedModel[] = [];
  for (const c of candidates) {
    if (c.candidates.length === 0 && c.baseModelCandidates.length === 0) {
      results.push(await buildMatchedModel(c.modelId, null));
      continue;
    }

    // 构建选项：供应商候选 + 基础定义候选 + 无匹配
    const options: string[] = c.candidates.map(m =>
      `📦 ${formatCandidate(m)}`
    );
    for (const bc of c.baseModelCandidates) {
      options.push(`📋 基础定义: ${bc.slug}`);
    }
    options.push("✗ 无匹配 / 手动配置（使用默认值）");

    const selected = await ctx.ui.select(
      `模型 "${c.modelId}" 选择对应的配置：`,
      options,
    );

    if (!selected || selected.startsWith("✗")) {
      results.push(await buildMatchedModel(c.modelId, null));
    } else if (selected.startsWith("📦")) {
      const idx = options.indexOf(selected);
      if (idx >= 0 && idx < c.candidates.length) {
        results.push(await buildMatchedModel(c.modelId, c.candidates[idx]));
      } else {
        results.push(await buildMatchedModel(c.modelId, null));
      }
    } else if (selected.startsWith("📋")) {
 // 基础定义候选，构造一个临时 candidate
      const idx = options.indexOf(selected) - c.candidates.length;
      if (idx >= 0 && idx < c.baseModelCandidates.length) {
        const bc = c.baseModelCandidates[idx];
        results.push(await buildMatchedModel(c.modelId, {
          providerId: "base",
          providerName: "base",
          path: bc.path,
          baseModel: bc.slug,
        }));
      } else {
        results.push(await buildMatchedModel(c.modelId, null));
      }
    } else {
      results.push(await buildMatchedModel(c.modelId, null));
    }
  }

  return results;
}

// ─── TUI 交互 ───────────────────────────────────────

/**
 * 处理多 key 分组：检测同域名的已有 provider，让用户选择
 */
async function handleMultiKeyGrouping(
  ctx: ExtensionCommandContext,
  info: FastAddInfo,
  overlappingProviders: ExistingProvider[],
): Promise<FastAddAction> {
  if (overlappingProviders.length === 0) {
    // 无重叠，直接确认
    return showNewProviderConfirmation(ctx, info);
  }

  // 有重叠，让用户选择
  const options = overlappingProviders.map(p => {
    const authEntry = loadAuthData()[p.id] as { key?: string } | undefined;
    return `🔀 追加到 "${p.id}"（${authEntry?.key ? maskKey(authEntry.key) : "无 Key"}）`;
  });
  options.push(`📦 新建分组（不同的 Key 或别名）`);
  options.push(`⏭  跳过`);

  const choice = await ctx.ui.select(
    `检测到同域名的 ${overlappingProviders.length} 个已有供应商：\n${overlappingProviders.map(p => `  • ${p.id} (${p.baseUrl})`).join("\n")}\n\n如何处理？`,
    options,
  );

  if (!choice || choice.startsWith("⏭")) return { kind: "cancel" };

  if (choice.startsWith("📦")) {
    // 新建分组
    const defaultName = `${info.providerId}-${overlappingProviders.length + 1}`;
    const newName = await ctx.ui.input("输入新分组的标识符", defaultName);
    if (!newName) return { kind: "cancel" };
    return { kind: "rename", newId: newName };
  }

  // 追加到已有分组
  const match = choice.match(/追加到 "([^"]+)"/);
  if (match) {
    const targetId = match[1];
    const existingAuth = loadAuthData();
    const existingKey = existingAuth[targetId] as { key?: string } | undefined;
    let keyAction: "replace" | "keep" = "keep";

    if (info.apiKey && existingKey?.key && info.apiKey !== existingKey.key) {
      const keyChoice = await ctx.ui.select(
        `API Key 冲突：\n现有 Key: ${maskKey(existingKey.key)}\n新   Key: ${maskKey(info.apiKey)}\n`,
        ["替换为新的 Key", "保留现有的 Key"],
      );
      if (!keyChoice) return { kind: "cancel" };
      keyAction = keyChoice.startsWith("替换") ? "replace" : "keep";
    }

    return { kind: "merge", targetId, keyAction };
  }

  return { kind: "cancel" };
}

/**
 * 新供应商确认对话框
 */
async function showNewProviderConfirmation(
  ctx: ExtensionCommandContext,
  info: FastAddInfo,
): Promise<FastAddAction> {
  const modelCount = info.modelOverrides?.length || info.models.length;
  const summaryLines = [
    `📡 地址:     ${info.url}`,
    `🏷️  标识符:   ${info.providerId}`,
    `🧠 模型:     ${modelCount} 个`,
    info.apiKey
      ? `🔑 API Key:  ${maskKey(info.apiKey)}`
      : `🔑 API Key:  （未提供，可后续用 /login 配置）`,
    ``,
    `将写入:`,
    `  • ${CONFIG_PATH}`,
    `  • ${AUTH_PATH}`,
  ];

  const choice = await ctx.ui.select(
    `确认添加供应商？\n${summaryLines.join("\n")}`,
    ["✅ 确认添加", "✏️  修改标识符", "❌ 取消"],
  );

  if (!choice || choice.startsWith("❌")) return { kind: "cancel" };
  if (choice.startsWith("✏️")) {
    const newName = await ctx.ui.input("输入自定义标识符", info.providerId);
    if (!newName) return { kind: "cancel" };
    return { kind: "rename", newId: newName };
  }
  return { kind: "confirm" };
}

function formatModels(models: unknown): string {
  if (typeof models === "string") return models;
  if (Array.isArray(models)) return models.map(m => {
    if (typeof m === "object" && m && "id" in m) return String((m as Record<string, unknown>).id);
    return String(m);
  }).join(", ");
  return String(models || "（无）");
}

// ─── TOML 写入工具 ──────────────────────────────────

function tomlModel(m: ModelOverride): Record<string, unknown> {
  const result: Record<string, unknown> = { id: m.id };
  if (m.name !== undefined && m.name !== m.id) result.name = m.name;
  if (m.contextWindow !== undefined) result.context_window = m.contextWindow;
  if (m.maxTokens !== undefined) result.max_tokens = m.maxTokens;
  if (m.costInput !== undefined && m.costInput > 0) result.cost_input = m.costInput;
  if (m.costOutput !== undefined && m.costOutput > 0) result.cost_output = m.costOutput;
  if (m.costCacheRead !== undefined && m.costCacheRead > 0) result.cost_cache_read = m.costCacheRead;
  if (m.costCacheWrite !== undefined && m.costCacheWrite > 0) result.cost_cache_write = m.costCacheWrite;
  if (m.reasoning !== undefined) result.reasoning = m.reasoning;
  if (m.input !== undefined && m.input.length > 1) result.input = m.input;
  return result;
}

function tomlDefaults(d: NonNullable<FastAddInfo["defaults"]>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  if (d.contextWindow !== undefined) result.context_window = d.contextWindow;
  if (d.maxTokens !== undefined) result.max_tokens = d.maxTokens;
  if (d.costInput !== undefined) result.cost_input = d.costInput;
  if (d.costOutput !== undefined) result.cost_output = d.costOutput;
  if (d.costCacheRead !== undefined) result.cost_cache_read = d.costCacheRead;
  if (d.costCacheWrite !== undefined) result.cost_cache_write = d.costCacheWrite;
  if (d.reasoning !== undefined) result.reasoning = d.reasoning;
  if (d.input !== undefined) result.input = d.input;
  return result;
}

// ─── 写入执行 ───────────────────────────────────────

async function applyAndRegister(
  pi: ExtensionAPI,
  info: FastAddInfo,
  action: Exclude<FastAddAction, { kind: "cancel" }>,
): Promise<{ success: boolean; message: string }> {
  const providerId =
    action.kind === "rename" ? action.newId
    : action.kind === "merge" ? action.targetId
    : info.providerId;

  const isMerge = action.kind === "merge";

  try {
    // ── providers.toml ──
    let configData: { providers: Array<Record<string, unknown>> };

    try {
      const raw = readFileSync(CONFIG_PATH, "utf8");
      configData = parse(raw) as { providers: Array<Record<string, unknown>> };
      if (!Array.isArray(configData.providers)) configData.providers = [];
    } catch {
      configData = { providers: [] };
    }

    const newModels: ModelOverride[] = info.modelOverrides && info.modelOverrides.length > 0
      ? info.modelOverrides
      : info.models.map(id => ({ id }));

    // 用于注册到 Pi 的完整模型列表（merge 时包含已有模型）
    let allModelsForRegister: ModelOverride[] = [...newModels];

    if (isMerge) {
      const existing = configData.providers.find(p => p.id === providerId);
      if (existing) {
        const existingModels = existing.models;
        const existingIds = new Set<string>();
        const existingOverrides: ModelOverride[] = [];

        // 提取已有模型
        if (Array.isArray(existingModels)) {
          for (const m of existingModels) {
            if (typeof m === "object" && m && "id" in m) {
              const id = String((m as Record<string, unknown>).id);
              existingIds.add(id);
              existingOverrides.push({
                id,
                name: (m as Record<string, unknown>).name as string | undefined,
                contextWindow: (m as Record<string, unknown>).context_window as number | undefined,
                maxTokens: (m as Record<string, unknown>).max_tokens as number | undefined,
                costInput: (m as Record<string, unknown>).cost_input as number | undefined,
                costOutput: (m as Record<string, unknown>).cost_output as number | undefined,
                costCacheRead: (m as Record<string, unknown>).cost_cache_read as number | undefined,
                costCacheWrite: (m as Record<string, unknown>).cost_cache_write as number | undefined,
                reasoning: (m as Record<string, unknown>).reasoning as boolean | undefined,
                input: (m as Record<string, unknown>).input as InputCapability[] | undefined,
              });
            }
          }
        } else if (typeof existingModels === "string") {
          existingModels.split(/[,，、]+/).map(s => s.trim()).forEach(id => {
            existingIds.add(id);
            existingOverrides.push({ id });
          });
        }

        // 过滤出新模型（不在已有列表中的）
        const freshModels = newModels.filter(m => !existingIds.has(m.id));

        // 写入 TOML：追加新模型
        if (freshModels.length > 0) {
          if (Array.isArray(existingModels)) {
            existing.models = [...existingModels, ...freshModels.map(m => tomlModel(m))];
          } else if (typeof existingModels === "string" && existingModels.trim()) {
            const ids = existingModels.split(/[,，、]+/).map(s => s.trim());
            const allIds = [...ids, ...freshModels.map(m => m.id)];
            existing.models = allIds.join(", ");
          } else {
            existing.models = freshModels.map(m => tomlModel(m));
          }
        }

        if (!existing.api || existing.api === "auto") {
          existing.api = info._chosenApi || "openai-old";
        }

        // 合并已有模型 + 新模型（新模型覆盖同 id 的已有模型参数）
        const mergedMap = new Map<string, ModelOverride>();
        for (const m of existingOverrides) mergedMap.set(m.id, m);
        for (const m of newModels) mergedMap.set(m.id, m); // 新模型优先
        allModelsForRegister = [...mergedMap.values()];
      }
    } else {
      const newEntry: Record<string, unknown> = {
        id: providerId,
        base_url: info.url,
        api: info._chosenApi || "openai-old",
        models: newModels.map(m => tomlModel(m)),
      };
      configData.providers.push(newEntry);
    }

    writeFileSync(CONFIG_PATH, stringify(configData), "utf8");

    // ── auth.json ──
    if (info.apiKey) {
      let authData: Record<string, unknown> = {};
      try {
        authData = JSON.parse(readFileSync(AUTH_PATH, "utf8"));
      } catch {
        authData = {};
      }

      if (!(isMerge && action.kind === "merge" && action.keyAction === "keep")) {
        authData[providerId] = { type: "api_key", key: info.apiKey };
      }

      writeFileSync(AUTH_PATH, JSON.stringify(authData, null, 2), "utf8");
    }

    // ── 注册到 Pi ──
    const resolvedApi: "openai-responses" | "openai-completions" | "anthropic-messages" =
      info._chosenApi === "openai-new" ? "openai-responses"
      : info._chosenApi === "anthropic" ? "anthropic-messages"
      : "openai-completions";

    pi.registerProvider(providerId, {
      name: providerId,
      baseUrl: info.url,
      api: resolvedApi,
      ...(info.apiKey ? { apiKey: info.apiKey } : {}),
      authHeader: true,
      models: allModelsForRegister.map(m => ({
        id: m.id,
        name: m.name || m.id,
        api: resolvedApi,
        reasoning: m.reasoning || false,
        input: m.input || ["text"] as const,
        cost: {
          input: m.costInput || 0,
          output: m.costOutput || 0,
          cacheRead: m.costCacheRead || 0,
          cacheWrite: m.costCacheWrite || 0,
        },
        contextWindow: m.contextWindow || 128000,
        maxTokens: m.maxTokens || 4096,
      })),
    });

    const totalModels = allModelsForRegister.length;
    const newCount = newModels.length;
    return {
      success: true,
      message: isMerge
        ? `供应商 "${providerId}" 已更新（共 ${totalModels} 个模型，新增 ${newCount}）`
        : `供应商 "${providerId}" 已添加（${totalModels} 个模型）`,
    };
  } catch (err) {
    return {
      success: false,
      message: `写入失败: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

// ─── 主入口 ─────────────────────────────────────────

export async function fastAddHandler(
  args: string,
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI,
): Promise<void> {
  // 1. 解析输入
  const result = parseFastAddInput(args);
  if (!result.ok) {
    ctx.ui.notify(`❌ ${result.error}`, "error");
    return;
  }

  const info = result.data;

  // 2. 如果有 API Key，尝试从 API 发现模型
  if (info.apiKey) {
    const discovered = await discoverModels(ctx, info);
    if (discovered && discovered.length > 0) {
      // 让用户为每个模型选择配置
      const selected = await showModelSelector(ctx, discovered);
      if (selected.length === 0) {
        ctx.ui.notify("未选择任何模型，已取消", "info");
        return;
      }

      // 更新 info.models 和 info.modelOverrides
      info.models = selected.map(m => m.id);
      info.modelOverrides = selected.map(m => ({
        id: m.id,
        name: m.name !== m.id ? m.name : undefined,
        contextWindow: m.contextWindow,
        maxTokens: m.maxTokens,
        costInput: m.costInput,
        costOutput: m.costOutput,
        costCacheRead: m.costCacheRead,
        costCacheWrite: m.costCacheWrite,
        reasoning: m.reasoning,
        input: m.input,
      }));
    }
  }

  // 3. 如果 API 拉取失败，回退到手动输入
  if (!info.modelOverrides || info.modelOverrides.length === 0) {
    if (info.models.length === 0) {
      // 提示用户输入模型名
      const input = await ctx.ui.input("输入要添加的模型名（逗号分隔）", "model-name");
      if (!input) {
        ctx.ui.notify("已取消", "info");
        return;
      }
      info.models = input.split(/[,，、]/).map(s => s.trim()).filter(Boolean);
    }

    // 询问 API 格式
    const apiChoice = await ctx.ui.select("API 格式？", [
      "openai-old (Chat Completions，最通用)",
      "openai-new (OpenAI Responses)",
      "anthropic (Anthropic Messages)",
    ]);
    info._chosenApi =
      apiChoice?.startsWith("openai-old") ? "openai-old"
      : apiChoice?.startsWith("openai-new") ? "openai-new"
      : apiChoice?.startsWith("anthropic") ? "anthropic"
      : "openai-old";
  }

  // 4. 检测重叠（同域名的所有 provider）
  const existing = loadExistingToml();
  const overlapping = existing?.providers
    ? findOverlap(extractDomainId(info.url), existing.providers)
    : [];

  // 5. 处理多 key 分组
  const action = await handleMultiKeyGrouping(ctx, info, overlapping);
  if (action.kind === "cancel") {
    ctx.ui.notify("已取消", "info");
    return;
  }

  // 6. 应用
  const applyResult = await applyAndRegister(pi, info, action);
  if (applyResult.success) {
    ctx.ui.notify(`✅ ${applyResult.message}`, "info");
  } else {
    ctx.ui.notify(`❌ ${applyResult.message}`, "error");
  }
}
