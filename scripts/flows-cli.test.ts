// scripts/flows-cli.test.ts — 流程命令行桥（只碰临时目录）
// 跑法：node --test --experimental-strip-types scripts/flows-cli.test.ts

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, "flows-cli.ts");

function run(args: string[], input?: string) {
	return spawnSync("node", ["--experimental-strip-types", CLI, ...args], {
		encoding: "utf8",
		timeout: 60_000,
		...(input !== undefined ? { input } : {}),
	});
}

function dir(): string {
	return mkdtempSync(join(tmpdir(), "flows-cli-"));
}

const GOOD = [
	"export default (kit) => kit.flow({",
	'\tid: "my-flow",',
	"\tnodes: [kit.custom(\"judge\", async () => ({ status: \"ok\", terminal: \"deny\" }))],",
	"});",
].join("\n");

describe("流程命令行桥", () => {
	it("list：空目录就是三条内置，各自没问题", () => {
		const result = run(["list", "--dir", dir()]);
		assert.equal(result.status, 0, result.stderr);
		const payload = JSON.parse(result.stdout);
		assert.deepEqual(payload.flows.map((f: { id: string }) => f.id), ["bash-pre", "bash-pre-chat", "bash-pre-classifier"]);
		for (const item of payload.flows) assert.deepEqual(item.problems, []);
	});

	it("get：内置那条有图，没有源码", () => {
		const result = run(["get", "bash-pre", "--dir", dir()]);
		const payload = JSON.parse(result.stdout);
		assert.equal(payload.ok, true);
		assert.ok(payload.flow.graph.nodes.length > 0);
		assert.equal(payload.flow.sourceText, undefined);
		assert.equal(payload.flow.active, "builtin");
	});

	it("save：从 stdin 存一份，再取回来就是我写的那份", () => {
		const root = dir();
		const saved = run(["save", "my-flow", "--dir", root], GOOD);
		assert.equal(saved.status, 0, saved.stderr);
		const payload = JSON.parse(saved.stdout);
		assert.equal(payload.ok, true);
		assert.deepEqual(payload.problems, []);
		assert.equal(payload.path, join(root, "my-flow.ts"));

		const got = JSON.parse(run(["get", "my-flow", "--dir", root]).stdout);
		assert.equal(got.flow.active, "authored");
		assert.equal(got.flow.sourceText.trim(), GOOD.trim());
		// judge 靠返回值自己给决定、没声明边，所以图上只有它一个节点，但会标出来
		assert.equal(got.flow.graph.nodes.length, 1);
		assert.equal(got.flow.graph.nodes[0].givesOwnDecision, true);
	});

	it("save：越界的源码拒绝，且不落盘", () => {
		const root = dir();
		const bad = 'import fs from "fs";\nexport default (kit) => kit.flow({ id: "bad", nodes: [] });';
		const result = run(["save", "bad", "--dir", root], bad);
		assert.notEqual(result.status, 0);
		assert.match(JSON.parse(result.stdout).error, /原生模块/);
		assert.equal(existsSync(join(root, "bad.ts")), false);
	});

	it("serve：一行一个请求，回显 id", () => {
		const requests = [
			JSON.stringify({ id: 1, cmd: "list" }),
			JSON.stringify({ id: 2, cmd: "get", patch: { id: "bash-pre" } }),
			JSON.stringify({ id: 3, cmd: "没这个命令" }),
		].join("\n") + "\n";
		const result = run(["serve", "--dir", dir()], requests);
		const lines = result.stdout.trim().split("\n").map((line) => JSON.parse(line));
		assert.equal(lines.length, 3);
		assert.equal(lines[0].id, 1);
		assert.equal(lines[0].flows.length, 3);
		assert.equal(lines[1].id, 2);
		assert.equal(lines[1].flow.id, "bash-pre");
		assert.equal(lines[2].ok, false);
	});
});

describe("图上改边的命令", () => {
	it("改一条边：文件被定点改过，其余原样", () => {
		const root = dir();
		const source = [
			"export default (kit) => kit.flow({",
			'\tid: "my-flow",',
			"\tnodes: [",
			'\t\tkit.custom("judge", async () => ({ status: "ok", terminal: "deny" }), { branches: { yes: "deny", no: "allow" } }),',
			"\t],",
			"});",
		].join("\n");
		writeFileSync(join(root, "my-flow.ts"), source);
		const result = run(["edit-edge", "my-flow", "--node", "judge", "--kind", "branch", "--label", "yes", "--to", "allow", "--dir", root]);
		assert.equal(result.status, 0, result.stdout + result.stderr);
		const payload = JSON.parse(result.stdout);
		assert.equal(payload.ok, true);
		assert.equal(payload.changed, true);
		assert.deepEqual(payload.problems, []);
		const after = readFileSync(join(root, "my-flow.ts"), "utf8");
		assert.match(after, /branches: \{ yes: "allow", no: "allow" \}/);
		assert.match(after, /id: "my-flow"/, "别的地方没动");
	});

	it("节点找不到：拒绝，文件不动", () => {
		const root = dir();
		writeFileSync(join(root, "my-flow.ts"), 'export default (kit) => kit.flow({ id: "my-flow", nodes: [] });');
		const before = readFileSync(join(root, "my-flow.ts"), "utf8");
		const result = run(["edit-edge", "my-flow", "--node", "没有这个", "--to", "deny", "--dir", root]);
		assert.notEqual(result.status, 0);
		assert.match(JSON.parse(result.stdout).error, /找不到节点/);
		assert.equal(readFileSync(join(root, "my-flow.ts"), "utf8"), before);
	});
});


describe("图上加节点（走命令行桥）", () => {
	it("插一个节点并接上一条边", () => {
		const root = dir();
		const source = [
			"export default (kit) => kit.flow({",
			'\tid: "my-flow",',
			"\tnodes: [",
			'\t\tkit.node("chatreview", { id: "chat" }),',
			"\t],",
			"});",
		].join("\n");
		writeFileSync(join(root, "my-flow.ts"), source);
		const result = run(["add-node", "my-flow", "--node", "watchdog", "--kind", "custom", "--dir", root]);
		assert.equal(result.status, 0, result.stdout + result.stderr);
		const payload = JSON.parse(result.stdout);
		assert.equal(payload.ok, true, JSON.stringify(payload));
		assert.equal(payload.changed, true);
		const after = readFileSync(join(root, "my-flow.ts"), "utf8");
		assert.match(after, /kit\.custom\("watchdog"/);
	});

	it("id 重复：拒绝，文件不动", () => {
		const root = dir();
		writeFileSync(join(root, "my-flow.ts"), 'export default (kit) => kit.flow({ id: "f", nodes: [kit.custom("dup", async () => ({ status: "abstain" }))] });');
		const before = readFileSync(join(root, "my-flow.ts"), "utf8");
		const result = run(["add-node", "my-flow", "--node", "dup", "--kind", "custom", "--dir", root]);
		assert.notEqual(result.status, 0);
		assert.match(JSON.parse(result.stdout).error, /已经有 id/);
		assert.equal(readFileSync(join(root, "my-flow.ts"), "utf8"), before);
	});
});

