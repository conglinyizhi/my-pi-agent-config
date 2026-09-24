// lib/hub-channel.ts — 连本机审批 hub；连不上就回退 GUI→TUI
//
// 协议：JSON 行，Unix socket ~/.pi/agent/run/hub.sock
// hub 在线时本机 GUI 由 hub 拉起（A.1 扇出），这里不再自己弹窗。但 hub 回了
// ask-ok adapters:0 而本机又没有它拉得起的窗时，这条 ask 谁都答不了：直接撤回
// 走本地通道，不让它挂满 1 小时 TTL。

import { createConnection } from "node:net";
import { accessSync, constants, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	createGuiTuiApprovalChannel,
	parseGuiDecision,
	toGuiPayload,
	type ApprovalChannel,
	type ApprovalDecision,
	type ApprovalRequest,
	type ApprovalRunGui,
	type ApprovalSelect,
} from "./approval-channel.ts";
import { guiBinaryCandidates, type GuiDiagnosis, type GuiFallbackReason } from "./gui-diagnosis.ts";

export const DEFAULT_HUB_SOCKET = join(homedir(), ".pi", "agent", "run", "hub.sock");
const CONNECT_MS = 400;
const PROTOCOL_V = 1;

type HubMsg = {
	v?: number;
	type?: string;
	id?: string;
	requestId?: string;
	action?: "allow" | "deny";
	comment?: string;
	pathActions?: ApprovalDecision["pathActions"];
	// 闸门窗里编辑后的执行范围；旧 GUI 不写，hub 也就不带这个字段
	writePaths?: string[];
	answers?: HubAnswer[];
	adapters?: number;
	by?: string;
	message?: string;
};

export function hubSocketPath(): string {
	return process.env.PI_HUB_SOCKET?.trim() || DEFAULT_HUB_SOCKET;
}

/** hub 在线，但本机窗拉不起来又没有适配器：这条 ask 没人能答 */
class HubNoChannelError extends Error {
	constructor() {
		super("hub 在线，但本机 GUI 与 IM 适配器都不在");
		this.name = "HubNoChannelError";
	}
}

/**
 * hub 能不能拉起本机闸门窗。条件与 hub 那边的 findGUIBinary 对齐：只看候选位
 * 有没有这个文件。pi 这边判得比 hub 严（比如再要求可执行），就会在 hub 其实
 * 拉得起窗的时候提前放弃，用户白答一次终端弹窗。
 */
export function hasLocalGui(): boolean {
	return guiBinaryCandidates().some(p => {
		try {
			return statSync(p).isFile();
		} catch {
			return false;
		}
	});
}

export interface HubThenLocalOptions {
	socketPath?: string;
	/** 测试注入；生产默认 GUI→TUI。不要在单测里走真窗口。 */
	local?: ApprovalChannel;
	/** 本机有没有 hub 能拉起的闸门窗；单测注入，默认看候选位 */
	hasLocalGui?: () => boolean;
	/** 回退本地通道时透传的 GUI / TUI / 诊断注入，让单测既不弹窗也不真查系统 */
	runGui?: ApprovalRunGui;
	selectApproval?: ApprovalSelect;
	diagnosis?: GuiDiagnosis;
}

export function createHubThenLocalChannel(opts: HubThenLocalOptions = {}): ApprovalChannel {
	const socketPath = opts.socketPath ?? hubSocketPath();
	const probeLocalGui = opts.hasLocalGui ?? hasLocalGui;
	return async (request, ctx) => {
		try {
			return await askHub(socketPath, request, ctx, probeLocalGui);
		} catch (err) {
			// 提前撤单与连不上 hub 都要回退本地，差别只在给用户的解释文本
			const reason: GuiFallbackReason = err instanceof HubNoChannelError ? "hub-no-channel" : "hub-unreachable";
			if (opts.local) return opts.local(request, ctx);
			return createGuiTuiApprovalChannel({
				runGui: opts.runGui,
				selectApproval: opts.selectApproval,
				diagnosis: opts.diagnosis,
				upstreamReason: reason,
			})(request, ctx);
		}
	};
}

async function askHub(
	socketPath: string,
	request: ApprovalRequest,
	ctx: ExtensionContext,
	probeLocalGui: () => boolean,
): Promise<ApprovalDecision> {
	const conn = await connectUnix(socketPath, CONNECT_MS);
	const sessionId = ctx.sessionManager?.getSessionId?.() ?? "";
	const requestId = `ask-${randomUUID()}`;
	const timeoutMs = request.signal ? remainingMs(request.signal) : 3_600_000;

	return new Promise<ApprovalDecision>((resolve, reject) => {
		let buf = "";
		let settled = false;
		const finish = (fn: () => void) => {
			if (settled) return;
			settled = true;
			conn.destroy();
			fn();
		};

		const onAbort = () => {
			writeLine(conn, { v: PROTOCOL_V, type: "abort", requestId });
			finish(() => reject(new Error("aborted")));
		};
		if (request.signal?.aborted) {
			onAbort();
			return;
		}
		request.signal?.addEventListener("abort", onAbort, { once: true });

		conn.on("data", chunk => {
			buf += chunk.toString("utf8");
			let nl: number;
			while ((nl = buf.indexOf("\n")) >= 0) {
				const line = buf.slice(0, nl);
				buf = buf.slice(nl + 1);
				if (!line.trim()) continue;
				let msg: HubMsg;
				try {
					msg = JSON.parse(line) as HubMsg;
				} catch {
					continue;
				}
				if (msg.type === "error") {
					finish(() => reject(new Error(msg.message || "hub error")));
					return;
				}
				if (msg.type === "ask-ok" && msg.requestId === requestId) {
					// hub 在跑、但本机拉不起窗又没有适配器接单：这条 ask 只能挂到 1 小时 TTL。
					// 与其让用户以为卡住，不如现在就把请求撤回来走本地通道。
					// 撤单是冲刷完才结算的，同一块里紧跟的 settled 仍优先——已经有人答了就采信
					if ((msg.adapters ?? 0) === 0 && !probeLocalGui()) {
						abortThenFinish(conn, requestId, () => finish(() => reject(new HubNoChannelError())));
					}
					continue;
				}
				if (msg.type === "settled" && msg.requestId === requestId) {
					// 取局部常量：闭包里 TS 认不出 msg.action 的收窄（msg 是可重新赋值的变量）
					const action = msg.action;
					if (action === "allow" || action === "deny") {
						finish(() => resolve(parseGuiDecision({
							action,
							comment: msg.comment,
							pathActions: msg.pathActions,
							// 编辑后的执行范围要跟着 settled 一起过 hub：漏在这里，
							// 用户改了申报范围也白改，pi 那边还是按申请值算护栅
							writePaths: msg.writePaths,
						})));
					} else {
						finish(() => reject(new Error("hub settled without action")));
					}
					return;
				}
			}
		});
		conn.on("error", err => finish(() => reject(err)));
		conn.on("close", () => finish(() => reject(new Error("hub closed"))));

		writeLine(conn, { v: PROTOCOL_V, type: "hello", role: "pi" });
		writeLine(conn, {
			v: PROTOCOL_V,
			type: "ask",
			requestId,
			sessionId,
			kind: request.kind,
			timeoutMs,
			payload: toGuiPayload(request),
		});
	});
}

/** 适配器带回的一条应答。样式由发起方给，用户填了什么由适配器填 */
export interface HubAnswer {
	id: string;
	value: string;
	label: string;
	wasCustom?: boolean;
}

/**
 * 提问走 hub 的三种结局。
 *
 * 「没人能答」必须能和「用户拒绝」分开：前者要回退本地 TUI，后者是用户的明确答复，
 * 回退反而会把同一个问题再问一遍。
 *
 * unavailable 带 code：「连不上 hub」与「hub 在、但没适配器在线」要给用户两份
 * 不同的修法，不能靠解析 reason 的中文措辞去猜。
 */
export type HubUnavailableCode = "connect" | "no-adapter" | "aborted" | "hub";

export type HubQuestionOutcome =
	| { status: "answered"; answers: HubAnswer[]; by: string }
	| { status: "denied"; comment: string; by: string }
	| { status: "unavailable"; reason: string; code: HubUnavailableCode };

export interface HubQuestionOptions {
	socketPath?: string;
	signal?: AbortSignal;
	/** 立刻推卡，不等适配器的 card-delay（详见 ApprovalRequestBase.urgent） */
	urgent?: boolean;
}

/**
 * 把结构化提问扇出给 hub，等适配器（IM 卡）作答。
 *
 * 与审批不同的地方：审批只关心 allow/deny，这里要把整条 settled 里的 answers 带回来。
 * 没有适配器在线时主动 abort 并报 unavailable —— 不撤的话这条 ask 会挂到超时，
 * 而调用方那边什么也看不到。
 */
export async function askHubQuestion(
	questions: unknown,
	ctx: ExtensionContext,
	opts: HubQuestionOptions = {},
): Promise<HubQuestionOutcome> {
	const socketPath = opts.socketPath ?? hubSocketPath();
	const requestId = `ask-${randomUUID()}`;
	const timeoutMs = opts.signal ? remainingMs(opts.signal) : 3_600_000;

	let conn: Awaited<ReturnType<typeof connectUnix>>;
	try {
		conn = await connectUnix(socketPath, CONNECT_MS);
	} catch (err) {
		return { status: "unavailable", reason: `连不上 hub：${err instanceof Error ? err.message : String(err)}`, code: "connect" };
	}

	return new Promise<HubQuestionOutcome>((resolve) => {
		let buf = "";
		let done = false;
		const finish = (outcome: HubQuestionOutcome) => {
			if (done) return;
			done = true;
			opts.signal?.removeEventListener("abort", onAbort);
			// 用 end() 而不是 destroy()：abort 那一行先写完再 FIN。
			// destroy() 会直接丢链接，还没冲刷出去的 abort 就没了，hub 里那条 ask
			// 只能挂到超时——而这正是撤回要避免的事
			conn.end();
			resolve(outcome);
		};
		const onAbort = () => {
			writeLine(conn, { v: PROTOCOL_V, type: "abort", requestId });
			finish({ status: "unavailable", reason: "提问被中止", code: "aborted" });
		};

		if (opts.signal?.aborted) {
			onAbort();
			return;
		}
		opts.signal?.addEventListener("abort", onAbort, { once: true });

		conn.on("error", (err) => finish({ status: "unavailable", reason: `hub 连接出错：${err.message}`, code: "connect" }));
		conn.on("close", () => finish({ status: "unavailable", reason: "hub 关掉了连接", code: "connect" }));

		conn.on("data", (chunk) => {
			buf += chunk.toString("utf8");
			let nl: number;
			while ((nl = buf.indexOf("\n")) >= 0) {
				const line = buf.slice(0, nl);
				buf = buf.slice(nl + 1);
				if (!line.trim()) continue;
				let msg: HubMsg;
				try {
					msg = JSON.parse(line) as HubMsg;
				} catch {
					continue;
				}
				if (msg.type === "error") {
					finish({ status: "unavailable", reason: msg.message || "hub error", code: "hub" });
					return;
				}
				if (msg.type === "ask-ok" && msg.requestId === requestId) {
					if ((msg.adapters ?? 0) === 0) {
						writeLine(conn, { v: PROTOCOL_V, type: "abort", requestId });
						finish({ status: "unavailable", reason: "没有适配器在线", code: "no-adapter" });
					}
					continue;
				}
				if (msg.type === "settled" && msg.requestId === requestId) {
					if (msg.action === "allow") {
						finish({ status: "answered", answers: msg.answers ?? [], by: msg.by ?? "" });
						return;
					}
					if (msg.action === "deny") {
						finish({ status: "denied", comment: msg.comment ?? "", by: msg.by ?? "" });
						return;
					}
					finish({ status: "unavailable", reason: "hub 结算了但没有动作", code: "hub" });
				}
			}
		});

		writeLine(conn, { v: PROTOCOL_V, type: "hello", role: "pi" });
		writeLine(conn, {
			v: PROTOCOL_V,
			type: "ask",
			requestId,
			sessionId: ctx.sessionManager?.getSessionId?.() ?? "",
			kind: "question",
			payload: { questions, ...(opts.urgent ? { urgent: true } : {}) },
			// 提问形状与本机闸门窗对不上：不声明的话 hub 会拉起一个
			// 空白的「危险命令审计」窗，用户看不懂也没法操作
			noLocalGUI: true,
			timeoutMs,
		});
	});
}

function remainingMs(signal: AbortSignal): number {
	const anySignal = signal as AbortSignal & { timeout?: number };
	return typeof anySignal.timeout === "number" ? anySignal.timeout : 3_600_000;
}

/**
 * 发 abort 行，数据真的交给内核之后才结算。直接 destroy() 会把还在缓冲里的
 * abort 丢掉，hub 侧那条 ask 就只剩等超时这一条路——而这正是撤回要避的
 */
function abortThenFinish(
	conn: { write(data: string, cb?: (err?: Error | null) => void): void },
	requestId: string,
	done: () => void,
): void {
	writeLine(conn, { v: PROTOCOL_V, type: "abort", requestId }, () => done());
}

function writeLine(
	conn: { write(data: string, cb?: (err?: Error | null) => void): void },
	msg: unknown,
	cb?: (err?: Error | null) => void,
): void {
	const line = `${JSON.stringify(msg)}\n`;
	if (cb) conn.write(line, cb);
	else conn.write(line);
}

function connectUnix(path: string, timeoutMs: number): Promise<import("node:net").Socket> {
	try {
		accessSync(path, constants.R_OK);
	} catch (err) {
		return Promise.reject(err);
	}
	return new Promise((resolve, reject) => {
		const sock = createConnection({ path });
		const timer = setTimeout(() => {
			sock.destroy();
			reject(new Error("hub connect timeout"));
		}, timeoutMs);
		sock.once("connect", () => {
			clearTimeout(timer);
			resolve(sock);
		});
		sock.once("error", err => {
			clearTimeout(timer);
			reject(err);
		});
	});
}
