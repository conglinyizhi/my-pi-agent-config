// zen-client.ts — OpenCode Zen 免费档的无 key 客户端（纯逻辑，不依赖扩展 UI）
//
// 它只做三件事：
//   1. 拉取 Zen 模型列表（GET /zen/v1/models，空 Authorization）
//   2. 逐模型探活（空 auth 发一次最小 chat/completions，按状态码归类）
//   3. 发起真实对话/工具调用（空 auth，OpenAI 兼容），返回 pi 的 AssistantMessage 形状
//
// 设计要点：
//   - 绝不发 Authorization bearer（Zen 免费档 401 任何不认识的 bearer；空头才放行）
//   - 裸 fetch，不走 pi 的 modelRegistry / provider 配置 —— 这些模型没有本地注册
//   - 纯函数、无 UI 依赖，llm-review.ts 直接 import，供门禁审核链路消费
//
// 可选优化（非默认）：需要时设 UA 为 "opencode/latest" 能解锁个别被 UA 门禁的模型
// （如 big-pickle）。默认发诚实 Hermes 归属头，不冒充别的客户端。

import type { AssistantMessage, Tool } from "@earendil-works/pi-ai";

const ZEN_BASE = "https://opencode.ai/zen/v1";

/** 免费档模型是否可用（探活分类结果） */
export type FreeModelStatus = "ok" | "paid" | "geo" | "rate" | "broken" | "timeout" | "unknown";

export interface FreeModelProbe {
	/** 模型 id（slug），如 laguna-s-2.1-free */
	id: string;
	/** 是否可用（probe ok） */
	ok: boolean;
	/** 状态分类（供展示/过滤） */
	status: FreeModelStatus;
	/** HTTP 状态码；探活失败/超时为 -1 */
	code: number;
	/** 失败原因（简短） */
	reason: string;
	/** 该模型是否支持工具调用（空 auth 实测） */
	toolCall: boolean;
}

const UA = "hermes-agent-probe/0.1";
const ATTRIBUTION = {
	"HTTP-Referer": "https://hermes-agent.nousresearch.com",
	"X-Title": "Hermes Agent",
};

/** 无 auth 请求的最小探测 payload（max_tokens 拉满，保证尽快返回） */
function probePayload(model: string) {
	return JSON.stringify({
		model,
		messages: [{ role: "user", content: "hi" }],
		max_tokens: 8,
	});
}

/** 分类探活 HTTP 状态码 → 语义状态 */
function classifyCode(code: number, errorMsg: string): { status: FreeModelStatus; reason: string } {
	const msg = errorMsg.toLowerCase();
	if (code === 200) return { status: "ok", reason: "" };
	if (code === 401) return { status: "paid", reason: "需要 key（不在免费档）" };
	if (code === 403) return { status: "geo", reason: errorMsg || "地理/权限拦截" };
	if (code === 429) return { status: "rate", reason: errorMsg || "限流/UA 门禁" };
	if (code === 400) return { status: "broken", reason: errorMsg || "上游异常" };
	return { status: "unknown", reason: errorMsg || `HTTP ${code}` };
}

/** 对单个模型做一次空 auth 探活。返回结构化结果，不抛异常（探活失败 = status 分类） */
export async function probeZenModel(
	id: string,
	signal?: AbortSignal,
	timeoutMs = 10_000,
): Promise<FreeModelProbe> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	// 传入的外部 signal 也合并进来：任一触发即中止
	const merged = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
	const url = `${ZEN_BASE}/chat/completions`;
	try {
		const res = await fetch(url, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: "", // 关键：空 auth
				"User-Agent": UA,
				...ATTRIBUTION,
			},
			body: probePayload(id),
			signal: merged,
		});
		let errText = "";
		try {
			const body = (await res.json()) as { error?: { message?: string } };
			errText = body.error?.message ?? "";
		} catch {
			/* 非 JSON 错误体，忽略 */
		}
		if (res.status === 200) {
			return { id, ok: true, status: "ok", code: 200, reason: "", toolCall: true };
		}
		const { status, reason } = classifyCode(res.status, errText);
		return { id, ok: false, status, code: res.status, reason, toolCall: false };
	} catch (err) {
		const aborted = signal?.aborted || controller.signal.aborted;
		if (aborted) {
			return { id, ok: false, status: "timeout", code: -1, reason: "探活超时/中止", toolCall: false };
		}
		return {
			id,
			ok: false,
			status: "unknown",
			code: -1,
			reason: err instanceof Error ? err.message : String(err),
			toolCall: false,
		};
	} finally {
		clearTimeout(timer);
	}
}

/** 拉取 Zen 全量模型 id 列表（空 auth）。失败返回空数组。 */
export async function listZenModels(signal?: AbortSignal): Promise<string[]> {
	try {
		const res = await fetch(`${ZEN_BASE}/models`, {
			headers: {
				Authorization: "",
				"User-Agent": UA,
				...ATTRIBUTION,
			},
			signal,
		});
		if (!res.ok) return [];
		const body = (await res.json()) as { data?: { id: string }[] };
		return (body.data ?? []).map((m) => m.id).filter(Boolean);
	} catch {
		return [];
	}
}

/** 探活整个候选集（默认只探 -free 后缀；传 all=true 探全量） */
export async function probeFreeCatalog(
	signal?: AbortSignal,
	opts: { onlyFree?: boolean; timeoutMs?: number; all?: boolean } = {},
): Promise<FreeModelProbe[]> {
	const timeoutMs = opts.timeoutMs ?? 10_000;
	const ids = await listZenModels(signal);
	const candidates = opts.all ? ids : ids.filter((id) => id.endsWith("-free"));
	const probes = await Promise.all(candidates.map((id) => probeZenModel(id, signal, timeoutMs)));
	return probes;
}
// ═══════════════════════════════════════════════════
// 真实对话 / 工具调用（供 llm-review 审核链路使用）
// 返回 pi AssistantMessage 形状，与 modelRegistry.complete 产物对齐，
// 使 llm-review 的 extractReviewResult / 错误处理逻辑无需改动即可接住。
//
// 流式 SSE + token 间隔超时：
//   - 逐 chunk 解析 OpenAI 兼容 SSE，拿到每个 token delta；
//   - 任意两个相邻 token（含首个 token 相对请求发出）间隔超过 tokenIdleMs，
//     即判定该请求停滞失败（stopReason="aborted"，errorMessage 含停滞说明）。
//   - 只对首次内容性 delta 才计时刷新；用户 signal 合并进来仍可即时中止。
// ═══════════════════════════════════════════════════

interface ZenChatParams {
	systemPrompt: string;
	messages: { role: "user"; content: string }[];
	tools: Tool[];
	maxTokens: number;
	temperature: number;
	signal?: AbortSignal;
	/** 相邻 token 间隔上限（毫秒）；首个 token 相对请求发出也计入。超时判停滞。 */
	tokenIdleMs?: number;
}

/** 解析分片累积的 toolCall arguments JSON；失败回退空对象 */
function parseToolArgs(raw: string): Record<string, unknown> {
	try {
		return JSON.parse(raw) as Record<string, unknown>;
	} catch {
		return {};
	}
}

/** 无 key 调用 OpenCode Zen 免费模型（OpenAI chat/completions，流式）。
 * 返回 AssistantMessage；请求失败 / 停滞 / 用户中止返回 stopReason="error"/"aborted"
 * 的消息（不抛异常），与 llm-review 的 failover 逻辑（检查 stopReason==="error"/"aborted"）对齐。 */
export async function callZenChat(
	modelId: string,
	params: ZenChatParams,
): Promise<AssistantMessage> {
	const tokenIdleMs = params.tokenIdleMs ?? 4_000;
	// 用独立的 AbortController 承载 token 停滞信号：一旦停滞超时即 abort 底层 fetch；
	// 用户 signal 合并进来，任一触发都中止。
	const idleController = new AbortController();
	const merged = params.signal
		? AbortSignal.any([params.signal, idleController.signal])
		: idleController.signal;

	const base: AssistantMessage = {
		role: "assistant",
		content: [],
		api: "openai-completions",
		provider: "opencode-free",
		model: modelId,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "stop",
		timestamp: Date.now(),
	};

	const body = {
		model: modelId,
		messages: [
			...(params.systemPrompt ? [{ role: "system", content: params.systemPrompt }] : []),
			...params.messages.map((m) => ({ role: m.role, content: m.content })),
		],
		tools: params.tools.map((t) => ({
			type: "function",
			function: { name: t.name, description: t.description, parameters: t.parameters },
		})),
		max_tokens: params.maxTokens,
		temperature: params.temperature,
		stream: true,
	};

	let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
	try {
		const res = await fetch(`${ZEN_BASE}/chat/completions`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: "",
				"User-Agent": UA,
				...ATTRIBUTION,
			},
			body: JSON.stringify(body),
			signal: merged,
		});

		if (!res.ok) {
			let errMsg = `HTTP ${res.status}`;
			try {
				const d = (await res.json()) as { error?: { message?: string } };
				errMsg = d.error?.message ?? errMsg;
			} catch {
				/* 非 JSON 错误体 */
			}
			return { ...base, stopReason: "error", errorMessage: errMsg };
		}
		if (!res.body) {
			return { ...base, stopReason: "error", errorMessage: "空响应体" };
		}

		reader = res.body.getReader();
		const decoder = new TextDecoder();
		let buf = "";
		let textOut = "";
		const toolCalls = new Map<number, { id?: string; name?: string; args: string }>();
		let finishReason: string | null = null;
		let usage: { prompt_tokens?: number; completion_tokens?: number } | undefined;
		let anchor = Date.now();
		const STALL = Symbol("stall");

		// 逐 chunk 读取，每个 chunk 与"距上次内容 delta 的 tokenIdleMs"赛跑：
		// 若停滞先到，判该模型停滞失败。
		while (true) {
			let timer: ReturnType<typeof setTimeout> | undefined;
			const stallPromise = new Promise<typeof STALL>((resolve) => {
				timer = setTimeout(() => resolve(STALL), tokenIdleMs);
			});
			let chunk: { value?: Uint8Array; done: boolean } | typeof STALL;
			try {
				chunk = await Promise.race([reader.read(), stallPromise]);
			} finally {
				clearTimeout(timer);
			}
			if (chunk === STALL) {
				idleController.abort(); // 中止底层 fetch，释放连接
				return {
					...base,
					stopReason: "aborted",
					errorMessage: `token 停滞：超过 ${tokenIdleMs}ms 无新 token`,
				};
			}
			if (chunk.done) break;
			if (chunk.value) buf += decoder.decode(chunk.value, { stream: true });

			// 结束标志（finish_reason / [DONE]）一出现即退出，不等 reader（避免连接 keep-alive
			// 不立即 close 时被 token 停滞误杀）。
			let gotEnd = false;
			let nl: number;
			while ((nl = buf.indexOf("\n")) >= 0) {
				const line = buf.slice(0, nl).trim();
				buf = buf.slice(nl + 1);
				if (!line || !line.startsWith("data:")) continue;
				const payload = line.slice(5).trim();
				if (payload === "[DONE]") {
					gotEnd = true;
					break;
				}

				let obj: { usage?: { prompt_tokens?: number; completion_tokens?: number }; choices?: { delta?: { content?: string | null; tool_calls?: { index?: number; id?: string; function?: { name?: string; arguments?: string } }[] }; finish_reason?: string | null }[] };
				try {
					obj = JSON.parse(payload);
				} catch {
					continue;
				}
				if (obj.usage) usage = obj.usage;

				const choice = obj.choices?.[0];
				const delta = choice?.delta ?? {};
				let hasContent = false;
				if (typeof delta.content === "string" && delta.content) {
					textOut += delta.content;
					hasContent = true;
				}
				for (const tc of delta.tool_calls ?? []) {
					const ti = tc.index ?? 0;
					const e = toolCalls.get(ti) ?? { args: "" };
					if (tc.id) e.id = tc.id;
					if (tc.function?.name) e.name = tc.function.name;
					if (typeof tc.function?.arguments === "string" && tc.function.arguments) {
						e.args += tc.function.arguments;
						hasContent = true;
					}
					toolCalls.set(ti, e);
				}
				if (hasContent) anchor = Date.now();
				if (choice?.finish_reason) {
					finishReason = choice.finish_reason;
					gotEnd = true;
				}
			}
			if (gotEnd) break;
		}

		const content: AssistantMessage["content"] = [];
		if (textOut) content.push({ type: "text", text: textOut });
		for (const [index, e] of toolCalls) {
			content.push({
				type: "toolCall",
				id: e.id ?? `call_${index}`,
				name: e.name ?? "",
				arguments: parseToolArgs(e.args),
			});
		}

		const finish = finishReason ?? "stop";
		const stopReason =
			finish === "tool_calls" ? "toolUse" : finish === "length" ? "length" : "stop";

		return {
			...base,
			content,
			stopReason,
			usage: {
				input: usage?.prompt_tokens ?? 0,
				output: usage?.completion_tokens ?? 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: (usage?.prompt_tokens ?? 0) + (usage?.completion_tokens ?? 0),
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
		};
	} catch (err) {
		const aborted = params.signal?.aborted || idleController.signal.aborted;
		return {
			...base,
			stopReason: aborted ? "aborted" : "error",
			errorMessage: err instanceof Error ? err.message : String(err),
		};
	} finally {
		try {
			await reader?.cancel();
		} catch {
			/* 连接已释放 */
		}
	}
}
