// lib/hub-admin.ts — 本机贴码 / 看 pending。只走 admin 角色，连不上就报错。

import { createConnection } from "node:net";
import { accessSync, constants } from "node:fs";
import { hubSocketPath } from "./hub-channel.ts";

const PROTOCOL_V = 1;
const CONNECT_MS = 800;
const READ_MS = 4_000;

export interface HubPairItem {
	code: string;
	channel: string;
	userId: string;
	displayName?: string;
	expiresAt: string;
}

export interface HubListItem {
	requestId: string;
	sessionId?: string;
	kind: string;
	expiresAt: string;
	command?: string;
}

export interface HubPrincipal {
	channel: string;
	userId: string;
	displayName?: string;
}

type HubMsg = {
	v?: number;
	type?: string;
	message?: string;
	principal?: HubPrincipal;
	pairs?: HubPairItem[];
	items?: HubListItem[];
};

export async function grantPairingCode(code: string, socketPath = hubSocketPath()): Promise<HubPrincipal> {
	const trimmed = normalizeCode(code);
	if (!trimmed.startsWith("PIHUB-")) {
		throw new Error("配对码应以 PIHUB- 开头");
	}
	const msg = await adminRpc(socketPath, { v: PROTOCOL_V, type: "grant", code: trimmed }, "grant-ok");
	if (!msg.principal?.channel || !msg.principal.userId) {
		throw new Error("hub 没有返回身份");
	}
	return msg.principal;
}

export async function listPendingPairs(socketPath = hubSocketPath()): Promise<HubPairItem[]> {
	const msg = await adminRpc(socketPath, { v: PROTOCOL_V, type: "pairs" }, "pairs-ok");
	return msg.pairs ?? [];
}

export async function listPendingAsks(socketPath = hubSocketPath()): Promise<HubListItem[]> {
	const msg = await adminRpc(socketPath, { v: PROTOCOL_V, type: "list" }, "list-ok");
	return msg.items ?? [];
}

/** 让 hub 拉起本机许可窗；pi 不自己弹窗。 */
export async function openAllowGUI(socketPath = hubSocketPath()): Promise<void> {
	await adminRpc(socketPath, { v: PROTOCOL_V, type: "open-allow" }, "open-allow-ok");
}

function normalizeCode(code: string): string {
	return code.trim().replace(/^[`"'<\s]+|[`"'>\s]+$/g, "").trim();
}

async function adminRpc(socketPath: string, request: Record<string, unknown>, expect: string): Promise<HubMsg> {
	const conn = await connectUnix(socketPath, CONNECT_MS);
	try {
		writeLine(conn, { v: PROTOCOL_V, type: "hello", role: "admin" });
		const hello = await readMsg(conn, READ_MS);
		if (hello.type !== "hello-ok") {
			throw new Error(hello.message || "hub hello 失败");
		}
		writeLine(conn, request);
		const msg = await readMsg(conn, READ_MS);
		if (msg.type === "error") {
			throw new Error(msg.message || "hub 拒绝");
		}
		if (msg.type !== expect) {
			throw new Error(msg.message || `意外响应 ${msg.type}`);
		}
		return msg;
	} finally {
		conn.destroy();
	}
}

function writeLine(conn: { write(data: string): void }, msg: unknown): void {
	conn.write(`${JSON.stringify(msg)}\n`);
}

function readMsg(conn: import("node:net").Socket, timeoutMs: number): Promise<HubMsg> {
	return new Promise((resolve, reject) => {
		let buf = "";
		const timer = setTimeout(() => {
			cleanup();
			reject(new Error("hub 响应超时"));
		}, timeoutMs);
		const onData = (chunk: Buffer) => {
			buf += chunk.toString("utf8");
			const nl = buf.indexOf("\n");
			if (nl < 0) return;
			const line = buf.slice(0, nl);
			cleanup();
			try {
				resolve(JSON.parse(line) as HubMsg);
			} catch {
				reject(new Error("hub 响应不是 JSON"));
			}
		};
		const onErr = (err: Error) => {
			cleanup();
			reject(err);
		};
		const cleanup = () => {
			clearTimeout(timer);
			conn.off("data", onData);
			conn.off("error", onErr);
		};
		conn.on("data", onData);
		conn.on("error", onErr);
	});
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
			reject(new Error("连不上 hub"));
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
