// lib/review-flow/load.test.ts — 加载作者写的流程（只碰临时目录）
// 跑法：node --test --experimental-strip-types lib/review-flow/load.test.ts

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { createKit } from "./kit.ts";
import { createReviewCache } from "../../extensions/sandbox-permissions/llm-review.ts";
import { listFlowFiles, loadFlowFile, loadFlows, normalizeExport, resetFlowCache } from "./load.ts";
import { preReviewViaFlow } from "./pre-review.ts";
import { runFlow } from "./runner.ts";

const GOOD_FLOW = [
	"export default (kit) => kit.flow({",
	"\tid: \"bash-pre\",",
	"\tdeadlineMs: 5000,",
	"\tnodes: [",
	"\t\tkit.node(\"chatreview\", { id: \"chat\", next: \"judge\" }),",
	"\t\tkit.custom(\"judge\", async () => ({ status: \"ok\", terminal: \"deny\", verdict: \"deny\", reason: \"作者说了算\" })),",
	"\t],",
	"});",
].join("\n");
const BAD_SHAPE = "export default 42;";
const NO_TERMINAL = [
	"export default (kit) => kit.flow({",
	"\tid: \"bad\",",
	"\tnodes: [kit.node(\"merge\", { id: \"merge\" })],",
	"});",
].join("\n");

function dirOf(files: Record<string, string>): string {
	const dir = mkdtempSync(join(tmpdir(), "review-flows-"));
	for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
	return dir;
}

describe("流程加载器", () => {
	it("目录里只收流程文件：跳过下划线开头与 .d.ts", () => {
		const dir = dirOf({ "bash-pre.ts": GOOD_FLOW, "_helper.ts": "export {};", "types.d.ts": "export {};" });
		assert.deepEqual(listFlowFiles(dir).map((f) => f.id), ["bash-pre"]);
		assert.deepEqual(listFlowFiles(join(dir, "不存在")), []);
	});

	it("函数式默认导出：工具集由加载器递进去", () => {
		const normalized = normalizeExport((kit: unknown) => (kit as ReturnType<typeof createKit>).flow({ id: "x", nodes: [] }));
		assert.ok(!("error" in normalized));
		if ("error" in normalized) return;
		assert.equal(normalized.flow.id, "x");
	});

	it("坏形状给出人话的原因，不抛", () => {
		const normalized = normalizeExport(42);
		assert.ok("error" in normalized && normalized.error.includes("默认导出"));
	});

	it("加载一个好流程：拿到 flow 与作者自己的节点实现", async () => {
		const dir = dirOf({ "bash-pre.ts": GOOD_FLOW });
		const loaded = await loadFlowFile("bash-pre", join(dir, "bash-pre.ts"));
		assert.ok(!("error" in loaded));
		if ("error" in loaded) return;
		assert.equal(loaded.flow.id, "bash-pre");
		assert.deepEqual(Object.keys(loaded.nodes), ["judge"]);
	});

	it("加载出来的流程真能跑：作者那个节点说了算", async () => {
		const dir = dirOf({ "bash-pre.ts": GOOD_FLOW });
		const loaded = await loadFlowFile("bash-pre", join(dir, "bash-pre.ts"));
		if ("error" in loaded) throw new Error(loaded.error);
		const result = await runFlow(
			loaded.flow,
			{},
			{ nodes: { chatreview: async () => ({ status: "ok", output: "chat", verdict: "safe" }) }, byId: loaded.nodes },
		);
		assert.equal(result.decision, "deny");
		assert.equal(result.trace.find((r) => r.nodeId === "judge")?.reason, "作者说了算");
	});

	it("语法坏的文件：返回原因，不抛给审核路径", async () => {
		const dir = dirOf({ "broken.ts": "export default (kit) => kit.flow({ id: \"x\", nodes: [ }\n" });
		const loaded = await loadFlowFile("broken", join(dir, "broken.ts"));
		assert.ok("error" in loaded);
	});

	it("校验不过的流程（走不到终点）也退回内置", async () => {
		const dir = dirOf({ "bad.ts": NO_TERMINAL });
		const loaded = await loadFlowFile("bad", join(dir, "bad.ts"));
		assert.ok("error" in loaded);
		if (!("error" in loaded)) return;
		assert.match(loaded.error, /走不到任何终点/);
	});

	it("端到端：作者写了同名流程，预审就走他那条", async () => {
		const dir = mkdtempSync(join(tmpdir(), "review-flows-"));
		writeFileSync(
			join(dir, "bash-pre.ts"),
			[
				"export default (kit) => kit.flow({",
				"\tid: \"bash-pre\",",
				"\tnodes: [kit.custom(\"judge\", async () => ({ status: \"ok\", terminal: \"deny\", verdict: \"deny\", reason: \"作者说不放行\" }))],",
				"});",
			].join("\n"),
		);
		const previous = process.env.PI_REVIEW_FLOWS_DIR;
		process.env.PI_REVIEW_FLOWS_DIR = dir;
		resetFlowCache();
		try {
			const result = await preReviewViaFlow({
				input: { command: "ls -la", rules: [] } as never,
				config: { enabled: true, mode: "auto", backend: "chain" } as never,
				cache: createReviewCache(),
			});
			assert.equal(result.autoApproved, false, "作者那条判 deny，就不该自动放行");
		} finally {
			if (previous === undefined) delete process.env.PI_REVIEW_FLOWS_DIR;
			else process.env.PI_REVIEW_FLOWS_DIR = previous;
			resetFlowCache();
		}
	});

	it("越界的文件根本不会被执行：副作用文件没落盘就被拒", async () => {
		const dir = mkdtempSync(join(tmpdir(), "review-flows-"));
		const marker = join(dir, "marker.txt");
		writeFileSync(
			join(dir, "escape.ts"),
			[
				'import { writeFileSync } from "node:fs";',
				`writeFileSync("${marker}", "我进来了");`,
				'export default (kit) => kit.flow({ id: "escape", nodes: [] });',
			].join("\n"),
		);
		const loaded = await loadFlowFile("escape", join(dir, "escape.ts"));
		assert.ok("error" in loaded, "越界要拒");
		if (!("error" in loaded)) return;
		assert.match(loaded.error, /原生模块/);
		assert.equal(existsSync(marker), false, "文件不该被执行过");
	});

	it("整个目录：一个好的一个坏的，好的照常可用", async () => {
		const dir = dirOf({ "bash-pre.ts": GOOD_FLOW, "bad.ts": BAD_SHAPE });
		const { flows, problems } = await loadFlows(dir);
		assert.equal(flows.has("bash-pre"), true);
		assert.deepEqual(problems.map((p) => p.id), ["bad"]);
	});
});
