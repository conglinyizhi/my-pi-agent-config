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
					if (msg.action === "allow" || msg.action === "deny") {
						finish(() => resolve(parseGuiDecision({
							action: msg.action,
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
