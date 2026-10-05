// lib/ab-pack.test.ts
// 跑法：node --test --experimental-strip-types lib/ab-pack.test.ts

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { archivePathsOf, canPromote, planPack } from "./ab-pack.ts";

const AT = "2026-10-05T10:00:00.000Z";
const base = { component: "gui" as const, ref: "HEAD", dir: "dev", dirty: false, at: AT };

describe("构建请求", () => {
	it("正常请求给出 manifest", () => {
		const plan = planPack({ ...base, sha: "abc123" });
		assert.equal(plan.ok, true);
		assert.deepEqual(plan.manifest, { ref: "HEAD", sha: "abc123", dirty: false, builtAt: AT });
	});

	it("ref 留空当 HEAD", () => {
		assert.equal(planPack({ ...base, ref: "  " }).manifest?.ref, "HEAD");
	});

	it("构建只能落暂存目录：别的名字都不是构建目标", () => {
		for (const dir of ["stable", "previous", "head"]) {
			const plan = planPack({ ...base, dir });
			assert.equal(plan.ok, false, dir);
			assert.match(String(plan.reason), /只能落暂存目录/);
		}
		assert.equal(planPack({ ...base }).ok, true, "缺省就是暂存目录");
	});

	it("组件名不认没见过的值", () => {
		assert.equal(planPack({ ...base, component: "gui2" as never }).ok, false);
		// 审核侧那条产线撤了：audit 不再是合法组件
		assert.equal(planPack({ ...base, component: "audit" as never }).ok, false);
	});

	it("gui 带上协议信息", () => {
		const gui = planPack({ ...base, protocol: 1, windows: ["gate"] });
		assert.equal(gui.manifest?.protocol, 1);
		assert.deepEqual(gui.manifest?.windows, ["gate"]);
	});
});

describe("能不能晋升", () => {
	it("干净产物可以", () => {
		assert.equal(canPromote({ ref: "HEAD", dirty: false }).ok, true);
	});

	it("脏产物默认不让晋升：复现不出来", () => {
		const verdict = canPromote({ ref: "HEAD", dirty: true });
		assert.equal(verdict.ok, false);
		assert.match(verdict.reason, /脏工作区/);
	});

	it("--force 可以越过，但那是留痕的强推", () => {
		assert.equal(canPromote({ ref: "HEAD", dirty: true }, { force: true }).ok, true);
	});

	it("没有 manifest 就谈不上晋升", () => {
		assert.equal(canPromote(undefined).ok, false);
		assert.match(canPromote(undefined).reason, /没构建过/);
	});
});

describe("取哪些路径", () => {
	it("gui 要窗口目录（审核侧不再打包，没有 audit 这一份）", () => {
		assert.deepEqual(archivePathsOf("gui"), ["gui"]);
	});
});
