// lib/ab-shell.test.ts — 壳的三条路径：槽在、槽不在、槽里那份起不来
// 跑法：node --test --experimental-strip-types lib/ab-shell.test.ts

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { loadSlotExtension } from "./ab-shell.ts";

/** 槽里的演示扩展：default 工厂返回自己的名字 */
function writeSlotExtension(root: string, slot: string, value: string, body?: string): void {
	const dir = join(root, "audit", slot, "extensions", "demo");
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "index.ts"), body ?? `export default function factory() { return "${value}"; }\n`, "utf8");
	writeFileSync(
		join(root, "audit", slot, "manifest.json"),
		JSON.stringify({ ref: slot, sha: `sha-${slot}`, builtAt: "2026-10-05T00:00:00Z" }, null, 2),
		"utf8",
	);
}

function setup(): string {
	const root = mkdtempSync(join(tmpdir(), "ab-shell-"));
	writeSlotExtension(root, "dev", "dev");
	writeSlotExtension(root, "head", "head");
	return root;
}

function pointCurrent(root: string, slot: string): void {
	const link = join(root, "audit", "current");
	if (existsSync(link)) rmSync(link, { force: true });
	symlinkSync(join(root, "audit", slot), link);
}

const fallback = async () => ({ default: () => "repo" });
const load = (root: string) => loadSlotExtension("audit", { extension: "demo", fallback, runtimeRoot: root });
const valueOf = (module: { default: unknown }): unknown => (module.default as () => unknown)();

describe("槽不在就用仓库", () => {
	it("运行时目录没初始化", async () => {
		const root = join(mkdtempSync(join(tmpdir(), "ab-shell-")), "runtime");
		const outcome = await load(root);
		assert.equal(outcome.source, "repo");
		assert.match(String(outcome.reason), /还没初始化/);
		assert.equal(existsSync(root), false, "不该凭空造目录");
	});

	it("current 没设置", async () => {
		const root = setup();
		const outcome = await load(root);
		assert.equal(outcome.source, "repo");
		assert.match(String(outcome.reason), /current 软链/);
	});

	it("槽里没有这个扩展", async () => {
		const root = setup();
		pointCurrent(root, "dev");
		const outcome = await loadSlotExtension("audit", { extension: "nope", fallback, runtimeRoot: root });
		assert.equal(outcome.source, "repo");
		assert.match(String(outcome.reason), /nope/);
	});
});

describe("槽在就用槽", () => {
	it("从槽里加载，并带上槽名与令牌", async () => {
		const root = setup();
		pointCurrent(root, "dev");
		const outcome = await load(root);
		assert.equal(outcome.source, "slot");
		assert.equal(outcome.slot, "dev");
		assert.equal(valueOf(outcome.module), "dev");
		assert.ok(outcome.token && outcome.token !== "none", "令牌必须随槽给出来");
	});

	it("换槽之后拿到的是另一份实现（令牌变了才真的换）", async () => {
		const root = setup();
		pointCurrent(root, "dev");
		const first = await load(root);
		assert.equal(valueOf(first.module), "dev");
		pointCurrent(root, "head");
		const second = await load(root);
		assert.equal(second.source, "slot");
		assert.equal(valueOf(second.module), "head", "换槽必须换到新实现");
		assert.notEqual(second.token, first.token, "令牌必须跟着槽变");
	});
});

describe("槽里那份起不来就退回仓库", () => {
	it("没有可用的 default 工厂", async () => {
		const root = setup();
		writeSlotExtension(root, "dev", "", "export const notDefault = 1;\n");
		pointCurrent(root, "dev");
		const outcome = await load(root);
		assert.equal(outcome.source, "repo");
		assert.match(String(outcome.reason), /default 工厂/);
		assert.match(readFileSync(join(root, "audit", "notice.txt"), "utf8"), /已退回仓库版本/);
	});

	it("语法坏了也不抛，只退回并留提示", async () => {
		const root = setup();
		writeSlotExtension(root, "dev", "", "export default function factory( {\n");
		pointCurrent(root, "dev");
		const outcome = await load(root);
		assert.equal(outcome.source, "repo");
		assert.match(String(outcome.reason), /加载失败/);
		assert.match(readFileSync(join(root, "audit", "notice.txt"), "utf8"), /加载失败/);
	});
});
