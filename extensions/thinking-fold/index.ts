// thinking-fold — 把 thinking 块尾部的重复输出折成一行提示
//
// 起因：便宜模型（本例 tokenflux/deepseek-flash）在超长会话里，thinking 尾部
// 会退化成复读：「好。 / 执行。 / Output. / （行动）/（写）」这类短句反复几十
// 上百次，每块占 70%-90% 的字符。模型自己还能继续出 toolCall、任务照常推进，
// 所以不该中止生成（那是 loop-guard 的活，它管整块上万字符的失控），
// 只需要在 TUI 上把它折起来，别占满屏幕。
//
// 本扩展是纯渲染层：
//   - 只注册 registerMarkdownTransformer，在 transcript 渲染前改写文本
//   - 不碰会话内容、不发消息、不 appendEntry、不写任何文件
//   - transformer 里没有 IO，异常一律兜住并返回原 markdown
//
// 判定逻辑在 detector.ts（纯逻辑，已在本机真实语料上回归）。
//
// 配置：extensions.toml 的 [thinking-fold] / [thinking-fold.detector]
// 手动：/thinking-fold [on|off|status]，或 Ctrl+Shift+D 直接切换

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { Key } from "@earendil-works/pi-tui";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";
import {
	DEFAULT_DUP_OPTIONS,
	type DupOptions,
	type DupSuffix,
	findDupSuffix,
} from "./detector.ts";

const STATUS_KEY = "thinking-fold";
const TOML_PATH = join(getAgentDir(), "extensions.toml");

/** 折叠提示文案（改这里就能改显示，不散落在逻辑里） */
export const FOLD_NOTICE_HEAD = "⋯ [已折叠 ";
export const FOLD_NOTICE_BODY = " 行重复输出";
/** 提示里最多列几个样例行 */
export const FOLD_NOTICE_SAMPLES = 3;

/** 渲染层用的 transformer 上下文（与 pi 的 MarkdownTransformContext 结构一致） */
export interface MarkdownTransformContext {
	messageType: "user" | "assistant" | "assistant-thinking";
	isStreaming: boolean;
	availableWidth: number;
}

export interface FoldConfig {
	enabled: boolean;
	detector: Partial<DupOptions>;
}

const DEFAULT_CONFIG: FoldConfig = { enabled: true, detector: {} };

/** 读取 extensions.toml 的 [thinking-fold] / [thinking-fold.detector]；缺失或损坏用默认值 */
export function loadConfig(path = TOML_PATH): FoldConfig {
	let section: Record<string, unknown> = {};
	try {
		const toml = parseToml(readFileSync(path, "utf8")) as Record<string, unknown>;
		const raw = toml["thinking-fold"];
		if (raw && typeof raw === "object") section = raw as Record<string, unknown>;
	} catch {
		return { ...DEFAULT_CONFIG };
	}

	const enabledRaw = section.enabled;
	const detector: Partial<DupOptions> = {};
	const detectorRaw = section.detector;
	if (detectorRaw && typeof detectorRaw === "object") {
		const src = detectorRaw as Record<string, unknown>;
		for (const key of Object.keys(DEFAULT_DUP_OPTIONS) as Array<keyof DupOptions>) {
			const value = src[key];
			if (typeof value === "number" && Number.isFinite(value)) detector[key] = value;
		}
	}
	return {
		enabled: typeof enabledRaw === "boolean" ? enabledRaw : DEFAULT_CONFIG.enabled,
		detector,
	};
}

/** 把一次命中拼成一行提示 */
export function buildFoldNotice(suffix: DupSuffix): string {
	const samples = suffix.top.slice(0, FOLD_NOTICE_SAMPLES).join(" / ");
	return `${FOLD_NOTICE_HEAD}${suffix.lines}${FOLD_NOTICE_BODY}${samples ? "：" + samples : ""}]`;
}

export interface FoldResult {
	text: string;
	/** 命中信息；没命中为 null */
	suffix: DupSuffix | null;
}

/** 纯函数：把块尾的复读后缀折成一行提示 */
export function applyFold(markdown: string, opts: Partial<DupOptions> = {}): FoldResult {
	const suffix = findDupSuffix(markdown, opts);
	if (!suffix) return { text: markdown, suffix: null };
	const head = markdown.split("\n").slice(0, suffix.startLine).join("\n");
	const notice = buildFoldNotice(suffix);
	return { text: head ? `${head}\n${notice}` : notice, suffix };
}

/** 最近一次折叠的统计（命令 / 状态栏用） */
export interface LastFold {
	lines: number;
	chars: number;
	kinds: number;
	top: string[];
	at: number;
}

export interface FoldState {
	enabled: boolean;
	/** 本 session 折叠过多少次 */
	folds: number;
	last: LastFold | null;
}

/**
 * 装配入口（独立出来便于用假 pi 驱动测试）。
 * 返回可读写的最小状态句柄，测试与状态查询都用它。
 */
export function createThinkingFold(pi: ExtensionAPI, cfg: FoldConfig) {
	let enabled = cfg.enabled;
	const detectorOpts = cfg.detector;
	const state: FoldState = { enabled, folds: 0, last: null };

	/** 最近的 ctx：transformer 拿不到 ctx，状态栏更新要用它，延迟一拍再写 */
	let latestCtx: ExtensionContext | null = null;
	let statusTimer: ReturnType<typeof setTimeout> | null = null;
	let lastStatusText: string | null = null;
	let lastStatusAt = 0;

	const notify = (ctx: ExtensionContext | null, text: string, level: "info" | "warning" = "info") => {
		try {
			ctx?.ui.notify(text, level);
		} catch {
			// 没有可用 UI：不影响折叠本身
		}
	};

	const clearStatusTimer = () => {
		if (statusTimer === null) return;
		clearTimeout(statusTimer);
		statusTimer = null;
	};

	const clearStatus = (ctx = latestCtx) => {
		lastStatusText = null;
		try {
			if (ctx?.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
		} catch {
			// session 可能已切换
		}
	};

	/**
	 * 命中后写状态栏。真正的 setStatus 甩到下一拍执行：
	 * transformer 跑在渲染调用栈里，直接改状态栏会从渲染里触发另一次渲染。
	 */
	const scheduleStatus = () => {
		if (statusTimer !== null) return;
		const timer = setTimeout(() => {
			statusTimer = null;
			const ctx = latestCtx;
			if (!enabled || !state.last || !ctx?.hasUI) return;
			const text = `✂️ 折叠 ${state.last.lines} 行 / ${state.last.chars} 字`;
			const now = Date.now();
			if (text === lastStatusText || now - lastStatusAt < 500) return;
			lastStatusText = text;
			lastStatusAt = now;
			try {
				ctx.ui.setStatus(STATUS_KEY, text);
			} catch {
				// 忽略
			}
		}, 0);
		statusTimer = timer as unknown as ReturnType<typeof setTimeout>;
		// 别为一次状态刷新把进程留住（print / 测试场景）
		(timer as unknown as { unref?: () => void }).unref?.();
	};

	// 同一段 markdown 会被反复渲染（滚动、footer 刷新），逐次重扫是纯浪费；
	// 按字符串做一层 memo，命中即原样返回（不重复计数）
	let memoKey: string | null = null;
	let memoValue: string | null = null;

	const transformer = (markdown: string, context: MarkdownTransformContext): string => {
		try {
			if (!enabled) return markdown;
			if (typeof markdown !== "string") return markdown;
			if (!context || context.messageType !== "assistant-thinking") return markdown;
			if (markdown === memoKey && memoValue !== null) return memoValue;
			const result = applyFold(markdown, detectorOpts);
			if (!result.suffix) {
				memoKey = markdown;
				memoValue = markdown;
				return markdown;
			}
			state.folds += 1;
			state.last = {
				lines: result.suffix.lines,
				chars: result.suffix.chars,
				kinds: result.suffix.kinds,
				top: result.suffix.top,
				at: Date.now(),
			};
			scheduleStatus();
			memoKey = markdown;
			memoValue = result.text;
			return result.text;
		} catch {
			// 任何意外都退回原始文本：渲染层不能因为折叠失败而炸
			return markdown;
		}
	};

	pi.registerMarkdownTransformer(transformer);

	const setEnabled = (next: boolean, ctx: ExtensionContext | null, source: string) => {
		if (enabled === next) {
			notify(ctx, `[thinking-fold] 已经是${next ? "开启" : "关闭"}状态`, "info");
			return;
		}
		enabled = next;
		state.enabled = next;
		if (!next) {
			clearStatusTimer();
			clearStatus(ctx);
		} else if (state.last) {
			lastStatusText = null;
			scheduleStatus();
		}
		notify(ctx, `[thinking-fold] 已${next ? "开启" : "关闭"}（${source}）`, "info");
	};

	pi.on("session_start", (_event, ctx) => {
		latestCtx = ctx;
		clearStatusTimer();
		clearStatus(ctx);
	});
	pi.on("session_shutdown", () => {
		clearStatusTimer();
	});

	pi.registerCommand("thinking-fold", {
		description: "thinking 尾部重复输出折叠：查看状态 / 开关（on | off | status）",
		handler: async (args, ctx) => {
			latestCtx = ctx;
			const arg = (args ?? "").trim().toLowerCase();
			if (arg === "on" || arg === "off") {
				setEnabled(arg === "on", ctx, "/thinking-fold");
				return;
			}
			if (arg && arg !== "status") {
				notify(ctx, "用法：/thinking-fold [on|off|status]", "warning");
				return;
			}
			const d = { ...DEFAULT_DUP_OPTIONS, ...detectorOpts };
			const lines = [
				`状态：${enabled ? "开启" : "关闭"}（配置默认 ${cfg.enabled ? "开启" : "关闭"}）`,
				`本 session 折叠：${state.folds} 次`,
				`判定：复读行出现 ≥ ${d.minCount} 次且行长 ≤ ${d.maxLineLen}；后缀 ≥ ${d.minLines} 行 / ${d.minChars} 字、复读种类 ≤ ${d.maxKinds}、整块最常见行 ≥ ${d.maxTopCount} 次，复读字符占比 ≥ ${d.minDensity}`,
				`　　　折起来的只是尾部那截：起点会对齐到第一个复读行，前头的内容不动`,
				state.last
					? `最近折叠：${state.last.lines} 行 / ${state.last.chars} 字 · ${state.last.kinds} 种（${state.last.top.slice(0, 3).join(" / ")}）`
					: "最近折叠：无",
			];
			notify(ctx, lines.join("\n"), "info");
		},
	});

	pi.registerShortcut(Key.ctrlShift("d"), {
		description: "切换 thinking 尾部重复输出折叠",
		handler: (ctx) => {
			try {
				latestCtx = ctx;
				setEnabled(!enabled, ctx, "Ctrl+Shift+D");
			} catch {
				// 切换失败不该影响别的东西
			}
		},
	});

	return state;
}

export default function (pi: ExtensionAPI) {
	createThinkingFold(pi, loadConfig());
}
