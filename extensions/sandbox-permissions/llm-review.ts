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
import { callZenChat } from "../opencode-free/zen-client.ts";
import { loadClassifierConfig, reviewViaClassifier, type ClassifierReviewInput } from "./review-classifier.ts";
import type { ReviewScenario } from "./review-dimensions.ts";
import { loadTrustedProgramDirs } from "./trusted.ts";
import { formatFacts, type PreshellFacts } from "../../lib/preshell.ts";
import { lastUserRequest } from "../../lib/last-user-request.ts";
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
	/**
	 * 分类后端的各维度权重（可选；chat 后端不产，审批窗据此自动决定要不要渲染权重表）。
	 * 由 review-dimensions.ts 的 dimensionReport() 产出，已是可 JSON 序列化的原始数据。
	 */
	dimensions?: ReviewDimensionRow[];
	/**
	 * 串联模式下 chat 那边的审核意见（chain 后端专用）。
	 *
	 * 分类器不产文本，只能靠维度拼理由；chat 会写一句人话。两边都跑时，把 chat 的
	 * 结论单独放这里，而不是揉进 reason——审批窗要能分清「谁说的什么」，
	 * 出问题时才好判断是哪一边在误报。
	 */
	chatReview?: {
		verdict: ReviewVerdict;
		reason: string;
		suggestion: string;
		opinion?: string;
		/** chat 侧的失败原因（verdict=error 时） */
		error?: string;
	};
}

/** 与 review-dimensions.ts 的 DimensionReportRow 同形；此处只声明，不复制逻辑 */
export type ReviewDimensionRow = import("./review-dimensions.ts").DimensionReportRow;

/** 审核模型引用（provider/model 对，用于模型池） */
export interface ModelRef {
	provider: string;
	model: string;
}

/**
 * 一次审核的调用选项（与配置无关的那点上下文）。
 *
 * facts 是命令的事实层（preshell）结果：带上它，审核模型看的是「碰了哪些路径、
 * 跑了什么程序、哪里看不懂」，而不是一条命令原文；拿不到时把原因一并给它，
 * 让它知道影响面不完整，而不是被读成「什么都没碰」。
 */
export interface ReviewCallOptions {
	facts?: PreshellFacts;
	factsUnavailable?: string;
	/**
	 * 本次审核场景：缺省 bash（命令审批）。
	 * ptc = run_code 脚本审核，该场景下 scripted_edit 不提问、不参与判定
	 * （见 review-dimensions 的 SCENARIOS）。
	 */
	scenario?: ReviewScenario;
}

export interface LlmReviewConfig {
	/** 审核后端：chat = 只跑对话模型；classifier = 只跑分类模型；chain = 两个都跑，意见合并（任一判风险就弹窗） */
	backend: "chat" | "classifier" | "chain";
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
	/**
	 * 注册模型（走 modelRegistry.complete）的单次审核总时长兜底（毫秒）。
	 * 从请求发出起算，超过即判失败切换下一个。防止挂死，不参与 token 间隔语义。
	 */
	timeoutMs: number;
	/**
	 * 免费模型（opencode-free 走 callZenChat 流式）的相邻 token 间隔上限（毫秒）。
	 * 任意两个相邻 token（含首个 token 相对请求发出）间隔超过此值即判停滞失败。
	 */
	tokenIdleMs: number;
	/** 内存缓存上限（同命令同规则不重复调 API） */
	maxCache: number;
}

const DEFAULT_CONFIG: LlmReviewConfig = {
	backend: "chat",
	enabled: true,
	mode: "auto",
	timeoutMs: 30_000,
	tokenIdleMs: 4_000,
	maxCache: 200,
};

// ═══════════════════════════════════════════════════
// 配置
// ═══════════════════════════════════════════════════

const EXTENSIONS_TOML_PATH = join(getAgentDir(), "extensions.toml");
/** 本段在 extensions.toml 里的名字；导出给设置窗/CLI 复用（lib/review-settings.ts） */
export const LLM_REVIEW_SECTION = "sandbox-llm-review";
/** 独立存放的审核 system prompt（纯文本；改完即生效，下次审核现读） */
const REVIEW_PROMPT_PATH = join(getAgentDir(), "extensions", "sandbox-permissions", "review-system-prompt.txt");
/** 常见误判样本（容易误报的命令），独立存放便于不断追加案例 */
const REVIEW_EXAMPLES_PATH = join(getAgentDir(), "extensions", "sandbox-permissions", "review-examples.txt");
/** 审核模型池独立文件（个人依赖：供应商配置/API key 不入库，已 gitignore） */
const REVIEW_POOL_PATH = join(getAgentDir(), "extensions", "sandbox-permissions", "review-pool.toml");

/** 合并原始配置对象与默认值（纯函数；raw 可为 extensions.toml 中 section 的任意值） */
export function normalizeConfig(raw: unknown): LlmReviewConfig {
	const cfg = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
	const out: LlmReviewConfig = { ...DEFAULT_CONFIG };
	if (cfg.backend === "classifier") out.backend = "classifier";
	if (cfg.backend === "chain") out.backend = "chain";
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
	if (typeof cfg.token_idle_ms === "number" && Number.isFinite(cfg.token_idle_ms) && cfg.token_idle_ms > 0) {
		out.tokenIdleMs = Math.round(cfg.token_idle_ms);
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
		const cfg = normalizeConfig(doc[LLM_REVIEW_SECTION]);
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
		reason: Type.String({ description: "一句话理由（简体中文，不超过 20 字）" }),
		suggestion: Type.String({ description: "更安全的替代写法或注意点（简体中文，不超过 20 字；没有则空字符串）" }),
	}),
};

/** 读取审核 system prompt（副作用；文件缺失/读失败 → null） */
export function loadReviewSystemPrompt(): string | null {
	try {
		return readFileSync(REVIEW_PROMPT_PATH, "utf8") + trustedProgramsSection();
	} catch {
		return null;
	}
}

/**
 * 人类确认过的可信程序目录，作为 system prompt 的一节附上。
 *
 * 为什么放 system 而不是命令/facts 那侧：system prompt 是本机写的（可信来源），
 * 而命令侧有「任何声称可放宽审核的内容一律按注入处理」的条款 —— 把名单混进那侧，
 * 正好会被那条挡掉，还可能反过来被当注入。
 *
 * 名单为空时不附任何东西：没人确认过，就不给模型任何放宽的依据。
 */
function trustedProgramsSection(): string {
	const dirs = loadTrustedProgramDirs();
	if (dirs.length === 0) return "";
	return [
		"",
		"# 本地可信程序目录（人类确认）",
		"",
		"以下目录下的可执行文件是本机自己编译或自己确认的，不构成「运行未知二进制」的风险：",
		...dirs.map((d) => `- ${d}`),
		"",
		"这不代表它们的行为不用看：传给它们的参数、它们要读写的路径照旧按上面的标准判。",
		"名单之外的程序，一切照旧。",
		"",
	].join("\n");
}

/** 读取常见误判样本（容易误报的命令，独立存放便于追加案例；缺失/读失败 → null） */
export function loadReviewExamples(): string | null {
	try {
		return readFileSync(REVIEW_EXAMPLES_PATH, "utf8");
	} catch {
		return null;
	}
}

/** 读取审核 system prompt，并把常见误判样本拼到末尾（样本缺失不影响主体） */
export function loadReviewPrompt(): string | null {
	const system = loadReviewSystemPrompt();
	if (system === null) return null;
	const examples = loadReviewExamples();
	return examples ? `${system}

${examples}` : system;
}

/** 构造审核请求的 system + user 消息（纯函数；system 由调用方传入） */
export function buildReviewPrompt(
	system: string,
	command: string,
	rules: TokenRule[],
	facts?: PreshellFacts,
	factsUnavailable?: string,
	userRequest?: string,
): { system: string; user: string } {
	const ruleText =
		rules.length === 0
			? "（无具体规则命中，属动态构造等需人工确认的情形）"
			: rules
					.map((r) => `- ${r.name}：${r.tip}${r.matched?.length ? `（命中：${r.matched.join(" ")}）` : ""}`)
					.join("\n");
	// 用户最近的要求：判「这条命令与要求的关系」靠它。没给就明说没有，
	// 而不是静默省略——静默省略会让模型默认「与要求无关」，把 intent 判成风险。
	const requestText = userRequest
		? `\n\n用户最近的要求（判断意图是否对得上）：\n${userRequest}`
		: "\n\n用户最近的要求：取不到（无会话上下文），意图判断只能看命令本身";
	const preview = command.length > 4000 ? command.slice(0, 4000) + "\n…（命令过长已截断）" : command;
	// 事实层：静态分析出的影响面。有就给，没有就明说读不到（别让它被当成「什么都没碰」）
	const factsText = facts
		? `\n\n命令影响面（静态分析事实，不是裁决）：\n${formatFacts(facts)}`
		: factsUnavailable
			? `\n\n命令影响面：静态分析不可用（${factsUnavailable}），只能按命令原文判断`
			: "";
	return {
		system,
		user: `命令：\n${preview}\n\n命中风险点：\n${ruleText}${factsText}${requestText}`,
	};
}

// ═══════════════════════════════════════════════════
// 输出解析（纯函数，容错）
// ═══════════════════════════════════════════════════

const BULLET_LEAD = /^[-*•·]\s+|^#{1,6}\s+|^\d+[.、)]\s*/;

function clip(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** 把模型的正文规整成给人工审核者看的无序列表。
 *  提示词已经要求「- 开头、1 到 3 条、每条不超过 30 字」，这里是兜底：
 *  模型写散文或编号列表时，仍然裁成短列表，不让一坨文字把卡片撑满。
 *  单独一段长句会先按句读切开再裁，而不是直接砍成半句话。 */
export function normalizeBullets(text: string, maxItems = 3, maxCharsPerItem = 30): string {
	const lines = text
		.split("\n")
		.map((line) => line.trim().replace(BULLET_LEAD, "").trim())
		.filter(Boolean);
	const pieces =
		lines.length === 1 && lines[0].length > maxCharsPerItem
			? lines[0]
				.split(/[。；;！？!?]+/)
				.map((s) => s.trim())
				.filter(Boolean)
			: lines;
	return pieces
		.slice(0, maxItems)
		.map((s) => `- ${clip(s, maxCharsPerItem)}`)
		.join("\n");
}

/** 从完整响应中提取审核结论（纯函数；传 response.content）：
 *  结论通过 report_review_verdict 工具调用提交（结构化 verdict，schema 约束）；
 *  模型回复的自由文本作为 opinion（看法）展示给人工审核者，提交给审核者的版本会被
 *  normalizeBullets 裁成短列表（提示词要求的形态，代码兜底）；
 *  未调用工具 → 无法结构化判定（verdict=error，回退弹窗），此时文本**不**裁，
 *  原样附带展示 —— 那种情况下这几行字就是排查证据。 */
export function extractReviewResult(content: AssistantMessage["content"]): ReviewResult {
	const raw = content
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
			const bullets = raw ? normalizeBullets(raw) : "";
			if (bullets) result.opinion = bullets;
			return result;
		}
		return { verdict: "error", reason: "invalid tool call arguments", suggestion: "", ...(raw ? { opinion: raw } : {}) };
	}
	// 未调用工具：不把文本当 JSON 解析，文本作为看法展示；verdict 按无法判定回退弹窗
	return {
		verdict: "error",
		reason: "模型未给出结构化结论（未调用审核工具）",
		suggestion: "",
		...(raw ? { opinion: raw } : {}),
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
 * 可调用的审核模型判别联合。
 * - kind="local"：pi 本地已注册的模型，走 modelRegistry.complete；
 * - kind="free"：OpenCode Zen 免费模型（provider === "opencode-free"），
 *   无本地注册，走 zen-client.callZenChat（空 auth 裸 HTTP）。
 * 把两类统一进同一条 failover 链，方便门禁免费优先、付费兜底。
 */
type ResolvedModel =
	| { kind: "local"; model: Model<any> }
	| { kind: "free"; modelId: string };

type PickResult = { models: ResolvedModel[]; source: "configured" | "session" };

/** OpenCode Zen 免费档的 provider id（与 review-pool.toml / opencode-free 插件约定一致） */
const OPencode_FREE_PROVIDER = "opencode-free";

/**
 * 候选审核模型列表。
 * - 配置了模型池（models）或单模型（provider/model）→ 逐条解析：
 *   provider === "opencode-free" 的条目视为免费模型（kind="free"），
 *   其余走 modelRegistry.find()（kind="local"，配置缺失的跳过）；
 * - 完全未配置 → 当前会话模型（文档化的默认行为）；
 * - 返回 source 供调用方区分「配置了但不可用」与「未配置且无会话模型」。
 */
function pickModels(
	ctx: ExtensionContext,
	config: LlmReviewConfig,
): PickResult {
	const refs =
		config.models ??
		(config.provider && config.model ? [{ provider: config.provider, model: config.model }] : []);
	if (refs.length > 0) {
		const models: ResolvedModel[] = [];
		for (const r of refs) {
			if (r.provider === OPencode_FREE_PROVIDER) {
				// 免费模型：不需要本地注册，直接用模型 id
				if (r.model) models.push({ kind: "free", modelId: r.model });
			} else {
				const m = ctx.modelRegistry.find(r.provider, r.model);
				if (m) models.push({ kind: "local", model: m });
			}
		}
		return { models, source: "configured" };
	}
	return { models: ctx.model ? [{ kind: "local", model: ctx.model }] : [], source: "session" };
}

/**
 * 执行一次 LLM 审核。
 * 失败一律返回 verdict=error（含禁用/无模型/超时/网络/解析失败），调用方必须回退弹窗。
 *
 * options 是本次调用的那点上下文（见 ReviewCallOptions）：
 *   - facts：命令的事实层（preshell）结果。带上它，审核模型看的是「碰了哪些路径、
 *     跑了什么程序、哪里看不懂」，而不是一条命令原文；拿不到时把原因一并给它，
 *     让它知道影响面不完整，而不是被读成「什么都没碰」。
 *   - scenario：审核场景。PTC 脚本审核传 scenario="ptc"，分类器据此过滤掉
 *     没有信息量的维度（scripted_edit）。classifier 与 chain 两条支路都经
 *     buildClassifierReviewInput 送下去，别在这里另开一条路。
 */
export async function reviewCommand(
	_pi: ExtensionAPI,
	ctx: ExtensionContext,
	command: string,
	rules: TokenRule[],
	signal: AbortSignal | undefined,
	cache: ReviewCache,
	config?: LlmReviewConfig,
	options?: ReviewCallOptions,
): Promise<ReviewResult> {
	const cfg = config ?? loadLlmReviewConfig();
	if (!cfg.enabled) return { verdict: "error", reason: "llm review disabled", suggestion: "" };

	const key = reviewCacheKey(command, rules);
	const hit = cache.get(key);
	if (hit) return hit;

	// 用户最近说了什么：分类器的 intent 维度与 chat 的提示词都要它。
	// 拿不到时 intent 只能猜，会倾向判「与要求无关」，于是满屏误报——
	// 所以这条链路必须真的接上，不能留空。
	const userRequest = sessionUserRequest(ctx);

	const runClassifier = () => runClassifierReview(ctx, command, rules, signal, options, userRequest);

	let result: ReviewResult;
	if (cfg.backend === "classifier") {
		result = await runClassifier();
	} else if (cfg.backend === "chain") {
		result = await runChainedReview(ctx, command, rules, signal, cfg, options, userRequest);
	} else {
		result = await runChatReview(ctx, command, rules, signal, cfg, options, userRequest);
	}

	// 只缓存有效结论（error 是瞬态的：无 key / 超时 / 限流，下次重试）
	if (result.verdict !== "error") cache.set(key, result);
	return result;
}

/** 从会话里取用户最近一条请求（拿不到就是 undefined，审核侧自行降级） */
export function sessionUserRequest(ctx: ExtensionContext): string | undefined {
	try {
		const entries = ctx.sessionManager?.getEntries?.() ?? [];
		return lastUserRequest(entries as never);
	} catch {
		// 会话不可读不该让审核整条挂掉：按「没有上下文」处理，与没有会话时一致
		return undefined;
	}
}

async function runChatReview(
	ctx: ExtensionContext,
	command: string,
	rules: TokenRule[],
	signal: AbortSignal | undefined,
	cfg: LlmReviewConfig,
	options: ReviewCallOptions | undefined,
	userRequest: string | undefined,
): Promise<ReviewResult> {
	const { models, source } = pickModels(ctx, cfg);
	if (models.length === 0) {
		return {
			verdict: "error",
			reason: source === "configured" ? "配置的审核模型均不可用" : "no usable model for llm review",
			suggestion: "",
		};
	}

	const systemPrompt = loadReviewPrompt();
	if (systemPrompt === null) {
		return { verdict: "error", reason: "review system prompt missing", suggestion: "" };
	}
	const { system, user } = buildReviewPrompt(systemPrompt, command, rules, options?.facts, options?.factsUnavailable, userRequest);

	// ModelRegistry 的 complete 在各版本 pi 上都有，但类型声明滞后过；用窄接口断言，
	// 运行时行为以实际 pi 版本为准。
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
	for (const resolved of models) {
		const label = resolved.kind === "local" ? resolved.model.id : resolved.modelId;
		const timeoutSignal = AbortSignal.timeout(cfg.timeoutMs);
		const merged = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
		try {
			let response: AssistantMessage;
			if (resolved.kind === "free") {
				// 免费模型：无 key 裸调 OpenCode Zen 流式；token 间隔由 callZenChat 内部
				// tokenIdleMs 控制（停滞>阈值判失败），此处只传用户 signal + 间隔阈值，
				// 不并入注册模型的 timeoutSignal（那是总时长兜底，语义不同）。
				response = await callZenChat(resolved.modelId, {
					systemPrompt: system,
					messages: [{ role: "user", content: user }],
					tools: [REVIEW_TOOL],
					maxTokens: 512,
					temperature: 0,
					signal,
					tokenIdleMs: cfg.tokenIdleMs,
				});
			} else {
				response = await completer.complete(
					resolved.model,
					{
						systemPrompt: system,
						messages: [{ role: "user", content: user, timestamp: Date.now() }],
						// 审核结论走工具调用（report_review_verdict），结构化参数免文本解析
						tools: [REVIEW_TOOL],
					},
					{ signal: merged, maxTokens: 512, temperature: 0 },
				);
			}
			if (response.stopReason === "aborted" || response.stopReason === "error") {
				// `aborted` 既可能来自用户取消，也可能是本次审核的超时信号。
				// 先区分二者，不能把超时笼统报成一个毫无上下文的 "aborted"。
				if (signal?.aborted) {
					return { verdict: "error", reason: "审核已取消：主任务已中止", suggestion: "" };
				}
				if (timeoutSignal.aborted) {
					// 注册模型总时长兜底触发（默认 30s 未完成整个回复）
					failures.push(`${label}: 审核总时长超时（${cfg.timeoutMs}ms）`);
					continue;
				}
				const reason = response.errorMessage || `远端服务中止了审核请求（${response.stopReason}，未提供详细错误）`;
				failures.push(`${label}: ${reason}`);
				continue;
			}
			const result = extractReviewResult(response.content);
			if (result.verdict !== "error") {
				return result;
			}
			// 未调用审核工具（未给出结构化结论）的模型，把它的自由文本输出也附上，
			// 供人工审核者在 GUI 里看到模型到底回了什么，而不是事后只看到一句空泛的失败原因
			failures.push(
				result.opinion
					? `${label}: ${result.reason}（模型输出：${result.opinion.slice(0, 200)}）`
					: `${label}: ${result.reason}`,
			);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			if (signal?.aborted) {
				return { verdict: "error", reason: "审核已取消：主任务已中止", suggestion: "" };
			}
			if (timeoutSignal.aborted) {
				failures.push(`${label}: 审核总时长超时（${cfg.timeoutMs}ms）`);
				continue;
			}
			failures.push(`${label}: ${msg || "远端服务未提供错误详情"}`);
		}
	}
	return {
		verdict: "error",
		reason: `审核模型全部失败：${failures.join("\n")}`,
		suggestion: "",
	};
}

/**
 * 分类器送审输入（纯函数，可单测）。
 *
 * 场景在这里落成 input.scenario：分类器据它决定哪些维度不提问（PTC 的 scripted_edit）。
 * 两条支路（classifier 与 chain）都走这一处，避免只改一半——那会让串联模式下的
 * PTC 审核又去问一遍脚本改写。
 */
export function buildClassifierReviewInput(args: {
	command: string;
	cwd: string;
	rules: TokenRule[];
	userRequest?: string;
	advisor?: ReviewResult;
	options?: ReviewCallOptions;
}): ClassifierReviewInput {
	const options = args.options;
	return {
		command: args.command,
		cwd: args.cwd,
		preshellText: options?.facts ? formatFacts(options.facts) : undefined,
		preshellUnavailable: options?.factsUnavailable,
		matchedRules: args.rules.map((r) => r.name).filter(Boolean),
		userRequestExcerpt: args.userRequest,
		// chat 的意见作为参考材料进 state（不参与判决）：
		// 分类器是判决者，chat 只是多一双眼睛。见 runChainedReview 的说明。
		advisorReview: args.advisor,
		scenario: options?.scenario ?? "bash",
	};
}

/**
 * 跑分类器那一路（chain 与 classifier 共用）。
 *
 * 导出给审核流 SDK：chain 的真实语义是"chat 先给意见、分类器拿它当参考做判决"，
 * 所以流程里的 classifier 节点必须能把 advisor 传下去，不能只调 backend=classifier 那条。
 */
export async function runClassifierReview(
	ctx: ExtensionContext,
	command: string,
	rules: TokenRule[],
	signal: AbortSignal | undefined,
	options: ReviewCallOptions | undefined,
	userRequest: string | undefined,
	advisor?: ReviewResult,
): Promise<ReviewResult> {
	return reviewViaClassifier(
		buildClassifierReviewInput({
			command,
			cwd: ctx.cwd ?? process.cwd(),
			rules,
			userRequest,
			advisor,
			options,
		}),
		loadClassifierConfig(),
		{ signal },
	);
}

/**
 * 串联：**chat 先给意见，分类器拿它当参考做判决**。
 *
 * 判不判弹窗只看分类器（它的阈值决定 safe/risky），chat 的结论不单独触发弹窗——
 * chat 会瞎报，让它一票否决等于把误报直接变成满屏弹窗。它的作用是给分类器
 * 多一份视角（尤其是 intent 这类需要读懂上下文的维度）。
 *
 * 串行是刻意的：参考意见必须在判决之前拿到。chat 失败不影响判决（advisor 省略）。
 */
async function runChainedReview(
	ctx: ExtensionContext,
	command: string,
	rules: TokenRule[],
	signal: AbortSignal | undefined,
	cfg: LlmReviewConfig,
	options: ReviewCallOptions | undefined,
	userRequest: string | undefined,
): Promise<ReviewResult> {
	// advisor 失败就当作没有参考意见：分类器本来就不依赖它
	const advisor = await runChatReview(ctx, command, rules, signal, cfg, options, userRequest);

	const classifier = await runClassifierReview(ctx, command, rules, signal, options, userRequest, advisor);

	// 分类器的判决就是最终判决。chat 的意见挂上去供弹窗展示，但不改变 verdict。
	const merged: ReviewResult = { ...classifier, chatReview: toAdvisorNote(advisor, classifier.verdict) };
	return merged;
}

/**
 * chat 的意见转成展示用的附注（纯函数，可单测）。
 *
 * 两种情形值得分开写：
 *   - 分类器判 risky：chat 说什么都只是旁证，带上它的结论即可
 *   - 分类器判 safe：chat 若判了风险，这里要明确标出来给人看
 *     （判决仍是放行，但人翻记录时该看到「有一边喊过风险」）
 */
export function toAdvisorNote(
	chat: ReviewResult,
	classifierVerdict: ReviewVerdict,
): ReviewResult["chatReview"] {
	const note: NonNullable<ReviewResult["chatReview"]> = {
		verdict: chat.verdict,
		reason: chat.reason,
		suggestion: chat.suggestion,
	};
	if (chat.opinion) note.opinion = chat.opinion;
	if (chat.verdict === "error") note.error = chat.reason;
	// 分类器放行、但 chat 喊了风险：留一行提醒，别让这条完全消失在记录里
	if (classifierVerdict === "safe" && (chat.verdict === "risky" || chat.verdict === "dangerous")) {
		note.reason = `（分类器判放行，对话模型持异议）${chat.reason}`;
	}
	return note;
}

/** 审核结论的展示文本（供弹窗 / GUI 展示附加） */
export function formatReviewNote(review: ReviewResult): string {
	const label =
		review.verdict === "dangerous"
			? "危险"
			: review.verdict === "risky"
				? "有风险"
				: review.verdict === "safe"
					? "安全"
					: "审核失败";
	// 结论与理由占第一行；建议与看法各占后面几行。
	// opinion 已是短列表（extract 里规整过），所以这里不再加「看法：」前缀
	const lines = [`🤖 LLM 审查：${label}${review.reason ? ` —— ${review.reason}` : ""}`];
	if (review.suggestion) lines.push(`建议：${review.suggestion}`);
	if (review.opinion) lines.push(review.opinion);
	return lines.join("\n");
}
