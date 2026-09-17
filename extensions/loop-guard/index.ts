// loop-guard — 重复输出（死循环）拦截
//
// 起因：2026-09-16 的 precss-bugfix 会话里，模型在 CoT 中反复输出
// 「好。/ 做。/（输出）」这类占位句，单块最高 13 万字符，白白烧掉大量
// token 与时间（详见 README.md 的事故记录）。
//
// 做法：在流式阶段盯 thinking / 正文的增量，判定交给 detector.ts（纯逻辑，
// 已用 408 个历史 session、13.3 万个输出块离线校准，命中 7 次全是真循环，
// 零误伤）。命中后：
//   warn  → 状态栏 + 一次性提示，不动输出
//   abort → 中止本次生成，并在 agent 停歇后注入一条纠正消息，
//           让模型带着「别再写占位句」的指令继续干活
//
// 配置：extensions.toml 的 [loop-guard] / [loop-guard.detector]
// 手动：/loop-guard 查看与临时切换
//
// 刻意不做的事：
//   - 不改系统提示词、不动工具表（保 KV 缓存前缀稳定）
//   - 不盯 toolcall_delta（拦在工具调用 JSON 中间会毁掉这一轮）
//   - warn 级不注入消息（注入本身就是对正常输出的干扰）

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";
import {
	DEFAULT_OPTIONS,
	LoopDetector,
	type LoopGuardOptions,
	type LoopHit,
} from "./detector.ts";

const STATUS_KEY = "loop-guard";
const CUSTOM_TYPE = "loop-guard";
const TOML_PATH = join(getAgentDir(), "extensions.toml");

export type Mode = "off" | "warn" | "abort";

export interface GuardConfig {
	enabled: boolean;
	/** off=不检测；warn=只提示；abort=提示并中止 */
	mode: Mode;
	/** 每个 session 允许的中止次数上限 */
	maxActionsPerSession: number;
	/** 两次中止之间的最小间隔，防拉锯 */
	cooldownMs: number;
	detector: Partial<LoopGuardOptions>;
}

const DEFAULT_CONFIG: GuardConfig = {
	enabled: true,
	mode: "abort",
	maxActionsPerSession: 3,
	cooldownMs: 15000,
	detector: {},
};

const MODES: Mode[] = ["off", "warn", "abort"];

/** 读取 extensions.toml 的 [loop-guard] / [loop-guard.detector]；文件缺失或损坏则用默认值 */
export function loadConfig(path = TOML_PATH): GuardConfig {
	let section: Record<string, unknown> = {};
	try {
		const toml = parseToml(readFileSync(path, "utf8")) as Record<string, unknown>;
		const raw = toml["loop-guard"];
		if (raw && typeof raw === "object") section = raw as Record<string, unknown>;
	} catch {
		return { ...DEFAULT_CONFIG };
	}
	const mode = section.mode;
	const enabledRaw = section.enabled;
	const detectorRaw = section.detector;
	return {
		enabled: typeof enabledRaw === "boolean" ? enabledRaw : DEFAULT_CONFIG.enabled,
		mode: typeof mode === "string" && (MODES as string[]).includes(mode) ? (mode as Mode) : DEFAULT_CONFIG.mode,
		maxActionsPerSession:
			typeof section.maxActionsPerSession === "number" && section.maxActionsPerSession >= 0
				? section.maxActionsPerSession
				: DEFAULT_CONFIG.maxActionsPerSession,
		cooldownMs:
			typeof section.cooldownMs === "number" && section.cooldownMs >= 0
				? section.cooldownMs
				: DEFAULT_CONFIG.cooldownMs,
		detector:
			detectorRaw && typeof detectorRaw === "object"
				? (detectorRaw as Partial<LoopGuardOptions>)
				: DEFAULT_CONFIG.detector,
	};
}

/** 给模型看的纠正消息（中止后注入） */
export function buildCorrectionPrompt(hit: LoopHit): string {
	const samples = hit.samples.map((s) => JSON.stringify(s)).join(" / ");
	return `<loop_guard>
检测到重复输出，已中止本次生成：重复内容共 ${hit.repeatChars} 字符 / ${hit.repeatLines} 行，集中在 ${hit.alphabet} 种短句上（${samples}），占窗口内 ${Math.round((1 - hit.intruderRatio) * 100)}% 的行。这是在重复占位句，没有产出新信息。

立刻换做法：
- 不要写「好 / 做 / 输出 / 现在 / RUN」这类占位语
- 该调工具就直接发出工具调用；该给结论就直接给结论
- 如果确实卡住了，用一句话说清卡在哪（缺什么输入、哪条命令失败），然后停下
</loop_guard>`;
}

function describeHit(hit: LoopHit): string {
	const head = hit.severity === "abort" ? "🛑 重复输出已中止" : "⚠️ 疑似重复输出";
	return `${head}：${hit.repeatChars} 字符 / ${hit.repeatLines} 行集中在 ${hit.alphabet} 种短句（${hit.sample}）`;
}

export default function (pi: ExtensionAPI) {
	createLoopGuard(pi, loadConfig());
}

/** 装配入口（独立出来便于用假 pi 驱动测试） */
export function createLoopGuard(pi: ExtensionAPI, cfg: GuardConfig) {
	let mode: Mode = cfg.enabled ? cfg.mode : "off";
	const detector = new LoopDetector(cfg.detector);

	// 运行态
	let currentIndex: number | null = null;
	/** 本块是否已提示过 warn */
	let warnNotified = false;
	/** 本块是否已中止过（一个块只动手一次） */
	let abortedThisBlock = false;
	/** 本 session 是否已提示过预算耗尽 */
	let budgetNotified = false;
	let pendingCorrection: LoopHit | null = null;
	let actionsUsed = 0;
	let lastActionAt = 0;
	let lastHit: LoopHit | null = null;
	/** 状态栏节流：同一级别 2 秒内不重复刷 */
	let lastStatusAt = 0;
	let lastStatusSeverity: string | null = null;

	const resetBlock = (index: number | null = null): void => {
		detector.reset();
		currentIndex = index;
		warnNotified = false;
		abortedThisBlock = false;
		lastStatusSeverity = null;
	};

	const setStatus = (ctx: ExtensionContext, text: string | undefined): void => {
		if (!ctx.hasUI) return;
		try {
			ctx.ui.setStatus(STATUS_KEY, text);
		} catch {
			// session 可能已切换
		}
	};

	/** print/rpc/subagent 等无 UI 场景下 notify 未必可用，一律兜住 */
	const notify = (ctx: ExtensionContext, text: string, level: "info" | "warning" = "warning"): void => {
		try {
			ctx.ui.notify(text, level);
		} catch {
			// 没有可用的 UI：不影响拦截本身
		}
	};

	pi.on("session_start", (_event, ctx) => {
		resetBlock();
		pendingCorrection = null;
		actionsUsed = 0;
		budgetNotified = false;
		lastHit = null;
		setStatus(ctx, undefined);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		resetBlock();
		setStatus(ctx, undefined);
	});

	pi.on("message_update", (event, ctx) => {
		const ev = event.assistantMessageEvent;
		if (mode === "off") return;

		switch (ev.type) {
			case "start":
				resetBlock();
				pendingCorrection = null;
				return;
			case "thinking_start":
			case "text_start":
				resetBlock(ev.contentIndex);
				return;
			case "thinking_end":
			case "text_end":
			case "toolcall_start":
				resetBlock();
				return;
			case "done":
			case "error":
				resetBlock();
				if (!pendingCorrection) setStatus(ctx, undefined);
				return;
			case "thinking_delta":
			case "text_delta": {
				if (ev.contentIndex !== currentIndex) resetBlock(ev.contentIndex);
				const delta = typeof ev.delta === "string" ? ev.delta : "";
				const hit = detector.feed(delta);
				if (hit) handleHit(hit, ctx);
				return;
			}
			default:
				return;
		}
	});

	function handleHit(hit: LoopHit, ctx: ExtensionContext): void {
		lastHit = hit;
		const warnOnly = hit.severity === "warn" || mode === "warn";
		const severity = warnOnly ? "warn" : "abort";
		const now = Date.now();
		if (severity !== lastStatusSeverity || now - lastStatusAt >= 2000) {
			lastStatusSeverity = severity;
			lastStatusAt = now;
			setStatus(ctx, warnOnly ? `⚠️ 疑似重复 ${hit.repeatChars} 字` : "🛑 已中止重复输出");
		}

		// warn 档：只提示，不动输出
		if (warnOnly) {
			if (!warnNotified) {
				warnNotified = true;
				notify(ctx, describeHit(hit));
			}
			return;
		}

		// 中止档：一个块只动手一次，再叠预算与冷却两道闸门
		if (abortedThisBlock) return;
		if (actionsUsed >= cfg.maxActionsPerSession) {
			if (!budgetNotified) {
				budgetNotified = true;
				notify(
					ctx,
					`${describeHit(hit)}\n本 session 中止次数已达上限（${cfg.maxActionsPerSession}），改为只提示`,
				);
			}
			return;
		}
		const actionAt = Date.now();
		if (actionAt - lastActionAt < cfg.cooldownMs) return;

		actionsUsed += 1;
		lastActionAt = actionAt;
		abortedThisBlock = true;
		pendingCorrection = hit;
		notify(ctx, `${describeHit(hit)}\n已中止，停歇后注入纠正指令让模型换个做法`);
		// 避免在流式回调里直接收流造成重入
		setTimeout(() => {
			try {
				ctx.abort();
			} catch {
				// 已结束时忽略
			}
		}, 0);
	}

	// 中止后 agent 停歇：注入纠正消息，带出一个新回合
	pi.on("agent_settled", (_event, ctx) => {
		const hit = pendingCorrection;
		pendingCorrection = null;
		if (!hit) return;
		setStatus(ctx, undefined);
		try {
			pi.sendMessage(
				{
					customType: CUSTOM_TYPE,
					content: buildCorrectionPrompt(hit),
					display: true,
					details: {
						repeatChars: hit.repeatChars,
						repeatLines: hit.repeatLines,
						alphabet: hit.alphabet,
						avgLineChars: hit.avgLineChars,
						samples: hit.samples,
					},
				},
				{ triggerTurn: true },
			);
		} catch (err) {
			notify(
				ctx,
				`[loop-guard] 纠正消息注入失败：${err instanceof Error ? err.message : String(err)}`,
			);
		}
	});

	pi.on("agent_end", (_event, ctx) => {
		resetBlock();
		if (!pendingCorrection) setStatus(ctx, undefined);
	});

	pi.registerCommand("loop-guard", {
		description: "重复输出拦截：查看状态 / 切换模式（off | warn | abort | reset）",
		handler: async (args, ctx) => {
			const arg = (args ?? "").trim().toLowerCase();
			if (arg === "off" || arg === "warn" || arg === "abort") {
				mode = arg;
				setStatus(ctx, undefined);
				notify(ctx, `[loop-guard] 模式切换为 ${mode}`, "info");
				return;
			}
			if (arg === "reset") {
				actionsUsed = 0;
				lastActionAt = 0;
				notify(ctx, "[loop-guard] 中止预算已重置", "info");
				return;
			}
			if (arg && arg !== "status") {
				notify(ctx, "用法：/loop-guard [off|warn|abort|reset]");
				return;
			}
			const d = { ...DEFAULT_OPTIONS, ...cfg.detector };
			const lines = [
				`模式：${mode}（配置默认 ${cfg.enabled ? cfg.mode : "off"}）`,
				`本 session 已中止：${actionsUsed}/${cfg.maxActionsPerSession}，冷却 ${cfg.cooldownMs}ms`,
				`判定：重复 ≥ ${d.warnRepeatChars} 字提示，≥ ${d.abortRepeatChars} 字中止`,
				`　　　重复行平均行长 ≤ ${d.maxAvgLineChars}，新行占比 ≤ ${d.maxIntruderRatio}，字母表 ≤ ${d.maxAlphabet}`,
				lastHit
					? `最近命中：${lastHit.severity} ${lastHit.repeatChars}字/${lastHit.repeatLines}行 alpha=${lastHit.alphabet} avg=${lastHit.avgLineChars} @${lastHit.offset}`
					: "最近命中：无",
			];
			notify(ctx, lines.join("\n"), "info");
		},
	});
}
