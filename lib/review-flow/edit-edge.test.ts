// lib/review-flow/edit-edge.test.ts — 图上改边：定点替换，不做整文件重排
// 跑法：node --test --experimental-strip-types lib/review-flow/edit-edge.test.ts

import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { editEdgeInSource, removeEdgeInSource } from "./edit-edge.ts";
import { loadFlowFile } from "./load.ts";
import { validateFlow } from "./validate.ts";

const SOURCE = [
	'import type { ReviewKit } from "../lib/review-flow/kit.ts";',
	"",
	"export default (kit: ReviewKit) =>",
	"\tkit.flow({",
	'\t\tid: "bash-pre",',
	"\t\tnodes: [",
	'\t\t\tkit.node("chatreview", { id: "chat", next: "classify" }),',
	'\t\t\tkit.node("classifier", { id: "classify", after: ["chat"], next: "judge" }),',
	'\t\t\tkit.custom("judge", async () => ({ status: "ok", terminal: "deny" }), { after: ["classify"], branches: { yes: "deny", no: "allow" } }),',
	"\t\t],",
	"\t});",
].join("\n");

async function flowOf(source: string) {
	const dir = mkdtempSync(join(tmpdir(), "edit-edge-"));
	const path = join(dir, "p.ts");
	writeFileSync(path, source);
	const loaded = await loadFlowFile("p", path);
	if ("error" in loaded) throw new Error(loaded.error);
	return loaded.flow;
}

describe("图上改边", () => {
	it("改 next：只替换那一个字面量，别的原样", async () => {
		const result = await editEdgeInSource({ source: SOURCE, nodeId: "chat", kind: "next", to: "judge" });
		assert.equal(result.ok, true, result.error);
		assert.equal(result.changed, true);
		assert.match(result.source ?? "", /id: "chat", next: "judge"/);
		assert.match(result.source ?? "", /id: "classify", after: \["chat"\], next: "judge"/, "别的节点没被动过");
		assert.equal(result.source?.includes("import type"), true, "注释之外的头部也在");
	});

	it("改出来的源码仍然能加载、能过校验", async () => {
		const result = await editEdgeInSource({ source: SOURCE, nodeId: "chat", kind: "next", to: "judge" });
		const flow = await flowOf(result.source ?? "");
		assert.deepEqual(validateFlow(flow), []);
		assert.equal(flow.nodes.find((n) => n.id === "chat")?.next, "judge");
	});

	it("改分支出口：yes 换成 gate", async () => {
		const result = await editEdgeInSource({ source: SOURCE, nodeId: "judge", kind: "branch", label: "yes", to: "allow" });
		assert.equal(result.ok, true, result.error);
		assert.match(result.source ?? "", /branches: \{ yes: "allow", no: "allow" \}/);
	});

	it("插入缺失的属性：onEmpty 原来没有，就补一条", async () => {
		const result = await editEdgeInSource({ source: SOURCE, nodeId: "classify", kind: "empty", to: "deny" });
		assert.equal(result.ok, true, result.error);
		assert.match(result.source ?? "", /next: "judge", onEmpty: "deny"/);
		const flow = await flowOf(result.source ?? "");
		assert.equal(flow.nodes.find((n) => n.id === "classify")?.onEmpty, "deny");
	});

	it("kit.custom 没有第三个参数：补一个只带这条边的对象", async () => {
		const oneLine = 'export default (kit) => kit.flow({ id: "x", nodes: [kit.custom("judge", async () => ({ status: "ok", terminal: "deny" }))] });';
		const result = await editEdgeInSource({ source: oneLine, nodeId: "judge", kind: "error", to: "deny" });
		assert.equal(result.ok, true, result.error);
		assert.match(result.source ?? "", /, \{ onError: "deny" \}\)\]/);
		const flow = await flowOf(result.source ?? "");
		assert.equal(flow.nodes.find((n) => n.id === "judge")?.onError, "deny");
	});

	it("单行的 options 对象里也插得进去（同一行补一条）", async () => {
		const oneLine = 'export default (kit) => kit.flow({ id: "x", nodes: [kit.custom("judge", fn, { next: "deny" })] });';
		const result = await editEdgeInSource({ source: oneLine, nodeId: "judge", kind: "error", to: "deny" });
		assert.equal(result.ok, true, result.error);
		assert.match(result.source ?? "", /\{ next: "deny", onError: "deny" \}/);
	});

	it("本来就是这个值：changed 是 false，源码不动", async () => {
		const result = await editEdgeInSource({ source: SOURCE, nodeId: "chat", kind: "next", to: "classify" });
		assert.equal(result.ok, true);
		assert.equal(result.changed, false);
		assert.equal(result.source, SOURCE);
	});

	it("目标不是字面量：拒绝，不改", async () => {
		const source = 'export default (kit) => kit.flow({ id: "x", nodes: [kit.custom("judge", fn, { next: someVar })] });';
		const result = await editEdgeInSource({ source, nodeId: "judge", kind: "next", to: "deny" });
		assert.equal(result.ok, false);
		assert.match(result.error ?? "", /不是字面量/);
	});

	it("找不到节点：拒绝，并说清为什么", async () => {
		const result = await editEdgeInSource({ source: SOURCE, nodeId: "没有这个", kind: "next", to: "deny" });
		assert.equal(result.ok, false);
		assert.match(result.error ?? "", /找不到节点/);
	});
});

describe("删一条边", () => {
	it("删掉独行的 next：整行一起走，不留空行", async () => {
		const source = [
			"export default (kit) => kit.flow({",
			'\tid: "f",',
			"\tnodes: [",
			'\t\tkit.node("chatreview", { id: "chat", next: "gate" }),',
			"\t],",
			"});",
		].join("\n");
		const result = await removeEdgeInSource({ source, nodeId: "chat", kind: "next" });
		assert.equal(result.ok, true, result.error);
		assert.equal(result.changed, true);
		assert.equal((result.source ?? "").includes("next"), false);
		assert.match(result.source ?? "", /kit\.node\("chatreview", \{ id: "chat" \}\),/);
	});

	it("删分支里的一个出口，别的留着", async () => {
		const source = 'export default (kit) => kit.flow({ id: "f", nodes: [kit.custom("c", async () => ({}), { branches: { yes: "a", no: "b" } })] });';
		const result = await removeEdgeInSource({ source, nodeId: "c", kind: "branch", label: "yes" });
		assert.equal(result.ok, true, result.error);
		assert.match(result.source ?? "", /no: "b"/);
		assert.equal((result.source ?? "").includes("yes"), false);
	});

	it("本来就没有这条边：不动，也不算错", async () => {
		const source = 'export default (kit) => kit.flow({ id: "f", nodes: [kit.node("gate", { id: "g" })] });';
		const result = await removeEdgeInSource({ source, nodeId: "g", kind: "next" });
		assert.equal(result.ok, true);
		assert.equal(result.changed, false);
		assert.equal(result.source, source);
	});
});

