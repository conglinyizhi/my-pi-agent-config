// scripts/ab-pack.test.ts — 真跑：从 HEAD 构建一个 gui 槽
// 跑法：node --test --experimental-strip-types scripts/ab-pack.test.ts

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdtempSync, readFileSync } from "node:fs";
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

describe("构建 gui 槽", () => {
	it("窗口产物与 manifest 都落到槽里", () => {
		const root = tmpRoot();
		const result = run(["gui", "--ref", "HEAD", "--dir", "dev", "--runtime-root", root]);
		assert.equal(result.status, 0, result.stderr);
		const slot = join(root, "gui", "dev");
		assert.equal(existsSync(join(slot, "gui", "electron", "main.js")), true);
		assert.equal(existsSync(join(slot, "gui", "frontend")), true);
		const manifest = JSON.parse(readFileSync(join(slot, "manifest.json"), "utf8"));
		assert.equal(manifest.ref, "HEAD");
		assert.match(String(manifest.sha), /^[0-9a-f]{7,}$/);
		assert.equal(typeof manifest.dirty, "boolean");
		assert.ok(manifest.builtAt);
	});

	it("--json 给结构化结果", () => {
		const root = tmpRoot();
		const result = run(["gui", "--dir", "dev", "--runtime-root", root, "--json"]);
		assert.equal(result.status, 0, result.stderr);
		assert.equal(JSON.parse(result.stdout).ok, true);
		assert.equal(existsSync(join(root, "gui", "dev", "manifest.json")), true, "缺省落暂存目录 dev");
	});

	it("拒绝往 stable 构建", () => {
		const root = tmpRoot();
		const result = run(["gui", "--dir", "stable", "--runtime-root", root]);
		assert.equal(result.status, 1);
		assert.match(result.stderr, /只能落暂存目录/);
		assert.equal(existsSync(join(root, "gui", "stable")), false, "拒绝时不该动盘");
	});

	it("从老 ref 构建时明说暂不支持，不假装支持", () => {
		const result = run(["gui", "--ref", "HEAD~1", "--dir", "dev", "--runtime-root", tmpRoot()]);
		assert.equal(result.status, 1);
		assert.match(result.stderr, /暂不支持从老 ref 构建/);
	});

	it("不给组件名时打印用法", () => {
		const result = run([]);
		assert.equal(result.status, 2);
		assert.match(result.stderr, /用法/);
	});

	it("audit 不再是合法组件（那条产线撤了）", () => {
		const result = run(["audit", "--dir", "dev", "--runtime-root", tmpRoot()]);
		assert.notEqual(result.status, 0);
	});
});

describe("槽要能拿到宿主的依赖", () => {
	it("槽里带上 node_modules 软链（不然槽内那份 import 不到宿主 pi 的包）", () => {
		const root = tmpRoot();
		const result = run(["gui", "--dir", "dev", "--runtime-root", root]);
		assert.equal(result.status, 0, result.stderr);
		const link = join(root, "gui", "dev", "node_modules");
		assert.equal(existsSync(link), true, "槽里该有 node_modules");
		assert.equal(lstatSync(link).isSymbolicLink(), true, "软链而不是复制");
	});
});

describe("自举已删", () => {
	it("stable / previous 都拒绝构建", () => {
		const root = tmpRoot();
		for (const dir of ["stable", "previous"]) {
			const result = run(["gui", "--dir", dir, "--runtime-root", root]);
			assert.notEqual(result.status, 0, dir);
			assert.match(result.stderr, /只能落暂存目录/);
			assert.equal(existsSync(join(root, "gui", dir)), false);
		}
	});
});
