// lib/review-flow/kit-extra.test.ts — 作者自己的 SDK 从 kit.ts 注入
// 跑法：node --test --experimental-strip-types lib/review-flow/kit-extra.test.ts

import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { listFlowFiles, loadFlows } from "./load.ts";
import { runFlow } from "./runner.ts";

const KIT_FILE = [
	'import { basename } from "node:path";',
	'export default (kit) => ({',
	'  ...kit,',
	'  my: { decide: (command) => { const program = basename(String(command).split(" ")[0] || ""); return program === "rm" ? "deny" : "allow"; } },',
	"});",
].join("\n");

const FLOW_FILE = [
	"export default (kit) => kit.flow({",
	'\tid: "bash-pre",',
	'\tnodes: [kit.custom("judge", async (ctx) => {',
	'\t\tconst verdict = kit.my.decide(String(ctx.input.command));',
	'\t\treturn { status: "ok", terminal: verdict, verdict };',
	"\t})],",
	"});",
].join("\n");

function dirWith(files: Record<string, string>): string {
	const dir = mkdtempSync(join(tmpdir(), "review-flows-"));
	for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
	return dir;
}

describe("作者自己的 SDK", () => {
	it("从 kit.ts 注入：流程只用 kit，判定由自己的代码说了算", async () => {
		const dir = dirWith({ "kit.ts": KIT_FILE, "bash-pre.ts": FLOW_FILE });
		const { flows, problems } = await loadFlows(dir);
		assert.deepEqual(problems, []);
		const loaded = flows.get("bash-pre");
		assert.ok(loaded);
		if (!loaded) return;
		const denied = await runFlow(loaded.flow, { command: "rm -rf /tmp/x" }, { nodes: {}, byId: loaded.nodes });
		const allowed = await runFlow(loaded.flow, { command: "ls -la" }, { nodes: {}, byId: loaded.nodes });
		assert.equal(denied.decision, "deny");
		assert.equal(allowed.decision, "allow");
	});

	it("kit.ts 里想 import 什么都行：它是宿主侧代码，不受流程那条规矩约束", async () => {
		const dir = dirWith({ "kit.ts": KIT_FILE, "bash-pre.ts": FLOW_FILE });
		const { problems } = await loadFlows(dir);
		assert.deepEqual(problems, []);
	});

	it("kit.ts 不算一条流程", () => {
		const dir = dirWith({ "kit.ts": KIT_FILE, "bash-pre.ts": FLOW_FILE });
		assert.deepEqual(listFlowFiles(dir).map((f) => f.id), ["bash-pre"]);
	});
});
