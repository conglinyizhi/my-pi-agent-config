import assert from "node:assert/strict";
import { createServer } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { createHubThenLocalChannel } from "./hub-channel.ts";

const dir = mkdtempSync(join(tmpdir(), "pi-hub-channel-"));
after(() => {
	rmSync(dir, { recursive: true, force: true });
});

function ctx() {
	return { sessionManager: { getSessionId: () => "sess-1" }, hasUI: false, ui: undefined } as never;
}

const request = {
	kind: "audit" as const,
	command: "sudo ls",
	reason: "sudo",
};

describe("createHubThenLocalChannel", () => {
	it("hub 在线时走 socket 决断，不回退本地", async () => {
		const sock = join(dir, "hub.sock");
		const server = createServer(conn => {
			let buf = "";
			conn.on("data", chunk => {
				buf += chunk.toString("utf8");
				let nl: number;
				while ((nl = buf.indexOf("\n")) >= 0) {
					const line = buf.slice(0, nl);
					buf = buf.slice(nl + 1);
					if (!line.trim()) continue;
					const msg = JSON.parse(line) as { type?: string; requestId?: string };
					if (msg.type === "hello") {
						conn.write(`${JSON.stringify({ v: 1, type: "hello-ok", role: "pi" })}\n`);
					}
					if (msg.type === "ask") {
						conn.write(`${JSON.stringify({ v: 1, type: "ask-ok", requestId: msg.requestId })}\n`);
						conn.write(`${JSON.stringify({
							v: 1,
							type: "settled",
							requestId: msg.requestId,
							action: "allow",
							comment: "hub",
						})}\n`);
					}
				}
			});
		});
		await new Promise<void>(resolve => server.listen(sock, resolve));
		try {
			const channel = createHubThenLocalChannel({ socketPath: sock });
			const decision = await channel(request, ctx());
			assert.equal(decision.action, "allow");
			assert.equal(decision.comment, "hub");
		} finally {
			await new Promise<void>(resolve => server.close(() => resolve()));
		}
	});

	it("hub 不在时回退本地通道，不弹真窗口", async () => {
		let localHits = 0;
		const channel = createHubThenLocalChannel({
			socketPath: join(dir, "missing.sock"),
			local: async () => {
				localHits += 1;
				return { action: "deny" };
			},
		});
		const decision = await channel(request, ctx());
		assert.equal(decision.action, "deny");
		assert.equal(localHits, 1);
	});
});
