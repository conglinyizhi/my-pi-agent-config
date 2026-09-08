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
import { isProtected } from "./model-protection.ts";
import { vimSelect } from "../../lib/vim-select.ts";

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
  /** 白话说明：这个开关到底管什么、什么时候该开 */
  desc?: string;
  /** providers.toml 里的完整路径，编辑时回显便于对照 */
  path: string;
}

type FieldSeed = Omit<FieldDef, "path">;

/** 给一组字段补上 TOML 路径（prefix 为空表示供应商顶层） */
function withPath(prefix: string, seeds: FieldSeed[]): FieldDef[] {
  return seeds.map(seed => {
    const sub = seed.section ? `${seed.section}.` : "";
    return { ...seed, path: prefix ? `${prefix}.${sub}${seed.key}` : `${sub}${seed.key}` };
  });
}

/**
 * compat 子块的说明。这几个开关是 pi 和接口之间的兼容性补丁：
 * 接口不按标准来时打开，能解决思维链丢失 / 请求报错这类问题。
 */
const COMPAT_DESCS = {
  developerRole: "允许用 developer 角色下发系统指令（新版 OpenAI 风格）。接口不认时关掉，pi 会退回 system 角色。",
  reasoningEffort: "接口接受 reasoning_effort 参数来调思考深度。不支持时开着会让请求报错。",
  thinkingFormat: "思考过程用哪种字段格式返回。DeepSeek 系（含多数中转站）要填 deepseek，否则思维链会丢。",
  adaptiveThinking: "让模型自己决定这一轮要不要思考，适用于会在思考/不思考之间自动切换的模型。",
  thinkingAsText: "思考过程必须写在正文里，而不是单独的 reasoning 字段。中转站只透传正文时用得上。",
  reasoningContent: "回传历史对话时，assistant 消息必须带上 reasoning_content，否则接口报错。DeepSeek 系常见。",
  eagerToolStreaming: "工具调用的参数边生成边流式下发，能更早开始执行。接口不支持时关掉。",
} as const;

/** 模型级字段 */
export const MODEL_FIELDS: FieldDef[] = withPath("models[]", [
  { key: "name", label: "名称", kind: "string", desc: "模型列表里显示的名字；留空就直接用模型 ID。" },
  { key: "context_window", label: "上下文窗口", kind: "number", desc: "一次对话最多能装多少 token，历史消息和本次输出都算在内。" },
  { key: "max_tokens", label: "最大输出", kind: "number", desc: "单次回复最多生成多少 token。" },
  { key: "cost_input", label: "输入价格", kind: "number", desc: "每百万输入 token 的单价，数字和 providers.toml 里保持一致，用来算花费。" },
  { key: "cost_output", label: "输出价格", kind: "number", desc: "每百万输出 token 的单价。" },
  { key: "cost_cache_read", label: "缓存读价格", kind: "number", desc: "命中提示词缓存时，读取那部分的单价。" },
  { key: "cost_cache_write", label: "缓存写价格", kind: "number", desc: "把提示词写进缓存的单价。" },
  { key: "reasoning", label: "推理", kind: "bool", desc: "这个模型会先输出思考过程再给答案；关掉就不请求思维链。" },
  { key: "input", label: "输入模态", kind: "modes", desc: "能接受什么输入：text 是纯文字，image 是能读图。" },
  { key: "cot_replay", label: "思维链回传", kind: "bool", desc: "把上一轮的思考过程带回对话历史。DeepSeek 系不开会丢思维链；等于一键打开「思考格式 + 历史带思考」。" },
  { key: "cost_locked", label: "锁定价格", kind: "bool", desc: "锁住价格，/provider:reload-online 刷新在线数据时不会用在线价覆盖它。" },
  { key: "supports_developer_role", label: "允许 developer 角色", kind: "bool", section: "compat", desc: COMPAT_DESCS.developerRole },
  { key: "supports_reasoning_effort", label: "支持思考强度参数", kind: "bool", section: "compat", desc: COMPAT_DESCS.reasoningEffort },
  { key: "thinking_format", label: "思考返回格式", kind: "string", section: "compat", desc: COMPAT_DESCS.thinkingFormat },
  { key: "force_adaptive_thinking", label: "强制自适应思考", kind: "bool", section: "compat", desc: COMPAT_DESCS.adaptiveThinking },
  { key: "requires_thinking_as_text", label: "思考需写进正文", kind: "bool", section: "compat", desc: COMPAT_DESCS.thinkingAsText },
  { key: "requires_reasoning_content_on_assistant_messages", label: "历史消息需带思考", kind: "bool", section: "compat", desc: COMPAT_DESCS.reasoningContent },
  { key: "supports_eager_tool_input_streaming", label: "工具参数流式下发", kind: "bool", section: "compat", desc: COMPAT_DESCS.eagerToolStreaming },
]);

/** 供应商级字段（含 defaults / compat 子块） */
const PROVIDER_FIELDS: FieldDef[] = withPath("", [
  { key: "api", label: "API 格式", kind: "api", desc: "这家供应商走哪套接口协议。选错了会连不上或直接报错。" },
  { key: "base_url", label: "API 地址", kind: "string", required: true, desc: "接口地址，通常以 /v1 结尾。" },
  { key: "name", label: "显示名称", kind: "string", desc: "模型列表里显示的供应商名字；留空就用标识符。" },
  { key: "cot_replay", label: "思维链回传（整家）", kind: "bool", desc: "对这家供应商下所有模型生效；某个模型单独设置了就以那个模型为准。" },
  { key: "context_window", label: "默认上下文窗口", kind: "number", section: "defaults", desc: "没单独配置的模型继承这个值。" },
  { key: "max_tokens", label: "默认最大输出", kind: "number", section: "defaults", desc: "没单独配置的模型继承这个值。" },
  { key: "input", label: "默认输入模态", kind: "modes", section: "defaults", desc: "没单独配置的模型继承这个值。" },
  { key: "reasoning", label: "默认推理", kind: "bool", section: "defaults", desc: "没单独配置的模型继承这个值。" },
  { key: "cost_input", label: "默认输入价格", kind: "number", section: "defaults", desc: "没单独配置的模型继承这个值。" },
  { key: "cost_output", label: "默认输出价格", kind: "number", section: "defaults", desc: "没单独配置的模型继承这个值。" },
  { key: "cost_cache_read", label: "默认缓存读价格", kind: "number", section: "defaults", desc: "没单独配置的模型继承这个值。" },
  { key: "cost_cache_write", label: "默认缓存写价格", kind: "number", section: "defaults", desc: "没单独配置的模型继承这个值。" },
  { key: "supports_developer_role", label: "允许 developer 角色", kind: "bool", section: "compat", desc: COMPAT_DESCS.developerRole },
  { key: "supports_reasoning_effort", label: "支持思考强度参数", kind: "bool", section: "compat", desc: COMPAT_DESCS.reasoningEffort },
  { key: "thinking_format", label: "思考返回格式", kind: "string", section: "compat", desc: COMPAT_DESCS.thinkingFormat },
  { key: "force_adaptive_thinking", label: "强制自适应思考", kind: "bool", section: "compat", desc: COMPAT_DESCS.adaptiveThinking },
  { key: "requires_thinking_as_text", label: "思考需写进正文", kind: "bool", section: "compat", desc: COMPAT_DESCS.thinkingAsText },
  { key: "requires_reasoning_content_on_assistant_messages", label: "历史消息需带思考", kind: "bool", section: "compat", desc: COMPAT_DESCS.reasoningContent },
  { key: "supports_eager_tool_input_streaming", label: "工具参数流式下发", kind: "bool", section: "compat", desc: COMPAT_DESCS.eagerToolStreaming },
]);

// ─── 小工具 ─────────────────────────────────────────

export function fmtValue(v: unknown): string {
  if (v === undefined || v === null) return "未设置";
  if (typeof v === "boolean") return v ? "开启" : "关闭";
  if (Array.isArray(v)) return v.join(", ");
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

/**
 * 编辑对话框的标题：字段名 + 当前值 + 白话说明 + TOML 路径 + 操作提示。
 * 说明写在这里，而不是菜单行上，菜单才能保持一行一项看得清。
 */
function fieldPrompt(field: FieldDef, current: unknown, how?: string): string {
  const lines = [`${field.label}（当前: ${fmtValue(current)}）`];
  if (field.desc) lines.push(field.desc);
  lines.push(`对应配置项: ${field.path}`);
  if (how) lines.push(how);
  return lines.join("\n");
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
export function getFieldValue(
  target: Record<string, unknown>,
  field: FieldDef,
): unknown {
  const container = field.section ? target[field.section] : target;
  if (!container || typeof container !== "object" || Array.isArray(container)) return undefined;
  return (container as Record<string, unknown>)[field.key];
}

// ─── 交互辅助 ───────────────────────────────────────

/** 清除字段的输入关键词：中英文都收 */
function isClearKeyword(text: string): boolean {
  return /^(clear|c|清除|清空)$/i.test(text);
}

/** 数字输入：预填当前值；输入「清除」清空字段；留空或非法取消 */
async function inputNumber(
  ctx: ExtensionCommandContext,
  field: FieldDef,
  current: unknown,
): Promise<{ type: "set"; value: number } | { type: "clear" } | null> {
  const raw = await ctx.ui.input(
    fieldPrompt(field, current, "填数字修改；填「清除」清空这个配置项；留空取消"),
    current === undefined || current === null ? "" : String(current),
  );
  if (raw === undefined) return null;
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  if (isClearKeyword(trimmed)) return { type: "clear" };
  const n = Number(trimmed);
  if (Number.isNaN(n)) {
    ctx.ui.notify(`"${trimmed}" 不是有效数字，已取消本次修改`, "warning");
    return null;
  }
  return { type: "set", value: n };
}

/** 文本输入：预填当前值；输入「清除」清空（非必填字段）；留空取消 */
async function inputString(
  ctx: ExtensionCommandContext,
  field: FieldDef,
  current: unknown,
): Promise<{ type: "set"; value: string } | { type: "clear" } | null> {
  const raw = await ctx.ui.input(
    fieldPrompt(
      field,
      current,
      field.required ? "填内容修改；留空取消" : "填内容修改；填「清除」清空这个配置项；留空取消",
    ),
    current === undefined || current === null ? "" : String(current),
  );
  if (raw === undefined) return null;
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  if (!field.required && isClearKeyword(trimmed)) {
    return { type: "clear" };
  }
  return { type: "set", value: trimmed };
}

/** 布尔选择：开启 / 关闭 / 清除（未设置）/ 取消 */
async function inputBool(
  ctx: ExtensionCommandContext,
  field: FieldDef,
  current: unknown,
): Promise<{ type: "set"; value: boolean } | { type: "clear" } | null> {
  const choice = await ctx.ui.select(
    fieldPrompt(field, current),
    ["开启", "关闭", "清除（恢复未设置）", "取消"],
  );
  if (!choice || choice === "取消") return null;
  if (choice.startsWith("清除")) return { type: "clear" };
  return { type: "set", value: choice === "开启" };
}

/** 输入模态（input 字段）：逗号分隔 text / image；输入「清除」清空；留空取消 */
async function inputModes(
  ctx: ExtensionCommandContext,
  field: FieldDef,
  current: unknown,
): Promise<{ type: "set"; value: string[] } | { type: "clear" } | null> {
  const raw = await ctx.ui.input(
    fieldPrompt(
      field,
      current,
      "填 text（纯文字）或 image（能读图），可以两个都填、用逗号隔开，例如 text, image；填「清除」清空；留空取消",
    ),
    Array.isArray(current) ? current.join(", ") : "",
  );
  if (raw === undefined) return null;
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  if (isClearKeyword(trimmed)) return { type: "clear" };
  const modes = trimmed.split(/[,，、]/).map(s => s.trim()).filter(Boolean);
  const invalid = modes.filter(m => m !== "text" && m !== "image");
  if (invalid.length > 0) {
    ctx.ui.notify(`无效模态: ${invalid.join(", ")}（仅支持 text / image），已取消本次修改`, "warning");
    return null;
  }
  return { type: "set", value: modes };
}

/** API 格式选择（供应商级）：选项里带上中文说明，值仍在开头 */
async function inputApiFormat(
  ctx: ExtensionCommandContext,
  field: FieldDef,
  current: unknown,
): Promise<{ type: "set"; value: string } | null> {
  const choice = await ctx.ui.select(
    fieldPrompt(field, current),
    [
      "openai-old — 旧版 Chat Completions 接口，中转站和自建服务最通用",
      "openai-new — 新版 OpenAI Responses 接口，官方 OpenAI / Azure 用这个",
      "anthropic — Anthropic Messages 接口，Claude 系列用这个",
      "auto — 自动检测，首次选中模型时再探测接口类型",
      "取消",
    ],
  );
  if (!choice || choice === "取消") return null;
  const value = choice.split(/\s+/)[0];
  return { type: "set", value };
}

/** 统一字段编辑入口：按 kind 分发，应用修改到 target；返回是否发生修改 */
export async function editFieldOn(
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

export async function chooseProvider(
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
  const selected = await vimSelect(ctx, `找到 ${matches.length} 个匹配项，请选择供应商：`, labels);
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
export function ensureModelsArray(provider: Record<string, unknown>): Array<Record<string, unknown>> | null {
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

export interface ModelFieldsMenuOptions {
  /** 是否提供「删除此模型」选项（复制/新增未落盘模型时关闭） */
  allowDelete?: boolean;
  /** 菜单标题，默认 `模型 "<id>" 参数：` */
  title?: string;
}

/**
 * 模型字段编辑菜单（循环直到返回）。
 * fast-edit 与 fast-edit-with-copy 共用，保证两处字段列表与交互一致。
 */
export async function modelFieldsMenu(
  ctx: ExtensionCommandContext,
  provider: Record<string, unknown>,
  model: Record<string, unknown>,
  menuOptions: ModelFieldsMenuOptions = {},
): Promise<void> {
  if (isProtected(model, "edit")) {
    ctx.ui.notify(`模型 "${model.id}" 受 do_not.edit 保护，不能编辑或删除`, "warning");
    return;
  }

  const allowDelete = menuOptions.allowDelete ?? true;
  const title = menuOptions.title ?? `模型 "${model.id}" 参数：`;

  while (true) {
    const options = MODEL_FIELDS.map(f =>
      `${f.label} — ${fmtValue(getFieldValue(model, f))}`,
    );
    if (allowDelete) options.push("🗑 删除此模型");
    options.push("↩ 返回");

    const choice = await vimSelect(ctx, title, options);
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

/** 模型参数编辑菜单（含删除选项） */
async function modelEditMenu(
  ctx: ExtensionCommandContext,
  provider: Record<string, unknown>,
  model: Record<string, unknown>,
): Promise<void> {
  await modelFieldsMenu(ctx, provider, model, { allowDelete: true });
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

  const choice = await vimSelect(ctx, `选择 "${provider.id}" 下的模型（${models.length} 个）：`, options);
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

    const choice = await vimSelect(ctx, `供应商 "${provider.id}" 配置：`, options);
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
