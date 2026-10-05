// scripts/ab-pack.test.ts — 真跑：从 HEAD 构建一个 audit 槽
// 跑法：node --test --experimental-strip-types scripts/ab-pack.test.ts

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, "ab-pack.ts");

function run(args: string[]) {
	return spawnSync("node", ["--experimental-strip-types", CLI, ...args], { encoding: "utf8", timeout: 60_000 });
}

function tmpRoot(): string {
	return mkdtempSync(join(tmpdir(), "ab-pack-"));
}

describe("构建 audit 槽", () => {
	it("源码与 manifest 都落到槽里", () => {
		const root = tmpRoot();
		const result = run(["audit", "--ref", "HEAD", "--slot", "dev", "--runtime-root", root]);
		assert.equal(result.status, 0, result.stderr);
		const slot = join(root, "audit", "dev");
		assert.equal(existsSync(join(slot, "lib", "ab-slots.ts")), true);
		assert.equal(existsSync(join(slot, "extensions", "sandbox-permissions", "index.ts")), true);
		const manifest = JSON.parse(readFileSync(join(slot, "manifest.json"), "utf8"));
		assert.equal(manifest.ref, "HEAD");
		assert.match(String(manifest.sha), /^[0-9a-f]{7,}$/);
		assert.equal(typeof manifest.dirty, "boolean");
		assert.ok(manifest.builtAt);
	});

	it("--json 给结构化结果", () => {
		const root = tmpRoot();
		const result = run(["audit", "--slot", "head", "--runtime-root", root, "--json"]);
		assert.equal(result.status, 0, result.stderr);
		const parsed = JSON.parse(result.stdout);
		assert.equal(parsed.ok, true);
		assert.equal(parsed.slot, "head");
		assert.equal(existsSync(join(root, "audit", "head", "manifest.json")), true);
	});

	it("拒绝往 stable 构建", () => {
		const root = tmpRoot();
		const result = run(["audit", "--slot", "stable", "--runtime-root", root]);
		assert.equal(result.status, 1);
		assert.match(result.stderr, /只由晋升与回退动/);
		assert.equal(existsSync(join(root, "audit", "stable")), false, "拒绝时不该动盘");
	});

	it("gui 从老 ref 构建时明说暂不支持，不假装支持", () => {
		const result = run(["gui", "--ref", "HEAD~1", "--slot", "dev", "--runtime-root", tmpRoot()]);
		assert.equal(result.status, 1);
		assert.match(result.stderr, /暂不支持从老 ref 构建/);
	});

	it("不给组件名时打印用法", () => {
		const result = run([]);
		assert.equal(result.status, 2);
		assert.match(result.stderr, /用法/);
	});
});
