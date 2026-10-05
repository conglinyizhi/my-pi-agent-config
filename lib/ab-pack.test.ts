// lib/ab-pack.test.ts
// 跑法：node --test --experimental-strip-types lib/ab-pack.test.ts

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { archivePathsOf, canPromote, planPack } from "./ab-pack.ts";

const AT = "2026-10-05T10:00:00.000Z";
const base = { component: "audit" as const, ref: "HEAD", slot: "dev" as const, dirty: false, at: AT };

describe("构建请求", () => {
	it("正常请求给出 manifest", () => {
		const plan = planPack({ ...base, sha: "abc123" });
		assert.equal(plan.ok, true);
		assert.deepEqual(plan.manifest, { ref: "HEAD", sha: "abc123", dirty: false, builtAt: AT });
	});

	it("ref 留空当 HEAD", () => {
		assert.equal(planPack({ ...base, ref: "  " }).manifest?.ref, "HEAD");
	});

	it("只允许构建到 dev 与 head：stable / previous 只由晋升与回退动", () => {
		for (const slot of ["stable", "previous"] as const) {
			const plan = planPack({ ...base, slot });
			assert.equal(plan.ok, false, slot);
			assert.match(String(plan.reason), /只由晋升与回退动/);
		}
		assert.equal(planPack({ ...base, slot: "head" }).ok, true);
	});

	it("组件名与槽名都不认没见过的值", () => {
		assert.equal(planPack({ ...base, component: "gui2" as never }).ok, false);
		assert.equal(planPack({ ...base, slot: "current" as never }).ok, false);
	});

	it("gui 带上协议信息，audit 不带", () => {
		const gui = planPack({ ...base, component: "gui", protocol: 1, windows: ["gate"] });
		assert.equal(gui.manifest?.protocol, 1);
		assert.deepEqual(gui.manifest?.windows, ["gate"]);
		const audit = planPack(base);
		assert.equal(audit.manifest?.protocol, undefined);
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
	it("audit 要源码，gui 要窗口目录", () => {
		assert.deepEqual(archivePathsOf("audit"), ["lib", "extensions"]);
		assert.deepEqual(archivePathsOf("gui"), ["gui"]);
	});
});
