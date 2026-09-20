// lib/hub-channel.ts — 连本机审批 hub；连不上就回退 GUI→TUI
//
// 协议：JSON 行，Unix socket ~/.pi/agent/run/hub.sock
// hub 在线时本机 GUI 由 hub 拉起（A.1 扇出），这里不再自己弹窗。

import { createConnection } from "node:net";
import { accessSync, constants } from "node:fs";
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
} from "./approval-channel.ts";

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
	answers?: HubAnswer[];
	adapters?: number;
	by?: string;
	message?: string;
};

export function hubSocketPath(): string {
	return process.env.PI_HUB_SOCKET?.trim() || DEFAULT_HUB_SOCKET;
}

export function createHubThenLocalChannel(opts: {
	socketPath?: string;
	/** 测试注入；生产默认 GUI→TUI。不要在单测里走真窗口。 */
	local?: ApprovalChannel;
} = {}): ApprovalChannel {
	const socketPath = opts.socketPath ?? hubSocketPath();
	const local = opts.local ?? createGuiTuiApprovalChannel();
	return async (request, ctx) => {
		try {
			return await askHub(socketPath, request, ctx);
		} catch {
			return local(request, ctx);
		}
	};
}

async function askHub(socketPath: string, request: ApprovalRequest, ctx: ExtensionContext): Promise<ApprovalDecision> {
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
				if (msg.type === "settled" && msg.requestId === requestId) {
					// 取局部常量：闭包里 TS 认不出 msg.action 的收窄（msg 是可重新赋值的变量）
					const action = msg.action;
					if (action === "allow" || action === "deny") {
						finish(() => resolve(parseGuiDecision({
							action,
							comment: msg.comment,
							pathActions: msg.pathActions,
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
 */
export type HubQuestionOutcome =
	| { status: "answered"; answers: HubAnswer[]; by: string }
	| { status: "denied"; comment: string; by: string }
	| { status: "unavailable"; reason: string };

export interface HubQuestionOptions {
	socketPath?: string;
	signal?: AbortSignal;
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
		return { status: "unavailable", reason: `连不上 hub：${err instanceof Error ? err.message : String(err)}` };
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
			finish({ status: "unavailable", reason: "提问被中止" });
		};

		if (opts.signal?.aborted) {
			onAbort();
			return;
		}
		opts.signal?.addEventListener("abort", onAbort, { once: true });

		conn.on("error", (err) => finish({ status: "unavailable", reason: `hub 连接出错：${err.message}` }));
		conn.on("close", () => finish({ status: "unavailable", reason: "hub 关掉了连接" }));

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
					finish({ status: "unavailable", reason: msg.message || "hub error" });
					return;
				}
				if (msg.type === "ask-ok" && msg.requestId === requestId) {
					if ((msg.adapters ?? 0) === 0) {
						writeLine(conn, { v: PROTOCOL_V, type: "abort", requestId });
						finish({ status: "unavailable", reason: "没有适配器在线" });
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
					finish({ status: "unavailable", reason: "hub 结算了但没有动作" });
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
			payload: { questions },
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

function writeLine(conn: { write(data: string): void }, msg: unknown): void {
	conn.write(`${JSON.stringify(msg)}\n`);
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
