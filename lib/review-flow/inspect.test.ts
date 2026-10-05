// lib/review-flow/inspect.test.ts — 流程体检
// 跑法：node --test --experimental-strip-types lib/review-flow/inspect.test.ts

import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { inspectFlows } from "./inspect.ts";

const GOOD = [
	"export default (kit) => kit.flow({",
	'\tid: "bash-pre",',
	"\tnodes: [kit.custom(\"judge\", async () => ({ status: \"ok\", terminal: \"deny\" }))],",
	"});",
].join("\n");

function dirWith(files: Record<string, string>): string {
	const dir = mkdtempSync(join(tmpdir(), "flows-inspect-"));
	for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
	return dir;
}

describe("流程体检", () => {
	it("空目录：三条内置都在，各自有图", async () => {
		const list = await inspectFlows(join(tmpdir(), "flows-inspect-空"));
		assert.deepEqual(list.map((f) => f.id), ["bash-pre", "bash-pre-chat", "bash-pre-classifier"]);
		for (const item of list) {
			assert.equal(item.active, "builtin");
			assert.equal(item.builtin, true);
			assert.ok(item.graph && item.graph.nodes.length > 0, item.id);
		}
	});

	it("作者覆盖了 bash-pre：那条就是作者在生效，不再重复列内置", async () => {
		const list = await inspectFlows(dirWith({ "bash-pre.ts": GOOD }));
		const authored = list.find((f) => f.id === "bash-pre");
		assert.equal(authored?.active, "authored");
		assert.ok(authored?.source?.endsWith("bash-pre.ts"));
		assert.deepEqual(authored?.problems, []);
		assert.equal(list.filter((f) => f.id === "bash-pre").length, 1);
	});

	it("作者那条坏了：退回同名内置，并写清原因", async () => {
		const list = await inspectFlows(dirWith({ "bash-pre.ts": 'import fs from "fs";\nexport default (kit) => kit.flow({ id: "bash-pre", nodes: [] });' }));
		const item = list.find((f) => f.id === "bash-pre");
		assert.equal(item?.active, "builtin");
		assert.ok(item?.graph, "退回内置那条要有图");
		assert.match(item?.problems[0] ?? "", /原生模块/);
	});

	it("作者那条坏了又没有同名内置：照样列出来给人改，只是没有图", async () => {
		const list = await inspectFlows(dirWith({ "my-own.ts": "export default 42;" }));
		const item = list.find((f) => f.id === "my-own");
		assert.ok(item);
		assert.equal(item?.graph, undefined);
		assert.ok((item?.problems.length ?? 0) > 0);
	});
});
