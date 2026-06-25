/**
 * /provider fast-add — 一行命令快速添加自定义供应商
 *
 * 格式：/provider fast-add <URL>[分隔符]<模型名>[分隔符]<API Key>
 * 分隔符：;  ；  ,  ，  、  （空格兜底）
 *
 * 示例：
 *   /provider fast-add https://tokenflux.dev/v1;deepseek-v4-flash;tp-xxxx
 *   /provider fast-add https://api.groq.com/openai/v1;llama-3-70b;sk-xxx
 *   /provider fast-add https://api.xyz.com;model-a,model-b  （无 Key）
 */

import { writeFileSync, readFileSync } from "node:fs";
import {
  getAgentDir,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ProviderConfig,
  type ProviderModelConfig,
} from "@earendil-works/pi-coding-agent";
import { parse, stringify } from "smol-toml";

// ─── 类型 ───────────────────────────────────────────

export interface FastAddInfo {
  url: string;
  providerId: string;
  providerName: string;
  models: string[];
  apiKey?: string;
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
const PLACEHOLDER_MODEL = "auto-detect";

// ─── 解析引擎 ───────────────────────────────────────

/** 按优先级尝试拆解剩余字符串 */
function splitByDelimiters(text: string): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];

  if (/[;；]/.test(trimmed)) {
    return trimmed.split(/[;；]+/).map(s => s.trim()).filter(Boolean);
  }
  if (/[,，、]/.test(trimmed)) {
    return trimmed.split(/[,，、]+/).map(s => s.trim()).filter(Boolean);
  }
  const spaced = trimmed.split(/\s+/).map(s => s.trim()).filter(Boolean);
  if (spaced.length > 0) return spaced;

  return [trimmed];
}

/** 判断字符串是否像 API Key */
function looksLikeApiKey(s: string): boolean {
  // 常见前缀
  if (/^(sk-|sk-ant-|sk-or-|tp-|api-|pk-|eyJ)/i.test(s)) return true;
  // 长乱序字符串（20 位以上，只含合法字符）
  if (s.length >= 20 && /^[a-zA-Z0-9_\-./=]+$/.test(s)) return true;
  return false;
}

/** 从 URL 提取默认供应商标识符 */
export function extractDomainId(url: string): string {
  try {
    const hostname = new URL(url).hostname;
    let domain = hostname.replace(/^(api|www|v1|v2)\./i, "");
    const parts = domain.split(".");
    if (parts.length >= 2) return parts[0];
    return domain;
  } catch {
    const match = url.match(/https?:\/\/([^/]+)/);
    if (match) return match[1].split(".")[0];
    return "custom-provider";
  }
}

/** 解析用户原始输入 */
export function parseFastAddInput(raw: string): { ok: true; data: FastAddInfo } | { ok: false; error: string } {
  const input = raw.trim();
  if (!input) return { ok: false, error: "输入不能为空" };

  // 1. 提取 URL（支持无协议头自动补全）
  let urlMatch = input.match(/(https?:\/\/[^\s;,，；、]+)/i);
  if (!urlMatch) {
    // 尝试补 https://
    const domainMatch = input.match(
      /^([a-zA-Z0-9][-a-zA-Z0-9]*\.[a-zA-Z]{2,}(:\d+)?(\/[-a-zA-Z0-9%@!~#=_+/.:,]*)?)/,
    );
    if (domainMatch && domainMatch.index === 0) {
      const withProtocol = `https://${domainMatch[1]}`;
      return parseFastAddInput(input.replace(domainMatch[1], withProtocol));
    }
    return { ok: false, error: "未检测到有效的 API 地址，需包含 http:// 或 https://" };
  }

  const url = urlMatch[1].replace(/\/+$/, "");

  // 2. 移除 URL，解析剩余部分
  const remaining = input.slice(urlMatch.index! + urlMatch[0].length).trim();
  const parts = splitByDelimiters(remaining);

  if (parts.length === 0) {
    return { ok: false, error: "未检测到模型名称。格式：<URL>;<模型名>[;<API Key>]" };
  }

  // 3. 区分模型名和 API Key
  let models: string[] = [];
  let apiKey: string | undefined;

  const keyCandidates = parts
    .map((p, i) => (looksLikeApiKey(p) ? i : -1))
    .filter(i => i >= 0);

  if (keyCandidates.length > 0) {
    // 取最后一个像 Key 的（避免模型名误判）
    const keyIdx = keyCandidates[keyCandidates.length - 1];
    apiKey = parts[keyIdx];
    const modelParts = parts.filter((_, i) => i !== keyIdx);
    models = modelParts.flatMap(p => p.split(/[,，、]+/).map(m => m.trim())).filter(Boolean);
  } else {
    models = parts.flatMap(p => p.split(/[,，、]+/).map(m => m.trim())).filter(Boolean);
  }

  // 去重
  models = [...new Set(models)];

  if (models.length === 0) {
    return { ok: false, error: "未检测到有效的模型名称" };
  }

  const providerId = extractDomainId(url);

  return {
    ok: true,
    data: {
      url,
      providerId,
      providerName: providerId,
      models,
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
        baseUrl: (p.base_url as string) ?? "",
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
): ExistingProvider | undefined {
  return existing.find(p => {
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

// ─── TUI 交互 ───────────────────────────────────────

function maskKey(key: string): string {
  if (key.length <= 8) return key;
  return key.slice(0, 6) + "…" + key.slice(-4);
}

/** 显示确认或合并对话框，返回用户操作意图 */
async function showConfirmationOrMerge(
  ctx: ExtensionCommandContext,
  info: FastAddInfo,
  overlap: ExistingProvider | undefined,
): Promise<FastAddAction> {
  if (overlap) {
    // ── 重叠：弹出合并对话框 ──
    const mergeChoice = await ctx.ui.select(
      `供应商 "${overlap.id}" 已存在（${overlap.baseUrl}）\n现有模型: ${formatModels(overlap.models)}\n新增模型: ${info.models.join("、")}\n如何处理？`,
      [
        `🔀 合并 — 将新模型追加到 "${overlap.id}"`,
        `📦 新建 — 以其他名称创建`,
        `⏭  跳过 — 什么也不做`,
      ],
    );
    if (!mergeChoice || mergeChoice.startsWith("⏭")) return { kind: "cancel" };

    if (mergeChoice.startsWith("🔀")) {
      // Key 冲突处理
      const existingAuth = loadAuthData();
      const existingKey = existingAuth[overlap.id] as { key?: string } | undefined;
      let keyAction: "replace" | "keep" = "keep";

      if (info.apiKey && existingKey?.key) {
        const keyChoice = await ctx.ui.select(
          `API Key 冲突：\n现有 Key: ${maskKey(existingKey.key)}\n新   Key: ${maskKey(info.apiKey)}\n`,
          ["替换为新的 Key", "保留现有的 Key"],
        );
        if (!keyChoice) return { kind: "cancel" };
        keyAction = keyChoice.startsWith("替换") ? "replace" : "keep";
      }

      return { kind: "merge", targetId: overlap.id, keyAction };
    }

    if (mergeChoice.startsWith("📦")) {
      const newName = await ctx.ui.input("输入新的供应商标识符", `${info.providerId}-2`);
      if (!newName) return { kind: "cancel" };
      return { kind: "rename", newId: newName };
    }

    return { kind: "cancel" };
  }

  // ── 无重叠：确认对话框 ──
  const summaryLines = [
    `📡 地址:     ${info.url}`,
    `🏷️  标识符:   ${info.providerId}`,
    `🧠 模型:     ${info.models.join(", ")}`,
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
  if (Array.isArray(models)) return models.map(m => (typeof m === "object" && m ? (m as any).id ?? JSON.stringify(m) : String(m))).join(", ");
  return String(models ?? "（无）");
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

    if (isMerge) {
      const existing = configData.providers.find(p => p.id === providerId);
      if (existing) {
        const existingModels = existing.models;
        const newModels = info.models.filter(m => {
          if (typeof existingModels === "string") {
            return !existingModels.split(/[,，、]+/).map(s => s.trim()).includes(m);
          }
          return true;
        });
        if (newModels.length > 0) {
          if (typeof existingModels === "string" && existingModels.trim()) {
            existing.models = `${existingModels}, ${newModels.join(", ")}`;
          } else {
            existing.models = newModels.join(", ");
          }
        }
      }
    } else {
      configData.providers.push({
        id: providerId,
        base_url: info.url,
        api: "auto",
        models: info.models.join(", "),
      });
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

      if (isMerge && action.kind === "merge" && action.keyAction === "keep") {
        // 跳过 Key 写入
      } else {
        authData[providerId] = { type: "api_key", key: info.apiKey };
      }

      writeFileSync(AUTH_PATH, JSON.stringify(authData, null, 2), "utf8");
    }

    // ── 注册到 Pi（占位模式，懒激活）──
    const guessedApi: ProviderModelConfig["api"] = "openai-responses";
    pi.registerProvider(providerId, {
      name: providerId,
      baseUrl: info.url,
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

    return {
      success: true,
      message: isMerge
        ? `供应商 "${providerId}" 已更新，新增模型: ${info.models.join("、")}`
        : `供应商 "${providerId}" 已添加（${info.models.length} 个模型），首次使用时自动检测 API 格式`,
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
  // 1. 解析
  const result = parseFastAddInput(args);
  if (!result.ok) {
    ctx.ui.notify(`❌ ${result.error}`, "error");
    return;
  }

  const info = result.data;

  // 2. 检测重叠
  const existing = loadExistingToml();
  const overlap = existing?.providers
    ? findOverlap(info.providerId, existing.providers)
    : undefined;

  // 3. TUI 确认
  const action = await showConfirmationOrMerge(ctx, info, overlap);
  if (action.kind === "cancel") {
    ctx.ui.notify("已取消", "info");
    return;
  }

  // 4. 应用
  const applyResult = await applyAndRegister(pi, info, action);
  if (applyResult.success) {
    ctx.ui.notify(`✅ ${applyResult.message}`, "info");
  } else {
    ctx.ui.notify(`❌ ${applyResult.message}`, "error");
  }
}
