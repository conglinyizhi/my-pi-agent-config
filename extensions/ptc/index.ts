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
import { scanScript } from "../../lib/ptc-analyze.ts";
import { makeProgressContext } from "../../lib/ptc-progress.ts";
import { runDryRun } from "../../lib/ptc-dryrun.ts";
import { yoloEnabled } from "../sandbox-permissions/yolo.ts";
import {
	approvePtcScript,
	beginPtcScope,
	endPtcScope,
	ptcRejectedText,
	ptcScopeCoversTool,
	ptcScopeForNestedCall,
	ptcScriptDigest,
	recordNestedCall,
	recordPtcExecution,
	summarizeArgs,
	type PtcToolInfo,
} from "../../lib/ptc-audit.ts";
import { RUN_CODE_SCHEMA, buildRunCodeDefinition, loadHostCodemode, type HostCodemodeModule } from "./host.ts";
import { approvePtcScriptInWorker } from "../../lib/worker-ptc-approval.ts";

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

/** worker 进程的标志：与 subagent-bash-guard 用同一个环境变量 */
function isWorkerProcess(): boolean {
	return process.env.PI_SUBAGENT === "1";
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

	// worker 里没有窗口、没有人可以问：审批换成「先预审，判不出安全再写 capability 请求」
	// （lib/worker-ptc-approval.ts）。主 agent 照旧走人工闸门那条。
	registerRunCode(pi, host, isWorkerProcess() ? { approve: approvePtcScriptInWorker } : undefined);
}

/**
 * 内层调用的归集（P0 观测）：脚本里派发的每次调用都带 parentToolCallId，
 * 按它归到所属脚本上。越界的调用**不拦**——它只是不享受这次的免问，
 * 照旧走自己那条审批链；这里只把"实际发生了什么"记下来。
 */
function watchNestedCalls(pi: ExtensionAPI): void {
	pi.on("tool_call", (event) => {
		const detail = event as { parentToolCallId?: string; toolName?: string; input?: unknown };
		if (!detail.parentToolCallId) return;
		const scope = ptcScopeForNestedCall(detail.parentToolCallId);
		if (scope === undefined) return;
		const toolName = detail.toolName ?? "";
		recordNestedCall(scope.callId, {
			tool: toolName,
			args: summarizeArgs(detail.input),
			covered: ptcScopeCoversTool(scope, toolName),
		});
	});
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

	watchNestedCalls(pi);

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

			// 字面量扫描：送审材料用它收窄工具面，批准范围用它决定内层哪些调用免问
			const scan = await scanScript(code);

			// 干跑：换掉 ctx 把控制流走一遍（不执行任何工具、不花 token）。
			// 拿到的是"确定会做什么"，与真跑归集对账后进审计；这一步在批准之前，
			// 所以审批卡上能看到它。
			const dry = await runDryRun({
				execute: definition.execute,
				toolCallId,
				code,
				ctx,
			});

			// 事前审核：过了才执行；没过整段不执行，返回编译失败式的错误。
			// yolo 与 bash-guard 保持一致：跳过整条审批链。
			if (!yoloEnabled()) {
				const outcome = await approve({
					pi,
					ctx,
					// cwd/home 只喂折叠芯片的显示路径（$PWD / ~），进不了送审材料
					input: {
						script: code,
						reason,
						tools: registeredTools(pi),
						scan,
						dry,
						cwd: ctx.cwd,
						home: process.env.HOME,
					},
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
			}

			const digest = ptcScriptDigest(code);
			beginPtcScope(toolCallId, digest, {
				tools: scan.tools,
				// 有看不清的地方就退回逐条审批：批准范围只敢覆盖"写出来的调用"
				opaque: scan.opaque.length > 0 || scan.parseError !== undefined,
			});
			try {
				// 内层调用的流式进度（subagent 的 fleet 快照等）在 codemode 那层会被丢掉，
			// 这里包一层 ctx 补回来，转成 run_code 自己的部分结果给界面看
			const progressCtx = makeProgressContext(ctx, (line: string) => {
				onUpdate?.({ content: [{ type: "text", text: line }], details: undefined });
			});
			return await definition.execute(toolCallId, { code }, signal, onUpdate, progressCtx);
			} finally {
				endPtcScope(toolCallId);
				// 跑完把"实际派发了哪些调用"写进审计（内存滚动，不落盘），
				// 顺带把干跑预演与真跑事实对一遍账
				recordPtcExecution(pi, { callId: toolCallId, digest, reason, dry });
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
