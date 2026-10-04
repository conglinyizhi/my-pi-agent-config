// ptc — 程序化工具调用（PTC）入口：run_code
//
// 与内置 codemode 的关系：**并存，不顶替**。内置那个名字叫 codemode，MCP 扩展靠
// isCodemodeTool 认它（名字 + schema 对象引用），改名顶掉会让 MCP 把工具按 direct
// 直接摆给模型。所以这里换个名字自建一份，内置的实现照常在。
//
// 比 codemode 多的一样东西是**理由**：入参里必须有一句 description，说明这段程序
// 要做什么、为什么。理由进 lib/ptc-reason.ts 的进程内登记表，审核引擎按
// callId / parentToolCallId 就能把「内层那记 bash」和「它属于哪段程序」对上——
// 这正是 dsh 的 PTC 用 `<run_code id>:ptc:<n>` 做的事，pi 的嵌套调用 id 天然是
// `<父 id>/<n>`，所以挂钩点是现成的。
//
// 引擎不重写：定义从宿主 pi 的 dist 里取（见 host.ts），我们只改名、换入参、
// 加理由登记与呈现。
//
// 事前审核走 lib/ptc-audit.ts：批了才执行，批过的脚本登记一个作用域，
// 内层调用不再逐条弹人工闸门（硬拦与自动判定照旧）。拒了就整段废弃。
//
// 设置（settings.json，/reload 生效）：
//   "ptc": false                              不注册 run_code（缺省注册）
//   "ptc": { "mode": "only" | "on", "inlineBudget": 12000 }
//     only = 模型只看到 run_code，其余工具都从程序里调；on = 目录式声明（缺省 on）
// 命令：/ptc-reasons 看登记表里最近几条理由，确认审核链拿得到东西。

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ptcCodeDigest, ptcReasonLedger } from "../../lib/ptc-reason.ts";
import {
	approvePtcScript,
	beginPtcScope,
	endPtcScope,
	ptcRejectedText,
	ptcScriptDigest,
	type PtcToolInfo,
} from "../../lib/ptc-audit.ts";
import { RUN_CODE_SCHEMA, buildRunCodeDefinition, loadHostCodemode, type HostCodemodeModule } from "./host.ts";

const SETTINGS_PATH = join(getAgentDir(), "settings.json");

function readSettings(): Record<string, unknown> {
	try {
		return JSON.parse(readFileSync(SETTINGS_PATH, "utf8")) as Record<string, unknown>;
	} catch {
		return {};
	}
}

export interface PtcSettings {
	/** false 时不注册 run_code */
	enabled: boolean;
	/** only = 只声明编排工具本身，其余工具藏起来但脚本里可调 */
	mode?: "on" | "only";
	/** 描述里工具目录的 token 预算 */
	inlineBudget?: number;
}

/** settings.json 里的 ptc 块：`false` 关闭；对象给 mode / inlineBudget（缺省 mode = on） */
export function readPtcSettings(settings: Record<string, unknown>): PtcSettings {
	const raw = settings.ptc;
	if (raw === false) return { enabled: false };
	const block = raw !== null && typeof raw === "object" ? (raw as { mode?: unknown; inlineBudget?: unknown }) : {};
	const mode = block.mode === "only" ? "only" : "on";
	const inlineBudget =
		typeof block.inlineBudget === "number" && Number.isFinite(block.inlineBudget) && block.inlineBudget >= 0
			? block.inlineBudget
			: undefined;
	return { enabled: true, mode, inlineBudget };
}

export default async function (pi: ExtensionAPI): Promise<void> {
	if (!readPtcSettings(readSettings()).enabled) return;

	let host: HostCodemodeModule;
	try {
		host = await loadHostCodemode();
	} catch (error) {
		// 加载期没有 ctx，攒到 session_start 再报（见 extensions/repo-prompts/warnings.ts）
		const message = `ptc: run_code 未注册 —— ${error instanceof Error ? error.message : String(error)}`;
		pi.on("session_start", (_event, ctx) => {
			ctx.ui.notify(message, "warning");
		});
		return;
	}

	registerRunCode(pi, host);
}

/**
 * 送审用的工具面：注册表里的全部工具。
 * 第 0 步还不知道脚本真正会调哪几个（静态扫描还没做），先把全集报一遍；
 * 自明的只列名字，其余附描述（见 lib/ptc-audit.ts 的 describeTools）。
 */
function registeredTools(pi: ExtensionAPI): PtcToolInfo[] {
	return (pi.getAllTools?.() ?? []).map((tool) => {
		const info = tool as { description?: string; annotations?: Record<string, unknown> };
		return { name: tool.name, description: info.description, annotations: info.annotations };
	});
}

/** 注册 run_code 与 /ptc-reasons。宿主模块与设置来源由调用方给，测试可以注入桩件 */
export function registerRunCode(
	pi: ExtensionAPI,
	host: HostCodemodeModule,
	options: { settings?: () => Record<string, unknown>; approve?: typeof approvePtcScript } = {},
): void {
	const settingsOf = options.settings ?? readSettings;
	const approve = options.approve ?? approvePtcScript;
	const definition = buildRunCodeDefinition(host, {
		getMode: () => readPtcSettings(settingsOf()).mode ?? "on",
		getInlineBudget: () => readPtcSettings(settingsOf()).inlineBudget,
	});

	pi.registerTool({
		...definition,
		parameters: RUN_CODE_SCHEMA,
		async execute(toolCallId: string, params: any, signal: any, onUpdate: any, ctx: any) {
			const reason = ptcReasonLedger().record(toolCallId, params?.description);
			if (reason === undefined) {
				return {
					content: [{
						type: "text",
						text: "run_code 需要一句 description（这段程序做什么、为什么）。空理由会让审核链看不出这条调用的来由，所以这次没有执行；补上理由再发一次。",
					}],
					details: undefined,
				};
			}
			const code = typeof params?.code === "string" ? params.code : "";
			// 先登记、再广播、再审核：内层调用到达审核链时，理由已经在表里了
			pi.events.emit("ptc:reason", {
				toolCallId,
				reason,
				codeDigest: ptcCodeDigest(code),
				codeChars: code.length,
			});

			// 事前审核：过了才执行；没过整段不执行，返回编译失败式的错误
			const outcome = await approve({
				pi,
				ctx,
				input: { script: code, reason, tools: registeredTools(pi) },
				signal,
			});
			if (!outcome.approved) {
				return {
					content: [{
						type: "text",
						text: ptcRejectedText(outcome.review?.reason ?? "未获批准", outcome.comment),
					}],
					details: undefined,
				};
			}

			beginPtcScope(toolCallId, ptcScriptDigest(code));
			try {
				return await definition.execute(toolCallId, { code }, signal, onUpdate, ctx);
			} finally {
				endPtcScope(toolCallId);
			}
		},
	} as never);

	pi.registerCommand("ptc-reasons", {
		description: "查看 run_code 最近登记的执行理由（审核链看到的那一份）",
		handler: async (_args, ctx) => {
			const entries = ptcReasonLedger().recent(10);
			ctx.ui.notify(
				entries.length > 0
					? entries.map((entry) => `${entry.callId}\n  ${entry.reason}`).join("\n")
					: "登记表里还没有理由（本会话还没有 run_code 调用）",
				"info",
			);
		},
	});
}
