// lib/ptc-progress.ts — 把内层调用的流式进度转发到 run_code 自己的 onUpdate
//
// 引擎的 codemode 执行内层工具时只传 signal、不传 onUpdate
// （dist/extensions/codemode/execute.js: ctx.executeTool(tool.name, args, { signal: callSignal })），
// 于是内层工具推的流式部分结果到这一层就被丢掉了。subagent 每 120ms 往外推一次
// fleet 快照，一条都到不了界面：run_code 的条目从头静到尾，长批次看着像卡死。
//
// 这里照干跑那套原型委托把 ctx.executeTool 包一层，只补一件事——给内层调用接上
// onUpdate，把部分结果压成一行交给 sink。其余字段与参数原样透传：脚本看到的
// 工具面必须与真跑一致（干跑与真跑两份包装要保持同一形状）。

const MIN_INTERVAL_MS = 250;
const MAX_LINE = 160;

/** 内层工具的部分结果：形状随工具而异，只认 content 里的 text */
interface NestedPartial {
	content?: unknown;
}

/** 从内层部分结果里抠一行可读进度；抠不出来返回 null（宁可不出声，也不刷屏） */
export function progressLine(tool: string, partial: unknown): string | null {
	const content = (partial as NestedPartial | undefined)?.content;
	if (!Array.isArray(content)) return null;
	const text = content
		.map((item) => {
			if (!item || typeof item !== "object") return "";
			const block = item as { type?: unknown; text?: unknown };
			return block.type === "text" && typeof block.text === "string" ? block.text : "";
		})
		.join(" ")
		.replace(/\s+/g, " ")
		.trim();
	if (text === "") return null;
	return `${tool}: ${text.length > MAX_LINE ? `${text.slice(0, MAX_LINE)}…` : text}`;
}

/**
 * 造一个只改 executeTool 的 ctx。三件事：
 * 1. 内层调用补上 onUpdate（引擎缺的那一步）
 * 2. 内层自己的 onUpdate 照旧调用，不吞
 * 3. 转出的进度去重 + 节流（相邻同文不重发，最小间隔 MIN_INTERVAL_MS）
 */
export function makeProgressContext<T extends object>(
	ctx: T,
	sink: (line: string) => void,
	now: () => number = Date.now,
): T {
	// 底层没有出口就别包：硬造一个 executeTool 会让「这个 ctx 能不能派调用」失真
	// （测试拿它分辨干跑与真跑；引擎在同样情形下也该照旧报自己的错）
	const base = ctx as unknown as { executeTool?: (n: string, a: unknown, o?: unknown) => Promise<unknown> };
	const direct = base.executeTool;
	if (typeof direct !== "function") return ctx;

	const wrapped = Object.create(ctx) as Record<string, unknown>;
	let lastAt = Number.NEGATIVE_INFINITY;
	let lastLine = "";

	Object.defineProperties(wrapped, {
		executeTool: {
			value: async (name: string, args: unknown, options?: Record<string, unknown>): Promise<unknown> => {
				const inner = options?.onUpdate;
				const onUpdate = (partial: unknown): void => {
					if (typeof inner === "function") (inner as (p: unknown) => void)(partial);
					const line = progressLine(name, partial);
					if (line === null || line === lastLine) return;
					const at = now();
					if (at - lastAt < MIN_INTERVAL_MS) return;
					lastAt = at;
					lastLine = line;
					sink(line);
				};
				return direct(name, args, { ...(options ?? {}), onUpdate });
			},
			enumerable: true,
			configurable: true,
			writable: true,
		},
	});

	return wrapped as T;
}
