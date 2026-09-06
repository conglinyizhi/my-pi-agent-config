// lib/model-selection.ts — 通用模型解析、选择、偏好与当前 session 模型设置
//
// 所有使用本模块的插件共享同一份机器级 TOML：
//   ~/.pi/agent/model-selection.toml
//
// 文件共享，偏好按 scope 隔离：每个插件有自己的 recent / pinned，另有 global.pinned
// 可供所有插件使用。旧的 message-page-model.toml、旧 [model] 结构和旧 root
// last/pinned 字段仍兼容读取。

import { homedir } from "node:os";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parse, stringify } from "smol-toml";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export type SelectableModel = Model<Api>;
export const DEFAULT_MODEL_SCOPE = "default";
export const MODEL_SELECTION_SCOPE = "model-selection";
export const MESSAGE_PAGE_SCOPE = "message-page";
export const SUBAGENT_MODEL_SCOPE = "subagent";

export interface LastModel {
  provider: string;
  id: string;
}

export interface ScopedModelPreferences {
  /** 该功能实际采用的独立默认模型；未设置时由调用方回退。 */
  selected?: LastModel;
  recent: LastModel[];
  pinned: LastModel[];
}

export interface ModelPreferences {
  globalPinned: LastModel[];
  scopes: Record<string, ScopedModelPreferences>;
}

export interface ModelSelection {
  model: SelectableModel;
  /** 用户在二次确认时选择的置顶级别；未置顶时为 undefined。 */
  pinScope?: "scope" | "global";
}

export const MAX_RECENT_MODELS = 4;

const PREFS_FILE = join(homedir(), ".pi", "agent", "model-selection.toml");
const LEGACY_LAST_MODEL_FILE = join(homedir(), ".pi", "agent", "message-page-model.toml");
const BACK_LABEL = "← 返回上一级";
const CANCEL_LABEL = "取消";
const CONFIRM_LABEL = "确认使用";
const PIN_SCOPE_CONFIRM_LABEL = "当前功能置顶并确认";
const PIN_GLOBAL_CONFIRM_LABEL = "所有功能置顶并确认";
const PIN_SELECT_LABEL = "选择这个置顶模型";
const PIN_UNPIN_SCOPE_LABEL = "取消当前功能置顶";
const PIN_UNPIN_GLOBAL_LABEL = "取消所有功能置顶";
const PIN_BACK_LABEL = "返回上一级";
const CLEAR_SELECTED_MODEL_LABEL = "恢复继承当前 session 模型";

function modelKey(model: LastModel): string {
  return `${model.provider}/${model.id}`;
}

function parseStoredModel(value: unknown): LastModel | undefined {
  if (!value || typeof value !== "object") return undefined;
  const model = value as { provider?: unknown; id?: unknown };
  if (typeof model.provider !== "string" || typeof model.id !== "string") return undefined;
  if (!model.provider.trim() || !model.id.trim()) return undefined;
  return { provider: model.provider.trim(), id: model.id.trim() };
}

function parseModelList(value: unknown): LastModel[] {
  if (!Array.isArray(value)) return [];
  const result: LastModel[] = [];
  for (const item of value) {
    const parsed = typeof item === "string" ? parseModelSpec(item) : parseStoredModel(item);
    if (parsed && !result.some((model) => modelKey(model) === modelKey(parsed))) result.push(parsed);
  }
  return result;
}

function normalizeScope(value: unknown): ScopedModelPreferences {
  const obj = (value && typeof value === "object" ? value : {}) as {
    selected?: unknown;
    recent?: unknown;
    last?: unknown;
    pinned?: unknown;
  };
  const selected = parseStoredModel(obj.selected)
    ?? (typeof obj.selected === "string" ? parseModelSpec(obj.selected) : undefined);
  const legacyLast = parseStoredModel(obj.last)
    ?? (typeof obj.last === "string" ? parseModelSpec(obj.last) : undefined);
  const recent = parseModelList(obj.recent);
  if (legacyLast && !recent.some((model) => modelKey(model) === modelKey(legacyLast))) recent.unshift(legacyLast);
  return {
    selected,
    recent: recent.slice(0, MAX_RECENT_MODELS),
    pinned: parseModelList(obj.pinned),
  };
}

function normalizePreferences(value: unknown): ModelPreferences {
  const obj = (value && typeof value === "object" ? value : {}) as {
    last?: unknown;
    pinned?: unknown;
    model?: unknown;
    global?: { pinned?: unknown };
    scopes?: unknown;
  };
  const scopes: Record<string, ScopedModelPreferences> = {};
  if (obj.scopes && typeof obj.scopes === "object") {
    for (const [scope, entry] of Object.entries(obj.scopes)) scopes[scope] = normalizeScope(entry);
  }

  // 兼容上一版共享文件：root last/pinned 和 [model] 都归入 default scope。
  const legacyLast = parseStoredModel(obj.last)
    ?? (typeof obj.last === "string" ? parseModelSpec(obj.last) : undefined)
    ?? parseStoredModel(obj.model);
  const legacyPinned = parseModelList(obj.pinned);
  if (legacyLast) {
    const current = scopes[DEFAULT_MODEL_SCOPE] ?? { recent: [], pinned: [] };
    const recent = !current.recent.some((model) => modelKey(model) === modelKey(legacyLast))
      ? [legacyLast, ...current.recent]
      : current.recent;
    scopes[DEFAULT_MODEL_SCOPE] = {
      ...current,
      recent: recent.slice(0, MAX_RECENT_MODELS),
    };
  }

  // 上一版 root pinned 对所有使用者共享，因此迁移为全局置顶最符合原语义。
  const configuredGlobal = obj.global && typeof obj.global === "object"
    ? parseModelList(obj.global.pinned)
    : [];
  const globalPinned = [...configuredGlobal, ...legacyPinned].filter(
    (model, index, list) => list.findIndex((item) => modelKey(item) === modelKey(model)) === index,
  );
  return { globalPinned, scopes };
}

function scopePreferences(preferences: ModelPreferences, scope: string): ScopedModelPreferences {
  // 每个插件 scope 必须真正隔离；旧 root 偏好只归入 default，不向新插件串入。
  return preferences.scopes[scope] ?? { recent: [], pinned: [] };
}

function serializedPreferences(preferences: ModelPreferences): Record<string, unknown> {
  const scopes: Record<string, unknown> = {};
  for (const [scope, entry] of Object.entries(preferences.scopes)) {
    scopes[scope] = {
      ...(entry.selected ? { selected: modelKey(entry.selected) } : {}),
      recent: entry.recent.slice(0, MAX_RECENT_MODELS).map(modelKey),
      pinned: entry.pinned.map(modelKey),
    };
  }
  return {
    global: { pinned: preferences.globalPinned.map(modelKey) },
    scopes,
  };
}

async function readModelPreferencesFile(): Promise<ModelPreferences> {
  for (const file of [PREFS_FILE, LEGACY_LAST_MODEL_FILE]) {
    try {
      const content = await readFile(file, "utf8");
      const preferences = normalizePreferences(parse(content));
      if (Object.keys(preferences.scopes).length > 0 || preferences.globalPinned.length > 0 || file === PREFS_FILE) {
        return preferences;
      }
    } catch {
      // 文件不存在或解析失败时继续尝试兼容来源。
    }
  }
  return { globalPinned: [], scopes: {} };
}

let preferenceWriteTail: Promise<void> = Promise.resolve();

/** 读取完整共享偏好；文件不存在时返回空结构。 */
export async function readModelPreferences(): Promise<ModelPreferences> {
  await preferenceWriteTail;
  return readModelPreferencesFile();
}

async function writeModelPreferencesFile(preferences: ModelPreferences): Promise<void> {
  try {
    await mkdir(join(homedir(), ".pi", "agent"), { recursive: true });
    const temp = `${PREFS_FILE}.tmp-${process.pid}-${Date.now()}`;
    await writeFile(temp, stringify(serializedPreferences(preferences)), "utf8");
    await rename(temp, PREFS_FILE);
  } catch {
    // 偏好写失败不应影响模型选择或当前 session。
  }
}

function enqueuePreferenceWrite(operation: () => Promise<void>): Promise<void> {
  const run = preferenceWriteTail.then(operation, operation);
  preferenceWriteTail = run.then(() => undefined, () => undefined);
  return run;
}

/** 写入完整共享偏好；插件通常应优先使用下面按 scope 的操作函数。 */
export function writeModelPreferences(preferences: ModelPreferences): Promise<void> {
  return enqueuePreferenceWrite(() => writeModelPreferencesFile(preferences));
}

export async function readScopedModelPreferences(scope = DEFAULT_MODEL_SCOPE): Promise<ScopedModelPreferences> {
  return scopePreferences(await readModelPreferences(), scope);
}

export async function readLastModel(scope = DEFAULT_MODEL_SCOPE): Promise<LastModel | undefined> {
  return (await readScopedModelPreferences(scope)).recent[0];
}

export async function readSelectedModel(scope: string): Promise<LastModel | undefined> {
  return (await readScopedModelPreferences(scope)).selected;
}

export type PreferredModelSpec = {
  spec: string;
  source: "explicit" | "scoped-default" | "session";
};

/** 只决定优先级，不解析 registry：显式参数 > 功能独立默认 > 当前 session。 */
export function preferredModelSpec(
  explicitSpec: string | undefined,
  scopedSelected: LastModel | undefined,
  sessionSpec: string | undefined,
): PreferredModelSpec | undefined {
  if (explicitSpec !== undefined) return { spec: explicitSpec.trim(), source: "explicit" };
  if (scopedSelected) return { spec: modelKey(scopedSelected), source: "scoped-default" };
  if (sessionSpec) return { spec: sessionSpec, source: "session" };
  return undefined;
}

export function withSelectedModel(
  preferences: ModelPreferences,
  scope: string,
  model?: LastModel,
): ModelPreferences {
  const next = clonePreferences(preferences);
  const current = scopePreferences(next, scope);
  next.scopes[scope] = { ...current, selected: model };
  return next;
}

/** 设置或清除某功能的独立默认模型，不影响 recent / pinned。 */
export function writeSelectedModel(scope: string, model?: LastModel): Promise<void> {
  return enqueuePreferenceWrite(async () => {
    const preferences = withSelectedModel(await readModelPreferencesFile(), scope, model);
    await writeModelPreferencesFile(preferences);
  });
}

function clonePreferences(preferences: ModelPreferences): ModelPreferences {
  return {
    globalPinned: [...preferences.globalPinned],
    scopes: Object.fromEntries(Object.entries(preferences.scopes).map(([scope, entry]) => [
      scope,
      { selected: entry.selected, recent: [...entry.recent], pinned: [...entry.pinned] },
    ])),
  };
}

/** 纯状态变换：记录最近使用，置顶模型不会重复进入 recent。 */
export function withRecordedModel(
  preferences: ModelPreferences,
  model: LastModel,
  scope = DEFAULT_MODEL_SCOPE,
): ModelPreferences {
  const next = clonePreferences(preferences);
  const current = scopePreferences(next, scope);
  const key = modelKey(model);
  const pinned = current.pinned.some((item) => modelKey(item) === key)
    || next.globalPinned.some((item) => modelKey(item) === key);
  next.scopes[scope] = {
    ...current,
    recent: pinned
      ? current.recent.filter((item) => modelKey(item) !== key)
      : [model, ...current.recent.filter((item) => modelKey(item) !== key)].slice(0, MAX_RECENT_MODELS),
  };
  return next;
}

/** 记录最近使用模型；已在当前或全局置顶列表中的模型不会进入 recent。 */
export function writeLastModel(
  provider: string,
  id: string,
  scope = DEFAULT_MODEL_SCOPE,
): Promise<void> {
  return enqueuePreferenceWrite(async () => {
    const preferences = withRecordedModel(await readModelPreferencesFile(), { provider, id }, scope);
    await writeModelPreferencesFile(preferences);
  });
}

/** 当前功能置顶或全局置顶；已置顶时只把它移到对应列表最前。 */
export function withPinnedModel(
  preferences: ModelPreferences,
  model: LastModel,
  scope = DEFAULT_MODEL_SCOPE,
  level: "scope" | "global" = "scope",
): ModelPreferences {
  const next = clonePreferences(preferences);
  if (level === "global") {
    next.globalPinned = [model, ...next.globalPinned.filter((item) => modelKey(item) !== modelKey(model))];
    for (const [scopeName, entry] of Object.entries(next.scopes)) {
      next.scopes[scopeName] = {
        ...entry,
        recent: entry.recent.filter((item) => modelKey(item) !== modelKey(model)),
      };
    }
  } else {
    const current = scopePreferences(next, scope);
    next.scopes[scope] = {
      ...current,
      pinned: [model, ...current.pinned.filter((item) => modelKey(item) !== modelKey(model))],
      recent: current.recent.filter((item) => modelKey(item) !== modelKey(model)),
    };
  }
  return next;
}

export function pinModel(
  provider: string,
  id: string,
  scope = DEFAULT_MODEL_SCOPE,
  level: "scope" | "global" = "scope",
): Promise<void> {
  return enqueuePreferenceWrite(async () => {
    const preferences = withPinnedModel(await readModelPreferencesFile(), { provider, id }, scope, level);
    await writeModelPreferencesFile(preferences);
  });
}

/** 取消当前功能或全局置顶。 */
export function withUnpinnedModel(
  preferences: ModelPreferences,
  model: LastModel,
  scope = DEFAULT_MODEL_SCOPE,
  level: "scope" | "global" = "scope",
): ModelPreferences {
  const next = clonePreferences(preferences);
  const key = modelKey(model);
  if (level === "global") {
    next.globalPinned = next.globalPinned.filter((item) => modelKey(item) !== key);
  } else {
    const current = scopePreferences(next, scope);
    next.scopes[scope] = {
      ...current,
      pinned: current.pinned.filter((item) => modelKey(item) !== key),
    };
  }
  return next;
}

export function unpinModel(
  provider: string,
  id: string,
  scope = DEFAULT_MODEL_SCOPE,
  level: "scope" | "global" = "scope",
): Promise<void> {
  return enqueuePreferenceWrite(async () => {
    const preferences = withUnpinnedModel(await readModelPreferencesFile(), { provider, id }, scope, level);
    await writeModelPreferencesFile(preferences);
  });
}

/** 记录一次已确认选择，并按置顶状态决定是否加入该 scope 的 recent。 */
export function recordModelSelection(
  provider: string,
  id: string,
  scope = DEFAULT_MODEL_SCOPE,
): Promise<void> {
  return writeLastModel(provider, id, scope);
}

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

function orderedModels(
  available: SelectableModel[],
  preferences: ModelPreferences,
  scope: string,
): SelectableModel[] {
  const current = scopePreferences(preferences, scope);
  const rank = new Map<string, number>();
  current.pinned.forEach((model, index) => rank.set(modelKey(model), index));
  preferences.globalPinned.forEach((model, index) => {
    const key = modelKey(model);
    if (!rank.has(key)) rank.set(key, current.pinned.length + index);
  });
  const recentRank = new Map(current.recent.map((model, index) => [modelKey(model), index]));
  return [...available].sort((a, b) => {
    const aRank = rank.get(modelKey(a));
    const bRank = rank.get(modelKey(b));
    if (aRank !== undefined || bRank !== undefined) {
      if (aRank === undefined) return 1;
      if (bRank === undefined) return -1;
      return aRank - bRank;
    }
    const aRecent = recentRank.get(modelKey(a));
    const bRecent = recentRank.get(modelKey(b));
    if (aRecent !== undefined || bRecent !== undefined) {
      if (aRecent === undefined) return 1;
      if (bRecent === undefined) return -1;
      return aRecent - bRecent;
    }
    return 0;
  });
}

function pinState(
  preferences: ModelPreferences,
  scope: string,
  model: LastModel,
): { scope: boolean; global: boolean } {
  const current = scopePreferences(preferences, scope);
  const key = modelKey(model);
  return {
    scope: current.pinned.some((item) => modelKey(item) === key),
    global: preferences.globalPinned.some((item) => modelKey(item) === key),
  };
}

async function confirmModel(ctx: ExtensionContext, model: SelectableModel): Promise<"confirm" | "scope" | "global" | "cancel"> {
  if (!ctx.hasUI) return "confirm";
  const choice = await ctx.ui.select(
    `确认使用模型：${modelLabel(model)}？`,
    [CONFIRM_LABEL, PIN_SCOPE_CONFIRM_LABEL, PIN_GLOBAL_CONFIRM_LABEL, CANCEL_LABEL],
  );
  if (choice === PIN_SCOPE_CONFIRM_LABEL) return "scope";
  if (choice === PIN_GLOBAL_CONFIRM_LABEL) return "global";
  if (choice === CONFIRM_LABEL) return "confirm";
  return "cancel";
}

export function pinnedModelActionOptions(state: { scope: boolean; global: boolean }): string[] {
  const options = [PIN_SELECT_LABEL];
  if (state.scope) options.push(PIN_UNPIN_SCOPE_LABEL);
  if (state.global) options.push(PIN_UNPIN_GLOBAL_LABEL);
  options.push(PIN_BACK_LABEL);
  return options;
}

async function confirmPinnedModel(
  ctx: ExtensionContext,
  model: SelectableModel,
  state: { scope: boolean; global: boolean },
): Promise<"select" | "back" | "unpin-scope" | "unpin-global"> {
  if (!ctx.hasUI) return "select";
  const options = pinnedModelActionOptions(state);
  const choice = await ctx.ui.select(
    `这是一个置顶模型：${modelLabel(model)}\n选择操作：`,
    options,
  );
  if (choice === PIN_SELECT_LABEL) return "select";
  if (choice === PIN_UNPIN_SCOPE_LABEL) return "unpin-scope";
  if (choice === PIN_UNPIN_GLOBAL_LABEL) return "unpin-global";
  return "back";
}

async function pickModelChoice(ctx: ExtensionContext, scope: string): Promise<ModelSelection | undefined> {
  const available = getAvailableModels(ctx);
  if (available.length === 0) {
    if (ctx.hasUI) ctx.ui.notify("没有已配置认证的模型可用", "warning");
    return undefined;
  }
  if (!ctx.hasUI) return { model: available[0] };

  const preferences = await readModelPreferences();
  const ordered = orderedModels(available, preferences, scope);
  const current = scopePreferences(preferences, scope);
  const pinnedKeys = new Set([
    ...current.pinned.map(modelKey),
    ...preferences.globalPinned.map(modelKey),
  ]);
  const direct: Array<{ label: string; model: SelectableModel; kind: "pinned" | "recent" }> = [];
  for (const model of ordered) {
    if (pinnedKeys.has(modelKey(model))) {
      const state = pinState(preferences, scope, model);
      const pinLabel = state.scope && state.global
        ? "当前功能 + 所有功能置顶"
        : state.scope ? "当前功能置顶" : "所有功能置顶";
      direct.push({ label: `${pinLabel}：${modelLabel(model)}`, model, kind: "pinned" });
    }
  }
  for (const recent of current.recent) {
    if (pinnedKeys.has(modelKey(recent))) continue;
    const model = available.find((item) => modelKey(item) === modelKey(recent));
    if (model) direct.push({ label: `最近使用：${modelLabel(model)}`, model, kind: "recent" });
  }

  const providers = Array.from(new Set(ordered.map((model) => model.provider)));
  const providerLabels = providers.map((provider) => {
    const count = ordered.filter((model) => model.provider === provider).length;
    return `${provider}（${count} 个模型）`;
  });

  for (;;) {
    const chosenProvider = await ctx.ui.select("选择供应商或常用模型：", [
      ...direct.map((item) => item.label),
      ...providerLabels,
    ]);
    if (chosenProvider === undefined) return undefined;
    const directChoice = direct.find((item) => item.label === chosenProvider);
    if (directChoice) {
      if (directChoice.kind === "recent") {
        const action = await confirmModel(ctx, directChoice.model);
        if (action === "cancel") return undefined;
        return {
          model: directChoice.model,
          pinScope: action === "scope" ? "scope" : action === "global" ? "global" : undefined,
        };
      }
      const state = pinState(preferences, scope, directChoice.model);
      const action = await confirmPinnedModel(ctx, directChoice.model, state);
      if (action === "select") return { model: directChoice.model };
      if (action === "unpin-scope") await unpinModel(directChoice.model.provider, directChoice.model.id, scope, "scope");
      if (action === "unpin-global") await unpinModel(directChoice.model.provider, directChoice.model.id, scope, "global");
      // 取消或取消置顶后重新读取列表，避免使用旧 pinState 误判；
      // 不直接替用户选择，回到“供应商或常用模型”一级。
      return pickModelChoice(ctx, scope);
    }

    const provider = providers[providerLabels.indexOf(chosenProvider)];
    if (!provider) continue;
    const models = ordered.filter((model) => model.provider === provider);
    const modelLabels = models.map(
      (model) => `${model.id} — ${model.name && model.name !== model.id ? model.name : ""}`.trim(),
    );

    for (;;) {
      const chosen = await ctx.ui.select(`【${provider}】选择模型：`, [...modelLabels, BACK_LABEL]);
      if (chosen === undefined) return undefined;
      if (chosen === BACK_LABEL) break;
      const index = modelLabels.indexOf(chosen);
      if (index >= 0) {
        const model = models[index];
        const isPinned = pinnedKeys.has(modelKey(model));
        if (isPinned) {
          const action = await confirmPinnedModel(ctx, model, pinState(preferences, scope, model));
          if (action === "select") return { model };
          if (action === "unpin-scope") await unpinModel(model.provider, model.id, scope, "scope");
          if (action === "unpin-global") await unpinModel(model.provider, model.id, scope, "global");
          // 返回和取消置顶都重新读取偏好并回到选择器上一级。
          return pickModelChoice(ctx, scope);
        }
        const action = await confirmModel(ctx, model);
        if (action === "cancel") return undefined;
        return { model, pinScope: action === "scope" ? "scope" : action === "global" ? "global" : undefined };
      }
    }
  }
}

/** 选择器带置顶状态管理并记录该 scope 的最近模型；插件应传自己的稳定名称。 */
export async function pickModel(
  ctx: ExtensionContext,
  scope = DEFAULT_MODEL_SCOPE,
): Promise<SelectableModel | undefined> {
  const choice = await pickModelChoice(ctx, scope);
  if (!choice) return undefined;
  if (choice.pinScope) await pinModel(choice.model.provider, choice.model.id, scope, choice.pinScope);
  await recordModelSelection(choice.model.provider, choice.model.id, scope);
  return choice.model;
}

export type ModelSelectionFailureReason = "cancelled" | "invalid_spec" | "not_found" | "unauthenticated";

export type ModelSelectionResult =
  | { ok: true; model: SelectableModel; pinScope?: "scope" | "global" }
  | { ok: false; reason: ModelSelectionFailureReason };

/** 解析并验证一个显式 provider/model；不打开模型列表。 */
export function resolveConfiguredModel(ctx: ExtensionContext, spec: string): ModelSelectionResult {
  const parsed = parseModelSpec(spec.trim());
  if (!parsed) return { ok: false, reason: "invalid_spec" };
  const model = resolveModel(ctx, spec.trim());
  if (!model) return { ok: false, reason: "not_found" };
  if (!ctx.modelRegistry.hasConfiguredAuth(model)) return { ok: false, reason: "unauthenticated" };
  return { ok: true, model };
}

/** 解析或选择模型；确认后按 scope 写入 last，置顶模型不会重复进入 last。 */
export async function selectModel(
  ctx: ExtensionContext,
  spec?: string,
  options: { scope?: string; persist?: boolean } = {},
): Promise<ModelSelectionResult> {
  const scope = options.scope ?? DEFAULT_MODEL_SCOPE;
  let selected: ModelSelection | undefined;
  if (spec?.trim()) {
    const resolved = resolveConfiguredModel(ctx, spec);
    if (!resolved.ok) return resolved;
    const state = pinState(await readModelPreferences(), scope, resolved.model);
    if (state.scope || state.global) {
      const action = await confirmPinnedModel(ctx, resolved.model, state);
      if (action === "select") selected = { model: resolved.model };
      else {
        if (action === "unpin-scope") await unpinModel(resolved.model.provider, resolved.model.id, scope, "scope");
        if (action === "unpin-global") await unpinModel(resolved.model.provider, resolved.model.id, scope, "global");
        return { ok: false, reason: "cancelled" };
      }
    } else {
      const action = await confirmModel(ctx, resolved.model);
      if (action === "cancel") return { ok: false, reason: "cancelled" };
      selected = { model: resolved.model, pinScope: action === "scope" ? "scope" : action === "global" ? "global" : undefined };
    }
  } else {
    selected = await pickModelChoice(ctx, scope);
    if (!selected) return { ok: false, reason: "cancelled" };
  }
  if (options.persist !== false) {
    if (selected.pinScope) {
      await pinModel(selected.model.provider, selected.model.id, scope, selected.pinScope);
    }
    await recordModelSelection(selected.model.provider, selected.model.id, scope);
  }
  return { ok: true, model: selected.model, pinScope: selected.pinScope };
}

export type ScopedDefaultModelSelectionResult =
  | { ok: true; action: "selected"; model: SelectableModel }
  | { ok: true; action: "inherit" }
  | { ok: false; reason: ModelSelectionFailureReason };

/**
 * 为某功能选择独立默认模型。无显式 spec 时，选择器顶部可恢复继承 fallbackLabel。
 * 本函数只写 scope.selected 和该 scope 的选择偏好，不修改当前 session。
 */
export async function selectScopedDefaultModel(
  ctx: ExtensionContext,
  scope: string,
  spec?: string,
  fallbackLabel = "当前 session 模型",
): Promise<ScopedDefaultModelSelectionResult> {
  if (!spec?.trim() && ctx.hasUI) {
    const current = await readSelectedModel(scope);
    const first = await ctx.ui.select(
      current
        ? `当前独立模型：${modelKey(current)}。选择操作：`
        : `当前未设置独立模型，将继承${fallbackLabel}。选择操作：`,
      ["选择或更换独立模型", CLEAR_SELECTED_MODEL_LABEL, CANCEL_LABEL],
    );
    if (first === CLEAR_SELECTED_MODEL_LABEL) {
      await writeSelectedModel(scope, undefined);
      return { ok: true, action: "inherit" };
    }
    if (first !== "选择或更换独立模型") return { ok: false, reason: "cancelled" };
  }

  const selected = await selectModel(ctx, spec, { scope });
  if (!selected.ok) return selected;
  await writeSelectedModel(scope, { provider: selected.model.provider, id: selected.model.id });
  return { ok: true, action: "selected", model: selected.model };
}

/**
 * 设置当前主 agent session 的模型。只调用 pi.setModel，不修改 defaultModel。
 * 成功后记录本插件 scope 的模型偏好；切换失败不写 recent 或新置顶。
 */
export async function setCurrentSessionModel(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  spec?: string,
  options: { persistLastModel?: boolean; scope?: string } = {},
): Promise<ModelSelectionResult> {
  const scope = options.scope ?? MODEL_SELECTION_SCOPE;
  const selected = await selectModel(ctx, spec, { scope, persist: false });
  if (!selected.ok) return selected;
  const accepted = await pi.setModel(selected.model);
  if (!accepted) return { ok: false, reason: "unauthenticated" };
  if (options.persistLastModel !== false) {
    if (selected.pinScope) {
      await pinModel(selected.model.provider, selected.model.id, scope, selected.pinScope);
    }
    await recordModelSelection(selected.model.provider, selected.model.id, scope);
  }
  return selected;
}

export function modelLabel(model: SelectableModel): string {
  return `${model.provider}/${model.id}`;
}

// 仅供测试验证排序语义；不暴露文件路径或内部 TOML 结构。
export function orderAvailableModelsForPreferences(
  available: SelectableModel[],
  preferences: ModelPreferences,
  scope = DEFAULT_MODEL_SCOPE,
): SelectableModel[] {
  return orderedModels(available, preferences, scope);
}
