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
//   - buildReviewPrompt / parseVerdict / reviewCacheKey / createReviewCache /
//     normalizeConfig 为纯函数，llm-review.test.ts 覆盖
//   - reviewCommand / loadLlmReviewConfig 为副作用，不单测

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { parse as parseToml } from "smol-toml";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, Context, Model } from "@earendil-works/pi-ai";
import type { TokenRule } from "./rule-engine";

export type ReviewVerdict = "safe" | "risky" | "dangerous" | "error";

export interface ReviewResult {
	verdict: ReviewVerdict;
	/** 一句话理由（中文；verdict=error 时为错误摘要） */
	reason: string;
	/** 更安全的替代写法或注意点（无则空字符串） */
	suggestion: string;
}

export interface LlmReviewConfig {
	/** 总开关：false 时 gate 完全跳过本层，回到原弹窗流程 */
	enabled: boolean;
	/**
	 * auto：verdict=safe 直接放行不弹窗（默认，减少弹窗）
	 * strict：LLM 只提供意见，无论 verdict 都仍弹窗人工确认
	 */
	mode: "auto" | "strict";
	/** 指定审核模型（provider/model）；缺省用当前会话模型 ctx.model */
	provider?: string;
	model?: string;
	/** 单次审核超时（毫秒），超时视为 error 回退弹窗 */
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

/** 合并原始配置对象与默认值（纯函数；raw 可为 extensions.toml 中 section 的任意值） */
export function normalizeConfig(raw: unknown): LlmReviewConfig {
	const cfg = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
	const out: LlmReviewConfig = { ...DEFAULT_CONFIG };
	if (typeof cfg.enabled === "boolean") out.enabled = cfg.enabled;
	if (cfg.mode === "strict") out.mode = "strict";
	if (typeof cfg.provider === "string" && cfg.provider) out.provider = cfg.provider;
	if (typeof cfg.model === "string" && cfg.model) out.model = cfg.model;
	if (typeof cfg.timeout_ms === "number" && Number.isFinite(cfg.timeout_ms) && cfg.timeout_ms > 0) {
		out.timeoutMs = Math.round(cfg.timeout_ms);
	}
	if (typeof cfg.max_cache === "number" && Number.isFinite(cfg.max_cache) && cfg.max_cache > 0) {
		out.maxCache = Math.round(cfg.max_cache);
	}
	return out;
}

/** 读取 extensions.toml 的 [sandbox-llm-review] 配置（文件缺失/解析失败/缺 section → 默认配置） */
export function loadLlmReviewConfig(): LlmReviewConfig {
	try {
		const doc = parseToml(readFileSync(EXTENSIONS_TOML_PATH, "utf8")) as Record<string, unknown>;
		return normalizeConfig(doc[CONFIG_SECTION]);
	} catch {
		return { ...DEFAULT_CONFIG };
	}
}

// ═══════════════════════════════════════════════════
// Prompt 构造（纯函数）
// ═══════════════════════════════════════════════════

const REVIEW_SYSTEM_PROMPT = [
	"你是一个 bash 命令安全审核器。你的任务：判断一条即将被执行的 bash 命令是否危险、写法是否合格。",
	"本地规则引擎已标记该命令命中以下风险点：",
	"",
	"请综合命令的真实意图与风险，只输出一个严格 JSON 对象（不要输出任何其他内容、不要 markdown 代码块）：",
	'{"verdict":"safe|risky|dangerous","reason":"一句话理由（中文）","suggestion":"更安全的替代写法或注意点（无则空字符串）"}',
	"",
	"判定标准：",
	"- safe：意图明确、风险可控、属常见操作。例如：对明确的临时目录做递归删除、对明确文件的权限调整、动态构造但内容可静态确认无注入。",
	"- risky：存在一定风险或写法不当，建议人工确认。例如：删除路径含通配符或变量、重定向覆盖非临时文件、命令拼接不可静态确认。",
	"- dangerous：明确危险或可能破坏系统/泄露数据。例如：删除系统关键路径、绕过沙箱、把敏感数据外传、sudo 提权后做破坏性操作。",
	"",
	"注意：只做审核与建议，不要执行、不要展开发挥。",
].join("\n");

/** 构造审核请求的 system + user 消息（纯函数） */
export function buildReviewPrompt(command: string, rules: TokenRule[]): { system: string; user: string } {
	const ruleText =
		rules.length === 0
			? "（无具体规则命中，属动态构造等需人工确认的情形）"
			: rules
					.map((r) => `- ${r.name}：${r.tip}${r.matched?.length ? `（命中：${r.matched.join(" ")}）` : ""}`)
					.join("\n");
	const preview = command.length > 4000 ? command.slice(0, 4000) + "\n…（命令过长已截断）" : command;
	return {
		system: REVIEW_SYSTEM_PROMPT,
		user: `命令：\n${preview}\n\n命中风险点：\n${ruleText}`,
	};
}

// ═══════════════════════════════════════════════════
// 输出解析（纯函数，容错）
// ═══════════════════════════════════════════════════

/** 从 LLM 输出中容错解析审核结论；任何失败 → verdict=error（调用方回退弹窗） */
export function parseVerdict(text: string): ReviewResult {
	const fail = (reason: string): ReviewResult => ({ verdict: "error", reason, suggestion: "" });
	if (!text || !text.trim()) return fail("empty response");

	// 剥离 ```json ... ``` / ``` ... ``` 包裹
	let cleaned = text.trim();
	const fence = cleaned.match(/^```(?:json)?\s*([\s\S]*?)```$/);
	if (fence) cleaned = fence[1].trim();

	// 提取第一个 { 到最后一个 }（容忍前后缀噪音）
	const start = cleaned.indexOf("{");
	const end = cleaned.lastIndexOf("}");
	if (start === -1 || end <= start) return fail("no json object in response");

	let parsed: unknown;
	try {
		parsed = JSON.parse(cleaned.slice(start, end + 1));
	} catch {
		return fail("invalid json");
	}
	if (!parsed || typeof parsed !== "object") return fail("json not an object");

	const obj = parsed as Record<string, unknown>;
	const verdict = obj.verdict;
	if (verdict !== "safe" && verdict !== "risky" && verdict !== "dangerous") {
		return fail(`unexpected verdict: ${String(verdict)}`);
	}
	return {
		verdict,
		reason: typeof obj.reason === "string" ? obj.reason.slice(0, 300) : "",
		suggestion: typeof obj.suggestion === "string" ? obj.suggestion.slice(0, 300) : "",
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

/** 选择审核模型：配置显式指定优先，否则当前会话模型，兜底 deepseek flash */
function pickModel(ctx: ExtensionContext, config: LlmReviewConfig): Model<any> | undefined {
	if (config.provider && config.model) {
		const m = ctx.modelRegistry.find(config.provider, config.model);
		if (m) return m;
	}
	if (ctx.model) return ctx.model;
	return ctx.modelRegistry.find("deepseek", "deepseek-v4-flash");
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

	const model = pickModel(ctx, cfg);
	if (!model) return { verdict: "error", reason: "no usable model for llm review", suggestion: "" };

	const { system, user } = buildReviewPrompt(command, rules);
	// 超时兜底 + 会话中止信号合并；任一触发即中止
	const timeoutSignal = AbortSignal.timeout(cfg.timeoutMs);
	const merged = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;

	// 本地类型 0.80.10 的 ModelRegistry 尚无 complete（运行时 0.84.2 已提供），
	// 用窄接口断言绕过类型检查；运行时行为以实际 pi 版本为准。
	const completer = ctx.modelRegistry as unknown as {
		complete(
			model: Model<any>,
			context: Context,
			options?: { signal?: AbortSignal; maxTokens?: number; temperature?: number },
		): Promise<AssistantMessage>;
	};

	try {
		const response = await completer.complete(
			model,
			{
				systemPrompt: system,
				messages: [{ role: "user", content: user, timestamp: Date.now() }],
			},
			{ signal: merged, maxTokens: 512, temperature: 0 },
		);
		if (response.stopReason === "aborted" || response.stopReason === "error") {
			return {
				verdict: "error",
				reason: response.errorMessage ?? `llm ${response.stopReason}`,
				suggestion: "",
			};
		}
		const text = response.content
			.filter((c): c is { type: "text"; text: string } => c.type === "text")
			.map((c) => c.text)
			.join("\n");
		const result = parseVerdict(text);
		// 只缓存有效结论；error 是瞬态（网络抖动等），下次重审
		if (result.verdict !== "error") cache.set(key, result);
		return result;
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		if (msg === "aborted" || /aborted|timeout/i.test(msg)) {
			return { verdict: "error", reason: "aborted", suggestion: "" };
		}
		return { verdict: "error", reason: `llm call failed: ${msg}`, suggestion: "" };
	}
}

/** 审核结论的展示文本（供 TUI 弹窗附加） */
export function formatReviewNote(review: ReviewResult): string {
	const label =
		review.verdict === "dangerous" ? "危险" : review.verdict === "risky" ? "有风险" : review.verdict;
	const parts = [`🤖 LLM 审查：${label}`];
	if (review.reason) parts.push(review.reason);
	if (review.suggestion) parts.push(`建议：${review.suggestion}`);
	return parts.join(" —— ");
}
