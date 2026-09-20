// ask_question 走 hub 的冒烟测试：
//   node --test extensions/ask-question/smoke.test.ts
//
// 不桩 askHubQuestion，而是把一个假 hub 挂在真实 socket 上，让扩展按真实路径去连 ——
// 这样「没适配器在线」「用户取消」「没人答就回退 TUI」三条分支都是真跑出来的。
//
// 注意：必须改 PI_HUB_SOCKET。本机 ~/.pi/agent/run/hub.sock 是真 hub，
// 忘了改的话测试会往真实 hub 里塞一条提问，然后挂在那儿等回答。

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

const dir = mkdtempSync(join(tmpdir(), "ask-question-hub-"));
const savedSocket = process.env.PI_HUB_SOCKET;
after(() => {
	rmSync(dir, { recursive: true, force: true });
	if (savedSocket === undefined) delete process.env.PI_HUB_SOCKET;
	else process.env.PI_HUB_SOCKET = savedSocket;
});

type ToolDef = { name: string; execute: (...args: unknown[]) => Promise<unknown> };
const tools = new Map<string, ToolDef>();
const { default: register } = await import("./index.ts");
register({ registerTool: (def: ToolDef) => tools.set(def.name, def) } as never);
const askQuestion = tools.get("ask_question");
assert.ok(askQuestion, "没注册上 ask_question");

const PARAMS = {
	questions: [
		{
			id: "q1",
			label: "隔离方式",
			question_text: "这次改造会动共享脚本，怎么隔离工作区？",
			options: [
				{ value: "worktree", label: "用 git worktree 隔离" },
				{ value: "branch", label: "直接开分支" },
			],
			allowOther: true,
		},
	],
};

/** tui：{ answer } = 用户在本地作答；{ hang: true } = 本地界面一直开着（真实 TUI 的常态） */
function fakeCtx(tui: { answer: unknown } | { hang: true }) {
	const notices: string[] = [];
	let customCalls = 0;
	const ctx = {
		mode: "tui",
		hasUI: true,
		cwd: "/home/dev/project",
		sessionManager: { getSessionId: () => "sess-1" },
		ui: {
			notify: (message: string) => notices.push(message),
			custom: () => {
				customCalls += 1;
				// 本地界面开着不动就一直挂着：两条路并行时，hub 先答也不会被它抢走
				return "hang" in tui ? new Promise(() => {}) : Promise.resolve(tui.answer);
			},
		},
	};
	return { ctx, notices, customCalls: () => customCalls };
}

/** 假 hub：按脚本回话，received 收集收到的每一行 */
async function fakeHub(name: string, reply: (msg: { type?: string; requestId?: string }, conn: { write(c: string): void }) => void) {
	const sock = join(dir, name);
	const received: { type?: string }[] = [];
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
				received.push(msg);
				reply(msg, conn);
			}
		});
	});
	await new Promise<void>(resolve => server.listen(sock, resolve));
	return { sock, received, close: () => new Promise<void>(resolve => server.close(() => resolve())) };
}

const hello = (msg: { type?: string }, conn: { write(c: string): void }) => {
	if (msg.type === "hello") conn.write(`${JSON.stringify({ v: 1, type: "hello-ok", role: "pi" })}\n`);
};

async function waitFor(pred: () => boolean, ms = 500): Promise<boolean> {
	const deadline = Date.now() + ms;
	while (Date.now() < deadline) {
		if (pred()) return true;
		await new Promise((r) => setTimeout(r, 10));
	}
	return pred();
}

async function withSocket<T>(sock: string, fn: () => Promise<T>): Promise<T> {
	process.env.PI_HUB_SOCKET = sock;
	try {
		return await fn();
	} finally {
		if (savedSocket === undefined) delete process.env.PI_HUB_SOCKET;
		else process.env.PI_HUB_SOCKET = savedSocket;
	}
}

const detailsOf = (result: unknown) => (result as { details: { answers: unknown[]; cancelled: boolean } }).details;
const textOf = (result: unknown) => (result as { content: { text: string }[] }).content[0].text;

describe("ask_question 走 hub", () => {
	it("适配器作答：用飞书那边的答案，本地界面同时开着但结果取自 hub", async () => {
		const hub = await fakeHub("answered.sock", (msg, conn) => {
			hello(msg, conn);
			if (msg.type !== "ask") return;
			conn.write(`${JSON.stringify({ v: 1, type: "ask-ok", requestId: msg.requestId, adapters: 1 })}\n`);
			conn.write(
				`${JSON.stringify({
					v: 1,
					type: "settled",
					requestId: msg.requestId,
					action: "allow",
					by: "adapter",
					answers: [{ id: "q1", value: "worktree", label: "用 git worktree 隔离" }],
				})}\n`,
			);
		});
		try {
			const { ctx, customCalls } = fakeCtx({ hang: true });
			const result = await withSocket(hub.sock, () => askQuestion.execute("c1", PARAMS, undefined, undefined, ctx));
			const details = detailsOf(result) as { answers: { value: string; index?: number; wasCustom: boolean }[]; cancelled: boolean };
			assert.equal(details.cancelled, false);
			assert.equal(details.answers.length, 1);
			assert.equal(details.answers[0].value, "worktree");
			assert.equal(details.answers[0].index, 1, "命中原选项要带 1 起的序号，结果文案里要用");
			assert.equal(details.answers[0].wasCustom, false);
			assert.match(textOf(result), /user selected: 1\. 用 git worktree 隔离/);
			// 设计是两条路都开着：本地界面照常起，hub 先答就把它收掉。
			// 只走 hub 的话，用户坐在终端前会被一个看不见的提问阻塞住
		} finally {
			await hub.close();
		}
	});

	it("用户自由输入：wasCustom 为真，不带序号", async () => {
		const hub = await fakeHub("custom.sock", (msg, conn) => {
			hello(msg, conn);
			if (msg.type !== "ask") return;
			conn.write(`${JSON.stringify({ v: 1, type: "ask-ok", requestId: msg.requestId, adapters: 1 })}\n`);
			conn.write(
				`${JSON.stringify({
					v: 1,
					type: "settled",
					requestId: msg.requestId,
					action: "allow",
					answers: [{ id: "q1", value: "先复制一份再改", label: "先复制一份再改", wasCustom: true }],
				})}\n`,
			);
		});
		try {
			const { ctx } = fakeCtx({ hang: true });
			const result = await withSocket(hub.sock, () => askQuestion.execute("c2", PARAMS, undefined, undefined, ctx));
			const details = detailsOf(result) as { answers: { index?: number; wasCustom: boolean; label: string }[] };
			assert.equal(details.answers[0].wasCustom, true);
			assert.equal(details.answers[0].index, undefined);
			assert.match(textOf(result), /user wrote: 先复制一份再改/);
		} finally {
			await hub.close();
		}
	});

	it("用户在飞书取消：算 cancelled，不回退 TUI 再问一遍", async () => {
		const hub = await fakeHub("denied.sock", (msg, conn) => {
			hello(msg, conn);
			if (msg.type !== "ask") return;
			conn.write(`${JSON.stringify({ v: 1, type: "ask-ok", requestId: msg.requestId, adapters: 1 })}\n`);
			conn.write(`${JSON.stringify({ v: 1, type: "settled", requestId: msg.requestId, action: "deny", by: "adapter" })}\n`);
		});
		try {
			const { ctx, customCalls } = fakeCtx({ hang: true });
			const result = await withSocket(hub.sock, () => askQuestion.execute("c3", PARAMS, undefined, undefined, ctx));
			assert.equal(detailsOf(result).cancelled, true);
			assert.match(textOf(result), /cancelled/);
		} finally {
			await hub.close();
		}
	});

	it("没有适配器在线：等本地 TUI 作答", async () => {
		const tuiResult = {
			questions: [],
			answers: [{ id: "q1", value: "branch", label: "直接开分支", wasCustom: false, index: 2 }],
			cancelled: false,
		};
		const hub = await fakeHub("no-adapter.sock", (msg, conn) => {
			hello(msg, conn);
			if (msg.type !== "ask") return;
			conn.write(`${JSON.stringify({ v: 1, type: "ask-ok", requestId: msg.requestId, adapters: 0 })}\n`);
		});
		try {
			const { ctx, customCalls } = fakeCtx({ answer: tuiResult });
			const result = await withSocket(hub.sock, () => askQuestion.execute("c4", PARAMS, undefined, undefined, ctx));
			assert.equal(customCalls(), 1, "本地界面要开着");
			assert.equal((detailsOf(result).answers[0] as { value: string }).value, "branch");
		} finally {
			await hub.close();
		}
	});

	it("本地先答：撤回 hub 那条，免得飞书上的卡一直挂着", async () => {
		// hub 一直不结算（适配器在，但没人理），本地答完就该把它撤掉
		const hub = await fakeHub("tui-wins.sock", (msg, conn) => {
			hello(msg, conn);
			if (msg.type === "ask") {
				conn.write(`${JSON.stringify({ v: 1, type: "ask-ok", requestId: msg.requestId, adapters: 1 })}\n`);
			}
		});
		try {
			const { ctx } = fakeCtx({
				answer: {
					questions: [],
					answers: [{ id: "q1", value: "branch", label: "直接开分支", wasCustom: false, index: 2 }],
					cancelled: false,
				},
			});
			const result = await withSocket(hub.sock, () => askQuestion.execute("c6", PARAMS, undefined, undefined, ctx));
			assert.equal((detailsOf(result).answers[0] as { value: string }).value, "branch");
			assert.ok(
				await waitFor(() => hub.received.some((m) => m.type === "abort")),
				"本地先答就该发 abort，否则 hub 里那条会挂到超时、卡也不会变成已取消",
			);
		} finally {
			await hub.close();
		}
	});

	it("hub 根本连不上：回退本地 TUI", async () => {
		const { ctx, customCalls } = fakeCtx({
			answer: {
				questions: [],
				answers: [{ id: "q1", value: "worktree", label: "用 git worktree 隔离", wasCustom: false, index: 1 }],
				cancelled: false,
			},
		});
		const result = await withSocket(join(dir, "missing.sock"), () =>
			askQuestion.execute("c5", PARAMS, undefined, undefined, ctx),
		);
		assert.equal(customCalls(), 1);
		assert.equal((detailsOf(result).answers[0] as { value: string }).value, "worktree");
	});
});
