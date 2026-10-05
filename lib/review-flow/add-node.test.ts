// lib/review-flow/add-node.test.ts
// 跑法：node --test --experimental-strip-types lib/review-flow/add-node.test.ts

import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { addNodeToSource } from "./add-node.ts";
import { loadFlowFile } from "./load.ts";
import { validateFlow } from "./validate.ts";

const SOURCE = [
	'export default (kit) => kit.flow({',
	'\tid: "f",',
	'\tnodes: [',
	'\t\tkit.node("chatreview", { id: "chat", next: "gate" }),',
	'\t\tkit.node("gate", { id: "gate", after: ["chat"], next: "allow" }),',
	'\t],',
	'});',
].join("\n");

async function flowOf(source: string) {
	const dir = mkdtempSync(join(tmpdir(), "add-node-"));
	const at = join(dir, "f.ts");
	writeFileSync(at, source);
	const loaded = await loadFlowFile("f", at);
	if ("error" in loaded) throw new Error(loaded.error);
	return loaded.flow;
}

describe("图上加节点", () => {
	it("追加到末尾：插进去、能加载", async () => {
		const result = await addNodeToSource({ source: SOURCE, id: "extra", kind: "custom" });
		assert.equal(result.ok, true, result.error);
		assert.match(result.source ?? "", /kit\.custom\("extra"/);
		const flow = await flowOf(result.source ?? "");
		assert.equal(flow.nodes.some((node) => node.id === "extra"), true);
	});

	it("插在某个节点之前", async () => {
		const result = await addNodeToSource({ source: SOURCE, id: "before-gate", kind: "custom", before: "gate" });
		assert.equal(result.ok, true, result.error);
		const flow = await flowOf(result.source ?? "");
		assert.equal(flow.nodes[1].id, "before-gate");
	});

	it("顺手把一条边改接到新节点：改完仍然合法", async () => {
		const result = await addNodeToSource({
			source: SOURCE,
			id: "checker",
			kind: "custom",
			connect: { nodeId: "gate", edge: { kind: "next" } },
		});
		assert.equal(result.ok, true, result.error);
		const flow = await flowOf(result.source ?? "");
		assert.equal(flow.nodes.find((node) => node.id === "gate")?.next, "checker");
		assert.deepEqual(validateFlow(flow), [], "校验得是干净的：新节点可达、也有出口");
	});

	it("id 重复就拒绝，不动源码", async () => {
		const result = await addNodeToSource({ source: SOURCE, id: "chat", kind: "custom" });
		assert.equal(result.ok, false);
		assert.equal(result.source, undefined);
	});

	it("找不到 nodes 数组时说清楚", async () => {
		const result = await addNodeToSource({ source: "export default (kit) => kit.flow({ id: \"x\" });", id: "a", kind: "custom" });
		assert.equal(result.ok, false);
		assert.match(result.error ?? "", /nodes 数组/);
	});
});
