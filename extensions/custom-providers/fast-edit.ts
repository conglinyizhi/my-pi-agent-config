/**
 * /provider:fast-edit — 交互式编辑供应商 / 模型配置
 *
 * 不用手改 providers.toml，全部走 TUI 向导：
 *
 * 1. 选择供应商（支持参数模糊匹配）
 * 2. 选择操作：
 *    - ✏️ 编辑模型参数   —— 微调现有模型（上下文、价格、推理、模态等）
 *    - ➕ 新增模型       —— 在供应商下添加新模型
 *    - 🔧 编辑供应商配置 —— 切换 API 格式（openai-old / openai-new / anthropic）、
 *                         改地址、默认参数、compat 等
 * 3. 保存后由 index.ts 复用 reload 逻辑重新注册到 pi
 *
 * 用法：/provider:fast-edit [供应商名]   （无参时列出全部供应商）
 */

import { readFileSync, writeFileSync } from "node:fs";
import { getAgentDir, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { parse, stringify } from "smol-toml";
import { findProviderMatches, type DeletableProvider } from "./fast-del.ts";

const CONFIG_PATH = `${getAgentDir()}/providers.toml`;

// ─── 字段定义 ───────────────────────────────────────

type FieldKind = "string" | "number" | "bool" | "modes" | "api";

interface FieldDef {
  key: string;
  label: string;
  kind: FieldKind;
  /** 所在子块：defaults / compat；缺省为直接字段 */
  section?: "defaults" | "compat";
  /** 必填字段（如 base_url）不可清除 */
  required?: boolean;
}

/** 模型级字段 */
const MODEL_FIELDS: FieldDef[] = [
  { key: "name", label: "名称", kind: "string" },
  { key: "context_window", label: "上下文窗口", kind: "number" },
  { key: "max_tokens", label: "最大输出", kind: "number" },
  { key: "cost_input", label: "输入价格", kind: "number" },
  { key: "cost_output", label: "输出价格", kind: "number" },
  { key: "cost_cache_read", label: "缓存读价格", kind: "number" },
  { key: "cost_cache_write", label: "缓存写价格", kind: "number" },
  { key: "reasoning", label: "推理", kind: "bool" },
  { key: "input", label: "输入模态", kind: "modes" },
  { key: "cot_replay", label: "CoT 回传", kind: "bool" },
  { key: "cost_locked", label: "锁定价格", kind: "bool" },
  { key: "supports_developer_role", label: "compat: developer role", kind: "bool", section: "compat" },
  { key: "supports_reasoning_effort", label: "compat: reasoning effort", kind: "bool", section: "compat" },
  { key: "thinking_format", label: "compat: thinking 格式", kind: "string", section: "compat" },
  { key: "force_adaptive_thinking", label: "compat: 强制自适应思考", kind: "bool", section: "compat" },
  { key: "requires_thinking_as_text", label: "compat: thinking 作为文本", kind: "bool", section: "compat" },
  { key: "requires_reasoning_content_on_assistant_messages", label: "compat: assistant 消息需 reasoning content", kind: "bool", section: "compat" },
  { key: "supports_eager_tool_input_streaming", label: "compat: 流式工具输入", kind: "bool", section: "compat" },
];

/** 供应商级字段（含 defaults / compat 子块） */
const PROVIDER_FIELDS: FieldDef[] = [
  { key: "api", label: "API 格式", kind: "api" },
  { key: "base_url", label: "API 地址", kind: "string", required: true },
  { key: "name", label: "显示名称", kind: "string" },
  { key: "cot_replay", label: "CoT 回传（provider 级）", kind: "bool" },
  { key: "context_window", label: "默认上下文窗口", kind: "number", section: "defaults" },
  { key: "max_tokens", label: "默认最大输出", kind: "number", section: "defaults" },
  { key: "input", label: "默认输入模态", kind: "modes", section: "defaults" },
  { key: "reasoning", label: "默认推理", kind: "bool", section: "defaults" },
  { key: "cost_input", label: "默认输入价格", kind: "number", section: "defaults" },
  { key: "cost_output", label: "默认输出价格", kind: "number", section: "defaults" },
  { key: "cost_cache_read", label: "默认缓存读价格", kind: "number", section: "defaults" },
  { key: "cost_cache_write", label: "默认缓存写价格", kind: "number", section: "defaults" },
  { key: "supports_developer_role", label: "compat: developer role", kind: "bool", section: "compat" },
  { key: "supports_reasoning_effort", label: "compat: reasoning effort", kind: "bool", section: "compat" },
  { key: "thinking_format", label: "compat: thinking 格式", kind: "string", section: "compat" },
  { key: "force_adaptive_thinking", label: "compat: 强制自适应思考", kind: "bool", section: "compat" },
  { key: "requires_thinking_as_text", label: "compat: thinking 作为文本", kind: "bool", section: "compat" },
  { key: "requires_reasoning_content_on_assistant_messages", label: "compat: assistant 消息需 reasoning content", kind: "bool", section: "compat" },
  { key: "supports_eager_tool_input_streaming", label: "compat: 流式工具输入", kind: "bool", section: "compat" },
];

// ─── 小工具 ─────────────────────────────────────────

function fmtValue(v: unknown): string {
  if (v === undefined || v === null) return "未设置";
  if (Array.isArray(v)) return v.join(", ");
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

/** 定位字段容器：有 section 时返回（并创建）子块对象，否则返回 target 本身 */
function fieldContainer(
  target: Record<string, unknown>,
  section: FieldDef["section"],
): Record<string, unknown> {
  if (!section) return target;
  const existing = target[section];
  if (existing && typeof existing === "object" && !Array.isArray(existing)) {
    return existing as Record<string, unknown>;
  }
  const created: Record<string, unknown> = {};
  target[section] = created;
  return created;
}

/** 读取字段当前值（含 section 定位） */
function getFieldValue(
  target: Record<string, unknown>,
  field: FieldDef,
): unknown {
  const container = field.section ? target[field.section] : target;
  if (!container || typeof container !== "object" || Array.isArray(container)) return undefined;
  return (container as Record<string, unknown>)[field.key];
}

// ─── 交互辅助 ───────────────────────────────────────

/** 数字输入：预填当前值；"clear"/"c" 清除字段；留空或非法取消 */
async function inputNumber(
  ctx: ExtensionCommandContext,
  field: FieldDef,
  current: unknown,
): Promise<{ type: "set"; value: number } | { type: "clear" } | null> {
  const raw = await ctx.ui.input(
    `${field.label}（当前: ${fmtValue(current)}；输入数字，输入 "clear" 清除该字段，留空取消）`,
    current === undefined || current === null ? "" : String(current),
  );
  if (raw === undefined) return null;
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  if (/^clear$/i.test(trimmed) || trimmed === "c") return { type: "clear" };
  const n = Number(trimmed);
  if (Number.isNaN(n)) {
    ctx.ui.notify(`"${trimmed}" 不是有效数字，已取消本次修改`, "warning");
    return null;
  }
  return { type: "set", value: n };
}

/** 文本输入：预填当前值；"clear" 清除（非必填字段）；留空取消 */
async function inputString(
  ctx: ExtensionCommandContext,
  field: FieldDef,
  current: unknown,
): Promise<{ type: "set"; value: string } | { type: "clear" } | null> {
  const raw = await ctx.ui.input(
    `${field.label}（当前: ${fmtValue(current)}${field.required ? "" : '，输入 "clear" 清除该字段'}，留空取消）`,
    current === undefined || current === null ? "" : String(current),
  );
  if (raw === undefined) return null;
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  if (!field.required && (/^clear$/i.test(trimmed) || trimmed === "c")) {
    return { type: "clear" };
  }
  return { type: "set", value: trimmed };
}

/** 布尔选择：true / false / 清除（未设置）/ 取消 */
async function inputBool(
  ctx: ExtensionCommandContext,
  field: FieldDef,
  current: unknown,
): Promise<{ type: "set"; value: boolean } | { type: "clear" } | null> {
  const choice = await ctx.ui.select(
    `${field.label}（当前: ${fmtValue(current)}）`,
    ["true", "false", "清除（未设置）", "取消"],
  );
  if (!choice || choice === "取消") return null;
  if (choice === "清除（未设置）") return { type: "clear" };
  return { type: "set", value: choice === "true" };
}

/** 输入模态（input 字段）：逗号分隔 text/image；"clear" 清除；留空取消 */
async function inputModes(
  ctx: ExtensionCommandContext,
  field: FieldDef,
  current: unknown,
): Promise<{ type: "set"; value: string[] } | { type: "clear" } | null> {
  const raw = await ctx.ui.input(
    `${field.label}（当前: ${fmtValue(current)}；text/image 逗号分隔，输入 "clear" 清除，留空取消）`,
    Array.isArray(current) ? current.join(", ") : "",
  );
  if (raw === undefined) return null;
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  if (/^clear$/i.test(trimmed) || trimmed === "c") return { type: "clear" };
  const modes = trimmed.split(/[,，、]/).map(s => s.trim()).filter(Boolean);
  const invalid = modes.filter(m => m !== "text" && m !== "image");
  if (invalid.length > 0) {
    ctx.ui.notify(`无效模态: ${invalid.join(", ")}（仅支持 text / image），已取消本次修改`, "warning");
    return null;
  }
  return { type: "set", value: modes };
}

/** API 格式选择（供应商级） */
async function inputApiFormat(
  ctx: ExtensionCommandContext,
  field: FieldDef,
  current: unknown,
): Promise<{ type: "set"; value: string } | null> {
  const choice = await ctx.ui.select(
    `${field.label}（当前: ${fmtValue(current)}）`,
    [
      "openai-old (Chat Completions，最通用)",
      "openai-new (OpenAI Responses)",
      "anthropic (Anthropic Messages)",
      "auto (自动检测)",
      "取消",
    ],
  );
  if (!choice || choice === "取消") return null;
  const value = choice.split(" ")[0];
  return { type: "set", value };
}

/** 统一字段编辑入口：按 kind 分发，应用修改到 target；返回是否发生修改 */
async function editFieldOn(
  ctx: ExtensionCommandContext,
  target: Record<string, unknown>,
  field: FieldDef,
): Promise<boolean> {
  const container = fieldContainer(target, field.section);
  const current = container[field.key];

  let result:
    | { type: "set"; value: string | number | boolean | string[] }
    | { type: "clear" }
    | null = null;

  switch (field.kind) {
    case "number":
      result = await inputNumber(ctx, field, current);
      break;
    case "string":
      result = await inputString(ctx, field, current);
      break;
    case "bool":
      result = await inputBool(ctx, field, current);
      break;
    case "modes":
      result = await inputModes(ctx, field, current);
      break;
    case "api":
      result = await inputApiFormat(ctx, field, current);
      break;
  }

  if (!result) return false;
  if (result.type === "clear") {
    if (field.required) return false;
    delete container[field.key];
    return true;
  }
  if (container[field.key] === result.value) return false;
  container[field.key] = result.value;
  return true;
}

// ─── 供应商选择 ─────────────────────────────────────

function providerListLabel(p: Record<string, unknown>): string {
  const id = String(p.id);
  const name = typeof p.name === "string" && p.name !== id ? ` | ${p.name}` : "";
  const baseUrl = typeof p.base_url === "string" ? ` | ${p.base_url}` : "";
  return `${id}${name}${baseUrl}`;
}

async function chooseProvider(
  ctx: ExtensionCommandContext,
  providers: Array<Record<string, unknown>>,
  query: string,
): Promise<Record<string, unknown> | null> {
  const list: DeletableProvider[] = providers.map(p => ({
    id: String(p.id),
    name: typeof p.name === "string" ? p.name : undefined,
    baseUrl: typeof p.base_url === "string" ? p.base_url : undefined,
  }));

  const matches = findProviderMatches(list, query);
  if (matches.length === 0) {
    ctx.ui.notify(query ? `没有匹配的供应商: ${query}` : "providers.toml 中没有供应商", "info");
    return null;
  }

  if (matches.length === 1) {
    return providers.find(p => String(p.id) === matches[0].id) ?? null;
  }

  const labels = matches.map(m => {
    const p = providers.find(pp => String(pp.id) === m.id);
    return p ? providerListLabel(p) : m.id;
  });
  const selected = await ctx.ui.select(`找到 ${matches.length} 个匹配项，请选择供应商：`, labels);
  if (!selected) return null;
  const idx = labels.indexOf(selected);
  if (idx < 0) return null;
  return providers.find(p => String(p.id) === matches[idx].id) ?? null;
}

// ─── 模型相关 ───────────────────────────────────────

/**
 * 确保 provider.models 是对象数组（可编辑）。
 * 字符串（逗号分隔 id）无损转数组；返回是否可用。
 */
function ensureModelsArray(provider: Record<string, unknown>): Array<Record<string, unknown>> | null {
  const models = provider.models;
  if (Array.isArray(models)) {
    // 直接返回原数组：push / splice 要作用到 provider.models 上才能写回
    return models as Array<Record<string, unknown>>;
  }
  if (typeof models === "string") {
    const trimmed = models.trim();
    if (trimmed === "" || trimmed === "auto") return null;
    const arr = trimmed
      .split(/[,，、]+/)
      .map(s => s.trim())
      .filter(Boolean)
      .map(id => ({ id }));
    provider.models = arr;
    return arr;
  }
  if (models === undefined) {
    const arr: Array<Record<string, unknown>> = [];
    provider.models = arr;
    return arr;
  }
  return null;
}

/** 模型参数编辑菜单（循环直到返回或删除） */
async function modelEditMenu(
  ctx: ExtensionCommandContext,
  provider: Record<string, unknown>,
  model: Record<string, unknown>,
): Promise<void> {
  while (true) {
    const options = MODEL_FIELDS.map(f =>
      `${f.label} — ${fmtValue(getFieldValue(model, f))}`,
    );
    options.push("🗑 删除此模型", "↩ 返回");

    const choice = await ctx.ui.select(`模型 "${model.id}" 参数：`, options);
    if (!choice || choice === "↩ 返回") return;

    if (choice === "🗑 删除此模型") {
      const confirmed = await ctx.ui.confirm("删除模型？", `"${model.id}" 将从 "${provider.id}" 中移除`);
      if (!confirmed) {
        ctx.ui.notify("已取消删除", "info");
        continue;
      }
      const models = ensureModelsArray(provider);
      if (models) {
        const idx = models.indexOf(model);
        if (idx >= 0) {
          models.splice(idx, 1);
          ctx.ui.notify(`模型 "${model.id}" 已删除`, "info");
        }
      }
      return;
    }

    const idx = options.indexOf(choice);
    const field = MODEL_FIELDS[idx];
    if (!field) continue;
    if (await editFieldOn(ctx, model, field)) {
      ctx.ui.notify(`已更新 ${field.label}`, "info");
    }
  }
}

/** 编辑现有模型 */
async function editModelFlow(
  ctx: ExtensionCommandContext,
  provider: Record<string, unknown>,
): Promise<boolean> {
  const models = ensureModelsArray(provider);
  if (!models) {
    ctx.ui.notify(
      provider.models === "auto"
        ? `"${provider.id}" 模型为自动拉取模式（auto），请先运行 /provider:reload-online 固定模型列表`
        : `"${provider.id}" 的 models 字段格式无法编辑（当前: ${fmtValue(provider.models)}）`,
      "warning",
    );
    return false;
  }
  if (models.length === 0) {
    ctx.ui.notify(`"${provider.id}" 下没有模型，可用「新增模型」添加`, "info");
    return false;
  }

  const options = models.map(m => {
    const id = String(m.id);
    const name = typeof m.name === "string" && m.name !== id ? ` | ${m.name}` : "";
    return `${id}${name}`;
  });
  options.push("↩ 返回");

  const choice = await ctx.ui.select(`选择 "${provider.id}" 下的模型（${models.length} 个）：`, options);
  if (!choice || choice === "↩ 返回") return false;

  const idx = options.indexOf(choice);
  const model = models[idx];
  if (!model) return false;

  await modelEditMenu(ctx, provider, model);
  return true;
}

/** 新增模型 */
async function addModelFlow(
  ctx: ExtensionCommandContext,
  provider: Record<string, unknown>,
): Promise<boolean> {
  const models = ensureModelsArray(provider);
  if (!models) {
    ctx.ui.notify(
      provider.models === "auto"
        ? `"${provider.id}" 模型为自动拉取模式（auto），无法手动新增模型，请先运行 /provider:reload-online 固定模型列表`
        : `"${provider.id}" 的 models 字段格式无法编辑（当前: ${fmtValue(provider.models)}）`,
      "warning",
    );
    return false;
  }

  const id = await ctx.ui.input("新模型 ID（必填，如 gpt-5.6-mini）", "");
  if (!id?.trim()) {
    ctx.ui.notify("已取消", "info");
    return false;
  }
  const modelId = id.trim();
  if (models.some(m => m.id === modelId)) {
    ctx.ui.notify(`模型 "${modelId}" 已存在，请用「编辑模型参数」修改`, "warning");
    return false;
  }

  const model: Record<string, unknown> = { id: modelId };
  await modelEditMenu(ctx, provider, model);

  models.push(model);
  const params = MODEL_FIELDS.filter(f => getFieldValue(model, f) !== undefined)
    .map(f => f.label)
    .join("、");
  ctx.ui.notify(`模型 "${modelId}" 已加入${params ? `（含 ${params}）` : ""}，记得保存`, "info");
  return true;
}

// ─── 供应商配置 ─────────────────────────────────────

/** 供应商参数编辑菜单（循环直到返回） */
async function providerEditMenu(
  ctx: ExtensionCommandContext,
  provider: Record<string, unknown>,
): Promise<boolean> {
  let dirty = false;
  while (true) {
    const options = PROVIDER_FIELDS.map(f =>
      `${f.label} — ${fmtValue(getFieldValue(provider, f))}`,
    );
    options.push("↩ 返回");

    const choice = await ctx.ui.select(`供应商 "${provider.id}" 配置：`, options);
    if (!choice || choice === "↩ 返回") return dirty;

    const idx = options.indexOf(choice);
    const field = PROVIDER_FIELDS[idx];
    if (!field) continue;
    if (await editFieldOn(ctx, provider, field)) {
      dirty = true;
      ctx.ui.notify(`已更新 ${field.label}`, "info");
    }
  }
}

// ─── 主入口 ─────────────────────────────────────────

export interface FastEditResult {
  changed: boolean;
  summary: string;
}

export async function fastEditHandler(
  args: string,
  ctx: ExtensionCommandContext,
): Promise<FastEditResult | null> {
  // 1. 加载配置
  let config: Record<string, unknown>;
  try {
    config = parse(readFileSync(CONFIG_PATH, "utf8")) as Record<string, unknown>;
  } catch (err) {
    ctx.ui.notify(`读取 providers.toml 失败: ${err instanceof Error ? err.message : String(err)}`, "error");
    return null;
  }

  const providers = config.providers;
  if (!Array.isArray(providers) || providers.length === 0) {
    ctx.ui.notify("providers.toml 中没有供应商，可用 /provider:fast-add 添加", "info");
    return null;
  }

  // 2. 选择供应商
  const provider = await chooseProvider(ctx, providers, args);
  if (!provider) return null;

  // 3. 操作菜单（循环直到保存 / 放弃）
  let dirty = false;
  while (true) {
    const choice = await ctx.ui.select(`供应商 "${provider.id}"：`, [
      "✏️ 编辑模型参数",
      "➕ 新增模型",
      "🔧 编辑供应商配置",
      "💾 保存并退出",
      "❌ 放弃修改",
    ]);
    if (!choice || choice.startsWith("❌")) {
      ctx.ui.notify(dirty ? "已放弃修改，未写盘" : "已取消", "info");
      return null;
    }
    if (choice.startsWith("💾")) {
      if (!dirty) {
        ctx.ui.notify("没有修改，无需保存", "info");
        return { changed: false, summary: "" };
      }
      try {
        writeFileSync(CONFIG_PATH, stringify(config), "utf8");
      } catch (err) {
        ctx.ui.notify(`写回 providers.toml 失败: ${err instanceof Error ? err.message : String(err)}`, "error");
        return null;
      }
      return { changed: true, summary: `供应商 "${provider.id}" 配置已更新` };
    }
    if (choice.startsWith("✏️")) {
      dirty = (await editModelFlow(ctx, provider)) || dirty;
    } else if (choice.startsWith("➕")) {
      dirty = (await addModelFlow(ctx, provider)) || dirty;
    } else if (choice.startsWith("🔧")) {
      dirty = (await providerEditMenu(ctx, provider)) || dirty;
    }
  }
}
