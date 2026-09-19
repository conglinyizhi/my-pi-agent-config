import assert from "node:assert/strict";
import { createServer } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { grantPairingCode, listPendingPairs, openAllowGUI } from "./hub-admin.ts";

const dir = mkdtempSync(join(tmpdir(), "pi-hub-admin-"));
after(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("hub-admin", () => {
	it("grant 走 admin 角色并把码交给 hub", async () => {
		const sock = join(dir, "hub.sock");
		const seen: string[] = [];
		const server = createServer(conn => {
			let buf = "";
			conn.on("data", chunk => {
				buf += chunk.toString("utf8");
				let nl: number;
				while ((nl = buf.indexOf("\n")) >= 0) {
					const line = buf.slice(0, nl);
					buf = buf.slice(nl + 1);
					if (!line.trim()) continue;
					const msg = JSON.parse(line) as { type?: string; role?: string; code?: string };
					seen.push(`${msg.type}:${msg.role ?? msg.code ?? ""}`);
					if (msg.type === "hello") {
						conn.write(`${JSON.stringify({ v: 1, type: "hello-ok", role: "admin" })}\n`);
					}
					if (msg.type === "grant") {
						conn.write(`${JSON.stringify({
							v: 1,
							type: "grant-ok",
							principal: { channel: "im", userId: "u1", displayName: "林" },
						})}\n`);
					}
				}
			});
		});
		await new Promise<void>(resolve => server.listen(sock, resolve));
		try {
			const p = await grantPairingCode("  `PIHUB-deadbeefdeadbeef`  ", sock);
			assert.equal(p.userId, "u1");
			assert.ok(seen.includes("hello:admin"));
			assert.ok(seen.some(s => s.startsWith("grant:PIHUB-")));
		} finally {
			await new Promise<void>(resolve => server.close(() => resolve()));
		}
	});

	it("pairs 列出 pending", async () => {
		const sock = join(dir, "pairs.sock");
		const server = createServer(conn => {
			let buf = "";
			conn.on("data", chunk => {
				buf += chunk.toString("utf8");
				let nl: number;
				while ((nl = buf.indexOf("\n")) >= 0) {
					const line = buf.slice(0, nl);
					buf = buf.slice(nl + 1);
					if (!line.trim()) continue;
					const msg = JSON.parse(line) as { type?: string };
					if (msg.type === "hello") {
						conn.write(`${JSON.stringify({ v: 1, type: "hello-ok" })}\n`);
					}
					if (msg.type === "pairs") {
						conn.write(`${JSON.stringify({
							v: 1,
							type: "pairs-ok",
							pairs: [{ code: "PIHUB-aa", channel: "im", userId: "u2", expiresAt: "t" }],
						})}\n`);
					}
				}
			});
		});
		await new Promise<void>(resolve => server.listen(sock, resolve));
		try {
			const pairs = await listPendingPairs(sock);
			assert.equal(pairs[0]?.userId, "u2");
		} finally {
			await new Promise<void>(resolve => server.close(() => resolve()));
		}
	});

	it("open-allow 只请 hub 开窗", async () => {
		const sock = join(dir, "open.sock");
		const server = createServer(conn => {
			let buf = "";
			conn.on("data", chunk => {
				buf += chunk.toString("utf8");
				let nl: number;
				while ((nl = buf.indexOf("\n")) >= 0) {
					const line = buf.slice(0, nl);
					buf = buf.slice(nl + 1);
					if (!line.trim()) continue;
					const msg = JSON.parse(line) as { type?: string };
					if (msg.type === "hello") {
						conn.write(`${JSON.stringify({ v: 1, type: "hello-ok" })}\n`);
					}
					if (msg.type === "open-allow") {
						conn.write(`${JSON.stringify({ v: 1, type: "open-allow-ok" })}\n`);
					}
				}
			});
		});
		await new Promise<void>(resolve => server.listen(sock, resolve));
		try {
			await openAllowGUI(sock);
		} finally {
			await new Promise<void>(resolve => server.close(() => resolve()));
		}
	});
});
