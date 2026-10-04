// review-settings.ts — 审核工作流设置的统一读写（扩展 / Electron 设置窗 / CLI 共用单点）
//
// 三处配置合成一个视图：
//   extensions.toml 的 [sandbox-llm-review]        总开关 / 档位 / 后端 / 超时 / 缓存
//   extensions.toml 的 [sandbox-review-classifier] 分类器端点 / 模型 / 超时
//   review-dimensions.toml                         八个维度的 enabled / above / below / action
//
// 两条硬约束（改本文件前先读）：
//   1 extensions.toml 是满注释的手写配置，**绝不整文件重写**：只能按键原地替换——
//     匹配该键所在行、只换值，行尾注释 / 其它段 / 空白逐字保留（replaceTomlKey）。
//     维度阈值那侧沿用原有整文件格式（formatDimensionsToml，原本在 review-command.ts），
//     但落盘同样走原子替换。
//   2 非法输入拒绝且不落盘：先全量校验，任何一项不合法就抛 ReviewSettingsError，
//     目标文件连打开都不开。写盘一律 tmp + rename，原文件在失败时保持原状。
//
// 读取侧与扩展侧同源：llm 段复用 llm-review.ts 的 normalizeConfig（那才是
// loadLlmReviewConfig 的事实来源），分类器段与维度表复用 review-classifier.ts 的
// normalizeClassifierConfig / normalizeDimensions。本文件不另造一套默认值。

import { existsSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { parse as parseToml } from "smol-toml";
import { LLM_REVIEW_SECTION, normalizeConfig } from "../extensions/sandbox-permissions/llm-review.ts";
import {
	CLASSIFIER_SECTION,
	DIMENSIONS_TOML_PATH,
	normalizeClassifierConfig,
	normalizeDimensions,
} from "../extensions/sandbox-permissions/review-classifier.ts";
import { DIMENSIONS, type DimensionConfig, type Primitive } from "../extensions/sandbox-permissions/review-dimensions.ts";

// ═══════════════════════════════════════════════════
// 路径
// ═══════════════════════════════════════════════════

export interface ReviewSettingsPaths {
	/** extensions.toml（[sandbox-llm-review] 与 [sandbox-review-classifier] 两段） */
	extensionsToml: string;
	/** review-dimensions.toml（八个维度） */
	dimensionsToml: string;
}

export function defaultReviewSettingsPaths(): ReviewSettingsPaths {
	return {
		extensionsToml: join(getAgentDir(), "extensions.toml"),
		// 与扩展侧同一个常量：写盘位置不在这里另算一遍
		dimensionsToml: DIMENSIONS_TOML_PATH,
	};
}

let pathsOverride: ReviewSettingsPaths | null = null;

/** 测试用：把读写指向别处（例如 /tmp 里的副本），绝不碰真实配置 */
export function setReviewSettingsPathsForTest(paths: ReviewSettingsPaths): void {
	pathsOverride = paths;
}

export function resetReviewSettingsPathsForTest(): void {
	pathsOverride = null;
}

/** 当前生效的路径（测试覆盖优先） */
export function resolveReviewSettingsPaths(): ReviewSettingsPaths {
	return pathsOverride ?? defaultReviewSettingsPaths();
}

// ═══════════════════════════════════════════════════
// 类型
// ═══════════════════════════════════════════════════

export type ReviewBackend = "chat" | "classifier" | "chain";
export type ReviewMode = "auto" | "strict";
export type DimensionAction = "review" | "ignore";

export interface ReviewLlmSettings {
	/** 总开关；false = gate 完全跳过 LLM 预审，回到纯弹窗流程 */
	enabled: boolean;
	mode: ReviewMode;
	backend: ReviewBackend;
	/** 注册模型单次审核总时长兜底（毫秒） */
	timeoutMs: number;
	/** 免费模型相邻 token 间隔上限（毫秒） */
	tokenIdleMs: number;
	/** 内存缓存上限 */
	maxCache: number;
}

export interface ReviewClassifierSettings {
	baseUrl: string;
	model: string;
	timeoutMs: number;
}

export interface ReviewSettings {
	llm: ReviewLlmSettings;
	classifier: ReviewClassifierSettings;
	dimensions: DimensionConfig[];
	/** 读文件时的降级提示（缺失 / 解析失败 → 值按默认走，这里明说） */
	warnings: string[];
}

/** 单个维度的展示元信息（前端不知道 DIMENSIONS，这份随读一起发下去） */
export interface DimensionSpecRow {
	id: string;
	label: string;
	type: Primitive;
	supportsBelow: boolean;
	instructions: string;
}

/** 阈值与数值的取值范围（校验与前端步进共用，别在两处各写一份） */
export interface ReviewLimits {
	step: number;
	aboveMin: number;
	aboveMax: number;
	belowMin: number;
	belowMax: number;
	timeoutMsMin: number;
	timeoutMsMax: number;
	tokenIdleMsMin: number;
	tokenIdleMsMax: number;
	maxCacheMin: number;
	maxCacheMax: number;
	classifierTimeoutMsMin: number;
	classifierTimeoutMsMax: number;
}

export const REVIEW_LIMITS: ReviewLimits = {
	step: 0.05,
	// 与 TUI 面板同一口径（adjustThreshold 的夹取范围）：0 会让阈值永远触发，1 则永不触发
	aboveMin: 0.05,
	aboveMax: 0.99,
	belowMin: 0.05,
	belowMax: 0.99,
	// 总时长兜底：1 秒以下等于必然超时，10 分钟以上不如直接弹窗
	timeoutMsMin: 1000,
	timeoutMsMax: 600_000,
	// 相邻 token 间隔：低于 200ms 会误杀慢模型，高于 60s 就等于没有停滞判定
	tokenIdleMsMin: 200,
	tokenIdleMsMax: 60_000,
	maxCacheMin: 1,
	maxCacheMax: 100_000,
	// 分类器单次请求：200ms 以下必然超时，60s 以上不如不设
	classifierTimeoutMsMin: 200,
	classifierTimeoutMsMax: 60_000,
};

export interface ReviewIssue {
	/** 出问题的字段路径（llm.mode / classifier.baseUrl / dimensions.elevation.above） */
	field: string;
	/** 中文说明：哪个字段、为什么不接受 */
	message: string;
}

/** 校验失败：带字段级明细，调用方（CLI / 窗口）原样展示即可 */
export class ReviewSettingsError extends Error {
	readonly issues: ReviewIssue[];

	constructor(issues: ReviewIssue[] | string) {
		const list = typeof issues === "string" ? [{ field: "", message: issues }] : issues;
		super(list.map((i) => (i.field ? `${i.field}：${i.message}` : i.message)).join("\n"));
		this.name = "ReviewSettingsError";
		this.issues = list;
	}
}

function fail(field: string, message: string): never {
	throw new ReviewSettingsError([{ field, message }]);
}

// ═══════════════════════════════════════════════════
// 读
// ═══════════════════════════════════════════════════

/** 维度展示元信息（顺序与 DIMENSIONS 一致，前端照此渲染行） */
export function dimensionFieldSpecs(): DimensionSpecRow[] {
	return DIMENSIONS.map((d) => ({
		id: d.id,
		label: d.label,
		type: d.type,
		supportsBelow: d.supportsBelow,
		instructions: d.instructions,
	}));
}

/**
 * 读全套设置。文件缺失 / 写坏不抛，按默认值返回并在 warnings 里说明——
 * 设置窗要能打开，而不是白板；真要写盘时 replaceTomlKey 会因找不到键而拒绝，
 * 不会把一份坏文件当默认值重写回去。
 */
export function loadReviewSettings(paths: ReviewSettingsPaths = resolveReviewSettingsPaths()): ReviewSettings {
	const warnings: string[] = [];
	let doc: Record<string, unknown> = {};
	try {
		doc = parseToml(readFileSync(paths.extensionsToml, "utf8")) as Record<string, unknown>;
	} catch (err) {
		warnings.push(
			`读不到 ${paths.extensionsToml}（${err instanceof Error ? err.message : String(err)}），下面显示的是默认值`,
		);
	}

	const llmRaw = normalizeConfig(doc[LLM_REVIEW_SECTION]);
	const classifierRaw = normalizeClassifierConfig(doc[CLASSIFIER_SECTION]);

	let dimensions: DimensionConfig[];
	try {
		const dimDoc = parseToml(readFileSync(paths.dimensionsToml, "utf8")) as Record<string, unknown>;
		dimensions = normalizeDimensions(dimDoc.dimension);
	} catch (err) {
		warnings.push(
			`读不到 ${paths.dimensionsToml}（${err instanceof Error ? err.message : String(err)}），阈值按默认 0.5`,
		);
		dimensions = normalizeDimensions(undefined);
	}

	return {
		llm: {
			enabled: llmRaw.enabled,
			mode: llmRaw.mode,
			backend: llmRaw.backend,
			timeoutMs: llmRaw.timeoutMs,
			tokenIdleMs: llmRaw.tokenIdleMs,
			maxCache: llmRaw.maxCache,
		},
		classifier: {
			baseUrl: classifierRaw.baseUrl,
			model: classifierRaw.model,
			timeoutMs: classifierRaw.timeoutMs,
		},
		dimensions,
		warnings,
	};
}

// ═══════════════════════════════════════════════════
// TOML 文本层：按键原地替换（绝不整文件重写）
// ═══════════════════════════════════════════════════

/** 段落头：[name] 或 [[name]]（后者只是数组表，值替换用不到，识别出来是为了别串段） */
const SECTION_RE = /^\s*\[\[?([^\[\]]+)\]\]?\s*(?:#.*)?$/;
/** 一个键值行：缩进 + 键 + 等号与空白 + 余下（值 + 行尾注释） */
const KEY_LINE_RE = /^(\s*)([A-Za-z0-9_.-]+)(\s*=\s*)(.*)$/;

/**
 * 把一行里的「值」和「值之后的东西」拆开。
 *
 * 值之后的空白 + 行尾注释必须原样保留：`mode = "auto"  # auto=…` 改完还得是
 * `mode = "strict"  # auto=…`，两个空格和注释一个字都不能动。带引号的值先按引号
 * 收尾（值里可能含 #），裸值 / 数字 / 布尔则按「空白 + #」认注释起点。
 */
export function splitValueAndTail(rest: string): { value: string; tail: string } {
	const quote = rest[0];
	if (quote === '"' || quote === "'") {
		let i = 1;
		while (i < rest.length) {
			if (quote === '"' && rest[i] === "\\") {
				i += 2;
				continue;
			}
			if (rest[i] === quote) {
				i += 1;
				break;
			}
			i += 1;
		}
		return { value: rest.slice(0, i), tail: rest.slice(i) };
	}
	const hash = /(^|\s)#/.exec(rest);
	const value = (hash ? rest.slice(0, hash.index + hash[1].length) : rest).replace(/\s+$/, "");
	return { value, tail: rest.slice(value.length) };
}

/**
 * 只替换目标段里目标键那一行的值，返回新文本。
 * 找不到段或键 → 抛错（宁可不写，也不猜着新加一行）。其余行逐字保留。
 */
export function replaceTomlKey(text: string, section: string, key: string, rawValue: string): string {
	const lines = text.split("\n");
	let current = "";
	for (let i = 0; i < lines.length; i += 1) {
		const line = lines[i];
		const sec = SECTION_RE.exec(line);
		if (sec) {
			current = sec[1].trim();
			continue;
		}
		if (current !== section) continue;
		const m = KEY_LINE_RE.exec(line);
		if (!m || m[2] !== key) continue;
		const { tail } = splitValueAndTail(m[4]);
		lines[i] = `${m[1]}${m[2]}${m[3]}${rawValue}${tail}`;
		return lines.join("\n");
	}
	throw new ReviewSettingsError([
		{
			field: `${section}.${key}`,
			message: `在 ${section == "" ? "文件顶层" : `[${section}]`} 里找不到键 ${key}，拒绝写入（手改过文件？）`,
		},
	]);
}

// ═══════════════════════════════════════════════════
// 原子写
// ═══════════════════════════════════════════════════

export interface AtomicWriteDeps {
	writeFileSync?: typeof writeFileSync;
	renameSync?: typeof renameSync;
	rmSync?: typeof rmSync;
}

/**
 * 临时文件 + rename 落盘：写完才换名，进程在中途死掉也不会留下半个文件。
 * 临时文件与目标同目录（rename 不跨文件系统），失败时清掉。
 */
export function atomicWriteFile(path: string, text: string, deps: AtomicWriteDeps = {}): void {
	const write = deps.writeFileSync ?? writeFileSync;
	const rename = deps.renameSync ?? renameSync;
	const rm = deps.rmSync ?? rmSync;

	let mode = 0o644;
	try {
		mode = statSync(path).mode & 0o777;
	} catch {
		// 新文件：给个常规权限位
	}

	const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
	try {
		write(tmp, text, { encoding: "utf8", mode });
		rename(tmp, path);
	} catch (err) {
		try {
			rm(tmp, { force: true });
		} catch {
			// 清理失败不遮住原始错误
		}
		throw err;
	}
}

/** 写盘前先正规化位数（0.6000000000000001 这种浮点尾巴不要落进文件） */
function fmtThreshold(value: number): string {
	return value.toFixed(2);
}

function tomlValue(value: boolean | number | string): string {
	if (typeof value === "boolean") return value ? "true" : "false";
	if (typeof value === "number") return Number.isInteger(value) ? String(value) : String(Math.round(value * 100) / 100);
	return JSON.stringify(value);
}

// ═══════════════════════════════════════════════════
// 校验（纯函数；写盘前必须全过）
// ═══════════════════════════════════════════════════

function requireBoolean(field: string, value: unknown): boolean {
	if (typeof value !== "boolean") fail(field, `需要 true / false，收到 ${describe(value)}`);
	return value;
}

function describe(value: unknown): string {
	if (typeof value === "string") return `“${value}”`;
	if (value === null) return "null";
	if (value === undefined) return "未给出";
	if (typeof value === "number") return String(value);
	if (Array.isArray(value)) return "数组";
	return typeof value === "object" ? "对象" : String(value);
}

function requireNumber(field: string, value: unknown, min: number, max: number, unit: string): number {
	if (typeof value !== "number" || !Number.isFinite(value)) fail(field, `需要数字，收到 ${describe(value)}`);
	if (value < min || value > max) fail(field, `需要在 ${min}–${max} 之间${unit ? `（${unit}）` : ""}，收到 ${value}`);
	return Math.round(value);
}

function requireThreshold(field: string, value: unknown, min: number, max: number): number {
	if (typeof value !== "number" || !Number.isFinite(value)) fail(field, `需要数字，收到 ${describe(value)}`);
	if (value < min || value > max) fail(field, `需要在 ${min}–${max} 之间，收到 ${value}`);
	return Math.round(value * 100) / 100;
}

function requireEnum<T extends string>(field: string, value: unknown, allowed: readonly T[]): T {
	if (typeof value !== "string" || !allowed.includes(value as T)) {
		fail(field, `只接受 ${allowed.join(" / ")}，收到 ${describe(value)}`);
	}
	return value as T;
}

/** base_url 必须是 http(s)：分类器请求会带上可能含敏感内容的命令正文 */
export function validateBaseUrl(value: unknown): string {
	if (typeof value !== "string" || !value.trim()) fail("classifier.baseUrl", `需要非空的 http(s) 地址，收到 ${describe(value)}`);
	const url = value.trim();
	// 先看协议前缀：漏写 scheme（api.example.com）是最常见的错，
	// 这种输入压根进不到 URL 解析，先报「只接受 http(s)」比报「不是合法 URL」好修
	if (!/^https?:\/\//i.test(url)) {
		fail("classifier.baseUrl", `只接受 http:// 或 https:// 开头，收到“${url}”`);
	}
	try {
		new URL(url);
	} catch {
		fail("classifier.baseUrl", `不是合法的 URL：“${url}”`);
	}
	return url;
}

/** 模型名：非空、无空白与不可见字符（模型名里出现空白基本是粘错了） */
export function validateModelId(value: unknown): string {
	const field = "classifier.model";
	if (typeof value !== "string" || !value.trim()) fail(field, `需要模型名，收到 ${describe(value)}`);
	const model = value.trim();
	if (model.length > 200) fail(field, `模型名过长（${model.length} 字符，上限 200）`);
	if (/\s/.test(model)) fail(field, `模型名里不能有空白字符：“${model}”`);
	// eslint-disable-next-line no-control-regex
	if (/[\u0000-\u001f]/.test(model)) fail(field, "模型名里有控制字符");
	return model;
}

// ═══════════════════════════════════════════════════
// patch → 写盘计划
// ═══════════════════════════════════════════════════

export interface LlmSettingsPatch {
	enabled?: boolean;
	mode?: ReviewMode;
	backend?: ReviewBackend;
	timeoutMs?: number;
	tokenIdleMs?: number;
	maxCache?: number;
}

export interface ClassifierSettingsPatch {
	baseUrl?: string;
	model?: string;
	timeoutMs?: number;
}

export interface DimensionSettingsPatch {
	id: string;
	enabled?: boolean;
	above?: number;
	below?: number | null;
	action?: DimensionAction;
}

export interface ReviewSettingsPatch {
	llm?: LlmSettingsPatch;
	classifier?: ClassifierSettingsPatch;
	dimensions?: DimensionSettingsPatch[];
}

export interface KeyWrite {
	section: string;
	key: string;
	/** 已经序列化成 TOML 字面量的值 */
	value: string;
	/** 人可读的变更记录；值没变时为 undefined */
	change?: { field: string; from: string; to: string };
}

export interface WritePlan {
	writes: KeyWrite[];
	/** 维度写入（null = 这次不动维度文件） */
	dimensions: DimensionConfig[] | null;
}

function planLlm(current: ReviewLlmSettings, patch: LlmSettingsPatch): KeyWrite[] {
	const writes: KeyWrite[] = [];
	const add = (key: string, raw: string, next: boolean | number | string, prev: boolean | number | string, field: string) => {
		const write: KeyWrite = { section: LLM_REVIEW_SECTION, key, value: raw };
		if (String(prev) !== String(next)) write.change = { field, from: String(prev), to: String(next) };
		writes.push(write);
	};

	if (patch.enabled !== undefined) {
		const next = requireBoolean("llm.enabled", patch.enabled);
		add("enabled", tomlValue(next), next, current.enabled, "总开关");
	}
	if (patch.mode !== undefined) {
		const next = requireEnum("llm.mode", patch.mode, ["auto", "strict"] as const);
		add("mode", tomlValue(next), next, current.mode, "档位");
	}
	if (patch.backend !== undefined) {
		const next = requireEnum("llm.backend", patch.backend, ["chat", "classifier", "chain"] as const);
		add("backend", tomlValue(next), next, current.backend, "审核后端");
	}
	if (patch.timeoutMs !== undefined) {
		const next = requireNumber(
			"llm.timeoutMs（timeout_ms，审核总时长兜底，毫秒）",
			patch.timeoutMs,
			REVIEW_LIMITS.timeoutMsMin,
			REVIEW_LIMITS.timeoutMsMax,
			"毫秒",
		);
		add("timeout_ms", tomlValue(next), next, current.timeoutMs, "审核总时长兜底");
	}
	if (patch.tokenIdleMs !== undefined) {
		const next = requireNumber(
			"llm.tokenIdleMs（token_idle_ms，相邻 token 间隔上限，毫秒）",
			patch.tokenIdleMs,
			REVIEW_LIMITS.tokenIdleMsMin,
			REVIEW_LIMITS.tokenIdleMsMax,
			"毫秒",
		);
		add("token_idle_ms", tomlValue(next), next, current.tokenIdleMs, "相邻 token 间隔上限");
	}
	if (patch.maxCache !== undefined) {
		const next = requireNumber(
			"llm.maxCache（max_cache，内存缓存上限）",
			patch.maxCache,
			REVIEW_LIMITS.maxCacheMin,
			REVIEW_LIMITS.maxCacheMax,
			"",
		);
		add("max_cache", tomlValue(next), next, current.maxCache, "内存缓存上限");
	}
	return writes;
}

function planClassifier(current: ReviewClassifierSettings, patch: ClassifierSettingsPatch): KeyWrite[] {
	const writes: KeyWrite[] = [];
	const add = (key: string, raw: string, next: boolean | number | string, prev: boolean | number | string, field: string) => {
		const write: KeyWrite = { section: CLASSIFIER_SECTION, key, value: raw };
		if (String(prev) !== String(next)) write.change = { field, from: String(prev), to: String(next) };
		writes.push(write);
	};

	if (patch.baseUrl !== undefined) {
		const next = validateBaseUrl(patch.baseUrl);
		add("base_url", tomlValue(next), next, current.baseUrl, "分类器端点");
	}
	if (patch.model !== undefined) {
		const next = validateModelId(patch.model);
		add("model", tomlValue(next), next, current.model, "分类器模型");
	}
	if (patch.timeoutMs !== undefined) {
		const next = requireNumber(
			"classifier.timeoutMs（timeout_ms，分类器单次请求超时，毫秒）",
			patch.timeoutMs,
			REVIEW_LIMITS.classifierTimeoutMsMin,
			REVIEW_LIMITS.classifierTimeoutMsMax,
			"毫秒",
		);
		add("timeout_ms", tomlValue(next), next, current.timeoutMs, "分类器超时");
	}
	return writes;
}

/** 单个维度配置的合法性（写维度文件前全过一遍） */
export function validateDimensionConfig(dim: DimensionConfig): void {
	const spec = DIMENSIONS.find((d) => d.id === dim.id);
	if (!spec) {
		fail(`dimensions.${dim.id}`, `未知维度（可用：${DIMENSIONS.map((d) => d.id).join(" / ")}）`);
	}
	if (typeof dim.enabled !== "boolean") fail(`dimensions.${dim.id}.enabled`, `需要 true / false，收到 ${describe(dim.enabled)}`);
	if (dim.action !== "review" && dim.action !== "ignore") {
		fail(`dimensions.${dim.id}.action`, `只接受 review（提示）/ ignore（忽略），收到 ${describe(dim.action)}`);
	}
	requireThreshold(`dimensions.${dim.id}.above`, dim.above, REVIEW_LIMITS.aboveMin, REVIEW_LIMITS.aboveMax);
	if (spec.supportsBelow) {
		if (dim.below === null || dim.below === undefined) {
			fail(`dimensions.${dim.id}.below`, `维度「${spec.label}」有置信度，below 不能为空`);
		}
		requireThreshold(`dimensions.${dim.id}.below`, dim.below, REVIEW_LIMITS.belowMin, REVIEW_LIMITS.belowMax);
	} else if (dim.below !== null && dim.below !== undefined) {
		fail(`dimensions.${dim.id}.below`, `维度「${spec.label}」（${spec.type}）没有置信度，below 不适用`);
	}
}

function planDimensions(current: DimensionConfig[], patch: DimensionSettingsPatch[]): DimensionConfig[] | null {
	if (patch.length === 0) return null;
	const byId = new Map(current.map((d) => [d.id, { ...d }]));
	const touched = new Set<string>();
	for (const entry of patch) {
		if (!entry || typeof entry !== "object" || typeof entry.id !== "string") {
			fail("dimensions", `每一项都需要 id 字段，收到 ${describe(entry)}`);
		}
		const spec = DIMENSIONS.find((d) => d.id === entry.id);
		if (!spec) {
			fail(`dimensions.${entry.id}`, `未知维度 id（可用：${DIMENSIONS.map((d) => d.id).join(" / ")}）`);
		}
		if (touched.has(entry.id)) fail(`dimensions.${entry.id}`, "同一维度在一次提交里给了两次");
		touched.add(entry.id);
		const next: DimensionConfig = byId.get(entry.id) ?? {
			id: entry.id,
			enabled: true,
			above: 0.5,
			below: spec.supportsBelow ? 0.5 : null,
			action: "review",
		};
		if (entry.enabled !== undefined) next.enabled = requireBoolean(`dimensions.${entry.id}.enabled`, entry.enabled);
		if (entry.above !== undefined) {
			next.above = requireThreshold(`dimensions.${entry.id}.above`, entry.above, REVIEW_LIMITS.aboveMin, REVIEW_LIMITS.aboveMax);
		}
		if (entry.below !== undefined) {
			if (entry.below === null) {
				if (spec.supportsBelow) fail(`dimensions.${entry.id}.below`, `维度「${spec.label}」有置信度，below 不能为空`);
				next.below = null;
			} else {
				if (!spec.supportsBelow) fail(`dimensions.${entry.id}.below`, `维度「${spec.label}」（${spec.type}）没有置信度，below 不适用`);
				next.below = requireThreshold(
					`dimensions.${entry.id}.below`,
					entry.below,
					REVIEW_LIMITS.belowMin,
					REVIEW_LIMITS.belowMax,
				);
			}
		}
		if (entry.action !== undefined) {
			next.action = requireEnum(`dimensions.${entry.id}.action`, entry.action, ["review", "ignore"] as const);
		}
		validateDimensionConfig(next);
		byId.set(entry.id, next);
	}
	// 顺序按 DIMENSIONS（与既有文件格式一致），未提到的维度保持原值
	return DIMENSIONS.map((spec) => byId.get(spec.id)).filter((d): d is DimensionConfig => d !== undefined);
}

function asRecord(value: unknown, field: string): Record<string, unknown> {
	if (value === undefined || value === null) return {};
	if (typeof value !== "object" || Array.isArray(value)) fail(field, `需要一个对象，收到 ${describe(value)}`);
	return value as Record<string, unknown>;
}

/** 全量校验一个 patch（纯函数，不碰文件系统） */
export function planSettingsWrite(current: ReviewSettings, patch: unknown): WritePlan {
	const root = asRecord(patch, "patch");
	const writes: KeyWrite[] = [
		...planLlm(current.llm, asRecord(root.llm, "llm") as LlmSettingsPatch),
		...planClassifier(current.classifier, asRecord(root.classifier, "classifier") as ClassifierSettingsPatch),
	];
	const dimsRaw = root.dimensions;
	if (dimsRaw !== undefined && !Array.isArray(dimsRaw)) fail("dimensions", `需要数组，收到 ${describe(dimsRaw)}`);
	const dimensions = Array.isArray(dimsRaw) ? planDimensions(current.dimensions, dimsRaw as DimensionSettingsPatch[]) : null;
	return { writes, dimensions };
}

// ═══════════════════════════════════════════════════
// 维度文件（沿用既有整文件格式；落盘原子替换）
// ═══════════════════════════════════════════════════

const DIMENSIONS_HEADER = `# 指令审核维度阈值（分类模型后端）
#
# 由 /sandbox:gui 面板维护（整文件重写，手改请保持本格式）。
# 端点与模型在 extensions.toml 的 [sandbox-review-classifier]；本文件只管阈值。
#
#   above  = 风险值高于它 → 提示用户过目
#            （choice 取高风险档概率之和；score 按档位线性归一化；noul 取「是」的概率）
#   below  = 置信度低于它 → 提示用户过目（模型没把握，宁可信其有）
#            noul 没有置信度，该字段对 scripted_edit 无效
#   action = review（提示）| ignore（不看这一维）
#            —— 没有 block：分类器是试验品，不允许它直接拒绝任何请求
`;

/** 维度配置 → TOML 文本（整文件内容；写回与测试共用） */
export function formatDimensionsToml(dims: DimensionConfig[]): string {
	const blocks = dims.map((d) => {
		const lines = [`[[dimension]]`, `id = "${d.id}"`, `enabled = ${d.enabled}`, `above = ${fmtThreshold(d.above)}`];
		if (d.below !== null) lines.push(`below = ${fmtThreshold(d.below)}`);
		lines.push(`action = "${d.action}"`);
		return lines.join("\n");
	});
	return `${DIMENSIONS_HEADER}\n${blocks.join("\n\n")}\n`;
}

/** 写维度文件（先校验再原子替换） */
export function saveDimensions(
	dims: DimensionConfig[],
	paths: ReviewSettingsPaths = resolveReviewSettingsPaths(),
	deps: AtomicWriteDeps = {},
): void {
	for (const dim of dims) validateDimensionConfig(dim);
	atomicWriteFile(paths.dimensionsToml, formatDimensionsToml(dims), deps);
}

// ═══════════════════════════════════════════════════
// 写
// ═══════════════════════════════════════════════════

export interface SaveReviewResult {
	/** 真正变化的字段（人可读的 “字段: 旧 → 新”） */
	changed: string[];
	settings: ReviewSettings;
	specs: DimensionSpecRow[];
	limits: ReviewLimits;
	paths: ReviewSettingsPaths;
}

/**
 * 应用一个 patch 并落盘。
 *
 * 顺序是刻意的：先把 patch 全量校验成写盘计划（任何一项不合法就抛，文件一个字节都没动），
 * 再把新文本整份算出来，最后才原子替换。extensions.toml 走按键替换，
 * 维度文件走既有整文件格式。
 */
export function saveReviewSettings(
	patch: unknown,
	paths: ReviewSettingsPaths = resolveReviewSettingsPaths(),
	deps: AtomicWriteDeps = {},
): SaveReviewResult {
	const current = loadReviewSettings(paths);
	const plan = planSettingsWrite(current, patch);

	// 文本先在内存里改完：replaceTomlKey 找不到键会在这里抛，此时还没落盘
	let text: string | null = null;
	try {
		text = readFileSync(paths.extensionsToml, "utf8");
	} catch {
		text = null;
	}
	if (plan.writes.length > 0) {
		if (text === null) {
			fail("extensions.toml", `读不到 ${paths.extensionsToml}，拒绝写入`);
		}
		let next = text as string;
		for (const w of plan.writes) next = replaceTomlKey(next, w.section, w.key, w.value);
		if (next !== text) atomicWriteFile(paths.extensionsToml, next, deps);
	}

	if (plan.dimensions) {
		const nextText = formatDimensionsToml(plan.dimensions);
		let prevText = "";
		try {
			prevText = readFileSync(paths.dimensionsToml, "utf8");
		} catch {
			prevText = "";
		}
		if (nextText !== prevText) atomicWriteFile(paths.dimensionsToml, nextText, deps);
	}

	const changed: string[] = [];
	for (const w of plan.writes) {
		if (w.change) changed.push(`${w.change.field}: ${w.change.from} → ${w.change.to}`);
	}
	if (plan.dimensions) {
		const before = new Map(current.dimensions.map((d) => [d.id, d]));
		for (const dim of plan.dimensions) {
			const prev = before.get(dim.id);
			if (!prev) continue;
			if (prev.enabled !== dim.enabled) changed.push(`${dim.id}.enabled: ${prev.enabled} → ${dim.enabled}`);
			if (prev.above !== dim.above) changed.push(`${dim.id}.above: ${prev.above} → ${dim.above}`);
			if (prev.below !== dim.below) changed.push(`${dim.id}.below: ${prev.below} → ${dim.below}`);
			if (prev.action !== dim.action) changed.push(`${dim.id}.action: ${prev.action} → ${dim.action}`);
		}
	}

	return {
		changed,
		settings: loadReviewSettings(paths),
		specs: dimensionFieldSpecs(),
		limits: REVIEW_LIMITS,
		paths,
	};
}

/** 文件是否存在（CLI 用来区分「没写过」与「写坏了」） */
export function reviewConfigFilesExist(paths: ReviewSettingsPaths = resolveReviewSettingsPaths()): {
	extensionsToml: boolean;
	dimensionsToml: boolean;
} {
	return { extensionsToml: existsSync(paths.extensionsToml), dimensionsToml: existsSync(paths.dimensionsToml) };
}
