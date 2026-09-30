// review-classifier.ts — 用分类模型替代 chat 模型做指令预审
//
// 与 chat 后端的区别：
//   chat：     命令+规则塞进 prompt，模型吐 verdict（safe/risky/dangerous）
//   classifier：一次请求问八个原子问题，拿回类型化答案 + 概率，**代码**按阈值决定要不要打扰用户
//
// 两条硬约束写在类型里：
//   1. 结果只可能是 safe（放行）或 risky（弹窗），**没有 dangerous/block**——
//      分类器是试验品，可靠性没有数据支撑，不许它挡死任何请求。
//   2. 任何失败（无 key / 超时 / 协议错 / 漏答）都折成 verdict=error，由调用方回退弹窗，
//      绝不静默放行。
//
// 理由（弹窗里给人看的那句话）由命中维度拼装：分类模型不产文本，理由必须来自代码。

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { parse as parseToml } from "smol-toml";
import { classifyReview, DEFAULT_BASE_URL, DEFAULT_MODEL, DEFAULT_TIMEOUT_MS, type ClassifyOptions } from "./classifier-client.ts";
import { buildQuestions, buildReviewState } from "./classifier-client.ts";
import {
	DEFAULT_THRESHOLD,
	DIMENSIONS,
	defaultDimensionConfigs,
	dimensionReportDetailed,
	evaluateAll,
	synthesize,
	type DimensionConfig,
	type DimensionVerdict,
} from "./review-dimensions.ts";
import type { ReviewResult } from "./llm-review.ts";

const EXTENSIONS_TOML_PATH = join(getAgentDir(), "extensions.toml");
/** 独立段：只放端点与模型（不常改） */
export const CLASSIFIER_SECTION = "sandbox-review-classifier";
/**
 * 维度阈值独立成文件：面板要能整文件重写它，不能拿 extensions.toml 去冒险
 * （那是手写的核心配置，程序化重写容易把别的段弄坏）。
 */
export const DIMENSIONS_TOML_PATH = join(getAgentDir(), "extensions", "sandbox-permissions", "review-dimensions.toml");

export interface ClassifierConfig {
	baseUrl: string;
	model: string;
	timeoutMs: number;
	dimensions: DimensionConfig[];
	/** 覆盖模型选择（测试用） */
	apiKey?: string;
}

export function defaultClassifierConfig(): ClassifierConfig {
	return {
		baseUrl: DEFAULT_BASE_URL,
		model: DEFAULT_MODEL,
		timeoutMs: DEFAULT_TIMEOUT_MS,
		dimensions: defaultDimensionConfigs(),
	};
}

/** 解析 [[sandbox-review-classifier.dimension]] 数组；缺项回退到默认配置 */
export function normalizeDimensions(raw: unknown): DimensionConfig[] {
	const defaults = defaultDimensionConfigs();
	const byId = new Map(defaults.map((d) => [d.id, d]));
	if (!Array.isArray(raw)) return defaults;

	for (const entry of raw) {
		if (!entry || typeof entry !== "object") continue;
		const row = entry as Record<string, unknown>;
		const id = typeof row.id === "string" ? row.id : "";
		const base = byId.get(id);
		if (!base) continue;
		const spec = DIMENSIONS.find((d) => d.id === id);
		const next: DimensionConfig = { ...base };
		if (typeof row.enabled === "boolean") next.enabled = row.enabled;
		if (typeof row.above === "number" && Number.isFinite(row.above)) next.above = clamp01(row.above);
		if (typeof row.below === "number" && Number.isFinite(row.below)) {
			// noul 没有 confidence：即使配置里写了 below 也不采纳
			next.below = spec?.supportsBelow ? clamp01(row.below) : null;
		}
		if (row.action === "ignore") next.action = "ignore";
		else if (row.action === "review") next.action = "review";
		byId.set(id, next);
	}
	// 保持 DIMENSIONS 的顺序（面板展示稳定）
	return DIMENSIONS.map((spec) => byId.get(spec.id) ?? { id: spec.id, enabled: true, above: DEFAULT_THRESHOLD, below: spec.supportsBelow ? DEFAULT_THRESHOLD : null, action: "review" });
}

export function normalizeClassifierConfig(raw: unknown): ClassifierConfig {
	const cfg = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
	const out = defaultClassifierConfig();
	if (typeof cfg.base_url === "string" && cfg.base_url.trim()) out.baseUrl = cfg.base_url.trim();
	if (typeof cfg.model === "string" && cfg.model.trim()) out.model = cfg.model.trim();
	if (typeof cfg.timeout_ms === "number" && Number.isFinite(cfg.timeout_ms) && cfg.timeout_ms > 0) {
		out.timeoutMs = Math.round(cfg.timeout_ms);
	}
	out.dimensions = normalizeDimensions(cfg.dimension);
	return out;
}

/** 读维度阈值：独立文件优先，缺失/损坏 → 默认八项 */
export function loadDimensionConfigs(): DimensionConfig[] {
	try {
		const doc = parseToml(readFileSync(DIMENSIONS_TOML_PATH, "utf8")) as Record<string, unknown>;
		return normalizeDimensions(doc.dimension);
	} catch {
		return defaultDimensionConfigs();
	}
}

/** 读 extensions.toml 的 [sandbox-review-classifier]（端点/模型）；维度另读独立文件 */
export function loadClassifierConfig(): ClassifierConfig {
	const fallback = defaultClassifierConfig();
	try {
		const doc = parseToml(readFileSync(EXTENSIONS_TOML_PATH, "utf8")) as Record<string, unknown>;
		const cfg = normalizeClassifierConfig(doc[CLASSIFIER_SECTION]);
		cfg.dimensions = loadDimensionConfigs();
		return cfg;
	} catch {
		return fallback;
	}
}

function clamp01(value: number): number {
	return Math.max(0, Math.min(1, value));
}

/** 审核输入的素材（从调用方来） */
export interface ClassifierReviewInput {
	command: string;
	cwd: string;
	/** preshell 事实层的格式化输出 */
	preshellText?: string;
	preshellUnavailable?: string;
	/** agent 给的理由（sandbox-allow 的 justification 等） */
	agentReason?: string;
	/** 用户最近请求的片段 */
	userRequestExcerpt?: string;
	/**
	 * 对话模型（chat 后端）给出的参考意见：只是一双额外的眼睛，**不参与判决**。
	 * 分类器拿它当额外上下文（尤其是需要读懂上下文的 intent 维度），
	 * 弹不弹窗仍只看分类器的维度阈值。
	 */
	advisorReview?: ReviewResult;
	matchedRules?: string[];
}

/** 命中维度 → 给人看的理由（分类模型不产文本，这句必须由代码拼） */
export function formatHitReason(hit: DimensionVerdict[]): string {
	return hit
		.map((v) => `${v.label}：${v.reason}`)
		.join("\n");
}

/**
 * 走分类模型审一次。返回 ReviewResult 与 chat 后端同形，调用方无需分叉。
 *
 * verdict 只用两档：safe（各维度均未超阈值）/ risky（有维度触发，应弹窗）；
 * 失败一律 error（含缺 key / 超时 / 协议错 / 全部漏答），回退弹窗。
 */
export async function reviewViaClassifier(
	input: ClassifierReviewInput,
	config: ClassifierConfig,
	options: { signal?: AbortSignal; classifyOptions?: ClassifyOptions } = {},
): Promise<ReviewResult> {
	const dims = config.dimensions.filter((d) => d.enabled && d.action !== "ignore");
	if (dims.length === 0) {
		return { verdict: "error", reason: "所有审核维度都被禁用", suggestion: "" };
	}

	const specs = DIMENSIONS.filter((spec) => dims.some((d) => d.id === spec.id));
	const state = buildReviewState({
		command: input.command,
		cwd: input.cwd,
		preshellText: input.preshellText,
		preshellUnavailable: input.preshellUnavailable,
		agentReason: input.agentReason,
		userRequestExcerpt: input.userRequestExcerpt,
		advisorReview: input.advisorReview,
		matchedRules: input.matchedRules,
	});
	const questions = buildQuestions(specs);

	const outcome = await classifyReview(state, questions, {
		baseUrl: config.baseUrl,
		model: config.model,
		timeoutMs: config.timeoutMs,
		apiKey: config.apiKey,
		signal: options.signal,
		fetchImpl: options.classifyOptions?.fetchImpl,
	});

	if (!outcome.ok) {
		return { verdict: "error", reason: `分类模型审核失败：${outcome.error}`, suggestion: "" };
	}

	const verdicts = evaluateAll(outcome.answers, dims);
	if (verdicts.length === 0) {
		return { verdict: "error", reason: "分类模型没有回答任何启用的维度", suggestion: "" };
	}

	const result = synthesize(verdicts);
	// 权重表：两种分支都带（safe 在 strict 模式下同样弹窗；出问题时最该看的就是当时的数）
	const dimensions = dimensionReportDetailed(outcome.answers, verdicts);
	if (result.outcome === "safe") {
		return {
			verdict: "safe",
			reason: `${result.summary}（${verdicts.length} 个维度）`,
			suggestion: "",
			dimensions,
		};
	}

	return {
		verdict: "risky",
		reason: formatHitReason(result.hit),
		suggestion: "以上维度的判断超过阈值。分类模型精度有限，确认命令与你的意图一致再批准。",
		dimensions,
	};
}
