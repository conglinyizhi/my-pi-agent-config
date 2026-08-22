// llm-review.ts — gate 危险命令的 LLM 预审层
//
// 位置：gate.ts 审批流程中「autoReject 硬拦之后、弹窗之前」。
// 职责：命中需确认规则（rm/sudo/dd/动态构造/管道执行器等）的 bash 命令，
//       先调用 LLM API 做质量与安全审核：
//   - verdict=safe 且 mode=auto → 直接放行（不弹窗，解决弹窗频繁）
//   - verdict=risky/dangerous/error → 回退原弹窗流程（意见附加进 TUI 展示）
//
// 安全底线（与 gate.ts 联动）：
//   - autoReject 规则永不进本层（gate.ts 先硬拦，不弹窗也不审）
//   - 审核失败（超时/网络/解析失败/无可用模型）一律回退弹窗，绝不静默放行
//   - 命令文本会发送到配置的 LLM API（默认当前会话模型）；启用即视为知情
//
// 结构：纯函数（可单测）与副作用（调 API / 读配置）分离：
//   - buildReviewPrompt / extractReviewResult / reviewCacheKey /
//     createReviewCache / normalizeConfig 为纯函数，llm-review.test.ts 覆盖
//   - reviewCommand / loadLlmReviewConfig / loadReviewSystemPrompt 为副作用，不单测

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { parse as parseToml } from "smol-toml";
import { Type } from "typebox";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, Context, Model, TextContent, Tool, ToolCall } from "@earendil-works/pi-ai";
import type { TokenRule } from "./rule-engine";

export type ReviewVerdict = "safe" | "risky" | "dangerous" | "error";

export interface ReviewResult {
	verdict: ReviewVerdict;
	/** 一句话理由（中文；verdict=error 时为错误摘要） */
	reason: string;
	/** 更安全的替代写法或注意点（无则空字符串） */
	suggestion: string;
	/** 模型调用工具后补充的命令质量看法（可选，供人工审核参考） */
	opinion?: string;
}

/** 审核模型引用（provider/model 对，用于模型池） */
export interface ModelRef {
	provider: string;
	model: string;
}

export interface LlmReviewConfig {
	/** 总开关：false 时 gate 完全跳过本层，回到原弹窗流程 */
	enabled: boolean;
	/**
	 * auto：verdict=safe 直接放行不弹窗（默认，减少弹窗）
	 * strict：LLM 只提供意见，无论 verdict 都仍弹窗人工确认
	 */
	mode: "auto" | "strict";
	/**
	 * 审核模型池：按顺序尝试，单个模型失败（限流/超时/网络）自动切换下一个，
	 * 全部失败才判 error 回退弹窗（失败原因汇总展示）。缓解免费模型限流冲击。
	 * 池子为空且未配置 provider/model → 用当前会话模型。
	 */
	models?: ModelRef[];
	/** 兼容旧配置：单模型（provider/model）；与 models 互斥，models 优先 */
	provider?: string;
	model?: string;
	/** 单模型单次审核超时（毫秒），超时视为该模型失败，切换下一个 */
	timeoutMs: number;
	/** 内存缓存上限（同命令同规则不重复调 API） */
	maxCache: number;
}

const DEFAULT_CONFIG: LlmReviewConfig = {
	enabled: true,
	mode: "auto",
	timeoutMs: 10_000,
	maxCache: 200,
};

// ═══════════════════════════════════════════════════
// 配置
// ═══════════════════════════════════════════════════

const EXTENSIONS_TOML_PATH = join(getAgentDir(), "extensions.toml");
const CONFIG_SECTION = "sandbox-llm-review";
/** 独立存放的审核 system prompt（纯文本；改完即生效，下次审核现读） */
const REVIEW_PROMPT_PATH = join(getAgentDir(), "extensions", "sandbox-permissions", "review-system-prompt.txt");
/** 审核模型池独立文件（个人依赖：供应商配置/API key 不入库，已 gitignore） */
const REVIEW_POOL_PATH = join(getAgentDir(), "extensions", "sandbox-permissions", "review-pool.toml");

/** 合并原始配置对象与默认值（纯函数；raw 可为 extensions.toml 中 section 的任意值） */
export function normalizeConfig(raw: unknown): LlmReviewConfig {
	const cfg = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
	const out: LlmReviewConfig = { ...DEFAULT_CONFIG };
	if (typeof cfg.enabled === "boolean") out.enabled = cfg.enabled;
	if (cfg.mode === "strict") out.mode = "strict";
	// 模型池：models = [{ provider, model }, ...]；仅收录结构合法的条目
	if (Array.isArray(cfg.models)) {
		const refs: ModelRef[] = [];
		for (const m of cfg.models) {
			if (m && typeof m === "object") {
				const { provider, model } = m as Record<string, unknown>;
				if (typeof provider === "string" && provider && typeof model === "string" && model) {
					refs.push({ provider, model });
				}
			}
		}
		if (refs.length > 0) out.models = refs;
	}
	// 兼容旧配置：单模型（models 缺省时生效）
	if (!out.models && typeof cfg.provider === "string" && cfg.provider && typeof cfg.model === "string" && cfg.model) {
		out.provider = cfg.provider;
		out.model = cfg.model;
	}
	if (typeof cfg.timeout_ms === "number" && Number.isFinite(cfg.timeout_ms) && cfg.timeout_ms > 0) {
		out.timeoutMs = Math.round(cfg.timeout_ms);
	}
	if (typeof cfg.max_cache === "number" && Number.isFinite(cfg.max_cache) && cfg.max_cache > 0) {
		out.maxCache = Math.round(cfg.max_cache);
	}
	return out;
}

/** 读取独立审核池文件（副作用；缺失/解析失败/无 models → undefined） */
function loadReviewPool(): ModelRef[] | undefined {
	try {
		const doc = parseToml(readFileSync(REVIEW_POOL_PATH, "utf8")) as { models?: unknown };
		if (!Array.isArray(doc.models)) return undefined;
		const refs: ModelRef[] = [];
		for (const m of doc.models) {
			if (m && typeof m === "object") {
				const { provider, model } = m as Record<string, unknown>;
				if (typeof provider === "string" && provider && typeof model === "string" && model) {
					refs.push({ provider, model });
				}
			}
		}
		return refs;
	} catch {
		return undefined;
	}
}

/** 读取 extensions.toml 的 [sandbox-llm-review] 配置，模型池以独立文件为准（文件缺失/解析失败 → 默认配置） */
export function loadLlmReviewConfig(): LlmReviewConfig {
	try {
		const doc = parseToml(readFileSync(EXTENSIONS_TOML_PATH, "utf8")) as Record<string, unknown>;
		const cfg = normalizeConfig(doc[CONFIG_SECTION]);
		// 审核模型池独立存放（个人依赖，不入库）；外部文件优先，缺省回退 extensions.toml 内联 models
		const pool = loadReviewPool();
		if (pool && pool.length > 0) cfg.models = pool;
		return cfg;
	} catch {
		return { ...DEFAULT_CONFIG };
	}
}

// ═══════════════════════════════════════════════════
// Prompt 构造（纯函数）
// ═══════════════════════════════════════════════════

// system prompt 独立存放在 review-system-prompt.txt（本插件目录），改完即生效；
// 读失败返回 null，调用方按 error 回退弹窗，绝不静默放行。

/** 审核结论汇报工具：LLM 通过工具调用提交结构化结论（verdict/reason/suggestion），
 *  替代脆弱的自由文本 JSON 解析；参数由 schema 约束，免去文本容错。 */
export const REVIEW_TOOL: Tool = {
	name: "report_review_verdict",
	description: "汇报对 shell 命令的安全审核结论。",
	parameters: Type.Object({
		verdict: Type.Union([Type.Literal("safe"), Type.Literal("risky"), Type.Literal("dangerous")]),
		reason: Type.String({ description: "一句话理由（中文）" }),
		suggestion: Type.String({ description: "更安全的替代写法或注意点（无则空字符串）" }),
	}),
};

/** 读取审核 system prompt（副作用；文件缺失/读失败 → null） */
export function loadReviewSystemPrompt(): string | null {
	try {
		return readFileSync(REVIEW_PROMPT_PATH, "utf8");
	} catch {
		return null;
	}
}

/** 构造审核请求的 system + user 消息（纯函数；system 由调用方传入） */
export function buildReviewPrompt(
	system: string,
	command: string,
	rules: TokenRule[],
): { system: string; user: string } {
	const ruleText =
		rules.length === 0
			? "（无具体规则命中，属动态构造等需人工确认的情形）"
			: rules
					.map((r) => `- ${r.name}：${r.tip}${r.matched?.length ? `（命中：${r.matched.join(" ")}）` : ""}`)
					.join("\n");
	const preview = command.length > 4000 ? command.slice(0, 4000) + "\n…（命令过长已截断）" : command;
	return {
		system,
		user: `命令：\n${preview}\n\n命中风险点：\n${ruleText}`,
	};
}

// ═══════════════════════════════════════════════════
// 输出解析（纯函数，容错）
// ═══════════════════════════════════════════════════

/** 从完整响应中提取审核结论（纯函数；传 response.content）：
 *  结论通过 report_review_verdict 工具调用提交（结构化 verdict，schema 约束）；
 *  模型回复的自由文本一律不做 JSON 解析，原样作为 opinion（看法）展示给人工审核者，
 *  允许像日常交流一样自然表述；
 *  未调用工具 → 无法结构化判定（verdict=error，回退弹窗），文本仍作为 opinion 附带展示。 */
export function extractReviewResult(content: AssistantMessage["content"]): ReviewResult {
	const opinion = content
		.filter((c): c is TextContent => c.type === "text")
		.map((c) => c.text)
		.join("\n")
		.trim()
		.slice(0, 500);
	const toolCall = content.find((c): c is ToolCall => c.type === "toolCall" && c.name === REVIEW_TOOL.name);
	if (toolCall) {
		const { verdict, reason, suggestion } = toolCall.arguments ?? {};
		if (verdict === "safe" || verdict === "risky" || verdict === "dangerous") {
			const result: ReviewResult = {
				verdict,
				reason: typeof reason === "string" ? reason.slice(0, 300) : "",
				suggestion: typeof suggestion === "string" ? suggestion.slice(0, 300) : "",
			};
			if (opinion) result.opinion = opinion;
			return result;
		}
		return { verdict: "error", reason: "invalid tool call arguments", suggestion: "", ...(opinion ? { opinion } : {}) };
	}
	// 未调用工具：不把文本当 JSON 解析，文本作为看法展示；verdict 按无法判定回退弹窗
	return {
		verdict: "error",
		reason: "模型未给出结构化结论（未调用审核工具）",
		suggestion: "",
		...(opinion ? { opinion } : {}),
	};
}

// ═══════════════════════════════════════════════════
// 内存缓存（同命令同规则不重复调 API）
// ═══════════════════════════════════════════════════

export interface ReviewCache {
	get(key: string): ReviewResult | undefined;
	set(key: string, value: ReviewResult): void;
	clear(): void;
}

/** 命令 + 规则集 → 稳定 key（规则按 name 排序，matched 参与） */
export function reviewCacheKey(command: string, rules: TokenRule[]): string {
	const rulePart = rules
		.map((r) => `${r.name}:${(r.matched ?? []).join(" ")}`)
		.sort()
		.join("|");
	return createHash("sha256").update(`${command}\u0000${rulePart}`).digest("hex").slice(0, 24);
}

/** LRU 简化版缓存：超上限时整体清空（审核结果量小，够用即可） */
export function createReviewCache(maxEntries = 200): ReviewCache {
	const map = new Map<string, ReviewResult>();
	return {
		get(key) {
			const v = map.get(key);
			if (v === undefined) return undefined;
			// 触达即提升为最新（保持 LRU 语义）
			map.delete(key);
			map.set(key, v);
			return v;
		},
		set(key, value) {
			if (map.has(key)) map.delete(key);
			map.set(key, value);
			if (map.size > maxEntries) {
				const oldest = map.keys().next().value;
				if (oldest !== undefined) map.delete(oldest);
			}
		},
		clear() {
			map.clear();
		},
	};
}

// ═══════════════════════════════════════════════════
// 审核调用（副作用：读配置 + 调 LLM API）
// ═══════════════════════════════════════════════════

/**
 * 候选审核模型列表。
 * - 配置了模型池（models）或单模型（provider/model）→ 只返回这些（配置缺失的跳过），
 *   池内切换是显式配置的容错，不是静默换模型；
 * - 完全未配置 → 当前会话模型（文档化的默认行为）；
 * - 返回 source 供调用方区分「配置了但不可用」与「未配置且无会话模型」。
 */
function pickModels(
	ctx: ExtensionContext,
	config: LlmReviewConfig,
): { models: Model<any>[]; source: "configured" | "session" } {
	const refs =
		config.models ??
		(config.provider && config.model ? [{ provider: config.provider, model: config.model }] : []);
	if (refs.length > 0) {
		const models = refs
			.map((r) => ctx.modelRegistry.find(r.provider, r.model))
			.filter((m): m is Model<any> => m !== undefined);
		return { models, source: "configured" };
	}
	return { models: ctx.model ? [ctx.model] : [], source: "session" };
}

/**
 * 执行一次 LLM 审核。
 * 失败一律返回 verdict=error（含禁用/无模型/超时/网络/解析失败），调用方必须回退弹窗。
 */
export async function reviewCommand(
	_pi: ExtensionAPI,
	ctx: ExtensionContext,
	command: string,
	rules: TokenRule[],
	signal: AbortSignal | undefined,
	cache: ReviewCache,
	config?: LlmReviewConfig,
): Promise<ReviewResult> {
	const cfg = config ?? loadLlmReviewConfig();
	if (!cfg.enabled) return { verdict: "error", reason: "llm review disabled", suggestion: "" };

	const key = reviewCacheKey(command, rules);
	const hit = cache.get(key);
	if (hit) return hit;

	const { models, source } = pickModels(ctx, cfg);
	if (models.length === 0) {
		return {
			verdict: "error",
			reason: source === "configured" ? "配置的审核模型均不可用" : "no usable model for llm review",
			suggestion: "",
		};
	}

	const systemPrompt = loadReviewSystemPrompt();
	if (systemPrompt === null) {
		return { verdict: "error", reason: "review system prompt missing", suggestion: "" };
	}
	const { system, user } = buildReviewPrompt(systemPrompt, command, rules);

	// 本地类型 0.80.10 的 ModelRegistry 尚无 complete（运行时 0.84.2 已提供），
	// 用窄接口断言绕过类型检查；运行时行为以实际 pi 版本为准。
	const completer = ctx.modelRegistry as unknown as {
		complete(
			model: Model<any>,
			context: Context,
			options?: { signal?: AbortSignal; maxTokens?: number; temperature?: number },
		): Promise<AssistantMessage>;
	};

	// 模型池：按序尝试，单个失败（限流/超时/网络）切换下一个；全部失败才 error。
	// 用户中止信号（signal）一旦触发立即返回，不再换模型。
	const failures: string[] = [];
	for (const model of models) {
		const timeoutSignal = AbortSignal.timeout(cfg.timeoutMs);
		const merged = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
		try {
			const response = await completer.complete(
				model,
				{
					systemPrompt: system,
					messages: [{ role: "user", content: user, timestamp: Date.now() }],
					// 审核结论走工具调用（report_review_verdict），结构化参数免文本解析
					tools: [REVIEW_TOOL],
				},
				{ signal: merged, maxTokens: 512, temperature: 0 },
			);
			if (response.stopReason === "aborted" || response.stopReason === "error") {
				const reason = response.errorMessage ?? `llm ${response.stopReason}`;
				if (signal?.aborted || response.stopReason === "aborted") {
					return { verdict: "error", reason: "aborted", suggestion: "" };
				}
				failures.push(`${model.id}: ${reason}`);
				continue;
			}
			const result = extractReviewResult(response.content);
			if (result.verdict !== "error") {
				// 只缓存有效结论；error 是瞬态（网络抖动等），下次重审
				cache.set(key, result);
				return result;
			}
			failures.push(`${model.id}: ${result.reason}`);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			if (signal?.aborted || msg === "aborted") {
				return { verdict: "error", reason: "aborted", suggestion: "" };
			}
			failures.push(`${model.id}: ${msg}`);
		}
	}
	return {
		verdict: "error",
		reason: `审核模型全部失败：${failures.join("；")}`,
		suggestion: "",
	};
}

/** 审核结论的展示文本（供弹窗 / GUI 展示附加） */
export function formatReviewNote(review: ReviewResult): string {
	const label =
		review.verdict === "dangerous" ? "危险" : review.verdict === "risky" ? "有风险" : review.verdict;
	const parts = [`🤖 LLM 审查：${label}`];
	if (review.reason) parts.push(review.reason);
	if (review.suggestion) parts.push(`建议：${review.suggestion}`);
	if (review.opinion) parts.push(`看法：${review.opinion}`);
	return parts.join(" —— ");
}
