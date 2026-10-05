// scripts/ab-slot.test.ts — 期 1 的真跑测试：临时 runtime 目录里做真实的软链操作
// 跑法：node --test --experimental-strip-types scripts/ab-slot.test.ts

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = dirname(HERE);
const CLI = join(HERE, "ab-slot.ts");
const SHIM = join(REPO, "bin", "ab-rollback");

function run(args: string[], env: Record<string, string> = {}) {
	return spawnSync("node", ["--experimental-strip-types", CLI, ...args], {
		encoding: "utf8",
		env: { ...process.env, ...env },
	});
}

/** 造一个临时 runtime，四个槽都有带 manifest 的内容 */
function setup(): string {
	const root = mkdtempSync(join(tmpdir(), "ab-slots-"));
	for (const component of ["gui", "audit"]) {
		for (const [slot, sha] of [["stable", "s1"], ["previous", "p1"], ["dev", "d1"], ["head", "h1"]] as const) {
			const dir = join(root, component, slot);
			mkdirSync(dir, { recursive: true });
			writeFileSync(join(dir, "manifest.json"), JSON.stringify({ ref: sha, sha, builtAt: "2026-10-05T00:00:00Z" }, null, 2));
		}
	}
	return root;
}

const currentTarget = (root: string, component: string): string => {
	const link = join(root, component, "current");
	return existsSync(link) ? readlinkSync(link).split("/").pop() ?? "" : "(无)";
};

const manifestSha = (root: string, component: string, slot: string): string => {
	const path = join(root, component, slot, "manifest.json");
	return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")).sha as string) : "(无)";
};

describe("切换", () => {
	it("换软链指到指定槽", () => {
		const root = setup();
		const result = run(["switch", "gui", "dev", "--runtime-root", root]);
		assert.equal(result.status, 0, result.stderr);
		assert.equal(currentTarget(root, "gui"), "dev");
	});

	it("反复切换不留临时链接", () => {
		const root = setup();
		run(["switch", "gui", "head", "--runtime-root", root]);
		run(["switch", "gui", "previous", "--runtime-root", root]);
		assert.equal(currentTarget(root, "gui"), "previous");
		assert.deepEqual(readdirSync(join(root, "gui")).filter((name) => name.includes(".tmp-")), []);
	});

	it("组件名或槽名不对就拒绝，不动盘", () => {
		const root = setup();
		const bad = run(["switch", "guy", "dev", "--runtime-root", root]);
		assert.equal(bad.status, 1);
		assert.match(bad.stderr, /组件名必须/);
		const badSlot = run(["switch", "gui", "current", "--runtime-root", root]);
		assert.equal(badSlot.status, 1);
		assert.equal(currentTarget(root, "gui"), "(无)");
	});

	it("运行时根是 / 时直接拒绝（下面有删除动作）", () => {
		const result = run(["status", "--runtime-root", "/"]);
		assert.equal(result.status, 1);
		assert.match(result.stderr, /运行时根不合法/);
	});
});

describe("回退", () => {
	it("CLI 回退：current 指回 previous 并留日志", () => {
		const root = setup();
		run(["switch", "audit", "dev", "--runtime-root", root]);
		const result = run(["rollback", "audit", "--reason", "判定逻辑静默失效", "--runtime-root", root]);
		assert.equal(result.status, 0, result.stderr);
		assert.equal(currentTarget(root, "audit"), "previous");
		assert.match(readFileSync(join(root, "audit", "promote.log"), "utf8"), /判定逻辑静默失效/);
	});

	it("没有 previous 时拒绝回退", () => {
		const root = setup();
		execFileSync("sh", ["-c", `rm -rf ${join(root, "gui", "previous")}`]);
		const result = run(["rollback", "gui", "--runtime-root", root]);
		assert.equal(result.status, 1);
		assert.match(result.stderr, /没有 previous 槽/);
	});

	it("应急 shim 只靠软链就能回退（不依赖 node 逻辑之外的任何东西）", () => {
		const root = setup();
		run(["switch", "gui", "dev", "--runtime-root", root]);
		const out = execFileSync(SHIM, ["gui"], { env: { ...process.env, PI_RUNTIME_ROOT: root }, encoding: "utf8" });
		assert.match(out, /已回退/);
		assert.equal(currentTarget(root, "gui"), "previous");
		assert.match(readFileSync(join(root, "gui", "promote.log"), "utf8"), /ab-rollback/);
	});

	it("shim 收到非法组件名时退出码 2", () => {
		const result = spawnSync(SHIM, ["nope"], { env: { ...process.env, PI_RUNTIME_ROOT: setup() }, encoding: "utf8" });
		assert.equal(result.status, 2);
	});
});

describe("干净往返与自动晋升", () => {
	it("攒够五次就自动晋升：dev 内容进 stable，旧 stable 落到 previous", () => {
		const root = setup();
		run(["switch", "gui", "dev", "--runtime-root", root]);
		for (let index = 0; index < 4; index += 1) {
			const step = run(["note", "gui", "clean", "--runtime-root", root]);
			assert.equal(step.status, 0, step.stderr);
			assert.equal(currentTarget(root, "gui"), "dev");
		}
		const fifth = run(["note", "gui", "clean", "--runtime-root", root]);
		assert.equal(fifth.status, 0, fifth.stderr);
		assert.match(fifth.stdout, /已自动晋升/);
		assert.equal(manifestSha(root, "gui", "stable"), "d1", "dev 的内容应该成为 stable");
		assert.equal(manifestSha(root, "gui", "previous"), "s1", "旧 stable 应该落到 previous");
		assert.equal(currentTarget(root, "gui"), "stable");
		assert.equal(JSON.parse(readFileSync(join(root, "gui", "streak.json"), "utf8")).clean, 0);
		assert.match(readFileSync(join(root, "gui", "promote.log"), "utf8"), /"event":"promote"/);
	});

	it("失败清零并记原因，重新攒", () => {
		const root = setup();
		run(["note", "gui", "clean", "--runtime-root", root]);
		run(["note", "gui", "clean", "--runtime-root", root]);
		const failed = run(["note", "gui", "failure", "--reason", "窗口被叉掉", "--runtime-root", root]);
		assert.equal(failed.status, 0, failed.stderr);
		const streak = JSON.parse(readFileSync(join(root, "gui", "streak.json"), "utf8"));
		assert.equal(streak.clean, 0);
		assert.equal(streak.failures, 1);
		assert.equal(streak.lastReason, "窗口被叉掉");
		assert.equal(manifestSha(root, "gui", "previous"), "p1", "没晋升，槽位不该动");
	});

	it("关掉自动晋升时只提示，不动槽位", () => {
		const root = setup();
		for (let index = 0; index < 5; index += 1) {
			run(["note", "gui", "clean", "--no-auto-promote", "--runtime-root", root]);
		}
		assert.equal(manifestSha(root, "gui", "stable"), "s1");
		assert.equal(manifestSha(root, "gui", "previous"), "p1");
		assert.match(readFileSync(join(root, "gui", "promote.log"), "utf8"), /promote-notice/);
	});

	it("门槛没到就不晋升，--force 可以强推（留痕）", () => {
		const root = setup();
		const early = run(["promote", "gui", "--runtime-root", root]);
		assert.match(early.stdout, /不晋升/);
		assert.equal(manifestSha(root, "gui", "stable"), "s1");
		const forced = run(["promote", "gui", "--force", "--runtime-root", root]);
		assert.equal(forced.status, 0, forced.stderr);
		assert.match(readFileSync(join(root, "gui", "promote.log"), "utf8"), /手工强推/);
	});
});

describe("状态", () => {
	it("--json 给结构化四槽 + 计数 + 判定", () => {
		const root = setup();
		run(["switch", "audit", "dev", "--runtime-root", root]);
		const result = run(["status", "--json", "--runtime-root", root]);
		assert.equal(result.status, 0, result.stderr);
		const parsed = JSON.parse(result.stdout);
		assert.equal(parsed.reports.length, 2);
		const audit = parsed.reports.find((entry: { component: string }) => entry.component === "audit");
		assert.equal(audit.current, "dev");
		assert.deepEqual(audit.slots.map((slot: { slot: string }) => slot.slot), ["stable", "previous", "dev", "head"]);
		assert.equal(audit.decision.action, "keep");
	});

	it("未知命令给用法并退出码 2", () => {
		const result = run(["nope"]);
		assert.equal(result.status, 2);
		assert.match(result.stderr, /用法/);
	});
});
