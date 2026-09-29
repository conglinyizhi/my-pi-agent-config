// network-command.ts — /sandbox:network：worker 出网审核强度（三档）
//
// 三个入口，同一个 handler：
//   1 /sandbox:network                    有图形时开 yad 窗口：三档选一个 → 放宽要确认 → 落盘
//   2 TUI 回退                             yad 不存在 / 没 DISPLAY / 窗口拉不起来时逐项提问
//   3 /sandbox:network <off|whitelist|loose>  直接设（写不写盘、确认不确认见下）
//
// 什么时候要确认：只有**放宽方向**（whitelist → loose/off、loose → off）才弹确认，
// 措辞里写明「会放宽对 AI 命令的审核」；收紧（→ whitelist）不拦，免得撤防护还要点两下。
// 这与 /sandbox:paths 的 add/remove 同口径：放宽要确认，收紧直接做。
//
// 档位语义在 network-policy.ts；本文件只管「谁把档设成什么」，不重复那份判定。
// yad 一律走注入的 runner（测试用假 runner；真 yad 是阻塞窗口，测试里绝不拉起）。

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
	NETWORK_MODES,
	loadNetworkMode,
	networkModeMeta,
	networkPolicyFile,
	parseNetworkMode,
	saveNetworkMode,
	type NetworkMode,
} from "./network-policy.ts";
import { resolveYadSession, yadPickRow, yadText, type YadSession, type YadSessionDeps } from "./yad-paths.ts";

/** 命令只用得到的 UI 子集（无 UI 环境里 pi 注入全 no-op stub，confirm 恒 false） */
export interface NetworkCommandContext {
	ui: Pick<ExtensionCommandContext["ui"], "notify" | "select" | "confirm">;
	hasUI: boolean;
	signal?: AbortSignal;
}

export type NetworkCommandDeps = YadSessionDeps;

export const NETWORK_USAGE = [
	"用法：",
	"  /sandbox:network                查看当前档位；有图形时开窗口改（无参数也会问一次）",
	`  /sandbox:network <${NETWORK_MODES.map((m) => m.label).join("|")}>   直接设档（放宽方向仍要确认一次）`,
	"  /sandbox:network status         只显示当前档位与三档含义",
	"  /sandbox:network help           本帮助",
	"",
	...NETWORK_MODES.map((m) => `  ${m.label.padEnd(9)} ${m.summary}`),
	"",
	"作用范围：worker（subagent）出网这一维。命令本身的风险（rm -rf、内联脚本、管道进解释器…）",
	"照旧走审核链，与档位无关；主 agent 的 bash 从不卡 network，也不受本档影响。",
	`配置：${networkPolicyFile()}（即时生效；文件缺失 = whitelist）`,
].join("\n");

/** 严格度：数字小的更松。放宽 = 数字变小。 */
const STRICTNESS: Record<NetworkMode, number> = { off: 0, loose: 1, whitelist: 2 };

export function isRelaxing(from: NetworkMode, to: NetworkMode): boolean {
	return STRICTNESS[to] < STRICTNESS[from];
}

export type NetworkAction =
	| { kind: "pick"; unknown?: string }
	| { kind: "set"; mode: NetworkMode }
	| { kind: "status" }
	| { kind: "help" };

/** 解析参数：档位词必须写全（缩写会让人以为调了别的档） */
export function parseNetworkArgs(args: string): NetworkAction {
	const words = args.trim().split(/\s+/).filter(Boolean);
	const first = (words[0] ?? "").toLowerCase();
	if (!first) return { kind: "pick" };
	if (["help", "-h", "--help"].includes(first)) return { kind: "help" };
	if (["status", "show", "list"].includes(first)) return { kind: "status" };
	// 允许 `/sandbox:network set loose` 这种写法，但裸档位词是主用法
	const word = first === "set" ? (words[1] ?? "") : first;
	if (!word) return { kind: "pick" };
	const mode = parseNetworkMode(word);
	return mode ? { kind: "set", mode } : { kind: "pick", unknown: word };
}

/** 参数补全：档位词 + status/help */
export function networkArgumentCompletions(prefix: string): { value: string; label: string }[] {
	const p = (prefix ?? "").trimStart();
	if (/\s/.test(p)) return [];
	return [...NETWORK_MODES.map((m) => m.label), "status", "help"]
		.filter((word) => word.startsWith(p.toLowerCase()))
		.map((word) => ({ value: word, label: word }));
}

/** 当前档位 + 三档含义（/sandbox:network status 与窗口共用） */
export function networkStatusText(): string {
	const current = loadNetworkMode();
	const lines = [
		`network 审核强度：${current}（${networkModeMeta(current).summary}）`,
		`配置：${networkPolicyFile()}（文件缺失按 whitelist；即时生效）`,
		"",
		"三档：",
	];
	for (const meta of NETWORK_MODES) {
		lines.push(`  ${meta.mode === current ? "▶" : " "} ${meta.label.padEnd(9)} ${meta.summary}`);
	}
	return lines.join("\n");
}

function confirmTitle(mode: NetworkMode): string {
	return `放宽 network 审核 → ${mode}？`;
}

/** 放宽前的确认正文：逐条列出这一档会发生什么（措辞即后果） */
export function confirmBody(mode: NetworkMode, file: string, from: NetworkMode): string {
	const meta = networkModeMeta(mode);
	return [
		`当前：${from}`,
		`改为：${mode}`,
		"",
		...meta.points.map((p) => `- ${p}`),
		"",
		"⚠️ 这一档会放宽对 AI 命令（worker）出网的审核，是自己给自己开门的事，只由人类来改",
		`写入：${file}`,
		"生效：即时（下一次判定就按新档），命令本身的风险审核不受影响",
	].join("\n");
}

function helpText(unknown?: string): { text: string; type: "info" | "warning" } {
	if (unknown) {
		return {
			text: `无法识别「${unknown}」：档位只有 ${NETWORK_MODES.map((m) => m.label).join(" | ")}\n\n${NETWORK_USAGE}`,
			type: "warning",
		};
	}
	return { text: NETWORK_USAGE, type: "info" };
}

/**
 * /sandbox:network 处理器：查看 / 选择 / 直接设档（yad 窗口 → TUI 回退）。
 */
export async function networkCommandHandler(
	args: string,
	ctx: NetworkCommandContext,
	deps: NetworkCommandDeps = {},
): Promise<void> {
	const action = parseNetworkArgs(args);
	if (action.kind === "help") {
		const { text, type } = helpText();
		ctx.ui.notify(text, type);
		return;
	}

	if (action.kind === "status") {
		ctx.ui.notify(networkStatusText(), "info");
		const session = resolveYadSession(ctx, deps);
		if (session) await infoWindow(session, networkStatusText());
		return;
	}

	const current = loadNetworkMode();
	const session = resolveYadSession(ctx, deps);
	let mode = action.kind === "set" ? action.mode : undefined;

	// 无参数（或认不出的词）：先选档
	if (!mode && session) {
		const picked = await pickViaYad(session, action.kind === "pick" ? action.unknown : undefined);
		if (picked.kind === "unavailable") {
			ctx.ui.notify(`yad 窗口拉不起来（${picked.detail}），改用逐项提问`, "warning");
		} else if (picked.kind === "cancel") {
			ctx.ui.notify("已取消", "info");
			return;
		} else {
			mode = picked.mode;
		}
	}
	if (!mode) {
		if (action.kind === "pick" && action.unknown && !session) {
			const { text, type } = helpText(action.unknown);
			ctx.ui.notify(text, type);
			return;
		}
		if (!ctx.hasUI) {
			ctx.ui.notify(
				`无交互界面，请带参数：/sandbox:network <${NETWORK_MODES.map((m) => m.label).join("|")}>\n${NETWORK_USAGE}`,
				"error",
			);
			return;
		}
		mode = await pickViaTui(ctx);
		if (!mode) {
			ctx.ui.notify("已取消", "info");
			return;
		}
	}

	await applyMode(mode, current, ctx, session);
}

type PickResult = { kind: "ok"; mode: NetworkMode } | { kind: "cancel" } | { kind: "unavailable"; detail: string };

async function pickViaYad(session: YadSession, unknown?: string): Promise<PickResult> {
	const current = loadNetworkMode();
	const rows = NETWORK_MODES.map((meta) => [meta.label, meta.summary]);
	const picked = await yadPickRow(session, {
		title: "network 审核强度 · pi",
		text: [
			`当前：${current}`,
			unknown ? `认不出的词：「${unknown}」` : "",
			"选一档按「设为该档」。放宽方向会再确认一次。",
		].filter(Boolean).join("\n"),
		headers: ["档位", "说明"],
		rows,
		okLabel: "设为该档",
		cancelLabel: "关闭",
	});
	if (picked.kind !== "ok") return picked;
	const mode = NETWORK_MODES[picked.index]?.mode;
	return mode ? { kind: "ok", mode } : { kind: "cancel" };
}

async function pickViaTui(ctx: NetworkCommandContext): Promise<NetworkMode | undefined> {
	const current = loadNetworkMode();
	const options = NETWORK_MODES.map((meta) => `${meta.label === current ? "▶ " : ""}${meta.label}：${meta.summary}`);
	const picked = await ctx.ui.select(
		`network 审核强度（当前 ${current}）`,
		[...options, "❌ 取消"],
		ctx.signal ? { signal: ctx.signal } : undefined,
	);
	if (!picked || picked.startsWith("❌")) return undefined;
	return NETWORK_MODES[options.indexOf(picked)]?.mode;
}

/** 落盘（放宽方向先确认） */
async function applyMode(
	mode: NetworkMode,
	current: NetworkMode,
	ctx: NetworkCommandContext,
	session: YadSession | null,
): Promise<void> {
	const meta = networkModeMeta(mode);
	const file = networkPolicyFile();

	if (mode === current) {
		ctx.ui.notify(`network 审核强度已经是 ${mode}：${meta.summary}`, "info");
		if (session) await infoWindow(session, networkStatusText());
		return;
	}

	if (isRelaxing(current, mode)) {
		const ok = await confirmRelax(mode, current, ctx, session, file);
		if (!ok) {
			ctx.ui.notify("已取消", "info");
			return;
		}
	}

	try {
		saveNetworkMode(mode);
	} catch (err) {
		const reason = err instanceof Error ? err.message : String(err);
		ctx.ui.notify(`写入失败：${reason}`, "error");
		if (session) await infoWindow(session, `写入失败\n${reason}`);
		return;
	}
	ctx.ui.notify(`network 审核强度已设为 ${mode}：${meta.summary}\n${file}（即时生效）`, "info");
}

/** 放宽前的确认：yad 窗口优先，窗口拉不起来时退回 ctx.ui.confirm */
async function confirmRelax(
	mode: NetworkMode,
	current: NetworkMode,
	ctx: NetworkCommandContext,
	session: YadSession | null,
	file: string,
): Promise<boolean> {
	const title = confirmTitle(mode);
	const body = confirmBody(mode, file, current);
	if (session) {
		const shown = await yadText(session, { title, text: body, okLabel: "保存", cancelLabel: "取消" });
		if (shown.kind === "ok") return true;
		if (shown.kind === "cancel") return false;
		ctx.ui.notify(`yad 窗口拉不起来（${shown.detail}），改用逐项提问`, "warning");
	}
	if (!ctx.hasUI) return false;
	return ctx.ui.confirm(title, body, ctx.signal ? { signal: ctx.signal } : undefined).then(Boolean);
}

/** 窗口里也说一句（跑 yad 的路子上人未必看 TUI 通知） */
async function infoWindow(session: YadSession, text: string): Promise<void> {
	await yadText(session, { title: "network 审核强度 · pi", text, okLabel: "知道了" });
}
