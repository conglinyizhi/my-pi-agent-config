/**
 * models.dev 集成 — 直接从 GitHub 仓库读取 providers/ 和 models/ 目录的 TOML 文件
 *
 * 数据结构：
 *   models/<lab>/<model>.toml           — 模型基础定义（上下文长度、模态、推理能力等）
 *   providers/<id>/provider.toml        — 供应商信息（API 地址、npm 包）
 *   providers/<id>/models/<model>.toml  — 供应商下特定模型的定价 + reasoning 配置
 *
 * 同一个模型名在不同供应商下的定价可能不同，所以让用户选择对应的供应商。
 */

import { parse } from "smol-toml";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { InputCapability } from "./types.ts";

// ─── 类型定义 ───────────────────────────────────────

export interface ProviderInfo {
  id: string;
  name?: string;
  apiBaseUrl?: string;
  npm?: string;
  doc?: string;
}

export interface ModelBaseDef {
  name: string;
  contextLength: number;
  maxOutput: number;
  inputModalities: string[];
  reasoning: boolean;
  toolCall: boolean;
}

export interface ProviderModelDef {
  providerId: string;
  modelId: string;
  baseModel?: string;
  name?: string;
  cost?: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  };
  reasoning?: boolean;
  contextLength?: number;
  maxOutput?: number;
  inputModalities?: string[];
}

export interface MatchedModel {
  id: string;
  name: string;
  contextWindow: number;
  maxTokens: number;
  input: InputCapability[];
  costInput: number;
  costOutput: number;
  costCacheRead: number;
  costCacheWrite: number;
  reasoning: boolean;
  source: string;
}

// ─── 静态回退数据 ───────────────────────────────────

interface StaticData {
  version: number;
  providerModelPaths: Record<string, string[]>;
  baseModelPaths: Record<string, string>;
  providerIds: string[];
  baseModelTomls: Record<string, string>;
}

let staticData: StaticData | null = null;

function loadStaticData(): StaticData | null {
  if (staticData) return staticData;
  try {
    const paths = ["./models-dev-static.json", "./extensions/custom-providers/models-dev-static.json"];
    for (const p of paths) {
      try {
        const raw = readFileSync(p, "utf8");
        staticData = JSON.parse(raw) as StaticData;
        return staticData;
      } catch {}
    }
  } catch {}
  return null;
}

// ─── 仓库 tree 缓存 ─────────────────────────────────

const REPO_OWNER = "anomalyco";
const REPO_BRANCH = "dev";
const RAW_BASE = `https://raw.githubusercontent.com/${REPO_OWNER}/models.dev/${REPO_BRANCH}`;

interface RepoTree {
  providerModelPaths: Map<string, string[]>; // modelId → provider paths
  baseModelPaths: Map<string, string>;       // modelSlug → base model path
  providerIds: Set<string>;
}

let cachedTree: RepoTree | null = null;
let cacheTimestamp = 0;
const CACHE_TTL = 24 * 60 * 60 * 1000;

// ─── Tree 获取与解析 ────────────────────────────────

async function fetchRepoTree(): Promise<RepoTree> {
  const now = Date.now();
  if (cachedTree && now - cacheTimestamp < CACHE_TTL) {
    return cachedTree;
  }

  // 尝试从 GitHub API 获取
  try {
    const url = `https://api.github.com/repos/${REPO_OWNER}/models.dev/git/trees/${REPO_BRANCH}?recursive=1`;
    const res = await fetch(url, {
      headers: { Accept: "application/vnd.github+json" },
      signal: AbortSignal.timeout(20000),
    });
    if (res.ok) {
      const data = (await res.json()) as { tree?: Array<{ path: string }> };
      if (Array.isArray(data.tree)) {
        const tree = parseTreePaths(data.tree.map(t => t.path));
        cachedTree = tree;
        cacheTimestamp = now;
        return tree;
      }
    }
  } catch {
    // 网络失败，回退到静态数据
  }

  // 回退到静态 JSON
  const staticData = loadStaticData();
  if (staticData) {
    const tree = parseTreePaths(
      // 从静态数据重建路径列表
      Object.values(staticData.providerModelPaths).flat()
        .concat(Object.values(staticData.baseModelPaths))
    );
    cachedTree = tree;
    cacheTimestamp = now;
    return tree;
  }

  throw new Error("无法获取 models.dev tree（网络失败且无静态数据）");
}

/** 从路径列表解析 tree 结构 */
function parseTreePaths(paths: string[]): RepoTree {
  const providerModelPaths = new Map<string, string[]>();
  const baseModelPaths = new Map<string, string>();
  const providerIds = new Set<string>();

  for (const path of paths) {
    const providerMatch = path.match(/^providers\/([^/]+)\/models\/(.+)\.toml$/);
    if (providerMatch) {
      const [, providerId, modelPath] = providerMatch;
      const modelId = modelPath.split("/").pop()!;
      if (!providerModelPaths.has(modelId)) {
        providerModelPaths.set(modelId, []);
      }
      providerModelPaths.get(modelId)!.push(path);
      providerIds.add(providerId);
      continue;
    }

    const baseMatch = path.match(/^models\/([^/]+)\/(.+)\.toml$/);
    if (baseMatch) {
      const modelSlug = baseMatch[2].toLowerCase();
      if (!baseModelPaths.has(modelSlug)) {
        baseModelPaths.set(modelSlug, path);
      }
    }
  }

  return { providerModelPaths, baseModelPaths, providerIds };
}

// ─── TOML 文件读取 ──────────────────────────────────

async function fetchToml(path: string): Promise<Record<string, unknown>> {
  // 如果是 models/ 目录下的基础定义，先查静态 JSON
  if (path.startsWith("models/")) {
    const staticData = loadStaticData();
    if (staticData?.baseModelTomls?.[path]) {
      return parse(staticData.baseModelTomls[path]) as Record<string, unknown>;
    }
  }

  // 从 GitHub raw 读取
  const url = `${RAW_BASE}/${path}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} for ${path}`);
  }
  const text = await res.text();
  return parse(text) as Record<string, unknown>;
}

// ─── 供应商信息 ─────────────────────────────────────

const providerInfoCache = new Map<string, ProviderInfo>();

async function getProviderInfo(providerId: string): Promise<ProviderInfo> {
  if (providerInfoCache.has(providerId)) {
    return providerInfoCache.get(providerId)!;
  }
  try {
    const toml = await fetchToml(`providers/${providerId}/provider.toml`);
    const info: ProviderInfo = {
      id: providerId,
      name: toml.name as string | undefined,
      apiBaseUrl: toml.api as string | undefined,
      npm: toml.npm as string | undefined,
      doc: toml.doc as string | undefined,
    };
    providerInfoCache.set(providerId, info);
    return info;
  } catch {
    const info: ProviderInfo = { id: providerId };
    providerInfoCache.set(providerId, info);
    return info;
  }
}

// ─── 模型定义解析 ───────────────────────────────────

function parseModalities(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw as string[];
  return ["text"];
}

function toInputCapabilities(mods: string[]): InputCapability[] {
  const caps: InputCapability[] = [];
  if (mods.includes("text")) caps.push("text");
  if (mods.includes("image")) caps.push("image");
  if (caps.length === 0) caps.push("text");
  return caps;
}

/**
 * 解析供应商-模型 TOML
 */
function parseProviderModelDef(path: string, toml: Record<string, unknown>): ProviderModelDef {
  const providerId = path.match(/^providers\/([^/]+)\//)![1];
  const modelId = path.split("/").pop()!.replace(/\.toml$/, "");

  const costRaw = toml.cost as Record<string, unknown> | undefined;
  const limitRaw = toml.limit as Record<string, unknown> | undefined;
  const modsRaw = toml.modalities as Record<string, unknown> | undefined;

  return {
    providerId,
    modelId,
    baseModel: toml.base_model as string | undefined,
    name: toml.name as string | undefined,
    reasoning: toml.reasoning as boolean | undefined,
    contextLength: limitRaw?.context as number | undefined,
    maxOutput: limitRaw?.output as number | undefined,
    inputModalities: modsRaw ? parseModalities(modsRaw.input) : undefined,
    cost: costRaw ? {
      input: costRaw.input as number ?? 0,
      output: costRaw.output as number ?? 0,
      cacheRead: costRaw.cache_read as number ?? 0,
      cacheWrite: costRaw.cache_write as number ?? 0,
    } : undefined,
  };
}

/**
 * 解析基础模型 TOML
 */
function parseBaseModelDef(toml: Record<string, unknown>): ModelBaseDef {
  const limit = toml.limit as Record<string, unknown> | undefined;
  const mods = toml.modalities as Record<string, unknown> | undefined;

  return {
    name: toml.name as string,
    contextLength: (limit?.context as number) ?? 128000,
    maxOutput: (limit?.output as number) ?? 4096,
    inputModalities: mods ? parseModalities(mods.input) : ["text"],
    reasoning: (toml.reasoning as boolean) ?? false,
    toolCall: (toml.tool_call as boolean) ?? false,
  };
}

// ─── 候选列表 ───────────────────────────────────────

export interface ModelCandidate {
  providerId: string;
  providerName: string;
  path: string;
  baseModel?: string;
  cost?: { input: number; output: number; cacheRead: number; cacheWrite: number };
  // 以下字段可能直接在 provider model toml 中，也可能需要读 base model
  name?: string;
  contextLength?: number;
  maxOutput?: number;
  inputModalities?: string[];
  reasoning?: boolean;
}

export interface ModelWithCandidates {
  modelId: string;
  candidates: ModelCandidate[];
  baseModelCandidates: { slug: string; path: string }[];
}

/**
 * 为单个模型 ID 查找候选列表
 */
export async function findModelCandidates(
  modelId: string,
): Promise<ModelWithCandidates> {
  const tree = await fetchRepoTree();

  // 1. 在 providers/*/models/ 中搜索匹配
  const providerPaths = tree.providerModelPaths.get(modelId) || [];

  // 也尝试模糊匹配（去掉版本号等）
  if (providerPaths.length === 0) {
    for (const [key, paths] of tree.providerModelPaths) {
      if (key.toLowerCase() === modelId.toLowerCase() ||
          key.replace(/[-._]/g, "") === modelId.replace(/[-._]/g, "")) {
        providerPaths.push(...paths);
      }
    }
  }

  // 2. 在 models/ 中搜索基础定义
  const slug = modelId.toLowerCase();
  const baseModelCandidates: { slug: string; path: string }[] = [];
  const basePath = tree.baseModelPaths.get(slug);
  if (basePath) {
    baseModelCandidates.push({ slug, path: basePath });
  } else {
    // 模糊匹配
    for (const [key, path] of tree.baseModelPaths) {
      if (key.includes(slug) || slug.includes(key) ||
          key.replace(/[-._]/g, "") === slug.replace(/[-._]/g, "")) {
        baseModelCandidates.push({ slug: key, path });
      }
    }
  }

  // 3. 并行读取供应商模型 TOML
  const candidates: ModelCandidate[] = [];
  if (providerPaths.length > 0) {
    const results = await Promise.allSettled(
      providerPaths.map(async (path) => {
        const toml = await fetchToml(path);
        const def = parseProviderModelDef(path, toml);
        const providerInfo = await getProviderInfo(def.providerId);
        return {
          providerId: def.providerId,
          providerName: providerInfo.name || def.providerId,
          path,
          baseModel: def.baseModel,
          cost: def.cost,
          name: def.name,
          contextLength: def.contextLength,
          maxOutput: def.maxOutput,
          inputModalities: def.inputModalities,
          reasoning: def.reasoning,
        } as ModelCandidate;
      }),
    );
    for (const r of results) {
      if (r.status === "fulfilled") candidates.push(r.value);
    }
  }

  return { modelId, candidates, baseModelCandidates };
}

// ─── 构建最终模型配置 ───────────────────────────────

/**
 * 从候选构建最终的模型配置
 * 如果选中的候选有 baseModel 引用，读取基础定义补充缺失字段
 */
export async function buildMatchedModel(
  modelId: string,
  candidate: ModelCandidate | null,
): Promise<MatchedModel> {
  // 默认值
  const fallback: MatchedModel = {
    id: modelId,
    name: modelId,
    contextWindow: 128000,
    maxTokens: 4096,
    input: ["text"],
    costInput: 0,
    costOutput: 0,
    costCacheRead: 0,
    costCacheWrite: 0,
    reasoning: false,
    source: "manual",
  };

  if (!candidate) return fallback;

  // 如果有 baseModel 引用，读取基础定义
  let baseDef: ModelBaseDef | null = null;
  if (candidate.baseModel) {
    try {
      const basePath = `models/${candidate.baseModel}.toml`;
      const toml = await fetchToml(basePath);
      baseDef = parseBaseModelDef(toml);
    } catch {
      // 基础定义不存在，用候选自身字段
    }
  }

  const contextLength = candidate.contextLength ?? baseDef?.contextLength ?? 128000;
  const maxOutput = candidate.maxOutput ?? baseDef?.maxOutput ?? 4096;
  const inputModalities = candidate.inputModalities ?? baseDef?.inputModalities ?? ["text"];
  const reasoning = candidate.reasoning ?? baseDef?.reasoning ?? false;
  const name = candidate.name ?? baseDef?.name ?? modelId;
  const cost = candidate.cost;

  return {
    id: modelId,
    name,
    contextWindow: contextLength,
    maxTokens: maxOutput,
    input: toInputCapabilities(inputModalities),
    costInput: cost?.input ?? 0,
    costOutput: cost?.output ?? 0,
    costCacheRead: cost?.cacheRead ?? 0,
    costCacheWrite: cost?.cacheWrite ?? 0,
    reasoning,
    source: `${candidate.providerId}`,
  };
}

// ─── 模型列表拉取 ───────────────────────────────────

export async function fetchModelIdsFromApi(
  baseUrl: string,
  apiKey: string,
): Promise<string[]> {
  const url = baseUrl.replace(/\/+$/, "") + "/models";
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText}`);
  }
  const data = (await res.json()) as { data?: Array<{ id: string }> };
  if (!Array.isArray(data.data)) {
    throw new Error("Invalid response format");
  }
  return data.data.map(m => m.id).sort();
}

// ─── 高级 API ───────────────────────────────────────

/**
 * 从 API 拉取模型列表，并为每个模型准备候选列表
 */
export async function discoverModelsWithCandidates(
  baseUrl: string,
  apiKey: string,
): Promise<ModelWithCandidates[]> {
  const apiModels = await fetchModelIdsFromApi(baseUrl, apiKey);

  // 并行查找候选（限制并发避免 rate limit）
  const concurrency = 5;
  const results: ModelWithCandidates[] = [];

  for (let i = 0; i < apiModels.length; i += concurrency) {
    const batch = apiModels.slice(i, i + concurrency);
    const batchResults = await Promise.all(
      batch.map(id => findModelCandidates(id).catch(() => ({
        modelId: id,
        candidates: [],
        baseModelCandidates: [],
      } as ModelWithCandidates))),
    );
    results.push(...batchResults);
  }

  return results;
}
