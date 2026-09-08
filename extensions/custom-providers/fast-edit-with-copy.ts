/**
 * /provider:fast-edit-with-copy — 复刻已有模型到指定供应商，再微调
 *
 * 场景：某供应商上线了微调过的模型（例如 deepseek-v4 上跑微调数据的测试模型），
 * 参数基本沿用母模型，但价格 / 上下文 / 名称有差异。手抄一遍容易漏字段，
 * 这个命令把源模型的整份配置复制过来，再让你在字段菜单里微调。
 *
 * 流程：
 * 1. 选目标供应商（新模型挂在哪个 provider 下）
 * 2. 选源模型（可以是任意供应商下的模型，支持关键词过滤）
 * 3. 输入新模型 ID（默认 `<源模型ID>-ft`）
 * 4. 确认复刻内容（id / 名称 / cost_locked 不复制，do_not 可选继承）
 * 5. 进字段微调菜单（与 /provider:fast-edit 同一套字段），选「↩ 返回」即保存
 *
 * 用法：
 *   /provider:fast-edit-with-copy                                  全交互
 *   /provider:fast-edit-with-copy <目标供应商>                      预筛目标供应商
 *   /provider:fast-edit-with-copy <目标供应商> <源模型>             预筛源模型
 *   /provider:fast-edit-with-copy <目标供应商> <源模型> <新模型ID>  全参数
 *
 * 单个参数时：命中供应商则当作目标，否则当作源模型关键词。
 */

import { readFileSync, writeFileSync } from "node:fs";
import { getAgentDir, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { parse, stringify } from "smol-toml";
import { findProviderMatches, type DeletableProvider } from "./fast-del.ts";
import {
  chooseProvider,
  ensureModelsArray,
  modelFieldsMenu,
  type FastEditResult,
} from "./fast-edit.ts";
import { formatTokens } from "./provider-diff.ts";
import { vimSelect } from "../../lib/vim-select.ts";

const CONFIG_PATH = `${getAgentDir()}/providers.toml`;

/** 复刻时不继承的字段：身份字段 + 本地锁定标记 */
export const COPY_EXCLUDED_KEYS = ["id", "name", "do_not", "cost_locked"] as const;

// ─── 参数解析 ───────────────────────────────────────

export interface CopyArgs {
  /** 目标供应商标识符关键词（可空） */
  targetQuery: string;
  /** 源模型关键词（可空） */
  sourceQuery: string;
  /** 新模型 ID（可空，缺省时交互输入） */
  newId: string;
}

export function parseCopyArgs(raw: string): CopyArgs {
  const parts = raw
    .trim()
    .split(/[\s,，;；、]+/)
    .map(s => s.trim())
    .filter(Boolean);
  return {
    targetQuery: parts[0] ?? "",
    sourceQuery: parts[1] ?? "",
    newId: parts[2] ?? "",
  };
}

// ─── 模型枚举与匹配 ─────────────────────────────────

export interface ModelEntry {
  providerId: string;
  modelId: string;
  /** 选择列表用的展示标签 */
  label: string;
  /** TOML 中的原始模型记录（snake_case） */
  model: Record<string, unknown>;
}

/** 展开所有供应商下的模型（字符串形式的 models 也会展开成 { id }） */
export function collectModelEntries(
  providers: Array<Record<string, unknown>>,
): ModelEntry[] {
  const entries: ModelEntry[] = [];
  for (const provider of providers) {
    const providerId = String(provider.id ?? "");
    if (!providerId) continue;

    const raw = provider.models;
    const list: Array<Record<string, unknown>> = [];
    if (Array.isArray(raw)) {
      for (const item of raw) {
        if (item && typeof item === "object" && !Array.isArray(item)) {
          list.push(item as Record<string, unknown>);
        }
      }
    } else if (typeof raw === "string" && raw !== "auto") {
      for (const id of raw.split(/[,，、]+/).map(s => s.trim()).filter(Boolean)) {
        list.push({ id });
      }
    }

    for (const model of list) {
      const modelId = String(model.id ?? "");
      if (!modelId) continue;
      const name = typeof model.name === "string" && model.name !== modelId
        ? ` (${model.name})`
        : "";
      entries.push({
        providerId,
        modelId,
        label: `${providerId} / ${modelId}${name}`,
        model,
      });
    }
  }
  return entries;
}

/** 按模型 ID / 名称 / 供应商 ID 做大小写不敏感的包含匹配；空 query 返回全部 */
export function filterModelEntries(entries: ModelEntry[], query: string): ModelEntry[] {
  const normalized = query.trim().toLocaleLowerCase();
  if (!normalized) return entries;
  return entries.filter(entry =>
    [
      entry.modelId,
      entry.providerId,
      typeof entry.model.name === "string" ? entry.model.name : "",
    ].some(value => value.toLocaleLowerCase().includes(normalized)),
  );
}

// ─── 复制逻辑 ───────────────────────────────────────

function cloneValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(cloneValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, inner]) => [key, cloneValue(inner)]),
    );
  }
  return value;
}

export interface CopyModelOptions {
  /** 继承的 do_not 保护；缺省不继承 */
  doNot?: string[];
}

/**
 * 复刻源模型配置：除 id / 名称 / do_not / cost_locked 外逐字段深拷贝，
 * id 用新模型 ID，名称留给用户自己定（默认回退成新 ID）。
 */
export function buildCopiedModel(
  source: Record<string, unknown>,
  newId: string,
  options: CopyModelOptions = {},
): Record<string, unknown> {
  const copy: Record<string, unknown> = { id: newId };
  for (const [key, value] of Object.entries(source)) {
    if ((COPY_EXCLUDED_KEYS as readonly string[]).includes(key)) continue;
    copy[key] = cloneValue(value);
  }
  if (options.doNot && options.doNot.length > 0) {
    copy.do_not = [...options.doNot];
  }
  return copy;
}

/** 一行概括复刻过来的字段，用于确认对话框 */
export function describeModelFields(model: Record<string, unknown>): string {
  const parts: string[] = [];
  if (typeof model.context_window === "number") {
    parts.push(`上下文 ${formatTokens(model.context_window)}`);
  }
  if (typeof model.max_tokens === "number") {
    parts.push(`最大输出 ${formatTokens(model.max_tokens)}`);
  }
  const costInput = typeof model.cost_input === "number" ? model.cost_input : 0;
  const costOutput = typeof model.cost_output === "number" ? model.cost_output : 0;
  if (costInput > 0 || costOutput > 0) {
    parts.push(`价格 ${costInput}/${costOutput}`);
  }
  if (typeof model.reasoning === "boolean") {
    parts.push(`推理 ${model.reasoning ? "开" : "关"}`);
  }
  if (Array.isArray(model.input)) {
    parts.push(`模态 ${model.input.join("+")}`);
  }
  if (model.cot_replay === true) parts.push("CoT 回传");
  if (model.thinking_level_map && typeof model.thinking_level_map === "object") {
    parts.push(`思考档位 ${Object.keys(model.thinking_level_map as object).length} 项`);
  }
  if (model.compat && typeof model.compat === "object") {
    parts.push(`compat ${Object.keys(model.compat as object).length} 项`);
  }
  if (Array.isArray(model.do_not) && model.do_not.length > 0) {
    parts.push(`do_not [${model.do_not.join(", ")}]`);
  }
  return parts.length > 0 ? parts.join("、") : "（无显式字段）";
}

// ─── 主入口 ─────────────────────────────────────────

export async function fastEditWithCopyHandler(
  args: string,
  ctx: ExtensionCommandContext,
): Promise<FastEditResult | null> {
  // 1. 读配置
  let config: Record<string, unknown>;
  try {
    config = parse(readFileSync(CONFIG_PATH, "utf8")) as Record<string, unknown>;
  } catch (err) {
    ctx.ui.notify(
      `读取 providers.toml 失败: ${err instanceof Error ? err.message : String(err)}`,
      "error",
    );
    return null;
  }

  const providers = Array.isArray(config.providers)
    ? (config.providers as Array<Record<string, unknown>>)
    : [];
  if (providers.length === 0) {
    ctx.ui.notify("providers.toml 中没有供应商，可用 /provider:fast-add 添加", "info");
    return null;
  }

  // 2. 解析参数；单参数时按是否命中供应商决定语义
  const parsed = parseCopyArgs(args);
  let targetQuery = parsed.targetQuery;
  let sourceQuery = parsed.sourceQuery;
  if (targetQuery && !sourceQuery) {
    const list: DeletableProvider[] = providers.map(p => ({
      id: String(p.id),
      name: typeof p.name === "string" ? p.name : undefined,
      baseUrl: typeof p.base_url === "string" ? p.base_url : undefined,
    }));
    if (findProviderMatches(list, targetQuery).length === 0) {
      sourceQuery = targetQuery;
      targetQuery = "";
    }
  }

  // 3. 目标供应商
  const target = await chooseProvider(ctx, providers, targetQuery);
  if (!target) return null;
  const targetId = String(target.id);

  const targetModels = ensureModelsArray(target);
  if (!targetModels) {
    ctx.ui.notify(
      target.models === "auto"
        ? `"${targetId}" 模型为自动拉取模式（auto），请先运行 /provider:reload-online 固定模型列表`
        : `"${targetId}" 的 models 字段格式无法编辑（当前: ${String(target.models)}）`,
      "warning",
    );
    return null;
  }

  // 4. 源模型
  const entries = collectModelEntries(providers);
  if (entries.length === 0) {
    ctx.ui.notify("providers.toml 中没有可复刻的模型", "info");
    return null;
  }

  let candidates = filterModelEntries(entries, sourceQuery);
  if (!sourceQuery && entries.length > 1) {
    const keyword = await ctx.ui.input(
      `源模型关键词（模型 ID / 名称 / 供应商，共 ${entries.length} 个模型，留空显示全部）`,
      "",
    );
    if (keyword === undefined) {
      ctx.ui.notify("已取消", "info");
      return null;
    }
    candidates = filterModelEntries(entries, keyword);
  }
  if (candidates.length === 0) {
    ctx.ui.notify(`没有匹配的源模型: ${sourceQuery}`, "info");
    return null;
  }

  let source: ModelEntry | undefined;
  if (candidates.length === 1) {
    source = candidates[0];
  } else {
    const labels = candidates.map(entry => entry.label);
    const selected = await vimSelect(ctx, `选择源模型（${candidates.length} 个）：`, labels);
    if (!selected) {
      ctx.ui.notify("已取消", "info");
      return null;
    }
    source = candidates[labels.indexOf(selected)];
  }
  if (!source) {
    ctx.ui.notify("已取消", "info");
    return null;
  }

  // 5. 新模型 ID
  let newId = parsed.newId.trim();
  if (!newId) {
    const input = await ctx.ui.input(`新模型 ID（将挂在 "${targetId}" 下）`, `${source.modelId}-ft`);
    if (!input?.trim()) {
      ctx.ui.notify("已取消", "info");
      return null;
    }
    newId = input.trim();
  }
  if (targetModels.some(model => String(model.id) === newId)) {
    ctx.ui.notify(
      `模型 "${newId}" 已存在于 "${targetId}"，如需改参数请用 /provider:fast-edit`,
      "warning",
    );
    return null;
  }

  // 6. do_not 继承（源模型有保护才问）
  const sourceDoNot = Array.isArray(source.model.do_not)
    ? source.model.do_not.filter((action): action is string => typeof action === "string")
    : [];
  let doNot: string[] = [];
  let doNotNote = "不继承";
  if (sourceDoNot.length > 0) {
    const choice = await ctx.ui.select(
      `源模型带 do_not 保护 [${sourceDoNot.join(", ")}]，新模型是否继承？`,
      [
        "不继承（新模型可自由编辑 / 被在线刷新）",
        `继承 ["remove"]（防止在线刷新时被删除）`,
        `完整继承 [${sourceDoNot.join(", ")}]`,
      ],
    );
    if (!choice) {
      ctx.ui.notify("已取消", "info");
      return null;
    }
    if (choice.startsWith("继承")) {
      doNot = ["remove"];
      doNotNote = `继承 ["remove"]`;
    } else if (choice.startsWith("完整继承")) {
      doNot = [...sourceDoNot];
      doNotNote = `完整继承 [${sourceDoNot.join(", ")}]`;
    }
  }

  // 7. 确认
  const copied = buildCopiedModel(source.model, newId);
  const sourceProvider = providers.find(p => String(p.id) === source!.providerId);
  const sourceApi = typeof sourceProvider?.api === "string" ? sourceProvider.api : "";
  const targetApi = typeof target.api === "string" ? target.api : "";
  const apiWarning = sourceApi && targetApi && sourceApi !== targetApi
    ? `\n⚠️ 源供应商 API 格式 (${sourceApi}) 与目标 (${targetApi}) 不同，compat 可能不适用`
    : "";

  const summary = [
    `源模型:     ${source.providerId} / ${source.modelId}`,
    `目标供应商: ${targetId}`,
    `新模型 ID:  ${newId}`,
    `复刻字段:   ${describeModelFields(copied)}`,
    `不复制:     id / 名称 / cost_locked（名称默认用新 ID）`,
    `do_not:     ${doNotNote}`,
  ].join("\n");

  const choice = await ctx.ui.select(
    `确认复刻？\n${summary}${apiWarning}`,
    ["✅ 复制并微调参数", "💾 直接保存", "❌ 取消"],
  );
  if (!choice || choice.startsWith("❌")) {
    ctx.ui.notify("已取消", "info");
    return null;
  }

  // 8. 微调（先编辑、后应用 do_not，避免 do_not=edit 把菜单自己锁死）
  if (choice.startsWith("✅")) {
    await modelFieldsMenu(ctx, target, copied, {
      allowDelete: false,
      title: `微调 "${newId}"（改完选「↩ 返回」保存）：`,
    });
  }
  if (doNot.length > 0) copied.do_not = doNot;

  // 9. 落盘
  targetModels.push(copied);
  try {
    writeFileSync(CONFIG_PATH, stringify(config), "utf8");
  } catch (err) {
    ctx.ui.notify(
      `写回 providers.toml 失败: ${err instanceof Error ? err.message : String(err)}`,
      "error",
    );
    return null;
  }

  return {
    changed: true,
    summary: `模型 "${newId}" 已从 "${source.providerId} / ${source.modelId}" 复刻到 "${targetId}"`,
  };
}
