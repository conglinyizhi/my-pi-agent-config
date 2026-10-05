// scripts/review-rules-cli.test.ts — 规则表命令行桥
// 跑法：node --test --experimental-strip-types scripts/review-rules-cli.test.ts

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";

const CLI = new URL("./review-rules-cli.ts", import.meta.url).pathname;

function run(args: string[]) {
	return spawnSync("node", ["--experimental-strip-types", CLI, ...args], { encoding: "utf8" });
}

function dir(): string {
	return mkdtempSync(join(tmpdir(), "rules-cli-"));
}

function patch(file: string, body: unknown): string {
	const at = join(dir(), "patch.json");
	writeFileSync(at, JSON.stringify(body), "utf8");
	return at;
}

describe("规则表命令行桥", () => {
	it("没有文件时给空表，不算错", () => {
		const result = run(["get", "--path", join(dir(), "review-rules.toml")]);
		assert.equal(result.status, 0, result.stderr);
		const payload = JSON.parse(result.stdout);
		assert.deepEqual(payload.rules, []);
		assert.deepEqual(payload.problems, []);
	});

	it("存了再读回来是同一批规则", () => {
		const file = join(dir(), "review-rules.toml");
		const body = { rules: [{ id: "low-conf", verdict: ["risky"], allTriggeredBelowConfidence: 0.5, then: "allow" }] };
		const saved = run(["save", "--path", file, "--file", patch(file, body)]);
		assert.equal(saved.status, 0, saved.stderr);
		const back = JSON.parse(run(["get", "--path", file]).stdout);
		assert.equal(back.rules[0].id, "low-conf");
		assert.equal(back.rules[0].allTriggeredBelowConfidence, 0.5);
		assert.match(readFileSync(file, "utf8"), /all_triggered_below_confidence = 0\.5/);
	});

	it("校验不过就拒绝写盘（不许半生效）", () => {
		const file = join(dir(), "review-rules.toml");
		const body = { rules: [{ id: "bad", then: "maybe" }] };
		const result = run(["save", "--path", file, "--file", patch(file, body)]);
		assert.notEqual(result.status, 0);
		assert.match(JSON.parse(result.stdout).error, /没有写盘/);
		assert.equal(run(["get", "--path", file]).stdout.includes("bad"), false, "盘上不该有它");
	});
});
