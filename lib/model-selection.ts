// lib/model-selection.ts — 通用模型解析、选择与当前 session 模型设置
//
// 从 gen-page-use-latest-msg 抽出的共享能力：
//   - provider/model 精确解析
//   - 已配置认证模型过滤
//   - 两级 provider → model 交互选择
//   - 设置当前主 session 模型（不写 defaultModel）
//
// 本模块只保存“上次选择”这一台机器级偏好；当前 session 模型由 pi.setModel
// 管理，重启后的默认值仍由 settings.json / pi 核心配置决定。

import { homedir } from "node:os";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parse, stringify } from "smol-toml";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export type SelectableModel = Model<Api>;

export interface LastModel {
  provider: string;
  id: string;
}

const LAST_MODEL_FILE = join(homedir(), ".pi", "agent", "model-selection.toml");
const LEGACY_LAST_MODEL_FILE = join(homedir(), ".pi", "agent", "message-page-model.toml");
const BACK_LABEL = "← 返回上一级";

/** 解析精确的 provider/model 标识；provider 允许包含非空字符但不能缺失。 */
export function parseModelSpec(spec: string): LastModel | undefined {
  const slash = spec.indexOf("/");
  if (slash <= 0 || slash === spec.length - 1) return undefined;
  const provider = spec.slice(0, slash).trim();
  const id = spec.slice(slash + 1).trim();
  if (!provider || !id) return undefined;
  return { provider, id };
}

/** 在当前 session 的 model registry 中解析 provider/model。 */
export function resolveModel(ctx: ExtensionContext, spec: string): SelectableModel | undefined {
  const parsed = parseModelSpec(spec);
  return parsed ? ctx.modelRegistry.find(parsed.provider, parsed.id) as SelectableModel | undefined : undefined;
}

/** 返回当前 registry 中已配置认证、可实际调用的模型。 */
export function getAvailableModels(ctx: ExtensionContext): SelectableModel[] {
  return ctx.modelRegistry
    .getAll()
    .filter((model) => ctx.modelRegistry.hasConfiguredAuth(model)) as SelectableModel[];
}

export async function readLastModel(): Promise<LastModel | undefined> {
  // 先读通用文件；兼容抽离前 message-page 的旧偏好文件。
  for (const file of [LAST_MODEL_FILE, LEGACY_LAST_MODEL_FILE]) {
    try {
      const content = await readFile(file, "utf8");
      const obj = parse(content) as { model?: { provider?: unknown; id?: unknown } };
      const model = obj?.model;
      if (model && typeof model.provider === "string" && typeof model.id === "string") {
        return { provider: model.provider, id: model.id };
      }
    } catch {
      // 当前文件不存在或解析失败，继续尝试兼容文件。
    }
  }
  return undefined;
}

export async function writeLastModel(provider: string, id: string): Promise<void> {
  try {
    await writeFile(LAST_MODEL_FILE, stringify({ model: { provider, id } }), "utf8");
  } catch {
    // 偏好写失败不应影响模型选择或当前 session。
  }
}

/**
 * 两级 provider → model 选择器。无 UI 时取第一个已认证模型。
 * 用户取消返回 undefined。
 */
export async function pickModel(ctx: ExtensionContext): Promise<SelectableModel | undefined> {
  const available = getAvailableModels(ctx);
  if (available.length === 0) {
    if (ctx.hasUI) ctx.ui.notify("没有已配置认证的模型可用", "warning");
    return undefined;
  }
  if (!ctx.hasUI) return available[0];

  const last = await readLastModel();
  const lastModel = last
    ? available.find((model) => model.provider === last.provider && model.id === last.id)
    : undefined;
  const lastLabel = lastModel ? `上次选择：${lastModel.provider}/${lastModel.id}` : undefined;
  const providers = Array.from(new Set(available.map((model) => model.provider))).sort();

  for (;;) {
    const providerLabels = providers.map((provider) => {
      const count = available.filter((model) => model.provider === provider).length;
      return `${provider}（${count} 个模型）`;
    });
    const labels = lastLabel ? [lastLabel, ...providerLabels] : providerLabels;
    const chosenProvider = await ctx.ui.select("选择供应商：", labels);
    if (chosenProvider === undefined) return undefined;
    if (lastLabel && chosenProvider === lastLabel) return lastModel;

    const provider = providers[providerLabels.indexOf(chosenProvider)];
    if (!provider) continue;
    const models = available.filter((model) => model.provider === provider);
    const modelLabels = models.map(
      (model) => `${model.id} — ${model.name && model.name !== model.id ? model.name : ""}`.trim(),
    );

    for (;;) {
      const chosen = await ctx.ui.select(`【${provider}】选择模型：`, [...modelLabels, BACK_LABEL]);
      if (chosen === undefined) return undefined;
      if (chosen === BACK_LABEL) break;
      const index = modelLabels.indexOf(chosen);
      if (index >= 0) return models[index];
    }
  }
}

export type ModelSelectionResult =
  | { ok: true; model: SelectableModel }
  | { ok: false; reason: "cancelled" | "invalid_spec" | "not_found" | "unauthenticated" };

/** 解析并验证一个显式 provider/model；不打开 UI。 */
export function resolveConfiguredModel(ctx: ExtensionContext, spec: string): ModelSelectionResult {
  const parsed = parseModelSpec(spec.trim());
  if (!parsed) return { ok: false, reason: "invalid_spec" };
  const model = resolveModel(ctx, spec.trim());
  if (!model) return { ok: false, reason: "not_found" };
  if (!ctx.modelRegistry.hasConfiguredAuth(model)) return { ok: false, reason: "unauthenticated" };
  return { ok: true, model };
}

/** 解析显式 provider/model；未提供 spec 时打开共享选择器。 */
export async function selectModel(
  ctx: ExtensionContext,
  spec?: string,
): Promise<ModelSelectionResult> {
  if (spec?.trim()) return resolveConfiguredModel(ctx, spec);
  const model = await pickModel(ctx);
  return model ? { ok: true, model } : { ok: false, reason: "cancelled" };
}

/**
 * 设置当前主 agent session 的模型。这里只调用 pi.setModel，不修改 defaultModel。
 * 返回 false 表示取消、解析失败、模型不存在或没有认证。
 */
export async function setCurrentSessionModel(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  spec?: string,
): Promise<ModelSelectionResult> {
  const selected = await selectModel(ctx, spec);
  if (!selected.ok) return selected;
  const accepted = await pi.setModel(selected.model);
  if (!accepted) return { ok: false, reason: "unauthenticated" };
  await writeLastModel(selected.model.provider, selected.model.id);
  return selected;
}

export function modelLabel(model: SelectableModel): string {
  return `${model.provider}/${model.id}`;
}
