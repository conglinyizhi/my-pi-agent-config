// lib/ptc-dryrun.ts — 干跑（P1）：用假 ctx 预先跑一遍脚本，拿"这段程序确定会做什么"
//
// 引擎把每次内层调用交给 `ctx.executeTool`，所以干跑不用改引擎：换掉 ctx 里的几个出口即可——
// executeTool 只记账不执行、models 一调就抛、store 读真值（不写，因为 store 的落点在我们
// 没接的 appendEntry 上）。其余字段原样透传：脚本看到的工具面必须与真跑一致。
//
// 干跑给的是**下界**：假数据会改变控制流（`if (r.includes(...))` 这种分支走不到），
// 所以它的结果只是一个"可能这样跑"的预演，真正的对账靠真跑归集（compareCalls）。

export interface DryRunCall {
	tool: string;
	/** 参数摘要（单行、截断） */
	args: string;
}

export interface DryRunResult {
	calls: DryRunCall[];
	status: "ok" | "timeout" | "error";
	error?: string;
	/** 引擎返回的正文摘要（脚本自己报错时原因就在这里面），排障与审计都要看它 */
	output?: string;
	ms: number;
}

/** 干跑的时限：脚本已经过一次静态扫描，这里只是把控制流走一遍，不该久 */
export const DRY_RUN_TIMEOUT_MS = 3000;

/** 占位结果：显眼、单行，脚本拿它做判断时不会意外为真 */
export function dryRunPlaceholder(tool: string): string {
	return `[dry-run] ${tool} 未真正执行`;
}

/** 参数摘要（与 ptc-audit 的 summarizeArgs 同一口径，这里不引它以免循环依赖） */
function summarize(input: unknown, maxChars = 120): string {
	let rendered: string;
	try {
		rendered = typeof input === "string" ? input : JSON.stringify(input ?? {});
	} catch {
		rendered = "<参数无法序列化>";
	}
	const flat = rendered.replace(/\s+/g, " ").trim();
	return flat.length > maxChars ? `${flat.slice(0, maxChars - 1)}…` : flat;
}

/** models 出口：任何方法调用都抛，干跑不花 token */
function blockedModels(): unknown {
	const thrower = (): never => {
		throw new Error("干跑不调用模型");
	};
	return new Proxy(
		{},
		{
			get: (_target, key) => {
				if (typeof key === "symbol") return undefined;
				if (key === "then") return undefined;
				return thrower;
			},
		},
	);
}

/**
 * 造一个干跑用的 ctx：**原型委托**原 ctx，自己只放两个覆盖。
 *
 * 两种更"直觉"的写法都在真机上撞过：
 * - `{ ...ctx }`：真的 ctx 把 `tools` / `sessionManager` 挂在原型或 getter 上，
 *   展开会丢掉它们，引擎读 `ctx.tools` 得到 undefined（Cannot read properties of
 *   undefined (reading 'filter')）
 * - Proxy：`executeTool` 在真 ctx 上是**只读不可配置**的属性，代理的 get 一旦返回
 *   别的值就违反 Proxy 不变量，直接抛 TypeError
 *
 * 原型委托两头都躲开：自己这两个属性是自有属性、优先于原型的同名属性，
 * 其余字段照常沿原型链取到原值 —— 脚本能调什么，干跑和真跑必须一致。
 */
export function dryRunContext<T extends object>(ctx: T, sink: DryRunCall[]): T {
	const dry = Object.create(ctx) as Record<string, unknown>;
	Object.defineProperties(dry, {
		executeTool: {
			value: async (name: string, args: unknown): Promise<unknown> => {
				sink.push({ tool: name, args: summarize(args) });
				return {
					toolCall: { id: `dry/${sink.length}`, name, arguments: args },
					isError: false,
					result: { content: [{ type: "text", text: dryRunPlaceholder(name) }] },
				};
			},
			enumerable: true,
			configurable: true,
			writable: true,
		},
		// 干跑不花 token：任何模型调用都抛
		modelRegistry: { value: blockedModels(), enumerable: true, configurable: true, writable: true },
	});
	return dry as T;
}

/**
 * 跑一遍干跑。脚本自己抛错时引擎会把它包成正常结果返回，所以"error"这一档
 * 主要是干跑本身出问题（引擎加载失败之类）；超时用 abort 判定。
 */
export async function runDryRun(options: {
	execute: (toolCallId: string, params: unknown, signal: unknown, onUpdate: unknown, ctx: unknown) => Promise<unknown>;
	toolCallId: string;
	code: string;
	ctx: unknown;
	timeoutMs?: number;
}): Promise<DryRunResult> {
	const started = Date.now();
	const calls: DryRunCall[] = [];
	const controller = new AbortController();
	// 时限自己兜：不指望引擎一定理会 abort（挂住的引擎不该把整段脚本执行拖住）
	let timer: ReturnType<typeof setTimeout> | undefined;
	const deadline = new Promise<"timeout">((resolve) => {
		timer = setTimeout(() => {
			controller.abort();
			resolve("timeout");
		}, options.timeoutMs ?? DRY_RUN_TIMEOUT_MS);
	});
	try {
		let result: unknown;
		const finished = await Promise.race([
			options
				.execute(
					options.toolCallId,
					{ code: options.code },
					controller.signal,
					undefined,
					dryRunContext((options.ctx ?? {}) as object, calls),
				)
				.then((value) => {
					result = value;
					return "done" as const;
				}),
			deadline,
		]);
		if (finished === "timeout") return { calls, status: "timeout", ms: Date.now() - started };
		const output = outputOf(result);
		return { calls, status: "ok", ...(output ? { output } : {}), ms: Date.now() - started };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			calls,
			status: controller.signal.aborted ? "timeout" : "error",
			error: message.slice(0, 200),
			ms: Date.now() - started,
		};
	} finally {
		clearTimeout(timer);
	}
}

/** 从引擎返回的结果里抽正文摘要（脚本报错时原因就在这里） */
function outputOf(result: unknown): string | undefined {
	const content = (result as { content?: unknown })?.content;
	if (!Array.isArray(content)) return undefined;
	const text = content
		.map((part) =>
			part && typeof part === "object" && (part as { type?: string }).type === "text"
				? String((part as { text?: unknown }).text ?? "")
				: "",
		)
		.join("")
		.trim();
	if (!text) return undefined;
	return text.length > 300 ? `${text.slice(0, 299)}…` : text;
}

export interface CallComparison {
	/** 干跑调了、真跑没调（多半是假数据把控制流带去了别的分支） */
	unfulfilled: string[];
	/** 真跑调了、干跑没预演到（最难的一类：只有真数据才走到的路） */
	unpredicted: string[];
}

function tally(names: string[]): Map<string, number> {
	const counts = new Map<string, number>();
	for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1);
	return counts;
}

/** 干跑与真跑的对账：按工具名计数，差在哪边就说哪边 */
export function compareCalls(dry: DryRunCall[], real: Array<{ tool: string }>): CallComparison {
	const dryCounts = tally(dry.map((call) => call.tool));
	const realCounts = tally(real.map((call) => call.tool));
	const render = (name: string, count: number): string => (count > 1 ? `${name}×${count}` : name);
	const unfulfilled: string[] = [];
	const unpredicted: string[] = [];
	for (const [name, count] of dryCounts) {
		const real = realCounts.get(name) ?? 0;
		if (count > real) unfulfilled.push(render(name, count - real));
	}
	for (const [name, count] of realCounts) {
		const predicted = dryCounts.get(name) ?? 0;
		if (count > predicted) unpredicted.push(render(name, count - predicted));
	}
	return { unfulfilled, unpredicted };
}

/** 对账结果压成一行，进审计与审批卡 */
export function compareLine(comparison: CallComparison): string {
	if (comparison.unfulfilled.length === 0 && comparison.unpredicted.length === 0) return "";
	const parts: string[] = [];
	if (comparison.unpredicted.length > 0) parts.push(`真跑多出：${comparison.unpredicted.join("、")}`);
	if (comparison.unfulfilled.length > 0) parts.push(`干跑多算：${comparison.unfulfilled.join("、")}`);
	return parts.join("；");
}
